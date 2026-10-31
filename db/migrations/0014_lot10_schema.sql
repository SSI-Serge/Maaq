-- MAAQ — lot 10 : Sous-agents Sorties et Devoirs (US-114 à US-121)
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_10_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
-- Sous-agents Sorties et Devoirs (lot 10, US-114 à US-121)
CREATE TYPE outing_category       AS ENUM ('self', 'couple', 'kids', 'teens');
CREATE TYPE outing_mood           AS ENUM ('calm', 'playful', 'both');
CREATE TYPE outing_frequency      AS ENUM ('monthly', 'twice_monthly', 'weekly');
CREATE TYPE outing_day_pref       AS ENUM ('weekend', 'weekday_evenings', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');
CREATE TYPE outing_proposal_status AS ENUM ('ready', 'dismissed', 'added');
CREATE TYPE outing_idea_section   AS ENUM ('in_budget', 'novelty');
CREATE TYPE outing_idea_status    AS ENUM ('proposed', 'dismissed', 'added');
CREATE TYPE homework_level        AS ENUM ('cp', 'ce1', 'ce2', 'cm1', 'cm2');
CREATE TYPE homework_activity_category AS ENUM ('nature', 'philosophy', 'stem', 'art', 'imagination', 'games_projects');

-- ---------------------------------------------------------------------
-- Fonctions appelées par les contraintes des tables ci-dessous
-- ---------------------------------------------------------------------
-- Une saisie qui ressemble à une adresse : numéro de voie en tête (« 12 rue… », « 5 bis, impasse… ») ou mot de type de voie. Filet de sécurité
-- de la base : le contrôle complet (message « Indiquez une ville ou un secteur, pas une adresse. ») reste celui de l'application. « place » et
-- « cours » ne sont pas retenus : ce sont aussi des noms de communes et de quartiers. (D47, US-114 RF5, RT2)
CREATE FUNCTION looks_like_address(p_text text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_text ~* '^\s*[0-9]+\s*(bis|ter|quater)?\s*,?\s+\S'
      OR p_text ~* '(^|[\s,;])(rue|avenue|av\.?|boulevard|bd|chemin|impasse|allée|allee|route|quai|passage|square|esplanade|ruelle|sentier|lotissement|résidence|residence|hameau|lieu-dit)([\s,;]|$)'
$$;
-- Jours de la semaine ISO (1 = lundi … 7 = dimanche) : au moins un, sans doublon
CREATE FUNCTION iso_weekdays_valid(p_days smallint[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(cardinality(p_days) BETWEEN 1 AND 7
                  AND p_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
                  AND (SELECT count(DISTINCT d) FROM unnest(p_days) d) = cardinality(p_days), false)
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
-- Catalogue fermé des catégories et des thèmes (US-114 RF2) : chargé avec le schéma, évolue par ajout de lignes
CREATE TABLE outing_themes (
  category    outing_category NOT NULL,
  theme_key   text NOT NULL CHECK (theme_key ~ '^[a-z_]+$'),
  label       varchar(60) NOT NULL,
  -- Sous-groupe d'affichage (D68) : « concerts » pour les six thèmes de concert ; vide pour les autres
  theme_group text CHECK (theme_group ~ '^[a-z_]+$'),
  sort_order  smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (category, theme_key)
);
-- Critères de sorties d'un profil (US-114) : réglages PERSONNELS, une ligne par profil parent. Table dédiée plutôt que des colonnes de
-- user_assistant_settings (RT1) : une dizaine de valeurs dont une liste de thèmes et des règles d'ensemble (« activé » exige budget, lieu et
-- au moins un thème), données privées à protéger par la sécurité par ligne alors que les réglages de notification sont lus par les
-- planificateurs, et traitement propre à l'export et à l'effacement.
CREATE TABLE outing_criteria (
  user_id          uuid PRIMARY KEY,
  account_id       uuid NOT NULL,
  -- « Recevoir des idées de sorties » : désactivé par défaut. Désactiver ne supprime rien (SG-2)
  enabled          boolean NOT NULL DEFAULT false,
  -- Budget total en euros (10 à 2 000) et nombre de personnes (1 à 10) ; obligatoires dès que l'interrupteur est activé
  budget_eur       integer CHECK (budget_eur BETWEEN 10 AND 2000),
  people_count     smallint CHECK (people_count BETWEEN 1 AND 10),
  -- Une ville ou un secteur, jamais une adresse (D47)
  departure_place  varchar(80),
  mood             outing_mood NOT NULL DEFAULT 'both',
  preferred_days   outing_day_pref[] NOT NULL DEFAULT ARRAY['weekend']::outing_day_pref[],
  frequency        outing_frequency NOT NULL DEFAULT 'monthly',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_outing_criteria_user FOREIGN KEY (user_id, account_id)
    REFERENCES users (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_outing_criteria_enabled CHECK (NOT enabled OR (budget_eur IS NOT NULL AND people_count IS NOT NULL AND departure_place IS NOT NULL)),
  CONSTRAINT ck_outing_criteria_place CHECK (departure_place IS NULL OR (length(btrim(departure_place)) >= 2 AND NOT looks_like_address(departure_place))),
  CONSTRAINT ck_outing_criteria_days CHECK (cardinality(preferred_days) BETWEEN 1 AND 9),
  -- D67 : « une par semaine » est retiré ; la valeur reste dans le type (on n'en retire pas une valeur), la contrainte la refuse
  CONSTRAINT ck_outing_criteria_frequency CHECK (frequency <> 'weekly')
);
-- Thèmes choisis : la catégorie est choisie si elle a au moins un thème (« au moins un thème par catégorie choisie », US-114 RF2)
CREATE TABLE outing_criteria_themes (
  user_id    uuid NOT NULL REFERENCES outing_criteria (user_id) ON DELETE CASCADE,
  category   outing_category NOT NULL,
  theme_key  text NOT NULL,
  PRIMARY KEY (user_id, category, theme_key),
  CONSTRAINT fk_outing_criteria_themes_theme FOREIGN KEY (category, theme_key)
    REFERENCES outing_themes (category, theme_key)
);
-- Propositions de sorties (US-115, US-116) : données PRIVÉES du profil, préparées en arrière-plan. Une par profil et par jour visé.
CREATE TABLE outing_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL,
  user_id            uuid NOT NULL,
  -- Jour visé (jour local de la famille) ; la proposition reste visible jusqu'à la fin de ce jour et disparaît 30 jours après
  target_date        date NOT NULL,
  status             outing_proposal_status NOT NULL DEFAULT 'ready',
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  -- Critères au moment de la préparation (en-tête de l'écran, jauge « X % du budget ») : ils ne suivent pas une modification ultérieure
  budget_eur         integer NOT NULL CHECK (budget_eur BETWEEN 10 AND 2000),
  people_count       smallint NOT NULL CHECK (people_count BETWEEN 1 AND 10),
  departure_place    varchar(80) NOT NULL CHECK (length(btrim(departure_place)) >= 2 AND NOT looks_like_address(departure_place)),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, target_date),
  CONSTRAINT fk_outing_proposals_user FOREIGN KEY (user_id, account_id)
    REFERENCES users (id, account_id) ON DELETE CASCADE
);
-- Idées d'une proposition (US-115 RF2 à RF4). Les textes sont chiffrés par l'application : la proposition peut préparer une surprise (US-117)
-- et les administrateurs n'en voient pas le contenu (RF5). Aucun prix, horaire ou lien ne vient de la mémoire du modèle (RF4).
CREATE TABLE outing_proposal_ideas (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id         uuid NOT NULL,
  user_id             uuid NOT NULL,
  idea_position       smallint NOT NULL CHECK (idea_position >= 1),
  -- « Dans le budget » (2 idées par thème choisi, 6 au plus) ou « Nouveautés hors budget » (2 au plus)
  section             outing_idea_section NOT NULL,
  -- Thème de l'idée « dans le budget » (écran présenté par thème) ; vide pour une nouveauté
  category            outing_category,
  theme_key           text,
  name                bytea NOT NULL,
  place               bytea NOT NULL,
  description         bytea NOT NULL,
  -- Durée, accès, à savoir
  details             bytea,
  offer_url           bytea NOT NULL,
  price_eur           numeric(8,2) NOT NULL CHECK (price_eur >= 0),
  price_is_estimated  boolean NOT NULL DEFAULT false,
  -- Calcul de l'estimation, quand le prix est marqué « estimé »
  price_basis         bytea,
  -- Date du relevé du prix (source datée)
  price_checked_on    date NOT NULL,
  -- Année d'ouverture d'une nouveauté ouverte depuis plus d'un an (RF4)
  opened_year         smallint CHECK (opened_year BETWEEN 1900 AND 2100),
  status              outing_idea_status NOT NULL DEFAULT 'proposed',
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, idea_position),
  CONSTRAINT fk_outing_ideas_proposal FOREIGN KEY (proposal_id, user_id)
    REFERENCES outing_proposals (id, user_id) ON DELETE CASCADE,
  CONSTRAINT fk_outing_ideas_theme FOREIGN KEY (category, theme_key)
    REFERENCES outing_themes (category, theme_key) ON DELETE SET NULL (category, theme_key),
  CONSTRAINT ck_outing_ideas_theme CHECK ((category IS NULL) = (theme_key IS NULL) AND (section = 'in_budget' OR category IS NULL)),
  CONSTRAINT ck_outing_ideas_price_basis CHECK (price_is_estimated OR price_basis IS NULL),
  CONSTRAINT ck_outing_ideas_opened_year CHECK (section = 'novelty' OR opened_year IS NULL)
);
-- Mémoire anti-répétition (US-115 RF8, US-116 RF3) : une offre déjà proposée n'est pas reproposée au même parent pendant 90 jours, même si la
-- proposition a été écartée ou supprimée. Aucun texte : seule l'empreinte de l'offre (calculée par l'application) est gardée.
CREATE TABLE outing_offer_memory (
  user_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  -- Empreinte SHA-256 (32 octets) de l'offre (nom et lieu normalisés), calculée par l'application
  offer_hash   bytea NOT NULL CHECK (octet_length(offer_hash) = 32),
  proposed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, offer_hash),
  CONSTRAINT fk_outing_offer_memory_user FOREIGN KEY (user_id, account_id)
    REFERENCES users (id, account_id) ON DELETE CASCADE
);
-- Catalogue des manuels, des exercices et des activités (US-119 RT4) : préparé une fois à partir des manuels et des fiches d'activités dont MAAQ
-- a les droits (S-09). Les tables sont créées avec le schéma ; les exercices et les activités sont chargés par l'équipe, pas par ce fichier.
CREATE TABLE homework_textbooks (
  textbook_key  text PRIMARY KEY CHECK (textbook_key ~ '^[a-z_]+$'),
  label         varchar(80) NOT NULL,
  -- Manuel étranger (Singapour, Chine) : « surprise », jamais annoncé avant d'être proposé (US-119 RF7)
  is_foreign    boolean NOT NULL DEFAULT false,
  sort_order    smallint NOT NULL DEFAULT 1
);
CREATE TABLE homework_exercises (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  textbook_key text NOT NULL REFERENCES homework_textbooks (textbook_key) ON DELETE RESTRICT,
  level        homework_level NOT NULL,
  number       integer NOT NULL CHECK (number >= 1),
  theme        varchar(120) NOT NULL,
  -- Énoncé de l'exercice (contenu de référence du manuel, D66) : 2 000 caractères au plus, jamais vide quand il est renseigné
  statement    text CHECK (statement IS NULL OR length(btrim(statement)) BETWEEN 1 AND 2000),
  -- Corrigé affiché au parent
  answer       text,
  UNIQUE (textbook_key, level, number)
);
CREATE TABLE homework_activities (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category     homework_activity_category NOT NULL,
  title        varchar(150) NOT NULL,
  -- Description : paragraphe d'introduction qui dit ce que fait l'enfant (affichée dans les questions et sur l'écran de la semaine) ; 1 000 caractères au plus
  description  text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000),
  -- Âge visé, de 6 à 12 ans : proposée à l'âge des devoirs de l'enfant, à un an près
  age          smallint NOT NULL CHECK (age BETWEEN 6 AND 12),
  needs_adult  boolean NOT NULL DEFAULT false,
  -- Étapes de l'activité (4 000 caractères au plus) et matériel nécessaire (1 000 au plus) : contenus de référence, D66
  steps        text CHECK (steps IS NULL OR length(btrim(steps)) BETWEEN 1 AND 4000),
  materials    text CHECK (materials IS NULL OR length(btrim(materials)) BETWEEN 1 AND 1000),
  -- Référence de la carte illustrée imprimable (fichier de l'application)
  card_ref     text,
  UNIQUE (category, title, age)
);
-- Âge des devoirs d'un enfant (US-118 RF4, S-11) : saisi par le parent, de 6 à 12 ans, SANS LIEN avec la naissance (le mois et l'année de naissance,
-- US-92, ne sont ni lus ni modifiés). Une ligne = l'enfant est suivi par l'aide ; sans ligne, il n'est pas proposé.
CREATE TABLE homework_children (
  member_id     uuid PRIMARY KEY,
  account_id    uuid NOT NULL,
  homework_age  smallint NOT NULL CHECK (homework_age BETWEEN 6 AND 12),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, account_id),
  CONSTRAINT fk_homework_children_member FOREIGN KEY (member_id, account_id)
    REFERENCES family_members (id, account_id) ON DELETE CASCADE
);
-- Progrès : exercices validés sur photos, par enfant. Seules les photos valident (US-119 RF6) ; la photo n'est jamais stockée (S-10, RT6).
CREATE TABLE homework_exercise_validations (
  member_id    uuid NOT NULL REFERENCES homework_children (member_id) ON DELETE CASCADE,
  exercise_id  bigint NOT NULL REFERENCES homework_exercises (id) ON DELETE RESTRICT,
  validated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, exercise_id)
);
-- Semaine de devoirs préparée (US-119 RF4) : une par famille et par semaine (lundi-dimanche)
CREATE TABLE homework_weeks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  week_start          date NOT NULL CHECK (date_part('isodow', week_start) = 1),
  -- Jours de travail choisis (1 = lundi … 7 = dimanche) : colonnes de l'écran « Semaine de devoirs »
  work_days           smallint[] NOT NULL CHECK (iso_weekdays_valid(work_days)),
  prepared_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  UNIQUE (account_id, week_start)
);
-- Manuels étrangers proposés à un enfant pour une semaine (US-119 RF7) : au plus un par enfant et par semaine, sauf si tous les exercices
-- France du niveau sont validés sur photos ; jamais avant que la moitié des exercices France du niveau soit validée sur photos
CREATE TABLE homework_week_foreign_books (
  week_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  member_id    uuid NOT NULL,
  textbook_key text NOT NULL REFERENCES homework_textbooks (textbook_key) ON DELETE RESTRICT,
  proposed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_id, member_id, textbook_key),
  CONSTRAINT fk_homework_foreign_books_week FOREIGN KEY (week_id, account_id)
    REFERENCES homework_weeks (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_homework_foreign_books_child FOREIGN KEY (member_id, account_id)
    REFERENCES homework_children (member_id, account_id) ON DELETE CASCADE
);
-- Éléments prévus d'une semaine, par enfant et par jour : un exercice, une activité du catalogue, ou une activité libre du parent
CREATE TABLE homework_week_items (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  week_id       uuid NOT NULL,
  account_id    uuid NOT NULL,
  member_id     uuid NOT NULL,
  day           date NOT NULL,
  exercise_id   bigint REFERENCES homework_exercises (id) ON DELETE RESTRICT,
  activity_id   bigint REFERENCES homework_activities (id) ON DELETE RESTRICT,
  -- Activité du parent (titre libre), chiffré par l'application
  custom_title  bytea,
  -- Case cochée : « fait », sans valider (seules les photos valident, RF6)
  checked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_homework_items_week FOREIGN KEY (week_id, account_id)
    REFERENCES homework_weeks (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_homework_items_child FOREIGN KEY (member_id, account_id)
    REFERENCES homework_children (member_id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_homework_items_kind CHECK (num_nonnulls(exercise_id, activity_id, custom_title) = 1)
);

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- Lot 10 : semaine de devoirs à l'origine de la tâche « Devoirs — [prénom] (N éléments) » (source « homework », US-119 RF4) ;
-- le lien vers homework_weeks est ajouté avec cette table, plus bas
ALTER TABLE family_tasks
  ADD COLUMN homework_week_id           uuid;
ALTER TABLE scheduled_notifications
  DROP CONSTRAINT ck_scheduled_notifications_subject;
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT ck_scheduled_notifications_subject CHECK (
    CASE WHEN kind IN ('task_daily', 'weekly_digest', 'outing_proposal')
           THEN subject_date IS NOT NULL AND event_id IS NULL AND task_id IS NULL
         WHEN kind IN ('task_due_1h', 'task_assigned')
           THEN task_id IS NOT NULL AND event_id IS NULL AND subject_date IS NULL
         ELSE event_id IS NOT NULL AND task_id IS NULL AND subject_date IS NULL END);
-- RDV créé depuis une idée (US-120) : nouvelle source « outing ». Enregistré directement comme confirmé par le parent (jamais proposé par l'agent,
-- jamais confirmé d'office, aucun lien avec un message ou un mail) ; sans AUCUN lien vers la proposition, qui reste privée (RT1).
-- La notification « RDV ajouté » de l'autre parent n'est pas envoyée (RF5, S-06) : voir family_event_notice_recipients.
ALTER TABLE family_events
  ADD CONSTRAINT ck_family_events_outing CHECK (source <> 'outing'
    OR (status IN ('confirmed', 'cancelled') AND source_message_id IS NULL AND source_inbound_email_id IS NULL AND NOT auto_confirmed));
-- Notification « L'heure de penser à vous » (US-115 RF6) : texte générique, au seul parent concerné, jamais par email (D63). Une par profil et par
-- jour visé (subject_date = jour visé) ; sans RDV ni tâche.
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT ck_scheduled_notifications_outing CHECK (kind <> 'outing_proposal' OR (email_sent_at IS NULL AND channel IS NULL));
-- Réglage familial « Aide Devoirs » (US-118 RF1) : lisible par tous les profils, modifiable par les deux parents (droits tenus par l'application,
-- comme les autres réglages familiaux). Désactivé par défaut ; désactiver n'efface rien (SG-2).
ALTER TABLE family_settings
  ADD COLUMN homework_help_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE family_settings
  ADD COLUMN homework_help_first_enabled_at timestamptz;
ALTER TABLE family_settings
  ADD COLUMN homework_help_disabled_at timestamptz;
ALTER TABLE family_settings
  ADD CONSTRAINT ck_family_settings_homework CHECK (NOT homework_help_enabled OR (homework_help_first_enabled_at IS NOT NULL AND homework_help_disabled_at IS NULL));
-- Tâche « Devoirs — [prénom] (N éléments) » : une par enfant et par jour de travail, assignée à l'enfant et liée à la semaine (US-119 RF4)
ALTER TABLE family_tasks
  ADD CONSTRAINT fk_tasks_homework_week FOREIGN KEY (homework_week_id, account_id)
    REFERENCES homework_weeks (id, account_id) ON DELETE CASCADE;
ALTER TABLE family_tasks
  ADD CONSTRAINT ck_tasks_homework CHECK ((source = 'homework') = (homework_week_id IS NOT NULL));

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
  -- Lot 10 : données Devoirs de l'enfant (âge, progrès, tâches « Devoirs »), supprimées avant que ses tâches ne soient désassignées
  PERFORM erase_member_homework_data(p_member_id);
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
  -- Lot 10 : données Devoirs de l'enfant (âge, progrès, tâches « Devoirs »), supprimées avant que ses tâches ne soient désassignées
  PERFORM erase_member_homework_data(NEW.id);
  UPDATE family_tasks SET assigned_member_id = NULL
   WHERE assigned_member_id = NEW.id AND status IN ('proposed', 'todo');
  UPDATE family_task_series SET assigned_member_id = NULL
   WHERE assigned_member_id = NEW.id AND ended_at IS NULL;
  DELETE FROM anticipation_questions WHERE member_id = NEW.id;
  IF COALESCE(NEW.user_id, OLD.user_id) IS NOT NULL THEN
    DELETE FROM travel_tracking WHERE user_id = COALESCE(NEW.user_id, OLD.user_id);
  END IF;
  RETURN NEW;
END $$;
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
             AND EXISTS (SELECT 1 FROM family_event_members m JOIN family_members fm ON fm.id = m.member_id
                          WHERE m.event_id = v_e.id AND fm.user_id = u.id)
         END;
END $$;
-- Profil connecté à la base : l'application l'indique au début de chaque transaction (SET LOCAL app.user_id = '<uuid du profil>').
-- Sert uniquement aux règles de sécurité par ligne ; vide (NULL) si rien n'est indiqué, et alors aucune ligne privée n'est visible.
CREATE FUNCTION app_current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
-- Niveau scolaire correspondant à l'« âge des devoirs » : 6 ans = CP, 7 = CE1, 8 = CE2, 9 = CM1, 10 à 12 = CM2 (US-118 RF4)
CREATE FUNCTION homework_level_for_age(p_age smallint) RETURNS homework_level LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE WHEN p_age = 6 THEN 'cp' WHEN p_age = 7 THEN 'ce1' WHEN p_age = 8 THEN 'ce2' WHEN p_age = 9 THEN 'cm1'
               WHEN p_age BETWEEN 10 AND 12 THEN 'cm2' END)::homework_level
$$;
-- Réservé aux deux parents : l'invité secondaire n'a ni critères, ni propositions (S-02)
CREATE FUNCTION outing_require_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND (u.role = 'primary_user' OR u.guest_rank = 'core') AND u.status <> 'removed') THEN
    RAISE EXCEPTION 'Les idées de sorties sont réservées aux deux parents' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Des critères activés ont au moins un thème. Contrôle différé à la fin de la transaction : l'application écrit les critères puis
-- leurs thèmes dans la même transaction, dans l'ordre de son choix. Un retrait du dernier thème d'un profil activé est refusé.
CREATE FUNCTION outing_criteria_themes_required() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_user uuid;
BEGIN
  v_user := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  IF EXISTS (SELECT 1 FROM outing_criteria c WHERE c.user_id = v_user AND c.enabled)
     AND NOT EXISTS (SELECT 1 FROM outing_criteria_themes t WHERE t.user_id = v_user) THEN
    RAISE EXCEPTION 'Des critères de sorties activés demandent au moins un thème' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
-- Transitions d'une proposition : prête ↔ écartée (retour en arrière du bouton « Annuler »), prête → ajoutée (terminal)
CREATE FUNCTION outing_proposal_transition_allowed(p_from outing_proposal_status, p_to outing_proposal_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (('ready', 'dismissed'), ('dismissed', 'ready'), ('ready', 'added'))
$$;
CREATE FUNCTION outing_proposal_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.target_date IS DISTINCT FROM OLD.target_date THEN
    RAISE EXCEPTION 'Le profil et le jour visé d''une proposition ne changent pas' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT outing_proposal_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Transition interdite pour une proposition de sorties : % vers %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    -- Revenir en arrière n'a de sens que s'il reste une idée à voir (la dernière idée écartée retire la proposition)
    IF NEW.status = 'ready' AND NOT EXISTS (SELECT 1 FROM outing_proposal_ideas i WHERE i.proposal_id = NEW.id AND i.status = 'proposed') THEN
      RAISE EXCEPTION 'Aucune idée à remettre dans la proposition' USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
    -- Une proposition retirée ou ajoutée n'a plus à être annoncée : la notification en attente est annulée
    IF NEW.status <> 'ready' THEN
      UPDATE scheduled_notifications SET status = 'cancelled'
       WHERE kind = 'outing_proposal' AND recipient_user_id = NEW.user_id AND subject_date = NEW.target_date AND status = 'scheduled';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Proposition supprimée (purge, effacement) : la notification qui ne serait pas encore partie est supprimée avec elle
CREATE FUNCTION outing_proposal_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM scheduled_notifications
   WHERE kind = 'outing_proposal' AND recipient_user_id = OLD.user_id AND subject_date = OLD.target_date AND status = 'scheduled';
  RETURN OLD;
END $$;
-- Ajout d'une idée : seulement à la création de la proposition ; 6 idées au plus « dans le budget » dont 2 par thème, 2 nouveautés au plus (RF2)
CREATE FUNCTION outing_idea_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status outing_proposal_status; v_n integer; v_max integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('outing_ideas:' || NEW.proposal_id::text, 0));
  SELECT status INTO v_status FROM outing_proposals WHERE id = NEW.proposal_id;
  IF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'Les idées se déposent à la création de la proposition' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_n FROM outing_proposal_ideas WHERE proposal_id = NEW.proposal_id AND section = NEW.section;
  v_max := CASE NEW.section WHEN 'in_budget' THEN 6 ELSE 2 END;
  IF v_n >= v_max THEN
    RAISE EXCEPTION 'Une proposition compte au plus 6 idées dans le budget et 2 nouveautés' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.category IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM outing_proposal_ideas
     WHERE proposal_id = NEW.proposal_id AND category = NEW.category AND theme_key = NEW.theme_key;
    IF v_n >= 2 THEN
      RAISE EXCEPTION 'Une proposition compte au plus 2 idées par thème' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Une idée ne change que de statut, et seulement tant que la proposition est prête : proposée → écartée ou ajoutée, écartée → proposée
CREATE FUNCTION outing_idea_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status outing_proposal_status;
BEGIN
  IF ROW(NEW.proposal_id, NEW.user_id, NEW.idea_position, NEW.section, NEW.category, NEW.theme_key, NEW.name, NEW.place, NEW.description,
         NEW.details, NEW.offer_url, NEW.price_eur, NEW.price_is_estimated, NEW.price_basis, NEW.price_checked_on, NEW.opened_year)
     IS DISTINCT FROM
     ROW(OLD.proposal_id, OLD.user_id, OLD.idea_position, OLD.section, OLD.category, OLD.theme_key, OLD.name, OLD.place, OLD.description,
         OLD.details, OLD.offer_url, OLD.price_eur, OLD.price_is_estimated, OLD.price_basis, OLD.price_checked_on, OLD.opened_year) THEN
    RAISE EXCEPTION 'Une idée de sortie ne se modifie pas : seul son statut change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (('proposed', 'dismissed'), ('proposed', 'added'), ('dismissed', 'proposed')) THEN
      RAISE EXCEPTION 'Transition interdite pour une idée de sortie : % vers %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    SELECT status INTO v_status FROM outing_proposals WHERE id = NEW.proposal_id FOR SHARE;
    IF v_status IS DISTINCT FROM 'ready' THEN
      RAISE EXCEPTION 'La proposition n''est plus affichée : ses idées ne changent plus' USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
-- Idée ajoutée au calendrier : la proposition passe à « ajoutée » (elle disparaît de l'accueil, US-120 RF6).
-- Dernière idée écartée : la proposition entière est retirée (US-116 RF2).
CREATE FUNCTION outing_idea_after_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'added' THEN
    UPDATE outing_proposals SET status = 'added' WHERE id = NEW.proposal_id AND status = 'ready';
  ELSIF NEW.status = 'dismissed'
        AND NOT EXISTS (SELECT 1 FROM outing_proposal_ideas i WHERE i.proposal_id = NEW.proposal_id AND i.status <> 'dismissed') THEN
    UPDATE outing_proposals SET status = 'dismissed' WHERE id = NEW.proposal_id AND status = 'ready';
  END IF;
  RETURN NULL;
END $$;
-- Lecture réservée au propriétaire : mêmes principes que travel_advice_visible_to, jamais un autre profil, même parent (US-117 RT1)
CREATE FUNCTION outing_criteria_visible_to(p_viewer uuid) RETURNS SETOF outing_criteria
LANGUAGE sql STABLE AS $$
  SELECT c.* FROM outing_criteria c WHERE c.user_id = p_viewer
$$;
CREATE FUNCTION outing_proposals_visible_to(p_viewer uuid) RETURNS SETOF outing_proposals
LANGUAGE sql STABLE AS $$
  SELECT p.* FROM outing_proposals p WHERE p.user_id = p_viewer
$$;
CREATE FUNCTION outing_ideas_visible_to(p_viewer uuid) RETURNS SETOF outing_proposal_ideas
LANGUAGE sql STABLE AS $$
  SELECT i.* FROM outing_proposal_ideas i WHERE i.user_id = p_viewer
$$;
-- Empreintes des offres à ne pas reproposer à un profil (proposées dans les 90 derniers jours, réglage outing_offer_memory_days)
CREATE FUNCTION outing_excluded_offers(p_user_id uuid) RETURNS SETOF bytea LANGUAGE sql STABLE AS $$
  SELECT m.offer_hash FROM outing_offer_memory m
   WHERE m.user_id = p_user_id
     AND m.proposed_at > now() - make_interval(days => COALESCE(
           (SELECT value_text::integer FROM platform_settings WHERE setting_key = 'outing_offer_memory_days'), 90))
$$;
-- Purge : propositions et idées 30 jours après le jour visé ; offres mémorisées après 90 jours. Retourne le nombre de lignes supprimées
-- (propositions et offres ; les idées partent en cascade). À planifier chaque jour.
CREATE FUNCTION purge_expired_outing_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_keep integer; v_memory integer; v_a bigint; v_b bigint;
BEGIN
  SELECT value_text::integer INTO v_keep FROM platform_settings WHERE setting_key = 'outing_proposal_retention_days';
  SELECT value_text::integer INTO v_memory FROM platform_settings WHERE setting_key = 'outing_offer_memory_days';
  DELETE FROM outing_proposals WHERE target_date < current_date - COALESCE(v_keep, 30);
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM outing_offer_memory WHERE proposed_at < now() - make_interval(days => COALESCE(v_memory, 90));
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
CREATE FUNCTION family_settings_homework_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
-- L'âge des devoirs ne concerne qu'un membre enfant actif
CREATE FUNCTION homework_child_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM family_members m WHERE m.id = NEW.member_id AND m.role = 'child' AND m.archived_at IS NULL) THEN
    RAISE EXCEPTION 'L''âge des devoirs ne concerne qu''un membre enfant actif' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Avancement d'un enfant sur le manuel France d'un niveau : exercices du niveau et exercices validés sur photos (une case cochée ne compte pas)
CREATE FUNCTION homework_level_progress(p_member_id uuid, p_level homework_level)
RETURNS TABLE (total integer, validated integer) LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer,
         count(*) FILTER (WHERE v.exercise_id IS NOT NULL)::integer
    FROM homework_exercises e
    JOIN homework_textbooks b ON b.textbook_key = e.textbook_key AND NOT b.is_foreign
    LEFT JOIN homework_exercise_validations v ON v.exercise_id = e.id AND v.member_id = p_member_id
   WHERE e.level = p_level
$$;
-- Critère de déblocage : la moitié au moins des exercices France du niveau est validée sur photos ; la règle repart à zéro au niveau suivant
CREATE FUNCTION homework_foreign_unlocked(p_member_id uuid, p_level homework_level) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p.total > 0 AND p.validated * 2 >= p.total FROM homework_level_progress(p_member_id, p_level) p
$$;
-- Exception : tous les exercices France du niveau sont validés sur photos : plusieurs manuels étrangers possibles
CREATE FUNCTION homework_france_level_done(p_member_id uuid, p_level homework_level) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p.total > 0 AND p.validated = p.total FROM homework_level_progress(p_member_id, p_level) p
$$;
CREATE FUNCTION homework_foreign_book_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_level homework_level;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('homework_foreign:' || NEW.week_id::text || NEW.member_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM homework_textbooks b WHERE b.textbook_key = NEW.textbook_key AND b.is_foreign) THEN
    RAISE EXCEPTION 'Seul un manuel étranger se propose ici (le manuel France est toujours proposé)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT homework_level_for_age(c.homework_age) INTO v_level FROM homework_children c WHERE c.member_id = NEW.member_id;
  IF NOT homework_foreign_unlocked(NEW.member_id, v_level) THEN
    RAISE EXCEPTION 'Un manuel étranger se débloque quand la moitié des exercices du niveau est validée sur photos' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM homework_week_foreign_books f WHERE f.week_id = NEW.week_id AND f.member_id = NEW.member_id)
     AND NOT homework_france_level_done(NEW.member_id, v_level) THEN
    RAISE EXCEPTION 'Une semaine compte au plus deux manuels : France et un seul manuel étranger' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Élément d'une semaine : jour compris dans la semaine ; exercice d'un manuel étranger seulement s'il est proposé pour cet enfant cette semaine ;
