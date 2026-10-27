-- MAAQ — lot 6 : Rappels de tâches et point de la semaine
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_6_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
CREATE TYPE digest_summary_status AS ENUM ('pending', 'generated', 'failed');

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Point de la semaine (US-98) : le résumé de l'agent, une fois par famille ; les listes sont calculées en direct
-- ---------------------------------------------------------------------
CREATE TABLE weekly_digests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Lundi de la semaine couverte
  week_start       date NOT NULL CHECK (date_part('isodow', week_start) = 1),
  summary_status   digest_summary_status NOT NULL DEFAULT 'pending',
  -- Résumé chiffré, rédigé avec des références (jamais de titre, lieu ni prénom) remplacées à l'affichage ; réservé aux parents
  agent_summary    bytea,
  generated_at     timestamptz,
  events_count     integer CHECK (events_count >= 0),
  tasks_count      integer CHECK (tasks_count >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, week_start),
  CONSTRAINT ck_weekly_digests_generated CHECK ((summary_status = 'generated') = (agent_summary IS NOT NULL AND generated_at IS NOT NULL))
);

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- Jour local d'une notification agrégée (rappel quotidien des tâches, point de la semaine : lundi de la semaine couverte)
ALTER TABLE scheduled_notifications
  ADD COLUMN subject_date        date;
-- Échéance d'envoi : au-delà, la notification est abandonnée (rappel de tâches : avant midi, US-97 RF9) ; NULL = début du RDV
ALTER TABLE scheduled_notifications
  ADD COLUMN deadline_at         timestamptz;
ALTER TABLE scheduled_notifications
  ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE user_assistant_settings
  ADD COLUMN task_daily_reminder_enabled  boolean NOT NULL DEFAULT true;
ALTER TABLE user_assistant_settings
  ADD COLUMN weekly_digest_enabled        boolean NOT NULL DEFAULT true;
-- Jour du point de la semaine (ISO, 7 = dimanche) et heure locale (minutes multiples de 5 : planificateur toutes les 5 minutes)
ALTER TABLE user_assistant_settings
  ADD COLUMN weekly_digest_weekday        smallint NOT NULL DEFAULT 7 CHECK (weekly_digest_weekday BETWEEN 1 AND 7);
ALTER TABLE user_assistant_settings
  ADD COLUMN weekly_digest_time           time NOT NULL DEFAULT '19:00'
    CHECK (date_part('minute', weekly_digest_time)::integer % 5 = 0 AND date_part('second', weekly_digest_time) = 0);
-- ---------------------------------------------------------------------
-- scheduled_notifications : sujets sans RDV (tâches, jour, semaine) et trajets
-- ---------------------------------------------------------------------
ALTER TABLE scheduled_notifications
  ADD COLUMN task_id uuid REFERENCES family_tasks (id) ON DELETE CASCADE;
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT ck_scheduled_notifications_subject CHECK (
    CASE WHEN kind IN ('task_daily', 'weekly_digest')
           THEN subject_date IS NOT NULL AND event_id IS NULL AND task_id IS NULL
         WHEN kind IN ('task_due_1h', 'task_assigned')
           THEN task_id IS NOT NULL AND event_id IS NULL AND subject_date IS NULL
         ELSE event_id IS NOT NULL AND task_id IS NULL AND subject_date IS NULL END);

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
CREATE FUNCTION purge_expired_weekly_digests() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_weeks integer; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_weeks FROM platform_settings WHERE setting_key = 'weekly_digest_retention_weeks';
  DELETE FROM weekly_digests WHERE week_start < current_date - COALESCE(v_weeks, 4) * 7;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- Notifications sans RDV (tâches, point de la semaine) : supprimées 30 jours après l'échéance (celles liées à un RDV partent avec lui)
CREATE FUNCTION purge_old_scheduled_notifications() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_days integer; v_n bigint; v_m bigint;
BEGIN
  SELECT value_text::integer INTO v_days FROM platform_settings WHERE setting_key = 'notification_retention_days';
  DELETE FROM scheduled_notifications
   WHERE event_id IS NULL AND status <> 'scheduled' AND due_at < now() - make_interval(days => COALESCE(v_days, 30));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- Registre des notifications « RDV ajouté » et « RDV à confirmer » : supprimé 30 jours après la fin du RDV (il part de toute façon avec le RDV)
  DELETE FROM scheduled_notifications n USING family_events e
   WHERE e.id = n.event_id AND n.kind IN ('event_added', 'event_to_confirm') AND n.status <> 'scheduled'
     AND e.ends_at < now() - make_interval(days => COALESCE(v_days, 30));
  GET DIAGNOSTICS v_m = ROW_COUNT;
  RETURN v_n + v_m;
END $$;

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
CREATE INDEX idx_weekly_digests_week ON weekly_digests (week_start);
CREATE UNIQUE INDEX ux_scheduled_notifications_task ON scheduled_notifications (task_id, kind, recipient_user_id, due_at)
  WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX ux_scheduled_notifications_day ON scheduled_notifications (kind, recipient_user_id, subject_date)
  WHERE subject_date IS NOT NULL;
CREATE INDEX idx_scheduled_notifications_task_id ON scheduled_notifications (task_id) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
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
-- Réglages du MVP2 (US-65)
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('overdue_task_reminder_days',           'integer', '7',  1, NULL, $$Une tâche en retard figure dans le rappel quotidien pendant ce nombre de jours (US-97 RF6)$$),
  ('weekly_digest_retention_weeks',        'integer', '4',  1, NULL, $$Conservation du point hebdomadaire, en semaines (US-98 RT3)$$),
  ('notification_retention_days',          'integer', '30', 1, NULL, $$Conservation des notifications sans RDV (tâches, point de la semaine) après leur échéance, en jours$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON TABLE weekly_digests IS $$Résumé de l'agent du point hebdomadaire, une fois par famille et par semaine, conservé 4 semaines. Les listes (RDV, tâches, points d'attention) sont calculées en direct selon la visibilité du profil ; l'invité secondaire n'a pas le résumé de l'agent. [US-98]$$;
COMMENT ON FUNCTION purge_expired_weekly_digests() IS $$Supprime les résumés du point hebdomadaire de plus de 4 semaines. À planifier chaque jour. [US-98 RT3]$$;
COMMENT ON FUNCTION purge_old_scheduled_notifications() IS $$Supprime les notifications sans RDV (tâches, point de la semaine) traitées depuis plus de 30 jours, et le registre des notifications « RDV ajouté » ou « RDV à confirmer » 30 jours après la fin du RDV. À planifier chaque jour. [US-97, US-98, US-113]$$;
