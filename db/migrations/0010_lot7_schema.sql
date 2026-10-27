-- MAAQ — lot 7 : Anticipation
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_7_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
CREATE TYPE question_origin       AS ENUM ('catalog');
CREATE TYPE question_status       AS ENUM ('pending', 'snoozed', 'settled', 'task_created', 'dismissed', 'expired');
CREATE TYPE question_answer       AS ENUM ('done_or_planned', 'todo', 'remind_later');

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Anticipation : catalogue, situation de la famille, questions à trois choix (US-102, US-108, AT-6, AT-7)
-- ---------------------------------------------------------------------
-- Questions du court questionnaire de situation (5 au plus) : une table, pour ajouter la 5e sans migration
CREATE TABLE family_situation_questions (
  situation_key  text PRIMARY KEY CHECK (situation_key ~ '^[a-z_]+$'),
  label          varchar(150) NOT NULL,
  sort_order     smallint NOT NULL DEFAULT 1
);
CREATE TABLE family_situation_answers (
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  situation_key       text NOT NULL REFERENCES family_situation_questions (situation_key) ON DELETE CASCADE,
  answer              boolean NOT NULL,
  answered_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  answered_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, situation_key)
);
-- Catalogue d'échéances types, géré depuis la console d'administration par chargement d'un fichier Excel (US-111, D50)
CREATE TABLE anticipation_catalog_items (
  id                         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                       text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  -- Peut contenir {membre}, remplacé à l'affichage par le prénom du membre concerné
  label                      varchar(200) NOT NULL,
  category                   varchar(40) NOT NULL,
  is_medical                 boolean NOT NULL DEFAULT false,
  active                     boolean NOT NULL DEFAULT true,
  -- Question posée pour un membre précis (âge, rôle) ou pour la famille
  per_member                 boolean NOT NULL DEFAULT false,
  -- Période concernée (peut chevaucher le 31/12, par exemple novembre à février)
  period_start_month         smallint NOT NULL CHECK (period_start_month BETWEEN 1 AND 12),
  period_start_day           smallint NOT NULL DEFAULT 1 CHECK (period_start_day BETWEEN 1 AND 31),
  period_end_month           smallint NOT NULL CHECK (period_end_month BETWEEN 1 AND 12),
  period_end_day             smallint NOT NULL DEFAULT 28 CHECK (period_end_day BETWEEN 1 AND 31),
  lead_days                  smallint NOT NULL DEFAULT 21 CHECK (lead_days >= 0),
  every_n_years              smallint NOT NULL DEFAULT 1 CHECK (every_n_years BETWEEN 1 AND 10),
  -- Conditions (toutes à remplir) : rôle et âge du membre, situation de la famille
  target_role                member_role,
  min_age_months             smallint CHECK (min_age_months >= 0),
  max_age_months             smallint CHECK (max_age_months >= 0),
  situation_key              text REFERENCES family_situation_questions (situation_key) ON DELETE RESTRICT,
  situation_required_value   boolean,
  -- Contenu médical validé par une source officielle puis relu avant publication (US-102 RT4)
  source_reference           text,
  reviewed_at                timestamptz,
  -- Référent santé (médecin ou pharmacien conseil) qui a validé le contenu médical avant le chargement (D54)
  reviewed_by                varchar(100),
  -- Numéro de version : monte à chaque modification de contenu (l'ancienne ligne est archivée) ; dernier chargement concerné
  version                    integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_catalog_age CHECK (min_age_months IS NULL OR max_age_months IS NULL OR min_age_months <= max_age_months),
  CONSTRAINT ck_catalog_per_member CHECK (per_member OR (target_role IS NULL AND min_age_months IS NULL AND max_age_months IS NULL)),
  CONSTRAINT ck_catalog_situation CHECK ((situation_key IS NULL) = (situation_required_value IS NULL)),
  CONSTRAINT ck_catalog_medical_reviewed CHECK (NOT (is_medical AND active) OR (reviewed_at IS NOT NULL AND source_reference IS NOT NULL AND reviewed_by IS NOT NULL))
);
-- La carte : un état par échéance (catalogue) ou par RDV qui revient (historique)
CREATE TABLE anticipation_questions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  origin             question_origin NOT NULL,
  catalog_item_id    integer REFERENCES anticipation_catalog_items (id) ON DELETE RESTRICT,
  member_id          uuid,
  -- Période concernée ; period_end = date limite, échéance de la tâche créée par « Non, à faire » (US-102 RF6)
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  -- Question du catalogue : libellé du catalogue au moment où elle est posée, avec le repère {membre} (jamais le prénom) ;
  -- recopié par trigger. Suggestion de l'historique : aucun texte, le titre vient du RDV d'origine (D54)
  label_template     varchar(200),
  status             question_status NOT NULL DEFAULT 'pending',
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  remind_at          date,
  -- Lundi de la semaine où la carte a été présentée (au plus 5 par semaine et par famille, AT-7)
  presented_week     date CHECK (presented_week IS NULL OR date_part('isodow', presented_week) = 1),
  times_presented    smallint NOT NULL DEFAULT 0 CHECK (times_presented >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_questions_member FOREIGN KEY (member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_questions_period CHECK (period_end >= period_start),
  CONSTRAINT ck_questions_origin CHECK (origin = 'catalog' AND catalog_item_id IS NOT NULL AND label_template IS NOT NULL),
  CONSTRAINT ck_questions_snoozed CHECK ((status = 'snoozed') = (remind_at IS NOT NULL)),
  CONSTRAINT ck_questions_remind CHECK (remind_at IS NULL OR remind_at <= period_end)
);
CREATE TABLE anticipation_answers (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id          uuid NOT NULL REFERENCES anticipation_questions (id) ON DELETE CASCADE,
  answer               question_answer NOT NULL,
  remind_months        smallint CHECK (remind_months IN (1, 3, 6)),
  answered_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  answered_at          timestamptz NOT NULL DEFAULT now(),
  created_task_id      uuid REFERENCES family_tasks (id) ON DELETE SET NULL,
  CONSTRAINT ck_answers_remind CHECK ((answer = 'remind_later') = (remind_months IS NOT NULL))
);

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- Interrupteur du catalogue d'anticipation et des suggestions de l'historique (US-102 RF9, US-108 RF8)
ALTER TABLE family_settings
  ADD COLUMN anticipation_enabled  boolean NOT NULL DEFAULT true;
-- Question à trois choix à l'origine de la tâche (« Non, à faire ») : une seule tâche par question
ALTER TABLE family_tasks
  ADD COLUMN origin_question_id         uuid REFERENCES anticipation_questions (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION anonymize_family_member(p_member_id uuid, p_write_trace boolean DEFAULT true) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v_account uuid; v_msg bigint[]; v_mail uuid[]; v_n bigint;
BEGIN
  SELECT account_id INTO v_account FROM family_members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  WITH del AS (
    DELETE FROM family_events e
     WHERE e.account_id = v_account AND NOT e.whole_family
       AND EXISTS (SELECT 1 FROM family_event_members x WHERE x.event_id = e.id AND x.member_id = p_member_id)
       AND NOT EXISTS (SELECT 1 FROM family_event_members y WHERE y.event_id = e.id AND y.member_id <> p_member_id)
    RETURNING e.source_message_id, e.source_inbound_email_id)
  SELECT COALESCE(array_agg(DISTINCT source_message_id) FILTER (WHERE source_message_id IS NOT NULL), '{}'),
         COALESCE(array_agg(DISTINCT source_inbound_email_id) FILTER (WHERE source_inbound_email_id IS NOT NULL), '{}'),
         count(*)
    INTO v_msg, v_mail, v_n FROM del;
  PERFORM delete_orphan_sources(v_msg, v_mail);
  -- MVP2 : tâches à faire non assignées, questions d'anticipation du membre supprimées (aussi faits à l'archivage)
  UPDATE family_tasks SET assigned_member_id = NULL WHERE assigned_member_id = p_member_id AND status IN ('proposed', 'todo');
  UPDATE family_task_series SET assigned_member_id = NULL WHERE assigned_member_id = p_member_id AND ended_at IS NULL;
  DELETE FROM anticipation_questions WHERE member_id = p_member_id;
  UPDATE family_members
     SET first_name = NULL, birth_year = NULL, birth_month = NULL, user_id = NULL,
         anonymized_at = COALESCE(anonymized_at, now()), archived_at = COALESCE(archived_at, now())
   WHERE id = p_member_id;
  IF p_write_trace THEN
    INSERT INTO erasure_traces (former_subject_id, former_account_id, subject_kind, digitorn_status, completed_at)
    VALUES (p_member_id, v_account, 'family_member', 'done', now());
  END IF;
  RETURN v_n;
END $$;
CREATE OR REPLACE FUNCTION family_member_archived() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE family_tasks SET assigned_member_id = NULL
   WHERE assigned_member_id = NEW.id AND status IN ('proposed', 'todo');
  UPDATE family_task_series SET assigned_member_id = NULL
   WHERE assigned_member_id = NEW.id AND ended_at IS NULL;
  DELETE FROM anticipation_questions WHERE member_id = NEW.id;
  RETURN NEW;
END $$;
-- Garde-fous des questions : jamais de suggestion tirée d'un RDV médical (D31, D44), ni quand le catalogue est désactivé
-- ou que le parent a demandé « Ne plus me le proposer » (la ligne n'est alors pas créée).
CREATE FUNCTION anticipation_question_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Question du catalogue : elle garde le libellé (avec le repère {membre}) qu'avait le catalogue quand elle est posée (D54)
  IF NEW.origin = 'catalog' AND NEW.label_template IS NULL THEN
    SELECT label INTO NEW.label_template FROM anticipation_catalog_items WHERE id = NEW.catalog_item_id;
  END IF;
  IF EXISTS (SELECT 1 FROM family_settings WHERE account_id = NEW.account_id AND NOT anticipation_enabled) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
-- Réponse à une question, atomique : réponse, état de la question et tâche créée dans une seule transaction (US-102 RF6, RF12 ;
-- US-108 RF3). Réservée aux parents. applied = false si la question a déjà reçu une réponse (elle disparaît pour l'autre parent).
CREATE FUNCTION answer_anticipation_question(
  p_question_id uuid, p_answer question_answer, p_user_id uuid,
  p_remind_months smallint DEFAULT NULL, p_task_title bytea DEFAULT NULL,
  p_assigned_member_id uuid DEFAULT NULL, p_due_date date DEFAULT NULL
) RETURNS TABLE (applied boolean, task_id uuid) LANGUAGE plpgsql AS $$
DECLARE v_q anticipation_questions%ROWTYPE; v_task uuid; v_remind date;
BEGIN
  SELECT * INTO v_q FROM anticipation_questions WHERE id = p_question_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, NULL::uuid; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.account_id = v_q.account_id
                    AND (u.role = 'primary_user' OR u.guest_rank = 'core') AND u.status <> 'removed') THEN
    RAISE EXCEPTION 'Seuls les parents répondent aux questions de rappel' USING ERRCODE = 'check_violation';
  END IF;
  IF v_q.status NOT IN ('pending', 'snoozed') THEN RETURN QUERY SELECT false, NULL::uuid; RETURN; END IF;
  IF p_answer = 'todo' THEN
    IF p_task_title IS NULL THEN
      RAISE EXCEPTION 'Le titre de la tâche est obligatoire pour la réponse « Non, à faire »' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO family_tasks (account_id, title, status, due_date, assigned_member_id, created_by_user_id, source, origin_question_id)
    VALUES (v_q.account_id, p_task_title, 'todo',
            COALESCE(p_due_date, v_q.period_end),
            p_assigned_member_id, p_user_id, 'anticipation', v_q.id)
    RETURNING id INTO v_task;
    UPDATE anticipation_questions SET status = 'task_created', status_changed_at = now(), remind_at = NULL WHERE id = v_q.id;
  ELSIF p_answer = 'done_or_planned' THEN
    UPDATE anticipation_questions SET status = 'settled', status_changed_at = now(), remind_at = NULL WHERE id = v_q.id;
  ELSE
    IF p_remind_months IS NULL OR p_remind_months NOT IN (1, 3, 6) THEN
      RAISE EXCEPTION 'Délai de rappel non permis' USING ERRCODE = 'check_violation';
    END IF;
    v_remind := LEAST((current_date + make_interval(months => p_remind_months))::date, v_q.period_end);
    UPDATE anticipation_questions SET status = 'snoozed', status_changed_at = now(), remind_at = v_remind WHERE id = v_q.id;
  END IF;
  INSERT INTO anticipation_answers (question_id, answer, remind_months, answered_by_user_id, created_task_id)
  VALUES (v_q.id, p_answer, CASE WHEN p_answer = 'remind_later' THEN p_remind_months END, p_user_id, v_task);
  RETURN QUERY SELECT true, v_task;
END $$;
-- Sélection hebdomadaire : au plus 5 questions par semaine et par famille, catalogue et historique confondus (AT-7).
-- Réveille d'abord les questions « Me le rappeler » arrivées à échéance et clôt celles dont la période est finie. Retourne les
-- questions nouvellement présentées. Aucune sélection si le catalogue est désactivé pour la famille.
CREATE FUNCTION pick_weekly_questions(p_account_id uuid, p_week date) RETURNS SETOF uuid LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_done integer;
BEGIN
  IF EXISTS (SELECT 1 FROM family_settings WHERE account_id = p_account_id AND NOT anticipation_enabled) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('anticipation_week:' || p_account_id::text, 0));
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_questions_per_week';
  UPDATE anticipation_questions SET status = 'pending', remind_at = NULL, status_changed_at = now()
   WHERE account_id = p_account_id AND status = 'snoozed' AND remind_at <= current_date;
  UPDATE anticipation_questions SET status = 'expired', remind_at = NULL, status_changed_at = now()
   WHERE account_id = p_account_id AND status IN ('pending', 'snoozed') AND period_end < current_date;
  SELECT count(*) INTO v_done FROM anticipation_questions WHERE account_id = p_account_id AND presented_week = p_week;
  RETURN QUERY
    WITH pick AS (
      SELECT id FROM anticipation_questions
       WHERE account_id = p_account_id AND status = 'pending' AND presented_week IS DISTINCT FROM p_week
       ORDER BY period_end, created_at
       LIMIT GREATEST(COALESCE(v_max, 5) - v_done, 0)
       FOR UPDATE)
    UPDATE anticipation_questions q SET presented_week = p_week, times_presented = q.times_presented + 1
      FROM pick WHERE q.id = pick.id
    RETURNING q.id;
END $$;
-- Questions et réponses d'anticipation : 24 mois après la fin de leur période (les refus « Ne plus me le proposer » restent)
CREATE FUNCTION purge_expired_anticipation() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'anticipation_retention_months';
  DELETE FROM anticipation_questions WHERE period_end < current_date - make_interval(months => COALESCE(v_months, 24));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
DROP VIEW v_family_tasks;
CREATE VIEW v_family_tasks AS
SELECT t.*,
       (t.status = 'todo'
        AND ((t.due_date + COALESCE(t.due_time, time '23:59:59')) AT TIME ZONE a.family_timezone) < now()) AS is_overdue
  FROM family_tasks t JOIN accounts a ON a.id = t.account_id;
COMMENT ON VIEW v_family_tasks IS $$Tâches avec l'affichage « En retard » calculé (à faire, échéance passée dans le fuseau de la famille). À combiner avec family_tasks_visible_to pour la visibilité. [US-110 RF6, AT-1]$$;

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
CREATE INDEX idx_situation_answers_answered_by ON family_situation_answers (answered_by_user_id);
CREATE INDEX idx_situation_answers_key ON family_situation_answers (situation_key);
CREATE INDEX idx_catalog_items_situation_key ON anticipation_catalog_items (situation_key);
-- Une question par échéance, membre et période (membre NULL = question de famille) ; une par RDV qui revient et par date anniversaire
CREATE UNIQUE INDEX ux_questions_catalog ON anticipation_questions (account_id, catalog_item_id, member_id, period_start) NULLS NOT DISTINCT
  WHERE origin = 'catalog';
CREATE INDEX idx_questions_open ON anticipation_questions (account_id, period_end) WHERE status IN ('pending', 'snoozed');
CREATE INDEX idx_questions_week ON anticipation_questions (account_id, presented_week);
CREATE INDEX idx_questions_period_end ON anticipation_questions (period_end);
CREATE INDEX idx_questions_catalog_item_id ON anticipation_questions (catalog_item_id);
CREATE INDEX idx_questions_member ON anticipation_questions (member_id);
CREATE UNIQUE INDEX ux_tasks_origin_question ON family_tasks (origin_question_id) WHERE origin_question_id IS NOT NULL;
CREATE INDEX idx_answers_question ON anticipation_answers (question_id, answered_at);
CREATE INDEX idx_answers_answered_by ON anticipation_answers (answered_by_user_id);
CREATE INDEX idx_answers_created_task ON anticipation_answers (created_task_id);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_anticipation_questions_before_insert BEFORE INSERT ON anticipation_questions
  FOR EACH ROW EXECUTE FUNCTION anticipation_question_before_insert();
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
      AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'trg_' || c.table_name || '_updated_at')
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', r.table_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Données de référence
-- ---------------------------------------------------------------------
INSERT INTO family_situation_questions (situation_key, label, sort_order) VALUES
  ('vehicle',          'Avez-vous un véhicule ?', 1),
  ('home_owner',       'Êtes-vous propriétaire de votre logement ?', 2),
  ('pet',              'Avez-vous un animal ?', 3),
  ('children_schooled','Vos enfants sont-ils scolarisés ?', 4);
-- Réglages du MVP2 (US-65)
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('max_questions_per_week',               'integer', '5',  1, NULL, $$Questions de rappel et suggestions présentées au plus par semaine et par famille (AT-7)$$),
  ('anticipation_retention_months',        'integer', '24', 1, NULL, $$Conservation des questions et réponses d'anticipation après la fin de leur période, en mois (D47)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON TABLE family_situation_questions IS $$Questions du questionnaire de situation de la famille (véhicule, logement, animal, scolarité ; 5 au plus), tenues par l'équipe produit. [US-102 RF2]$$;
COMMENT ON TABLE family_situation_answers IS $$Réponses de la famille au questionnaire de situation. Absence de ligne = sans réponse : seules les échéances sans condition de situation sont proposées. [US-102 RF2]$$;
COMMENT ON TABLE anticipation_catalog_items IS $$Catalogue d'anticipation : échéances types (impôts, rentrée, contrôle technique, suivis médicaux selon l'âge…) avec période, délai, fréquence et conditions. Données de référence. [US-102 RF1, RT1, RT4]$$;
COMMENT ON COLUMN anticipation_catalog_items.every_n_years IS $$Fréquence : 1 = chaque année, 2 = tous les 2 ans… Une échéance réglée (« Oui ») revient la période suivante après ce délai$$;
COMMENT ON COLUMN anticipation_catalog_items.is_medical IS $$Question médicale générique (âge et catalogue seulement, jamais l'historique des RDV, D44). Un contenu médical actif exige une source et une relecture$$;
COMMENT ON TABLE anticipation_questions IS $$Question à trois choix (« Oui, c'est fait ou prévu » / « Non, à faire » / « Me le rappeler dans… ») issue du catalogue ou de l'historique non médical. Réservée aux parents ; la réponse d'un parent vaut pour la famille. [US-102, US-108, AT-6, AT-7]$$;
COMMENT ON COLUMN anticipation_questions.label_template IS $$Libellé du catalogue au moment où la question est posée, avec le repère {membre} remplacé à l'affichage : la question garde son ancien libellé sans jamais contenir de prénom. Vide pour une suggestion de l'historique, dont le texte est recomposé à partir du RDV d'origine (D54)$$;
COMMENT ON COLUMN anticipation_questions.presented_week IS $$Lundi de la semaine de présentation : au plus 5 questions par semaine et par famille, catalogue et historique confondus (AT-7). Une question sans réponse peut être présentée à nouveau$$;
COMMENT ON COLUMN anticipation_questions.status IS $$pending ; snoozed (« Me le rappeler », reposée à remind_at) ; settled (« Oui ») ; task_created (« Non » : une tâche existe) ; dismissed (« Ne plus me le proposer ») ; expired (période terminée sans réponse)$$;
COMMENT ON COLUMN family_tasks.origin_question_id IS $$Question d'anticipation qui a créé la tâche (réponse « Non, à faire ») : unique, pas de double création (CC-7)$$;
COMMENT ON TABLE anticipation_answers IS $$Journal des réponses aux questions à trois choix : réponse, auteur, date, tâche créée. Conservé 24 mois après la période, avec la question. [US-102 RT3, US-108, AT-6]$$;
COMMENT ON FUNCTION answer_anticipation_question(uuid, question_answer, uuid, smallint, bytea, uuid, date) IS $$Enregistre la réponse d'un parent à une question à trois choix, change l'état de la question et crée la tâche (réponse « Non ») dans une seule transaction, sans double création. applied = false si déjà traitée. [US-102 RF6, RF12, US-108 RF3, AT-6]$$;
COMMENT ON FUNCTION pick_weekly_questions(uuid, date) IS $$Marque au plus 5 questions par semaine et par famille comme présentées (celles dont l'échéance est la plus proche d'abord), réveille les rappels échus et clôt les périodes finies. [US-102 RF4, US-108 RF5, AT-7]$$;
COMMENT ON FUNCTION purge_expired_anticipation() IS $$Supprime les questions d'anticipation et leurs réponses 24 mois après la fin de leur période. À planifier chaque jour. [US-102 RT3, D47]$$;