-- un élément se déplace d'un jour à l'autre et se coche, il ne change pas de contenu ni d'enfant
CREATE FUNCTION homework_item_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_start date; v_book text;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.week_id, NEW.member_id, NEW.exercise_id, NEW.activity_id, NEW.custom_title)
                          IS DISTINCT FROM ROW(OLD.week_id, OLD.member_id, OLD.exercise_id, OLD.activity_id, OLD.custom_title) THEN
    RAISE EXCEPTION 'Un élément de devoirs se déplace d''un jour à l''autre ou se coche ; il ne change ni de contenu ni d''enfant' USING ERRCODE = 'check_violation';
  END IF;
  SELECT week_start INTO v_start FROM homework_weeks WHERE id = NEW.week_id;
  IF NEW.day < v_start OR NEW.day > v_start + 6 THEN
    RAISE EXCEPTION 'Le jour doit être dans la semaine préparée' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.exercise_id IS NOT NULL THEN
    SELECT b.textbook_key INTO v_book FROM homework_exercises e JOIN homework_textbooks b ON b.textbook_key = e.textbook_key AND b.is_foreign
     WHERE e.id = NEW.exercise_id;
    IF v_book IS NOT NULL AND NOT EXISTS (SELECT 1 FROM homework_week_foreign_books f
                                           WHERE f.week_id = NEW.week_id AND f.member_id = NEW.member_id AND f.textbook_key = v_book) THEN
      RAISE EXCEPTION 'Ce manuel étranger n''est pas proposé à cet enfant cette semaine' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Effacement des données Devoirs d'un enfant (retrait ou effacement du membre, changement de rôle) : tâches « Devoirs », éléments, manuels
