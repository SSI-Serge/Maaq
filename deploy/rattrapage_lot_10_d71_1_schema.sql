-- MAAQ — rattrapage additif de l'aide Devoirs (décisions D71 à D73 : jours de devoirs, tâche « Préparer les devoirs », profil de l'enfant, pages d'exercices ; US-118 RF7, US-119 RF1/RF11/RT1, US-180),
-- fichier 1/4 : STRUCTURE. Pour une base qui a déjà reçu le lot 10 (jusqu'à rattrapage_lot_10_annuel_2_schema.sql, D70) et le lot 0 à 9 ; indépendant des lots 11 à 14. Une base neuve applique le lot_10_2 régénéré
-- et n'a besoin d'aucun de ces quatre fichiers. Ordre : 1 (structure), 2 (passage à blanc de la reprise, sans écriture), 3 (reprise unique), 4 (contraintes, qui supposent la reprise faite). Idempotents.
--  1. family_settings.homework_days ; la série « Préparer les devoirs » (source homework_prep) prend toujours ces jours (trigger) ; un changement retire les occurrences à venir des jours décochés dès le lendemain.
--  2. family_members.child_profile_user_id (profil de l'enfant, porté par la fiche enfant), family_member_of_profile(), profile_is_child_linked(), fiche « autre » masquée (family_member_is_hidden(), gardes, v_family_members_listed).
--  3. Fonctions REMPLACÉES : family_events_visible_to(), family_tasks_visible_to(), can_check_family_task(), change_family_task_status(), family_event_notice_recipients() (membre du profil = fiche enfant pour un enfant ;
--     RDV de toute la famille retirés pour son profil ; il ne coche pas la tâche des devoirs), erase_member_homework_data(), erase_family_homework_progress(), purge_expired_homework_data() (pages d'exercices),
--     family_settings_homework_before_write() (jours rangés).
--  4. Lecture seule du profil d'un enfant sur les données Devoirs (gardes) et homework_child_items_for() (éléments du jour sans corrigé).
--  5. Pages d'exercices : type homework_question_form, homework_exercise_pages, homework_exercise_page_answers (fiche réponse lisible des seuls parents, sécurité par ligne), fonctions de lecture, réglage de console homework_page_retention_months.

-- Type : formes de question (liste fermée)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'homework_question_form') THEN
    CREATE TYPE homework_question_form AS ENUM ('multiple_choice', 'true_false', 'true_false_correction', 'equations_to_complete', 'fill_in_blanks',
                                               'matching', 'ordering', 'problem', 'written_answer');
  END IF;
END $$;

-- 1. Jours de devoirs
ALTER TABLE family_settings ADD COLUMN IF NOT EXISTS homework_days smallint[] NOT NULL DEFAULT ARRAY[1, 2, 4, 5]::smallint[];
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_family_settings_homework_days' AND conrelid = 'family_settings'::regclass) THEN
    ALTER TABLE family_settings ADD CONSTRAINT ck_family_settings_homework_days CHECK (iso_weekdays_valid(homework_days));
  END IF;
END $$;
COMMENT ON COLUMN family_settings.homework_days IS $$Jours de devoirs du foyer (1 = lundi … 7 = dimanche, sans doublon, au moins un) : lundi, mardi, jeudi et vendredi au départ. Réglage familial, modifiable par les deux parents, lisible en lecture seule par les invités secondaires. La tâche « Préparer les devoirs » revient ces jours-là : la base aligne les jours de sa série sur ce réglage (trigger) et retire les occurrences à venir des jours décochés dès le lendemain. Stocké trié. [US-118 RF7, US-119 RF1, D71 S-30]$$;

CREATE OR REPLACE FUNCTION family_settings_homework_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Jours de devoirs rangés dans l'ordre (la validité est contrôlée par ck_family_settings_homework_days)
  IF NEW.homework_days IS NOT NULL THEN
    NEW.homework_days := ARRAY(SELECT d FROM unnest(NEW.homework_days) d ORDER BY d);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.homework_help_enabled AND NOT NEW.homework_help_enabled THEN
    NEW.homework_help_disabled_at := now();
  END IF;
  IF NEW.homework_help_enabled AND (TG_OP = 'INSERT' OR NOT OLD.homework_help_enabled) THEN
    NEW.homework_help_disabled_at := NULL;
    IF NOT EXISTS (SELECT 1 FROM family_members m WHERE m.account_id = NEW.account_id AND m.role = 'child' AND m.archived_at IS NULL) THEN
      RAISE EXCEPTION 'L''aide Devoirs demande au moins un membre enfant dans la famille' USING ERRCODE = 'check_violation';
    END IF;
    NEW.homework_help_first_enabled_at := COALESCE(NEW.homework_help_first_enabled_at, now());
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION family_task_series_homework_prep_days() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.weekdays := COALESCE((SELECT st.homework_days FROM family_settings st WHERE st.account_id = NEW.account_id), ARRAY[1, 2, 4, 5]::smallint[]);
  RETURN NEW;
END $$;
COMMENT ON FUNCTION family_task_series_homework_prep_days() IS $$Aligne les jours de la série « Préparer les devoirs » (source homework_prep) sur les jours de devoirs du foyer (family_settings.homework_days ; lundi, mardi, jeudi, vendredi sans réglage) à chaque écriture. [US-118 RF7, US-119 RF1, D71 S-30]$$;

DROP TRIGGER IF EXISTS trg_family_task_series_homework_prep ON family_task_series;
CREATE TRIGGER trg_family_task_series_homework_prep BEFORE INSERT OR UPDATE ON family_task_series
  FOR EACH ROW WHEN (NEW.source = 'homework_prep') EXECUTE FUNCTION family_task_series_homework_prep_days();

CREATE OR REPLACE FUNCTION family_settings_homework_days_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_today date;
BEGIN
  SELECT (now() AT TIME ZONE a.family_timezone)::date INTO v_today FROM accounts a WHERE a.id = NEW.account_id;
  v_today := COALESCE(v_today, current_date);
  UPDATE family_task_series s
     SET weekdays = NEW.homework_days, materialized_until = LEAST(s.materialized_until, v_today)
   WHERE s.account_id = NEW.account_id AND s.source = 'homework_prep' AND s.ended_at IS NULL;
  DELETE FROM family_tasks t USING family_task_series s
   WHERE t.series_id = s.id AND s.account_id = NEW.account_id AND s.source = 'homework_prep' AND s.ended_at IS NULL
     AND t.status IN ('proposed', 'todo') AND t.due_date > v_today
     AND NOT (date_part('isodow', t.due_date)::smallint = ANY (NEW.homework_days));
  RETURN NULL;
END $$;
COMMENT ON FUNCTION family_settings_homework_days_changed() IS $$Applique un changement des jours de devoirs à la série « Préparer les devoirs » du foyer, dès le lendemain : nouveaux jours dans la série, occurrences à venir des jours décochés supprimées (les faites et les passées restent), date de création des occurrences ramenée à aujourd'hui pour que le planificateur crée les jours ajoutés. [US-118 RF7, D71 S-30]$$;

DROP TRIGGER IF EXISTS trg_family_settings_homework_days ON family_settings;
CREATE TRIGGER trg_family_settings_homework_days AFTER UPDATE OF homework_days ON family_settings
  FOR EACH ROW WHEN (OLD.homework_days IS DISTINCT FROM NEW.homework_days) EXECUTE FUNCTION family_settings_homework_days_changed();

-- 2. Profil de l'enfant, porté par la fiche enfant
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS child_profile_user_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_family_members_child_profile' AND conrelid = 'family_members'::regclass) THEN
    ALTER TABLE family_members
      ADD CONSTRAINT fk_family_members_child_profile FOREIGN KEY (child_profile_user_id, account_id)
        REFERENCES users (id, account_id) ON DELETE SET NULL (child_profile_user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_family_members_child_profile' AND conrelid = 'family_members'::regclass) THEN
    ALTER TABLE family_members
      ADD CONSTRAINT ck_family_members_child_profile CHECK (child_profile_user_id IS NULL
        OR (role = 'child' AND user_id IS NULL AND archived_at IS NULL AND anonymized_at IS NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ux_family_members_child_profile ON family_members (child_profile_user_id) WHERE child_profile_user_id IS NOT NULL;
COMMENT ON COLUMN family_members.child_profile_user_id IS $$Profil de l'enfant : profil d'invité secondaire de l'enfant, porté par sa fiche enfant (rôle enfant, non liée à un profil par user_id). Unique, du même foyer, remis à vide à la suppression du profil sans anonymiser la fiche, et à vide si la fiche cesse d'être une fiche enfant active. Le membre du profil est alors cette fiche enfant (family_member_of_profile) et sa fiche « autre » est masquée. Sans lien avec l'âge des devoirs. [D73 S-38, S-39]$$;

CREATE OR REPLACE FUNCTION family_member_child_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- La fiche cesse d'être une fiche enfant active : le lien tombe, sans erreur
  IF TG_OP = 'UPDATE' AND NEW.child_profile_user_id IS NOT NULL AND NEW.child_profile_user_id IS NOT DISTINCT FROM OLD.child_profile_user_id
     AND (NEW.role <> 'child' OR NEW.archived_at IS NOT NULL OR NEW.anonymized_at IS NOT NULL) THEN
    NEW.child_profile_user_id := NULL;
  END IF;
  IF NEW.child_profile_user_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.child_profile_user_id IS DISTINCT FROM OLD.child_profile_user_id) THEN
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.child_profile_user_id AND u.account_id = NEW.account_id AND u.role = 'guest' AND u.guest_rank = 'secondary') THEN
      RAISE EXCEPTION 'Le profil d''un enfant est un invité secondaire du même foyer' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION family_member_child_profile_guard() IS $$Le profil relié à une fiche enfant est un invité secondaire du même foyer ; le lien tombe quand la fiche cesse d'être une fiche enfant active (changement de rôle, retrait, effacement). [D73 S-38]$$;

DROP TRIGGER IF EXISTS trg_family_members_child_profile ON family_members;
CREATE TRIGGER trg_family_members_child_profile BEFORE INSERT OR UPDATE ON family_members
  FOR EACH ROW EXECUTE FUNCTION family_member_child_profile_guard();

CREATE OR REPLACE FUNCTION family_member_of_profile(p_user uuid) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN COALESCE((SELECT c.id FROM family_members c WHERE c.child_profile_user_id = p_user),
                  (SELECT m.id FROM family_members m WHERE m.user_id = p_user));
END $$;
COMMENT ON FUNCTION family_member_of_profile(uuid) IS $$Membre d'un profil : la fiche enfant à laquelle il est relié (family_members.child_profile_user_id) s'il est le profil d'un enfant, sinon sa propre fiche (créée avec lui). Règle unique pour la visibilité des RDV et des tâches, le droit de cocher et les destinataires des notifications. NULL si le profil n'a pas de fiche. [US-92, D73 S-38, S-39]$$;

CREATE OR REPLACE FUNCTION profile_is_child_linked(p_user uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM family_members c WHERE c.child_profile_user_id = p_user);
END $$;
COMMENT ON FUNCTION profile_is_child_linked(uuid) IS $$Vrai si le profil est celui d'un enfant (relié à une fiche enfant). Ce profil ne voit pas les RDV de toute la famille, ne coche pas la tâche des devoirs, ne modifie pas ses éléments de devoirs et n'a pas le tchat de l'Assistant Famille (ce dernier point est tenu par l'application). [D73 S-38, S-40, S-45, S-47]$$;

CREATE OR REPLACE FUNCTION family_member_is_hidden(p_member uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM family_members o JOIN family_members c ON c.child_profile_user_id = o.user_id AND c.account_id = o.account_id WHERE o.id = p_member)
$$;
COMMENT ON FUNCTION family_member_is_hidden(uuid) IS $$Vrai si la fiche est la fiche « autre » du profil d'un enfant (profil relié à une fiche enfant) : elle est masquée dans les membres, les RDV et l'assignation des tâches. [D73 S-39]$$;

CREATE OR REPLACE FUNCTION family_member_not_hidden_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_member uuid;
BEGIN
  v_member := NULLIF(to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid;
  IF v_member IS NOT NULL AND family_member_is_hidden(v_member) THEN
    RAISE EXCEPTION 'La fiche « autre » du profil d''un enfant est masquée : utilisez sa fiche enfant' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION family_member_not_hidden_guard() IS $$Refuse qu'une écriture vise la fiche « autre » masquée du profil d'un enfant (participant d'un RDV ou d'une série, tâche ou série de tâches assignée). Le nom de la colonne vient de l'argument du trigger. [D73 S-39]$$;

DROP TRIGGER IF EXISTS trg_family_event_members_not_hidden ON family_event_members;
CREATE TRIGGER trg_family_event_members_not_hidden BEFORE INSERT OR UPDATE OF member_id ON family_event_members
  FOR EACH ROW EXECUTE FUNCTION family_member_not_hidden_guard('member_id');
DROP TRIGGER IF EXISTS trg_family_event_series_members_not_hidden ON family_event_series_members;
CREATE TRIGGER trg_family_event_series_members_not_hidden BEFORE INSERT OR UPDATE OF member_id ON family_event_series_members
  FOR EACH ROW EXECUTE FUNCTION family_member_not_hidden_guard('member_id');
DROP TRIGGER IF EXISTS trg_family_tasks_not_hidden ON family_tasks;
CREATE TRIGGER trg_family_tasks_not_hidden BEFORE INSERT OR UPDATE OF assigned_member_id ON family_tasks
  FOR EACH ROW EXECUTE FUNCTION family_member_not_hidden_guard('assigned_member_id');
DROP TRIGGER IF EXISTS trg_family_task_series_not_hidden ON family_task_series;
CREATE TRIGGER trg_family_task_series_not_hidden BEFORE INSERT OR UPDATE OF assigned_member_id ON family_task_series
  FOR EACH ROW EXECUTE FUNCTION family_member_not_hidden_guard('assigned_member_id');

CREATE OR REPLACE VIEW v_family_members_listed AS
SELECT m.* FROM family_members m WHERE NOT family_member_is_hidden(m.id);
COMMENT ON VIEW v_family_members_listed IS $$Membres du foyer à afficher et à proposer : family_members sans la fiche « autre » du profil d'un enfant, masquée (D73 S-39).$$;

-- 4. Lecture seule du profil d'un enfant, éléments du jour sans corrigé
CREATE OR REPLACE FUNCTION homework_child_read_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF profile_is_child_linked(app_current_user_id()) THEN
    RAISE EXCEPTION 'Le profil d''un enfant lit ses devoirs, il ne les modifie pas' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
COMMENT ON FUNCTION homework_child_read_only_guard() IS $$Refuse toute écriture sur les données Devoirs quand le profil indiqué par l'application (app.user_id) est celui d'un enfant : il ne coche pas ses éléments, ne déplace rien, ne change pas son âge des devoirs. Sans profil indiqué (traitements du serveur, suppressions en cascade), la règle ne joue pas. [D73 S-40]$$;

DROP TRIGGER IF EXISTS trg_homework_weeks_child_read_only ON homework_weeks;
CREATE TRIGGER trg_homework_weeks_child_read_only BEFORE INSERT OR UPDATE OR DELETE ON homework_weeks
  FOR EACH ROW EXECUTE FUNCTION homework_child_read_only_guard();
DROP TRIGGER IF EXISTS trg_homework_items_child_read_only ON homework_week_items;
CREATE TRIGGER trg_homework_items_child_read_only BEFORE INSERT OR UPDATE OR DELETE ON homework_week_items
  FOR EACH ROW EXECUTE FUNCTION homework_child_read_only_guard();
DROP TRIGGER IF EXISTS trg_homework_foreign_books_child_read_only ON homework_week_foreign_books;
CREATE TRIGGER trg_homework_foreign_books_child_read_only BEFORE INSERT OR UPDATE OR DELETE ON homework_week_foreign_books
  FOR EACH ROW EXECUTE FUNCTION homework_child_read_only_guard();
DROP TRIGGER IF EXISTS trg_homework_validations_child_read_only ON homework_exercise_validations;
CREATE TRIGGER trg_homework_validations_child_read_only BEFORE INSERT OR UPDATE OR DELETE ON homework_exercise_validations
  FOR EACH ROW EXECUTE FUNCTION homework_child_read_only_guard();
DROP TRIGGER IF EXISTS trg_homework_children_child_read_only ON homework_children;
CREATE TRIGGER trg_homework_children_child_read_only BEFORE INSERT OR UPDATE OR DELETE ON homework_children
  FOR EACH ROW EXECUTE FUNCTION homework_child_read_only_guard();
CREATE OR REPLACE FUNCTION homework_child_items_for(p_viewer uuid, p_day date)
RETURNS TABLE (it_id bigint, it_day date, it_exercise_id bigint, it_activity_id bigint, it_textbook_key text, it_level homework_level, it_number integer,
               it_theme text, it_statement text, it_activity_title text, it_activity_description text, it_activity_steps text, it_activity_materials text,
               it_needs_adult boolean, it_custom_title bytea, it_checked_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT i.id, i.day, i.exercise_id, i.activity_id, e.textbook_key, e.level, e.number, e.theme::text, e.statement,
         a.title::text, a.description, a.steps, a.materials, a.needs_adult, i.custom_title, i.checked_at
    FROM family_members c
    JOIN family_settings st ON st.account_id = c.account_id AND st.homework_help_enabled
    JOIN homework_week_items i ON i.member_id = c.id AND i.account_id = c.account_id
    LEFT JOIN homework_exercises e ON e.id = i.exercise_id
    LEFT JOIN homework_activities a ON a.id = i.activity_id
   WHERE c.child_profile_user_id = p_viewer AND i.day = p_day
$$;
COMMENT ON FUNCTION homework_child_items_for(uuid, date) IS $$Éléments de devoirs du jour de l'enfant dont le profil est indiqué (exercices du catalogue avec leur énoncé, activités avec leurs étapes, activités libres du parent, case cochée), SANS le corrigé. Rien pour un autre profil, ni quand l'aide Devoirs est désactivée. Le jour est la date locale de la famille, passée par l'application. [US-119 RF4, D73 S-40]$$;


-- 5. Pages d'exercices
CREATE OR REPLACE FUNCTION homework_question_forms_valid(p_forms homework_question_form[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(cardinality(p_forms) BETWEEN 1 AND 9 AND (SELECT count(DISTINCT f) FROM unnest(p_forms) f) = cardinality(p_forms), false)
$$;
COMMENT ON FUNCTION homework_question_forms_valid(homework_question_form[]) IS $$Vrai si la liste des formes de question d'une page est non vide et sans doublon (1 à 9 formes de la liste fermée). [US-180 RF3, D72 S-42]$$;

CREATE TABLE IF NOT EXISTS homework_exercise_pages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  member_id           uuid NOT NULL,
  -- Profil qui a demandé la page : le parent, ou l'enfant lui-même par son profil ; vide si ce profil est supprimé
  created_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Thème, matière et niveau repérés par le modèle, CHIFFRÉS par l'application comme tous les textes saisis (D72)
  theme               bytea NOT NULL CHECK (octet_length(theme) BETWEEN 1 AND 2000),
  subject             bytea NOT NULL CHECK (octet_length(subject) BETWEEN 1 AND 1000),
  level               bytea NOT NULL CHECK (octet_length(level) BETWEEN 1 AND 1000),
  -- Formes de question de la page, liste fermée (QCM, vrai/faux, texte à trous…) : métadonnée sans contenu, utile aux statistiques de la console et au contrôle de la page
  question_forms      homework_question_form[] NOT NULL CHECK (homework_question_forms_valid(question_forms)),
  -- Les 3 exercices dans l'ordre facile, moyen, difficile, en données structurées CHIFFRÉES par l'application (énoncés seuls ; le contrôle du contenu est fait par le code, US-180 RT1)
  exercises           bytea NOT NULL CHECK (octet_length(exercises) BETWEEN 1 AND 200000),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_homework_pages_child FOREIGN KEY (member_id, account_id)
    REFERENCES homework_children (member_id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_homework_pages_member ON homework_exercise_pages (member_id, account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_homework_pages_account ON homework_exercise_pages (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_homework_pages_created ON homework_exercise_pages (created_at);
CREATE INDEX IF NOT EXISTS idx_homework_pages_created_by ON homework_exercise_pages (created_by_user_id);
COMMENT ON TABLE homework_exercise_pages IS $$Pages d'exercices créées à partir d'une leçon (3 exercices : facile, moyen, difficile), rattachées à un membre enfant suivi par l'aide Devoirs et à son foyer, avec le profil qui les a créées. Thème, matière, niveau et exercices chiffrés par l'application. Sans photo ni prénom. Lue par les parents du foyer et par l'enfant (par son profil) pour ses seules pages ; la fiche réponse est dans homework_exercise_page_answers, lue des seuls parents. Supprimée 12 mois après sa création, avec le membre, à l'effacement des progrès de Devoirs et avec le compte. Donnée de mineur, incluse dans l'export de la famille. [US-180 RF4 à RF7, RT4, RT5, D71 S-35, S-36, D72 S-42]$$;
COMMENT ON COLUMN homework_exercise_pages.member_id IS $$Membre enfant (fiche enfant) pour qui la page est créée (il a un âge des devoirs) : la page disparaît avec son suivi Devoirs (retrait ou effacement du membre, effacement des âges). [US-180 RT4, RT5]$$;
COMMENT ON COLUMN homework_exercise_pages.created_by_user_id IS $$Profil qui a demandé la page : un parent du foyer, ou l'enfant lui-même par son profil (contrôlé à l'écriture). Vide si ce profil est supprimé. Compte dans le plafond quotidien de ce profil. [US-180 RF10, RT4]$$;
COMMENT ON COLUMN homework_exercise_pages.theme IS $$Thème de la leçon repéré par le modèle, chiffré par l'application, affiché dans « Exercices — [thème] » et dans le dossier des parents (« Les fractions — 10/11/2026 »). Aucune donnée personnelle : le modèle ne reçoit jamais le prénom (US-180 RT2). [US-180 RF3, RF7]$$;
COMMENT ON COLUMN homework_exercise_pages.subject IS $$Matière repérée par le modèle (maths, français, histoire…), texte libre court, chiffré par l'application. [US-180 RF3, RT4]$$;
COMMENT ON COLUMN homework_exercise_pages.level IS $$Niveau de la leçon repéré par le modèle (CP, CE2, CM1…), texte libre court chiffré par l'application : distinct de l'âge des devoirs de l'enfant. [US-180 RF3, RT4]$$;
COMMENT ON COLUMN homework_exercise_pages.question_forms IS $$Formes de question utilisées par la page, dans la liste fermée homework_question_form (QCM, vrai/faux, vrai/faux avec correction, égalités à compléter, texte à trous, éléments à relier, ranger, problème, réponse rédigée), sans doublon. Posée par l'application après son contrôle de la page. [US-180 RF3, RT1, D72 S-42]$$;
COMMENT ON COLUMN homework_exercise_pages.exercises IS $$Les 3 exercices dans l'ordre facile, moyen, difficile, en données structurées chiffrées par l'application (consigne, questions, cases, lignes d'écriture) que l'application met en forme avec la charte de MAAQ. Énoncés seuls : jamais de réponse ici. 200 000 octets au plus. [US-180 RF3, RF5, RT1, RT4]$$;

CREATE TABLE IF NOT EXISTS homework_exercise_page_answers (
  page_id        uuid PRIMARY KEY,
  account_id     uuid NOT NULL,
  -- Bonnes réponses, correction des phrases fausses, réponse type des réponses rédigées (« Toute réponse proche est acceptée »), chiffrées par l'application
  answers        bytea NOT NULL CHECK (octet_length(answers) BETWEEN 1 AND 200000),
  -- Barème sur 20 points (facile < moyen < difficile ; le total exact est contrôlé par le code, US-180 RT1), chiffré par l'application
  grading_scale  bytea NOT NULL CHECK (octet_length(grading_scale) BETWEEN 1 AND 20000),
  CONSTRAINT fk_homework_answers_page FOREIGN KEY (page_id, account_id)
    REFERENCES homework_exercise_pages (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_homework_answers_account ON homework_exercise_page_answers (account_id);
COMMENT ON TABLE homework_exercise_page_answers IS $$Fiche réponse et barème d'une page d'exercices, « pour l'adulte qui corrige », chiffrés. Lue des seuls parents du foyer, y compris par la sécurité par ligne : l'enfant ne la voit jamais (même pour ses propres pages), il peut seulement l'écrire pour la page qu'il crée. Une page a toujours sa fiche (contrôle différé). Supprimée avec sa page. [US-180 RF4, RT4, D71 S-36]$$;
COMMENT ON COLUMN homework_exercise_page_answers.page_id IS $$Page d'exercices à laquelle appartient la fiche (une fiche par page) : supprimée avec elle. [US-180 RT4]$$;
COMMENT ON COLUMN homework_exercise_page_answers.answers IS $$Bonnes réponses de chaque question, correction des phrases fausses et réponse type des réponses rédigées, en données structurées chiffrées par l'application. Jamais renvoyée à un profil qui n'est pas un parent. [US-180 RF4, RT4]$$;
COMMENT ON COLUMN homework_exercise_page_answers.grading_scale IS $$Barème sur 20 points (facile < moyen < difficile), en données structurées chiffrées par l'application. [US-180 RF4, RT1]$$;

CREATE OR REPLACE FUNCTION homework_pages_access(p_user uuid, p_account uuid, p_member uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN u.role = 'primary_user' OR (u.role = 'guest' AND u.guest_rank = 'core') THEN 'parent'
           WHEN u.role = 'guest' AND u.guest_rank = 'secondary' AND p_member IS NOT NULL
                AND EXISTS (SELECT 1 FROM family_members c
                              JOIN homework_children hc ON hc.member_id = c.id AND hc.account_id = c.account_id
                              JOIN family_settings st ON st.account_id = c.account_id AND st.homework_help_enabled
                             WHERE c.child_profile_user_id = u.id AND c.id = p_member AND c.account_id = u.account_id)
           THEN 'child'
         END
    FROM users u
   WHERE u.id = p_user AND u.account_id = p_account AND u.status IN ('active', 'grace_period')
$$;
COMMENT ON FUNCTION homework_pages_access(uuid, uuid, uuid) IS $$Droit d'un profil sur les pages d'exercices d'un foyer et d'un membre enfant : parent (utilisateur principal et invité 1), child (profil de cet enfant, relié à sa fiche enfant qui a un âge des devoirs, aide activée) ou NULL. Sert aux règles de sécurité par ligne et aux fonctions de lecture. [US-180 RF1, RF5, RF7, RT4, D71 S-34, S-36, D73]$$;

CREATE OR REPLACE FUNCTION homework_exercise_pages_visible_to(p_viewer uuid) RETURNS SETOF homework_exercise_pages
LANGUAGE sql STABLE AS $$
  SELECT p.* FROM homework_exercise_pages p WHERE homework_pages_access(p_viewer, p.account_id, p.member_id) IS NOT NULL
$$;
COMMENT ON FUNCTION homework_exercise_pages_visible_to(uuid) IS $$Pages d'exercices lisibles par un profil : toutes celles de son foyer pour un parent, celles de l'enfant relié à son profil pour un profil d'enfant (la fiche réponse n'en fait pas partie). La limite des 30 derniers jours de « Mes exercices » est un affichage de l'application. [US-180 RF5, RF7, RT4]$$;

CREATE OR REPLACE FUNCTION homework_exercise_answers_visible_to(p_viewer uuid) RETURNS SETOF homework_exercise_page_answers
LANGUAGE sql STABLE AS $$
  SELECT a.* FROM homework_exercise_page_answers a WHERE homework_pages_access(p_viewer, a.account_id, NULL) = 'parent'
$$;
COMMENT ON FUNCTION homework_exercise_answers_visible_to(uuid) IS $$Fiches réponse et barèmes lisibles par un profil : ceux de son foyer pour un parent (utilisateur principal et invité 1), aucun pour un profil d'enfant, y compris l'enfant à qui appartient la page. [US-180 RF4, RT4, D71 S-36]$$;

CREATE OR REPLACE FUNCTION homework_page_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by_user_id IS NOT NULL AND homework_pages_access(NEW.created_by_user_id, NEW.account_id, NEW.member_id) IS NULL THEN
    RAISE EXCEPTION 'Une page d''exercices est créée par un parent du foyer ou par l''enfant lui-même' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION homework_page_before_insert() IS $$Refuse une page d'exercices dont le profil créateur n'est ni un parent du foyer ni le profil de l'enfant concerné. [US-180 RF1, RT4]$$;

DROP TRIGGER IF EXISTS trg_homework_pages_before_insert ON homework_exercise_pages;
CREATE TRIGGER trg_homework_pages_before_insert BEFORE INSERT ON homework_exercise_pages
  FOR EACH ROW EXECUTE FUNCTION homework_page_before_insert();

CREATE OR REPLACE FUNCTION homework_page_needs_answers() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM homework_exercise_pages p WHERE p.id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM homework_exercise_page_answers a WHERE a.page_id = NEW.id) THEN
    RAISE EXCEPTION 'Une page d''exercices demande sa fiche réponse et son barème' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
COMMENT ON FUNCTION homework_page_needs_answers() IS $$Contrôle différé : une page d'exercices créée a sa fiche réponse et son barème à la fin de la transaction. Exécutée avec les droits du propriétaire (l'enfant qui crée sa page ne lit pas la fiche). [US-180 RT1, RT4]$$;

DROP TRIGGER IF EXISTS trg_homework_pages_needs_answers ON homework_exercise_pages;
CREATE CONSTRAINT TRIGGER trg_homework_pages_needs_answers AFTER INSERT ON homework_exercise_pages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION homework_page_needs_answers();

ALTER TABLE homework_exercise_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS homework_pages_read ON homework_exercise_pages;
CREATE POLICY homework_pages_read ON homework_exercise_pages FOR SELECT
  USING (homework_pages_access((SELECT app_current_user_id()), account_id, member_id) IS NOT NULL);
DROP POLICY IF EXISTS homework_pages_insert ON homework_exercise_pages;
CREATE POLICY homework_pages_insert ON homework_exercise_pages FOR INSERT
  WITH CHECK (created_by_user_id = (SELECT app_current_user_id())
              AND homework_pages_access((SELECT app_current_user_id()), account_id, member_id) IS NOT NULL);
DROP POLICY IF EXISTS homework_pages_delete ON homework_exercise_pages;
CREATE POLICY homework_pages_delete ON homework_exercise_pages FOR DELETE
  USING (homework_pages_access((SELECT app_current_user_id()), account_id, member_id) = 'parent');
ALTER TABLE homework_exercise_page_answers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS homework_answers_read ON homework_exercise_page_answers;
CREATE POLICY homework_answers_read ON homework_exercise_page_answers FOR SELECT
  USING (homework_pages_access((SELECT app_current_user_id()), account_id, NULL) = 'parent');
DROP POLICY IF EXISTS homework_answers_insert ON homework_exercise_page_answers;
CREATE POLICY homework_answers_insert ON homework_exercise_page_answers FOR INSERT
  WITH CHECK (homework_pages_access((SELECT app_current_user_id()), account_id, NULL) = 'parent'
              OR EXISTS (SELECT 1 FROM homework_exercise_pages p
                          WHERE p.id = homework_exercise_page_answers.page_id AND p.account_id = homework_exercise_page_answers.account_id
                            AND p.created_by_user_id = (SELECT app_current_user_id())));
DROP POLICY IF EXISTS homework_answers_delete ON homework_exercise_page_answers;
CREATE POLICY homework_answers_delete ON homework_exercise_page_answers FOR DELETE
  USING (homework_pages_access((SELECT app_current_user_id()), account_id, NULL) = 'parent');

INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('homework_page_retention_months', 'integer', '12', 1, NULL, $$Conservation d'une page d'exercices créée à partir d'une leçon (avec sa fiche réponse), en mois après sa création (US-180 RT5, D71 S-35, avis du DPO à venir)$$)
ON CONFLICT (setting_key) DO NOTHING;

-- 3. Fonctions de socle et de purge REMPLACÉES (après les tables et fonctions d'aide qu'elles citent)
CREATE OR REPLACE FUNCTION homework_prep_task_visible_to(p_user uuid, p_account uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM family_members c
                   JOIN homework_children hc ON hc.member_id = c.id AND hc.account_id = c.account_id
                   JOIN family_settings st ON st.account_id = c.account_id AND st.homework_help_enabled
                  WHERE c.child_profile_user_id = p_user AND c.account_id = p_account);
END $$;
COMMENT ON FUNCTION homework_prep_task_visible_to(uuid, uuid) IS $$Vrai si le profil est celui d'un enfant (relié à une fiche enfant) qui a un âge des devoirs et que l'aide Devoirs est activée pour le foyer : il voit alors la tâche « Préparer les devoirs » sans qu'elle lui soit assignée. [US-119 RF1 et RT1, D71 S-31, D73]$$;

CREATE OR REPLACE FUNCTION family_events_visible_to(p_viewer uuid) RETURNS SETOF family_events
LANGUAGE sql STABLE AS $$
  SELECT e.*
    FROM family_events e
    JOIN users v ON v.id = p_viewer AND v.account_id = e.account_id
   WHERE e.status IN ('provisional', 'set_aside', 'confirmed')
     AND ( v.role = 'primary_user' OR v.guest_rank = 'core'
        OR (e.whole_family AND NOT profile_is_child_linked(v.id))
        OR e.requested_by_user_id = v.id
        OR EXISTS (SELECT 1 FROM family_event_members m
                    WHERE m.event_id = e.id AND m.member_id = family_member_of_profile(v.id)) )
$$;
COMMENT ON FUNCTION family_events_visible_to(uuid) IS $$RDV visibles par un profil selon son rang (décision D26). Un profil relié à une fiche enfant ne voit que les RDV dont la fiche enfant est participante, jamais ceux de toute la famille (D73 S-45). [US-78, 79]$$;

CREATE OR REPLACE FUNCTION family_tasks_visible_to(p_viewer uuid) RETURNS SETOF family_tasks
LANGUAGE sql STABLE AS $$
  -- D71, D73 : membre du profil = fiche enfant pour un enfant ; la tâche des devoirs est vue de son profil (homework_prep_task_visible_to)
  SELECT t.*
    FROM family_tasks t
    JOIN users v ON v.id = p_viewer AND v.account_id = t.account_id
   WHERE t.status <> 'cancelled'
     AND ( v.role = 'primary_user' OR v.guest_rank = 'core'
        OR ( t.status <> 'proposed'
             AND ( t.created_by_user_id = v.id
                OR t.assigned_member_id = family_member_of_profile(v.id)
                OR t.event_id IN (SELECT id FROM family_events_visible_to(p_viewer))
                OR ( t.source = 'homework_prep' AND homework_prep_task_visible_to(v.id, t.account_id) ) ) )
        OR ( t.status = 'proposed'
             AND EXISTS (SELECT 1 FROM family_events e WHERE e.id = t.event_id AND e.requested_by_user_id = v.id) ) )
$$;
COMMENT ON FUNCTION family_tasks_visible_to(uuid) IS $$Tâches visibles par un profil selon son rang (décision D26, AT-2). Les tâches assignées sont celles de la fiche du profil (la fiche enfant pour un enfant). Exception D71 : la tâche « Préparer les devoirs » est visible du profil d'un enfant qui a un âge des devoirs, tant que l'aide Devoirs est activée. [US-110, US-96, US-119 RF1 et RT1, D71 S-31, D73]$$;

CREATE OR REPLACE FUNCTION can_check_family_task(p_user_id uuid, p_task_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (can_manage_family_task(p_user_id, p_task_id)
          OR EXISTS (SELECT 1 FROM family_tasks t WHERE t.id = p_task_id AND t.assigned_member_id = family_member_of_profile(p_user_id)))
     AND NOT EXISTS (SELECT 1 FROM family_tasks t WHERE t.id = p_task_id AND t.source = 'homework_prep' AND profile_is_child_linked(p_user_id))
$$;
COMMENT ON FUNCTION can_check_family_task(uuid, uuid) IS $$Vrai si le profil peut cocher cette tâche (parents : toutes ; invité secondaire : ses créations et les tâches qui lui sont assignées, celles de la fiche enfant pour un enfant). Le profil d'un enfant ne coche jamais la tâche « Préparer les devoirs » (D73 S-40) mais garde ses tâches à lui (S-46). [AT-2]$$;

CREATE OR REPLACE FUNCTION change_family_task_status(
  p_task_id uuid, p_to task_status, p_user_id uuid,
  p_expected_version integer DEFAULT NULL, p_cancel_reason task_cancel_reason DEFAULT 'user'
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_task family_tasks%ROWTYPE; v_member uuid;
BEGIN
  SELECT * INTO v_task FROM family_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_task.source = 'homework_prep' AND profile_is_child_linked(p_user_id) THEN
    RAISE EXCEPTION 'Le profil d''un enfant ne change pas l''état de la tâche des devoirs' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_expected_version IS NOT NULL AND v_task.version <> p_expected_version THEN RETURN false; END IF;
  IF NOT family_task_transition_allowed(v_task.status, p_to) THEN RETURN false; END IF;
  IF p_to = 'done' THEN
    v_member := family_member_of_profile(p_user_id);
    IF v_member IS NULL OR NOT EXISTS (SELECT 1 FROM family_members WHERE id = v_member AND account_id = v_task.account_id) THEN
      RAISE EXCEPTION 'Ce profil n''a pas de membre : impossible de cocher la tâche' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE family_tasks
     SET status = p_to,
         status_changed_by_user_id = p_user_id,
         done_at = CASE WHEN p_to = 'done' THEN now() END,
         done_by_member_id = CASE WHEN p_to = 'done' THEN v_member END,
         cancel_reason = CASE WHEN p_to = 'cancelled' THEN p_cancel_reason END
   WHERE id = p_task_id;
  RETURN true;
END $$;
COMMENT ON FUNCTION change_family_task_status(uuid, task_status, uuid, integer, task_cancel_reason) IS $$Change le statut d'une tâche de façon atomique (transition permise, version attendue) ; « faite par » = membre du profil (la fiche enfant pour un enfant). false = introuvable, modifiée ou transition interdite. Le profil d'un enfant ne change jamais l'état de la tâche « Préparer les devoirs » (erreur insufficient_privilege, D73 S-40). [US-110 RF7, AT-1]$$;

CREATE OR REPLACE FUNCTION family_event_notice_recipients(p_event_id uuid, p_kind notification_kind)
RETURNS TABLE (user_id uuid, has_device boolean) LANGUAGE plpgsql STABLE AS $$
DECLARE v_e family_events%ROWTYPE; v_activation timestamptz; v_delay integer;
BEGIN
  IF p_kind NOT IN ('event_added', 'event_to_confirm') THEN
    RAISE EXCEPTION 'Type de notification non géré : %', p_kind USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_e FROM family_events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN; END IF;
  -- RDV créé depuis une idée de sortie : le parent l'a voulu en connaissance de cause, l'autre parent n'est pas notifié (US-120 RF5, D64 S-06)
  IF v_e.source = 'outing' THEN RETURN; END IF;
  v_activation := platform_setting_timestamp('event_notice_activation_at');
  IF v_activation IS NULL OR v_e.created_at < v_activation THEN RETURN; END IF;
  IF (p_kind = 'event_to_confirm' AND v_e.status <> 'provisional') OR (p_kind = 'event_added' AND v_e.status <> 'confirmed') THEN
    RETURN;
  END IF;
  SELECT COALESCE(value_text::integer, 10) INTO v_delay FROM platform_settings WHERE setting_key = 'event_notice_delay_minutes';
  RETURN QUERY
  SELECT u.id,
         EXISTS (SELECT 1 FROM devices d JOIN push_subscriptions ps ON ps.device_id = d.id
                  WHERE d.user_id = u.id AND d.revoked_at IS NULL)
    FROM users u
   WHERE u.account_id = v_e.account_id AND u.status = 'active' AND u.role <> 'admin'
     AND u.id IS DISTINCT FROM v_e.requested_by_user_id
     AND u.id IS DISTINCT FROM v_e.confirmed_by_user_id
     AND COALESCE((SELECT s.notify_events_added FROM user_assistant_settings s WHERE s.user_id = u.id), true)
     AND CASE
           WHEN u.role = 'primary_user' OR u.guest_rank = 'core' THEN
             p_kind = 'event_to_confirm'
             OR (NOT v_e.auto_confirmed AND v_e.confirmed_at <= v_e.created_at + make_interval(mins => v_delay))
           ELSE
             p_kind = 'event_added'
             AND EXISTS (SELECT 1 FROM family_event_members m
                          WHERE m.event_id = v_e.id AND m.member_id = family_member_of_profile(u.id))
         END;
END $$;
COMMENT ON FUNCTION family_event_notice_recipients(uuid, notification_kind) IS $$Destinataires d'une notification « RDV ajouté » ou « RDV à confirmer » avec leur canal (appareil autorisé ou non) : jamais le demandeur ni celui qui confirme, seulement après la date de mise en service, réglage personnel respecté ; invité secondaire seulement pour « ajouté » ; jamais pour un RDV créé depuis une idée de sortie (source « outing »). [US-113 RF1 à RF11, RF14, US-120 RF5]$$;

CREATE OR REPLACE FUNCTION erase_member_homework_data(p_member_id uuid, p_keep_age boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM family_tasks WHERE source = 'homework' AND assigned_member_id = p_member_id;
  DELETE FROM homework_week_items WHERE member_id = p_member_id;
  DELETE FROM homework_exercise_pages WHERE member_id = p_member_id;
  DELETE FROM homework_week_foreign_books WHERE member_id = p_member_id;
  DELETE FROM homework_exercise_validations WHERE member_id = p_member_id;
  IF NOT p_keep_age THEN
    DELETE FROM homework_children WHERE member_id = p_member_id;
  END IF;
END $$;
COMMENT ON FUNCTION erase_member_homework_data(uuid, boolean) IS $$Supprime les données Devoirs d'un enfant : tâches « Devoirs », éléments prévus, pages d'exercices (avec leur fiche réponse), manuels proposés, exercices validés et, sauf demande contraire, l'âge des devoirs. Appelée au retrait et à l'effacement du membre. [US-93, US-119 RT5, US-180 RT5]$$;

CREATE OR REPLACE FUNCTION erase_family_homework_progress(p_account_id uuid, p_keep_ages boolean DEFAULT true) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_tasks bigint; v_weeks bigint; v_valid bigint; v_pages bigint;
BEGIN
  DELETE FROM family_tasks WHERE account_id = p_account_id AND source = 'homework';
  GET DIAGNOSTICS v_tasks = ROW_COUNT;
  DELETE FROM homework_weeks WHERE account_id = p_account_id;
  GET DIAGNOSTICS v_weeks = ROW_COUNT;
  DELETE FROM homework_exercise_pages WHERE account_id = p_account_id;
  GET DIAGNOSTICS v_pages = ROW_COUNT;
  DELETE FROM homework_exercise_validations v USING homework_children c WHERE c.member_id = v.member_id AND c.account_id = p_account_id;
  GET DIAGNOSTICS v_valid = ROW_COUNT;
  IF NOT p_keep_ages THEN
    DELETE FROM homework_children WHERE account_id = p_account_id;
  END IF;
  RETURN v_tasks + v_weeks + v_valid + v_pages;
END $$;
COMMENT ON FUNCTION erase_family_homework_progress(uuid, boolean) IS $$Efface les plannings et les progrès Devoirs d'une famille : semaines préparées (avec éléments et tâches « Devoirs »), pages d'exercices (avec leur fiche réponse), exercices validés et, si demandé, l'âge des devoirs (conservé par défaut : c'est le comportement de l'écran, D65). Retourne le nombre de lignes supprimées. [US-118 RF5, US-119 RT5, US-180 RT5]$$;

CREATE OR REPLACE FUNCTION purge_expired_homework_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_grace integer; v_pages integer; v_a bigint; v_b bigint; v_c bigint;
BEGIN
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'homework_week_retention_months';
  SELECT value_text::integer INTO v_grace FROM platform_settings WHERE setting_key = 'homework_validation_grace_days';
  SELECT value_text::integer INTO v_pages FROM platform_settings WHERE setting_key = 'homework_page_retention_months';
  DELETE FROM homework_weeks WHERE week_start + 6 < current_date - make_interval(months => COALESCE(v_months, 12));
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM homework_exercise_validations v USING homework_children c
   WHERE c.member_id = v.member_id
     AND NOT EXISTS (SELECT 1 FROM family_settings st
                      WHERE st.account_id = c.account_id
                        AND (st.homework_help_enabled
                             OR st.homework_help_disabled_at >= now() - make_interval(days => COALESCE(v_grace, 30))));
  GET DIAGNOSTICS v_b = ROW_COUNT;
  DELETE FROM homework_exercise_pages WHERE created_at < now() - make_interval(months => COALESCE(v_pages, 12));
  GET DIAGNOSTICS v_c = ROW_COUNT;
  RETURN v_a + v_b + v_c;
END $$;
COMMENT ON FUNCTION purge_expired_homework_data() IS $$Supprime les semaines de devoirs (avec éléments, manuels proposés et tâches « Devoirs ») 12 mois après la semaine, les pages d'exercices (avec leur fiche réponse) 12 mois après leur création (homework_page_retention_months), et les exercices validés des enfants dont la famille n'a plus l'aide Devoirs active depuis plus de 30 jours (homework_validation_grace_days). À planifier chaque jour. [US-119 RT5, D65, US-180 RT5]$$;

COMMENT ON COLUMN family_tasks.homework_week_id IS $$Semaine de devoirs à l'origine de la tâche « Devoirs — [prénom] (N éléments) » (source « homework ») : une tâche par enfant et par jour de travail ; supprimée avec la semaine. Ces tâches ne sont plus créées depuis D71 (S-33) : préparer une semaine n'en crée plus, le planning du jour s'ouvre depuis la tâche « Préparer les devoirs » ; celles qui existent restent jusqu'à leur échéance. [US-119 RF4, D71]$$;