-- proposés, exercices validés et âge des devoirs (sauf p_keep_age). Données de mineurs : rien ne reste. [US-93, US-119 RT5]
CREATE FUNCTION erase_member_homework_data(p_member_id uuid, p_keep_age boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM family_tasks WHERE source = 'homework' AND assigned_member_id = p_member_id;
  DELETE FROM homework_week_items WHERE member_id = p_member_id;
  DELETE FROM homework_week_foreign_books WHERE member_id = p_member_id;
  DELETE FROM homework_exercise_validations WHERE member_id = p_member_id;
  IF NOT p_keep_age THEN
    DELETE FROM homework_children WHERE member_id = p_member_id;
  END IF;
END $$;
-- Bouton « Effacer les progrès de Devoirs » (US-118 RF5) : supprime les semaines préparées (avec éléments et tâches), les exercices validés et,
-- si p_keep_ages est faux, l'âge des devoirs des enfants. Retourne le nombre de semaines, de validations et de tâches supprimées.
CREATE FUNCTION erase_family_homework_progress(p_account_id uuid, p_keep_ages boolean DEFAULT true) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_tasks bigint; v_weeks bigint; v_valid bigint;
BEGIN
  DELETE FROM family_tasks WHERE account_id = p_account_id AND source = 'homework';
  GET DIAGNOSTICS v_tasks = ROW_COUNT;
  DELETE FROM homework_weeks WHERE account_id = p_account_id;
  GET DIAGNOSTICS v_weeks = ROW_COUNT;
  DELETE FROM homework_exercise_validations v USING homework_children c WHERE c.member_id = v.member_id AND c.account_id = p_account_id;
  GET DIAGNOSTICS v_valid = ROW_COUNT;
  IF NOT p_keep_ages THEN
    DELETE FROM homework_children WHERE account_id = p_account_id;
  END IF;
  RETURN v_tasks + v_weeks + v_valid;
END $$;
-- Purge Devoirs (D65, à valider par le DPO et à écrire dans l'AIPD) : semaines préparées et leurs éléments supprimés 12 mois après la semaine
-- (avec les manuels proposés et les tâches « Devoirs » liées) ; exercices validés gardés tant que l'aide est active pour la famille de l'enfant,
-- puis encore 30 jours après sa désactivation (délai de grâce : une réactivation les retrouve). Retourne le nombre de semaines et de validations supprimées.
CREATE FUNCTION purge_expired_homework_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_grace integer; v_a bigint; v_b bigint;
BEGIN
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'homework_week_retention_months';
  SELECT value_text::integer INTO v_grace FROM platform_settings WHERE setting_key = 'homework_validation_grace_days';
  DELETE FROM homework_weeks WHERE week_start + 6 < current_date - make_interval(months => COALESCE(v_months, 12));
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM homework_exercise_validations v USING homework_children c
   WHERE c.member_id = v.member_id
     AND NOT EXISTS (SELECT 1 FROM family_settings st
                      WHERE st.account_id = c.account_id
                        AND (st.homework_help_enabled
                             OR st.homework_help_disabled_at >= now() - make_interval(days => COALESCE(v_grace, 30))));
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
-- Un membre qui n'est plus enfant n'est plus suivi par l'aide Devoirs
CREATE FUNCTION family_member_homework_role_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM erase_member_homework_data(NEW.id);
  RETURN NEW;
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
CREATE INDEX idx_outing_criteria_account_id ON outing_criteria (account_id);
CREATE INDEX idx_outing_criteria_themes_theme ON outing_criteria_themes (category, theme_key);
CREATE INDEX idx_outing_proposals_account_id ON outing_proposals (account_id);
CREATE INDEX idx_outing_proposals_target ON outing_proposals (target_date);
CREATE INDEX idx_outing_ideas_user ON outing_proposal_ideas (user_id);
CREATE INDEX idx_outing_ideas_theme ON outing_proposal_ideas (category, theme_key) WHERE category IS NOT NULL;
CREATE INDEX idx_outing_offer_memory_account_id ON outing_offer_memory (account_id);
CREATE INDEX idx_outing_offer_memory_proposed ON outing_offer_memory (proposed_at);
CREATE INDEX idx_homework_exercises_level ON homework_exercises (level, textbook_key);
CREATE INDEX idx_homework_activities_pick ON homework_activities (category, age);
CREATE INDEX idx_homework_children_account_id ON homework_children (account_id);
CREATE INDEX idx_homework_validations_exercise ON homework_exercise_validations (exercise_id);
CREATE INDEX idx_homework_weeks_prepared_by ON homework_weeks (prepared_by_user_id);
CREATE INDEX idx_homework_foreign_books_account_id ON homework_week_foreign_books (account_id);
CREATE INDEX idx_homework_foreign_books_member ON homework_week_foreign_books (member_id, account_id);
CREATE INDEX idx_homework_foreign_books_textbook ON homework_week_foreign_books (textbook_key);
CREATE UNIQUE INDEX ux_homework_items_exercise ON homework_week_items (week_id, member_id, day, exercise_id) WHERE exercise_id IS NOT NULL;
CREATE UNIQUE INDEX ux_homework_items_activity ON homework_week_items (week_id, member_id, day, activity_id) WHERE activity_id IS NOT NULL;
CREATE INDEX idx_homework_items_account_id ON homework_week_items (account_id);
CREATE INDEX idx_homework_items_member ON homework_week_items (member_id, account_id);
CREATE INDEX idx_homework_items_exercise ON homework_week_items (exercise_id) WHERE exercise_id IS NOT NULL;
CREATE INDEX idx_homework_items_activity ON homework_week_items (activity_id) WHERE activity_id IS NOT NULL;
CREATE UNIQUE INDEX ux_tasks_homework_day ON family_tasks (homework_week_id, assigned_member_id, due_date) WHERE homework_week_id IS NOT NULL;
CREATE INDEX idx_tasks_homework_week ON family_tasks (homework_week_id, account_id) WHERE homework_week_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Triggers et sécurité par ligne
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_outing_criteria_parent BEFORE INSERT OR UPDATE ON outing_criteria
  FOR EACH ROW EXECUTE FUNCTION outing_require_parent();
CREATE TRIGGER trg_outing_proposals_parent BEFORE INSERT ON outing_proposals
  FOR EACH ROW EXECUTE FUNCTION outing_require_parent();
CREATE TRIGGER trg_outing_offer_memory_parent BEFORE INSERT ON outing_offer_memory
  FOR EACH ROW EXECUTE FUNCTION outing_require_parent();
CREATE CONSTRAINT TRIGGER trg_outing_criteria_themes_required AFTER INSERT OR UPDATE ON outing_criteria
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION outing_criteria_themes_required();
CREATE CONSTRAINT TRIGGER trg_outing_criteria_themes_kept AFTER DELETE OR UPDATE ON outing_criteria_themes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION outing_criteria_themes_required();
CREATE TRIGGER trg_outing_proposals_before_update BEFORE UPDATE ON outing_proposals
  FOR EACH ROW EXECUTE FUNCTION outing_proposal_before_update();
CREATE TRIGGER trg_outing_proposals_deleted AFTER DELETE ON outing_proposals
  FOR EACH ROW EXECUTE FUNCTION outing_proposal_deleted();
CREATE TRIGGER trg_outing_ideas_before_insert BEFORE INSERT ON outing_proposal_ideas
  FOR EACH ROW EXECUTE FUNCTION outing_idea_before_insert();
CREATE TRIGGER trg_outing_ideas_before_update BEFORE UPDATE ON outing_proposal_ideas
  FOR EACH ROW EXECUTE FUNCTION outing_idea_before_update();
CREATE TRIGGER trg_outing_ideas_after_status AFTER UPDATE OF status ON outing_proposal_ideas
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION outing_idea_after_status();
-- Sécurité par ligne : un profil ne lit et n'écrit que ses propres lignes (US-117 RT1). Non forcée : le propriétaire des tables
-- (migrations, planificateurs de purge) la contourne ; elle protège les connexions faites avec un rôle limité qui indiquent le profil
-- (app.user_id). Sans cette indication, aucune ligne n'est visible.
ALTER TABLE outing_criteria ENABLE ROW LEVEL SECURITY;
CREATE POLICY outing_criteria_owner ON outing_criteria
  USING (user_id = (SELECT app_current_user_id())) WITH CHECK (user_id = (SELECT app_current_user_id()));
ALTER TABLE outing_criteria_themes ENABLE ROW LEVEL SECURITY;
CREATE POLICY outing_criteria_themes_owner ON outing_criteria_themes
  USING (user_id = (SELECT app_current_user_id())) WITH CHECK (user_id = (SELECT app_current_user_id()));
ALTER TABLE outing_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY outing_proposals_owner ON outing_proposals
  USING (user_id = (SELECT app_current_user_id())) WITH CHECK (user_id = (SELECT app_current_user_id()));
ALTER TABLE outing_proposal_ideas ENABLE ROW LEVEL SECURITY;
CREATE POLICY outing_proposal_ideas_owner ON outing_proposal_ideas
  USING (user_id = (SELECT app_current_user_id())) WITH CHECK (user_id = (SELECT app_current_user_id()));
ALTER TABLE outing_offer_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY outing_offer_memory_owner ON outing_offer_memory
  USING (user_id = (SELECT app_current_user_id())) WITH CHECK (user_id = (SELECT app_current_user_id()));
CREATE TRIGGER trg_family_settings_homework BEFORE INSERT OR UPDATE ON family_settings
  FOR EACH ROW EXECUTE FUNCTION family_settings_homework_before_write();
CREATE TRIGGER trg_homework_children_before_write BEFORE INSERT OR UPDATE OF member_id, homework_age ON homework_children
  FOR EACH ROW EXECUTE FUNCTION homework_child_before_write();
CREATE TRIGGER trg_homework_foreign_books_before_insert BEFORE INSERT ON homework_week_foreign_books
  FOR EACH ROW EXECUTE FUNCTION homework_foreign_book_before_insert();
CREATE TRIGGER trg_homework_items_before_write BEFORE INSERT OR UPDATE ON homework_week_items
  FOR EACH ROW EXECUTE FUNCTION homework_item_before_write();
CREATE TRIGGER trg_family_members_homework_role AFTER UPDATE OF role ON family_members
  FOR EACH ROW WHEN (OLD.role = 'child' AND NEW.role <> 'child') EXECUTE FUNCTION family_member_homework_role_changed();
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
-- Graines : catalogue des thèmes de sorties (US-114 RF2) et manuels de maths (US-119 RF7). Les exercices et les activités sont chargés par l'équipe.
INSERT INTO outing_themes (category, theme_key, label, sort_order) VALUES
  ('self', 'culture', 'Culture', 1), ('self', 'wellbeing', 'Bien-être', 2), ('self', 'nature', 'Nature', 3), ('self', 'foodie', 'Gourmand', 4),
  ('self', 'creative', 'Créatif', 5), ('self', 'sport', 'Sport', 6), ('self', 'show', 'Spectacle', 7), ('self', 'strolling', 'Flânerie', 8),
  ('self', 'with_friends', 'Entre amis', 9),
  ('couple', 'romantic', 'Romantique', 1), ('couple', 'relaxation', 'Détente', 2), ('couple', 'discovery', 'Découverte', 3),
  ('couple', 'gastronomy', 'Gastronomie', 4), ('couple', 'culture', 'Culture', 5), ('couple', 'couple_activities', 'Activités à deux', 6),
  ('couple', 'playful', 'Ludique', 7), ('couple', 'nature', 'Nature', 8),
  ('kids', 'animals', 'Animaux', 1), ('kids', 'outdoors', 'Plein air', 2), ('kids', 'theme_parks', 'Parcs d''attractions', 3),
  ('kids', 'science_discovery', 'Sciences et découverte', 4), ('kids', 'creative', 'Créatif', 5), ('kids', 'shows', 'Spectacles', 6),
  ('kids', 'sport_movement', 'Sport et mouvement', 7), ('kids', 'indoor_games', 'Jeux d''intérieur', 8), ('kids', 'seasonal', 'Saisonnier', 9),
  ('kids', 'gentle_adventure', 'Aventure douce', 10),
  ('teens', 'thrills', 'Sensations', 1), ('teens', 'sport', 'Sport', 2), ('teens', 'games_tech', 'Jeux et techno', 3),
  ('teens', 'pop_culture', 'Culture pop', 4), ('teens', 'creative', 'Créatif', 5), ('teens', 'social', 'Social', 6),
  ('teens', 'discovery', 'Découverte', 7), ('teens', 'adventure', 'Aventure', 8), ('teens', 'autonomy', 'Autonomie', 9),
  ('teens', 'parent_teen_time', 'Moment parent-ado', 10);
-- Sous-groupe « Concerts » (D68) : six thèmes pour « Pour moi », « En couple » et « Ados », aucun pour « Enfants de 3 à 10 ans » (absents du catalogue : refusés par la clé étrangère)
INSERT INTO outing_themes (category, theme_key, label, theme_group, sort_order) VALUES
  ('self', 'world_concert', 'Concert du monde', 'concerts', 10), ('self', 'urban_concert', 'Concert urbain', 'concerts', 11),
  ('self', 'pop_concert', 'Concert pop', 'concerts', 12), ('self', 'hiphop_rap_concert', 'Concert hip-hop / rap', 'concerts', 13),
  ('self', 'jazz_concert', 'Concert jazz', 'concerts', 14), ('self', 'rock_concert', 'Concert rock', 'concerts', 15),
  ('couple', 'world_concert', 'Concert du monde', 'concerts', 9), ('couple', 'urban_concert', 'Concert urbain', 'concerts', 10),
  ('couple', 'pop_concert', 'Concert pop', 'concerts', 11), ('couple', 'hiphop_rap_concert', 'Concert hip-hop / rap', 'concerts', 12),
  ('couple', 'jazz_concert', 'Concert jazz', 'concerts', 13), ('couple', 'rock_concert', 'Concert rock', 'concerts', 14),
  ('teens', 'world_concert', 'Concert du monde', 'concerts', 11), ('teens', 'urban_concert', 'Concert urbain', 'concerts', 12),
  ('teens', 'pop_concert', 'Concert pop', 'concerts', 13), ('teens', 'hiphop_rap_concert', 'Concert hip-hop / rap', 'concerts', 14),
  ('teens', 'jazz_concert', 'Concert jazz', 'concerts', 15), ('teens', 'rock_concert', 'Concert rock', 'concerts', 16);
INSERT INTO homework_textbooks (textbook_key, label, is_foreign, sort_order) VALUES
  ('france', 'Manuel France', false, 1), ('singapore', 'Manuel Singapour', true, 2), ('china', 'Manuel Chine', true, 3);
-- Réglages du lot 10 (US-65)
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('outing_proposal_retention_days', 'integer', '30', 1, NULL, $$Conservation d'une proposition de sorties après son jour visé, en jours (US-115 RF7)$$),
  ('outing_offer_memory_days',       'integer', '90', 1, NULL, $$Durée pendant laquelle une offre déjà proposée n'est pas reproposée au même parent, en jours (US-115 RF8)$$),
  ('homework_week_retention_months', 'integer', '12', 1, NULL, $$Conservation d'une semaine de devoirs et de ses éléments après la semaine, en mois (US-119 RT5, D65)$$),
  ('homework_validation_grace_days', 'integer', '30', 1, NULL, $$Délai de grâce des exercices validés après la désactivation de l'aide Devoirs, en jours : une réactivation pendant ce délai les retrouve (US-119 RT5, D65)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON TABLE scheduled_notifications IS $$Rappels (J-7, J-1, jour J), relances (24 h, 48 h) et notifications de trajet programmés par RDV et destinataire ; rappels de tâches, point de la semaine et annonce d'une proposition de sorties sans RDV. Supprimés avec le RDV ; sans RDV, 30 jours après l'échéance. [US-79, 81, 83, 97, 98, 107, 115]$$;
COMMENT ON TABLE family_settings IS $$Réglages de l'Assistant Famille communs à la famille : zone scolaire, catalogue d'anticipation actif ou non, aide Devoirs. Absence de ligne = valeurs par défaut. [US-102 RF9, US-108 RF8, US-109 RF4, US-118 RF1]$$;
COMMENT ON FUNCTION anonymize_family_member(uuid, boolean) IS $$Efface un membre (anonymisation) et supprime ses RDV exclusifs et leurs fichiers, ses questions d'anticipation, ses données Devoirs ; ses tâches à faire deviennent non assignées ; trace non nominative. [US-57, 93, 96 RF8, 119 RT5, D34]$$;
COMMENT ON FUNCTION family_event_notice_recipients(uuid, notification_kind) IS $$Destinataires d'une notification « RDV ajouté » ou « RDV à confirmer » avec leur canal (appareil autorisé ou non) : jamais le demandeur ni celui qui confirme, seulement après la date de mise en service, réglage personnel respecté ; invité secondaire seulement pour « ajouté » ; jamais pour un RDV créé depuis une idée de sortie (source « outing »). [US-113 RF1 à RF11, RF14, US-120 RF5]$$;
COMMENT ON FUNCTION app_current_user_id() IS $$Profil indiqué par l'application dans la variable de session app.user_id (SET LOCAL au début de la transaction) ; NULL si elle est absente. Sert aux règles de sécurité par ligne des données privées d'un profil (idées de sorties). [US-117 RT1]$$;
COMMENT ON FUNCTION looks_like_address(text) IS $$Vrai si le texte ressemble à une adresse (numéro de voie en tête ou mot de type de voie) : refusé pour le lieu de départ des sorties. Filet de sécurité de la base, en plus du contrôle de l'application. [US-114 RF5, RT2, D47]$$;
COMMENT ON FUNCTION iso_weekdays_valid(smallint[]) IS $$Vrai si la liste contient 1 à 7 jours ISO (1 = lundi) sans doublon. [US-119 RF2]$$;
COMMENT ON FUNCTION homework_level_for_age(smallint) IS $$Niveau de maths de l'âge des devoirs : 6 ans CP, 7 CE1, 8 CE2, 9 CM1, 10 à 12 ans CM2 ; NULL hors de 6 à 12 ans. [US-118 RF4]$$;
COMMENT ON COLUMN outing_themes.theme_group IS $$Sous-groupe d'affichage du thème (clé technique, par exemple « concerts » : l'écran range ces thèmes dans un sous-groupe repliable) ; vide = thème sans sous-groupe. Un thème d'un sous-groupe reste un thème ordinaire de sa catégorie (règle « au moins un thème », choix, idées). Le libellé du sous-groupe est porté par l'écran (D68)$$;
COMMENT ON TABLE outing_themes IS $$Listes fermées des thèmes de sorties, par catégorie (pour moi, en couple, enfants de 3 à 10 ans, ados de 11 à 17 ans). Le même thème peut exister dans plusieurs catégories. [US-114 RF2]$$;
COMMENT ON TABLE outing_criteria IS $$Critères de sorties d'un profil parent : interrupteur (désactivé par défaut), budget et nombre de personnes, ville ou secteur de départ, ambiance, jours préférés, fréquence. Données PRIVÉES du profil : l'autre parent ne les voit pas. Les catégories et thèmes sont dans outing_criteria_themes. [US-114, US-117, RT1]$$;
COMMENT ON COLUMN outing_criteria.enabled IS $$« Recevoir des idées de sorties » : faux par défaut ; vrai exige budget, nombre de personnes, lieu de départ et au moins un thème. Désactiver arrête les propositions sans rien supprimer (SG-2)$$;
COMMENT ON COLUMN outing_criteria.departure_place IS $$Ville ou secteur (« Lyon », « Paris et Île-de-France »), 80 caractères au plus, jamais une adresse : refusé si la saisie ressemble à une adresse (looks_like_address). Aucune adresse de domicile n'est stockée (D47)$$;
COMMENT ON COLUMN outing_criteria.frequency IS $$Fréquence des propositions : une par mois (monthly, défaut) ou deux par mois (twice_monthly). La valeur weekly (une par semaine) est retirée par la décision D67 (coût d'une proposition) : elle reste dans le type énuméré mais la contrainte ck_outing_criteria_frequency la refuse$$;
COMMENT ON COLUMN outing_criteria.preferred_days IS $$Jours préférés : week-end (samedi, dimanche), soirs de semaine, ou un jour précis. Au moins un ; « week-end » par défaut. Le jour visé est choisi par l'application (US-115 RF1)$$;
COMMENT ON TABLE outing_criteria_themes IS $$Thèmes choisis par un profil, par catégorie : une catégorie est choisie quand elle a au moins un thème. Des critères activés exigent au moins un thème (contrôle différé à la fin de la transaction). Privé au profil. [US-114 RF2, RF6]$$;
COMMENT ON TABLE outing_proposals IS $$Proposition de sorties préparée pour un profil parent, pour un jour visé : statut (prête, écartée, ajoutée) et critères du moment. Donnée PRIVÉE du profil : jamais dans le calendrier familial, le carnet de bord, le point de la semaine ni le compteur de l'icône ; sans lien avec le RDV éventuellement créé. Supprimée 30 jours après le jour visé. [US-115, US-116, US-117]$$;
COMMENT ON COLUMN outing_proposals.status IS $$ready = visible sur l'accueil du profil ; dismissed = retirée par le profil (revenir en arrière possible tant qu'une idée reste) ; added = une idée a été ajoutée au calendrier. Transitions : ready ↔ dismissed, ready → added$$;
COMMENT ON COLUMN outing_proposals.target_date IS $$Jour visé, choisi par l'application (prochain jour préféré au moins 4 jours plus tard et sans RDV sur toute la journée). Une seule proposition par profil et par jour visé : un second passage du planificateur ne crée pas de doublon$$;
COMMENT ON TABLE outing_proposal_ideas IS $$Idées d'une proposition de sorties : rubrique, thème, nom, lieu, prix (relevé ou estimé, avec sa date de relevé), description, détails, lien « Voir l'offre », et statut de chaque idée (proposée, écartée, ajoutée). Textes chiffrés par l'application. Privé au profil propriétaire de la proposition. Supprimées avec elle. [US-115 RF2 à RF4, US-116 RF2, US-117]$$;
COMMENT ON COLUMN outing_proposal_ideas.price_is_estimated IS $$Prix non affiché par la source, estimé avec son calcul (price_basis) : l'application affiche « estimé », ou « ≈ » pour une nouveauté$$;
COMMENT ON COLUMN outing_proposal_ideas.status IS $$proposed ; dismissed = « Pas cette fois » (retire cette seule idée ; la dernière idée retirée retire la proposition) ; added = « Ajoutée au calendrier » (la proposition passe à « ajoutée ») . Aucun lien vers le RDV créé$$;
COMMENT ON TABLE outing_offer_memory IS $$Offres déjà proposées à un profil parent, pour ne pas les reproposer pendant 90 jours (réglage outing_offer_memory_days). Empreinte seulement, aucun texte ; une nouvelle proposition de la même offre renouvelle la date. Privée au profil ; supprimée avec lui. [US-115 RF8, US-116 RF3]$$;
COMMENT ON COLUMN outing_offer_memory.offer_hash IS $$Empreinte SHA-256 de l'offre (nom et lieu normalisés), calculée par l'application avec un secret : jamais un texte lisible$$;
COMMENT ON FUNCTION outing_proposal_transition_allowed(outing_proposal_status, outing_proposal_status) IS $$Transitions permises d'une proposition de sorties : prête vers écartée et retour, prête vers ajoutée. [US-116 RF1, RF2, US-120 RF6]$$;
COMMENT ON FUNCTION outing_criteria_visible_to(uuid) IS $$Critères de sorties d'un profil : uniquement les siens, jamais ceux de l'autre parent. [US-114 RF1, US-117]$$;
COMMENT ON FUNCTION outing_proposals_visible_to(uuid) IS $$Propositions de sorties d'un profil : uniquement les siennes, tous statuts ; l'accueil n'affiche que les prêtes dont le jour visé n'est pas passé. [US-117 RF1, RT1]$$;
COMMENT ON FUNCTION outing_ideas_visible_to(uuid) IS $$Idées des propositions d'un profil : uniquement les siennes. [US-117 RF1, RT1]$$;
COMMENT ON FUNCTION outing_excluded_offers(uuid) IS $$Empreintes des offres déjà proposées à un profil dans les 90 derniers jours (réglable) : à écarter de la prochaine proposition. [US-115 RF8, US-116 RF3]$$;
COMMENT ON FUNCTION purge_expired_outing_data() IS $$Supprime les propositions de sorties et leurs idées 30 jours après le jour visé, et les offres mémorisées après 90 jours. À planifier chaque jour. [US-115 RF7, RF8, US-116 RT1]$$;
COMMENT ON COLUMN family_settings.homework_help_enabled IS $$Aide Devoirs activée pour toute la famille (faux par défaut). Ne s'active que si la famille compte au moins un membre enfant ; désactiver arrête l'aide sans effacer les plannings ni les progrès. [US-118 RF1, RF2, RF5, D64]$$;
COMMENT ON COLUMN family_settings.homework_help_first_enabled_at IS $$Date de la première activation, posée automatiquement : vide = la présentation en trois lignes n'a jamais été montrée (US-118 RF3)$$;
COMMENT ON COLUMN family_settings.homework_help_disabled_at IS $$Date de la dernière désactivation de l'aide, posée automatiquement quand elle passe de vraie à fausse et remise à vide à la réactivation. Les exercices validés sont gardés jusqu'à homework_validation_grace_days (30) après cette date : une réactivation pendant ce délai les retrouve (D65)$$;
COMMENT ON TABLE homework_textbooks IS $$Manuels de maths : France (toujours proposé) et manuels étrangers (Singapour, Chine), qui se débloquent par enfant et par niveau. [US-119 RF7, RT4]$$;
COMMENT ON COLUMN homework_exercises.statement IS $$Énoncé de l'exercice, contenu de référence du manuel porté par la base (D66) : 2 000 caractères au plus, facultatif. Aucune donnée personnelle : table de référence sans lien avec un compte, un profil ou un membre$$;
COMMENT ON TABLE homework_exercises IS $$Exercices de maths du catalogue : manuel, niveau (CP à CM2), numéro, thème, corrigé. Table de référence chargée une fois ; un rechargement met les lignes à jour sans les supprimer (les progrès les désignent). [US-119 RF2, RF4, RT4]$$;
COMMENT ON COLUMN homework_activities.description IS $$Description de l'activité : paragraphe d'introduction qui dit ce que fait l'enfant, contenu de référence porté par la base : 1 000 caractères au plus, facultatif. Affichée dans les questions de l'aide et sur l'écran de la semaine. Aucune donnée personnelle$$;
COMMENT ON COLUMN homework_activities.steps IS $$Étapes de l'activité, contenu de référence porté par la base (D66) : 4 000 caractères au plus, facultatif. Aucune donnée personnelle$$;
COMMENT ON COLUMN homework_activities.materials IS $$Matériel nécessaire à l'activité, contenu de référence porté par la base (D66) : 1 000 caractères au plus, facultatif. Aucune donnée personnelle$$;
COMMENT ON TABLE homework_activities IS $$Activités d'éveil du catalogue : catégorie (nature, philo, STIM, art, imagination, jeux et projets), âge visé, « avec un adulte », carte illustrée. Table de référence chargée une fois. [US-119 RF2, RF4, RT4]$$;
COMMENT ON TABLE homework_children IS $$Âge des devoirs de chaque enfant suivi par l'aide Devoirs : 6 à 12 ans, saisi par le parent, distinct de la date de naissance (un enfant travaille souvent au-dessus de son âge). Partagé entre les deux parents. Donnée de mineur : supprimée avec le membre et à l'effacement des progrès. [US-118 RF4, RT1, D64 S-11]$$;
COMMENT ON COLUMN homework_children.homework_age IS $$Âge des devoirs (6 à 12 ans) : donne le niveau de maths (6 CP … 10 CM2, 11 et 12 CM2) et l'âge des activités à un an près. Sans lien avec family_members.birth_year et birth_month, qu'il ne modifie pas$$;
COMMENT ON TABLE homework_exercise_validations IS $$Exercices réussis sans aide, validés par l'analyse d'une photo du travail de l'enfant (la photo est supprimée, jamais conservée). Une ligne par enfant et par exercice. Une case cochée ne valide pas. Donnée de mineur. [US-119 RF5, RF6, RF7, RT5, RT6]$$;
COMMENT ON TABLE homework_weeks IS $$Semaine de devoirs préparée pour la famille : lundi de la semaine, jours de travail. Une par famille et par semaine : la carte « Préparer la semaine de devoirs » n'apparaît plus ensuite. Supprimée à l'effacement des progrès, avec ses éléments et ses tâches. [US-119 RF1, RF2, RF4, RT5]$$;
COMMENT ON TABLE homework_week_foreign_books IS $$Manuel étranger proposé à un enfant pour une semaine. La base impose la règle de progression : débloqué par la moitié des exercices France du niveau validée sur photos, un seul par enfant et par semaine sauf si tous les exercices France du niveau sont validés sur photos. Un élément d'un manuel étranger n'existe que si le manuel est proposé ici. [US-119 RF7]$$;
COMMENT ON TABLE homework_week_items IS $$Éléments prévus d'une semaine de devoirs, par enfant et par jour : exercice du catalogue, activité du catalogue ou activité libre du parent. Une case cochée (checked_at) compte comme « fait » sans valider. Un élément se déplace d'un jour à l'autre de la semaine ou se retire. Donnée de mineur. [US-119 RF2, RF4, RF6, RT5]$$;
COMMENT ON COLUMN family_tasks.homework_week_id IS $$Semaine de devoirs à l'origine de la tâche « Devoirs — [prénom] (N éléments) » (source « homework ») : une tâche par enfant et par jour de travail ; supprimée avec la semaine. [US-119 RF4]$$;
COMMENT ON FUNCTION homework_level_progress(uuid, homework_level) IS $$Avancement d'un enfant sur les exercices du manuel France d'un niveau : nombre d'exercices et nombre d'exercices validés sur photos (une case cochée ne compte pas). [US-119 RF6, RF7]$$;
COMMENT ON FUNCTION homework_foreign_unlocked(uuid, homework_level) IS $$Vrai si la moitié au moins des exercices France du niveau est validée sur photos (les manuels étrangers sont alors débloqués) ; faux sans exercice au catalogue. La règle repart à zéro à chaque niveau. [US-119 RF7]$$;
COMMENT ON FUNCTION homework_france_level_done(uuid, homework_level) IS $$Vrai si tous les exercices du manuel France du niveau sont validés sur photos (D65 : une case cochée ne suffit pas) : plusieurs manuels étrangers sont alors possibles dans la semaine. [US-119 RF7]$$;
COMMENT ON FUNCTION erase_member_homework_data(uuid, boolean) IS $$Supprime les données Devoirs d'un enfant : tâches « Devoirs », éléments prévus, manuels proposés, exercices validés et, sauf demande contraire, l'âge des devoirs. Appelée au retrait et à l'effacement du membre. [US-93, US-119 RT5]$$;
COMMENT ON FUNCTION erase_family_homework_progress(uuid, boolean) IS $$Efface les plannings et les progrès Devoirs d'une famille : semaines préparées (avec éléments et tâches « Devoirs »), exercices validés et, si demandé, l'âge des devoirs (conservé par défaut : c'est le comportement de l'écran, D65). Retourne le nombre de lignes supprimées. [US-118 RF5, US-119 RT5]$$;
COMMENT ON FUNCTION purge_expired_homework_data() IS $$Supprime les semaines de devoirs (avec éléments, manuels proposés et tâches « Devoirs ») 12 mois après la semaine, et les exercices validés des enfants dont la famille n'a plus l'aide Devoirs active depuis plus de 30 jours (homework_validation_grace_days). À planifier chaque jour. [US-119 RT5, D65]$$;
