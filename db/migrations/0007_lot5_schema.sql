-- MAAQ — lot 5 : Tâches
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_5_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
CREATE TYPE task_status           AS ENUM ('proposed', 'todo', 'done', 'cancelled');
CREATE TYPE task_cancel_reason    AS ENUM ('user', 'event_cancelled', 'series_ended', 'expired');
CREATE TYPE task_source           AS ENUM ('user', 'agent', 'anticipation');

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Tâches (US-110, US-95, US-96) : une tâche seule, liée à un RDV, ou l'occurrence d'une tâche récurrente
-- ---------------------------------------------------------------------
CREATE TABLE family_task_series (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  title                bytea NOT NULL,
  note                 bytea,
  assigned_member_id   uuid,
  due_time             time,
  -- Deux modes exclusifs : règle propre (les poubelles chaque mardi) ou « une tâche par séance » d'une série de RDV (US-95 RF9)
  event_series_id      uuid,
  days_before_event    smallint CHECK (days_before_event >= 0),
  first_date           date,
  repeat_unit          series_repeat_unit,
  repeat_interval      smallint NOT NULL DEFAULT 1,
  weekdays             smallint[],
  month_mode           series_month_mode,
  month_day            smallint,
  month_nth            smallint,
  month_weekday        smallint,
  end_kind             series_end_kind NOT NULL DEFAULT 'never',
  until_date           date,
  occurrence_count     integer CHECK (occurrence_count > 0),
  -- Dernière date pour laquelle les occurrences sont créées (8 semaines glissantes)
  materialized_until   date,
  ended_at             timestamptz,
  -- Modèle proposé avec une série de RDV provisoire (D48) : sans occurrence tant que la série n'est pas confirmée
  proposed             boolean NOT NULL DEFAULT false,
  created_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  source               task_source NOT NULL DEFAULT 'user',
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT ck_task_series_proposed CHECK (NOT proposed OR event_series_id IS NOT NULL),
  CONSTRAINT fk_task_series_member FOREIGN KEY (assigned_member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_task_series_event_series FOREIGN KEY (event_series_id, account_id)
    REFERENCES family_event_series (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_task_series_mode CHECK (
    (event_series_id IS NOT NULL AND days_before_event IS NOT NULL AND first_date IS NULL AND repeat_unit IS NULL
       AND repeat_interval = 1 AND weekdays IS NULL AND month_mode IS NULL AND month_day IS NULL AND month_nth IS NULL
       AND month_weekday IS NULL AND end_kind = 'never' AND until_date IS NULL AND occurrence_count IS NULL)
    OR (event_series_id IS NULL AND days_before_event IS NULL AND first_date IS NOT NULL AND repeat_unit IS NOT NULL
       AND series_rule_valid(repeat_unit, repeat_interval, weekdays, month_mode, month_day, month_nth, month_weekday))),
  CONSTRAINT ck_task_series_end CHECK (
    (end_kind = 'date') = (until_date IS NOT NULL) AND (end_kind = 'count') = (occurrence_count IS NOT NULL)
    AND (until_date IS NULL OR first_date IS NULL OR until_date >= first_date))
);
CREATE TABLE family_tasks (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  series_id                  uuid,
  -- Date d'origine de l'occurrence dans la série : clé d'idempotence du planificateur
  occurrence_date            date,
  event_id                   uuid,
  -- Chiffrés. Pour un RDV médical, titre générique sans spécialité ni motif (AT-4)
  title                      bytea NOT NULL,
  note                       bytea,
  status                     task_status NOT NULL DEFAULT 'todo',
  -- Échéance : date locale (fuseau de la famille) et heure facultative (« avant 8 h 15 »)
  due_date                   date NOT NULL,
  due_time                   time,
  -- Tâche relative à un RDV : écart conservé quand le RDV est déplacé (US-95 RF6)
  days_before_event          smallint CHECK (days_before_event >= 0),
  -- Toujours un membre, jamais un profil (US-96 RT1) ; NULL = personne, suivie par les deux parents (AT-3)
  assigned_member_id         uuid,
  done_by_member_id          uuid,
  done_at                    timestamptz,
  status_changed_at          timestamptz NOT NULL DEFAULT now(),
  status_changed_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  cancel_reason              task_cancel_reason,
  created_by_user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  source                     task_source NOT NULL DEFAULT 'user',
  version                    integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_tasks_series FOREIGN KEY (series_id, account_id)
    REFERENCES family_task_series (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_tasks_event FOREIGN KEY (event_id, account_id)
    REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_tasks_assigned FOREIGN KEY (assigned_member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_tasks_done_by FOREIGN KEY (done_by_member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_tasks_done CHECK ((status = 'done') = (done_at IS NOT NULL) AND (status = 'done') = (done_by_member_id IS NOT NULL)),
  CONSTRAINT ck_tasks_cancelled CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CONSTRAINT ck_tasks_proposed CHECK (status <> 'proposed' OR event_id IS NOT NULL),
  CONSTRAINT ck_tasks_offset CHECK (days_before_event IS NULL OR event_id IS NOT NULL),
  CONSTRAINT ck_tasks_occurrence CHECK (series_id IS NULL OR occurrence_date IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION change_family_event_status(
  p_event_id uuid, p_to event_status, p_user_id uuid,
  p_expected_version integer DEFAULT NULL, p_reason event_change_reason DEFAULT 'user_request',
  p_scope change_scope DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_event family_events%ROWTYPE; v_tz text;
BEGIN
  SELECT * INTO v_event FROM family_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_expected_version IS NOT NULL AND v_event.version <> p_expected_version THEN RETURN false; END IF;
  IF NOT family_event_transition_allowed(v_event.status, p_to) THEN RETURN false; END IF;
  IF p_to = 'confirmed' THEN
    IF v_event.starts_at <= now() THEN
      RAISE EXCEPTION 'Ce rendez-vous est déjà passé' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT v_event.whole_family AND NOT EXISTS (SELECT 1 FROM family_event_members WHERE event_id = p_event_id) THEN
      RAISE EXCEPTION 'Précisez le membre concerné avant de confirmer' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE family_events
     SET status = p_to,
         confirmed_by_user_id = CASE WHEN p_to = 'confirmed' THEN p_user_id ELSE confirmed_by_user_id END,
         confirmed_at = CASE WHEN p_to = 'confirmed' THEN now() ELSE confirmed_at END,
         auto_confirmed = CASE WHEN p_to = 'confirmed' AND p_user_id IS NULL AND p_reason = 'no_response' THEN true ELSE auto_confirmed END
   WHERE id = p_event_id;
  -- Les tâches proposées avec le RDV deviennent « à faire » avec lui, en une seule opération (D48). Une échéance devenue passée
  -- entre-temps est ramenée à aujourd'hui : une tâche ne naît pas en retard.
  IF p_to = 'confirmed' THEN
    SELECT family_timezone INTO v_tz FROM accounts WHERE id = v_event.account_id;
    UPDATE family_tasks
       SET status = 'todo', status_changed_by_user_id = p_user_id, due_date = GREATEST(due_date, (now() AT TIME ZONE v_tz)::date)
     WHERE event_id = p_event_id AND status = 'proposed';
  END IF;
  IF p_to IN ('cancelled', 'dismissed') THEN
    UPDATE family_tasks
       SET status = 'cancelled', cancel_reason = 'event_cancelled', status_changed_by_user_id = p_user_id
     WHERE event_id = p_event_id AND status IN ('proposed', 'todo');
  END IF;
  INSERT INTO family_event_history (event_id, user_id, action, from_status, to_status, reason, series_id, scope)
  VALUES (p_event_id, p_user_id,
          CASE p_to WHEN 'confirmed' THEN 'confirmed' WHEN 'set_aside' THEN 'set_aside'
                    WHEN 'dismissed' THEN 'dismissed' ELSE 'cancelled' END::event_action,
          v_event.status, p_to, p_reason, v_event.series_id, CASE WHEN v_event.series_id IS NOT NULL THEN p_scope END);
  RETURN true;
END $$;
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
CREATE OR REPLACE FUNCTION confirm_family_series(p_series_id uuid, p_user_id uuid, p_expected_version integer DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_series family_event_series%ROWTYPE; v_id uuid; v_n integer := 0;
BEGIN
  SELECT * INTO v_series FROM family_event_series WHERE id = p_series_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_expected_version IS NOT NULL AND v_series.version <> p_expected_version THEN RETURN NULL; END IF;
  IF v_series.status <> 'provisional' THEN RETURN NULL; END IF;
  UPDATE family_event_series
     SET status = 'confirmed', confirmed_by_user_id = p_user_id, confirmed_at = now()
   WHERE id = p_series_id;
  -- Les modèles de tâches proposés avec la série deviennent des tâches récurrentes, en même temps qu'elle (D48)
  UPDATE family_task_series SET proposed = false WHERE event_series_id = p_series_id AND proposed;
  FOR v_id IN SELECT id FROM family_events
               WHERE series_id = p_series_id AND status IN ('provisional', 'set_aside') AND starts_at > now()
               ORDER BY starts_at LOOP
    IF NOT change_family_event_status(v_id, 'confirmed', p_user_id, NULL, 'user_request', 'all') THEN
      RAISE EXCEPTION 'La séance % ne peut pas être confirmée', v_id USING ERRCODE = 'check_violation';
    END IF;
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'Aucune séance à venir à confirmer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_n;
END $$;
CREATE OR REPLACE FUNCTION cancel_family_series(p_series_id uuid, p_user_id uuid, p_expected_version integer DEFAULT NULL,
                                     p_reason event_change_reason DEFAULT 'user_request')
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_series family_event_series%ROWTYPE; v_to event_status; v_from event_status; v_id uuid; v_n integer := 0;
BEGIN
  SELECT * INTO v_series FROM family_event_series WHERE id = p_series_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_expected_version IS NOT NULL AND v_series.version <> p_expected_version THEN RETURN NULL; END IF;
  IF v_series.status = 'provisional' THEN v_to := 'dismissed'; v_from := 'provisional';
  ELSIF v_series.status = 'confirmed' THEN v_to := 'cancelled'; v_from := 'confirmed';
  ELSE RETURN NULL; END IF;
  FOR v_id IN SELECT id FROM family_events
               WHERE series_id = p_series_id AND starts_at > now()
                 AND (status = v_from OR (v_from = 'provisional' AND status = 'set_aside'))
               ORDER BY starts_at LOOP
    IF NOT change_family_event_status(v_id, v_to, p_user_id, NULL, p_reason, 'all') THEN
      RAISE EXCEPTION 'La séance % ne peut pas être annulée', v_id USING ERRCODE = 'check_violation';
    END IF;
    v_n := v_n + 1;
  END LOOP;
  UPDATE family_event_series SET status = v_to, ended_at = now() WHERE id = p_series_id;
  -- Modèles de tâches proposés avec une série jamais confirmée : abandonnés sans trace (D48)
  DELETE FROM family_task_series WHERE event_series_id = p_series_id AND proposed;
  UPDATE family_task_series SET ended_at = now() WHERE event_series_id = p_series_id AND ended_at IS NULL;
  RETURN v_n;
END $$;
-- Tâche récurrente : au plus 50 actives par famille (règle propre) ; au plus 10 tâches par série de RDV (D47, PO du 26/10/2026)
CREATE FUNCTION family_task_series_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  IF NEW.assigned_member_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM family_members WHERE id = NEW.assigned_member_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Une tâche ne peut être assignée qu''à un membre actif' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ended_at IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.event_series_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family_task_series:' || NEW.account_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_recurring_tasks_per_family';
    SELECT count(*) INTO v_count FROM family_task_series
     WHERE account_id = NEW.account_id AND event_series_id IS NULL AND ended_at IS NULL;
    IF v_count >= COALESCE(v_max, 50) THEN
      RAISE EXCEPTION 'Nombre maximal de tâches récurrentes atteint (%)', COALESCE(v_max, 50) USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('event_tasks:' || NEW.event_series_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_tasks_per_event';
    SELECT count(*) INTO v_count FROM family_task_series WHERE event_series_id = NEW.event_series_id AND ended_at IS NULL;
    IF v_count >= COALESCE(v_max, 10) THEN
      RAISE EXCEPTION 'Au plus % tâches préparatoires par série de RDV', COALESCE(v_max, 10) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION family_task_series_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_member_id IS NOT NULL AND NEW.assigned_member_id IS DISTINCT FROM OLD.assigned_member_id
     AND EXISTS (SELECT 1 FROM family_members WHERE id = NEW.assigned_member_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Une tâche ne peut être assignée qu''à un membre actif' USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
-- Transitions d'une tâche (AT-1) : proposée → à faire / annulée ; à faire → faite / annulée ; faite → à faire (annulation du cochage)
CREATE FUNCTION family_task_transition_allowed(p_from task_status, p_to task_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (
    ('proposed', 'todo'), ('proposed', 'cancelled'),
    ('todo', 'done'), ('todo', 'cancelled'),
    ('done', 'todo'))
$$;
-- Au plus 10 tâches préparatoires par RDV (US-95 RF8) : les tâches proposées, à faire et faites, hors annulées. Les proposées
-- comptent (D48) : elles deviennent « à faire » avec le RDV, la confirmation ne doit pas échouer à la 11e tâche.
CREATE FUNCTION check_event_task_limit(p_event_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('event_tasks:' || p_event_id::text, 0));
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_tasks_per_event';
  SELECT count(*) INTO v_count FROM family_tasks
   WHERE event_id = p_event_id AND series_id IS NULL AND status IN ('proposed', 'todo', 'done');
  IF v_count >= COALESCE(v_max, 10) THEN
    RAISE EXCEPTION 'Au plus % tâches préparatoires par RDV', COALESCE(v_max, 10) USING ERRCODE = 'check_violation';
  END IF;
END $$;
-- Une tâche proposée n'a jamais d'échéance déjà passée ni postérieure au RDV (dates locales, fuseau de la famille). Contrôle
-- seulement tant que le RDV est à venir : un RDV passé n'est plus proposé à personne (D51).
CREATE FUNCTION check_proposed_task_due(p_account_id uuid, p_event_id uuid, p_due date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_tz text; v_start timestamptz;
BEGIN
  SELECT starts_at INTO v_start FROM family_events WHERE id = p_event_id;
  IF v_start IS NULL OR v_start <= now() THEN RETURN; END IF;
  SELECT family_timezone INTO v_tz FROM accounts WHERE id = p_account_id;
  IF p_due < (now() AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'Une tâche proposée ne peut pas avoir une échéance passée' USING ERRCODE = 'check_violation';
  END IF;
  IF p_due > (v_start AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'Une tâche proposée ne peut pas être due après le RDV' USING ERRCODE = 'check_violation';
  END IF;
END $$;
CREATE FUNCTION family_task_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_member_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM family_members WHERE id = NEW.assigned_member_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Une tâche ne peut être assignée qu''à un membre actif' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('proposed', 'todo', 'done') AND NEW.event_id IS NOT NULL AND NEW.series_id IS NULL THEN
    PERFORM check_event_task_limit(NEW.event_id);
  END IF;
  IF NEW.status = 'proposed' AND NEW.event_id IS NOT NULL THEN
    PERFORM check_proposed_task_due(NEW.account_id, NEW.event_id, NEW.due_date);
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION family_task_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT family_task_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Transition de statut interdite pour la tâche : % vers %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
    IF OLD.status = 'done' THEN
      NEW.done_at := NULL;
      NEW.done_by_member_id := NULL;
    END IF;
  END IF;
  -- Pas de nouveau contrôle de plafond à l'ajout d'une tâche proposée : elle compte déjà depuis sa création
  IF NEW.status = 'proposed' AND NEW.event_id IS NOT NULL AND NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    PERFORM check_proposed_task_due(NEW.account_id, NEW.event_id, NEW.due_date);
  END IF;
  IF NEW.assigned_member_id IS NOT NULL AND NEW.assigned_member_id IS DISTINCT FROM OLD.assigned_member_id
     AND EXISTS (SELECT 1 FROM family_members WHERE id = NEW.assigned_member_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Une tâche ne peut être assignée qu''à un membre actif' USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
-- Changement de statut atomique d'une tâche, avec contrôle de version. « Faite par » = le membre du profil qui coche.
-- Retourne false si la tâche est introuvable, modifiée entre-temps ou si la transition n'est pas permise.
CREATE FUNCTION change_family_task_status(
  p_task_id uuid, p_to task_status, p_user_id uuid,
  p_expected_version integer DEFAULT NULL, p_cancel_reason task_cancel_reason DEFAULT 'user'
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_task family_tasks%ROWTYPE; v_member uuid;
BEGIN
  SELECT * INTO v_task FROM family_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_expected_version IS NOT NULL AND v_task.version <> p_expected_version THEN RETURN false; END IF;
  IF NOT family_task_transition_allowed(v_task.status, p_to) THEN RETURN false; END IF;
  IF p_to = 'done' THEN
    SELECT id INTO v_member FROM family_members WHERE user_id = p_user_id AND account_id = v_task.account_id;
    IF NOT FOUND THEN
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
-- Termine une tâche récurrente (« Toutes », ou fin de la règle) : les occurrences à faire à partir d'aujourd'hui sont annulées.
-- Retourne le nombre d'occurrences annulées.
CREATE FUNCTION end_family_task_series(p_series_id uuid, p_user_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  UPDATE family_task_series SET ended_at = COALESCE(ended_at, now()) WHERE id = p_series_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE family_tasks
     SET status = 'cancelled', cancel_reason = 'series_ended', status_changed_by_user_id = p_user_id
   WHERE series_id = p_series_id AND status IN ('proposed', 'todo') AND due_date >= current_date;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- Nombre de tâches retirées avec un RDV annulé ou ignoré : « 2 tâches de préparation ont été retirées » (US-95 RF7)
CREATE FUNCTION family_event_retired_task_count(p_event_id uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM family_tasks WHERE event_id = p_event_id AND status = 'cancelled' AND cancel_reason = 'event_cancelled'
$$;
-- Droits sur les tâches (AT-2, D26) : parents = toutes ; invité secondaire = celles qu'il a créées, celles qui lui sont assignées
-- et celles des RDV qu'il voit. Les tâches annulées ne s'affichent pas ; une tâche proposée n'est vue que des parents et du demandeur du RDV.
CREATE FUNCTION family_tasks_visible_to(p_viewer uuid) RETURNS SETOF family_tasks
LANGUAGE sql STABLE AS $$
  SELECT t.*
    FROM family_tasks t
    JOIN users v ON v.id = p_viewer AND v.account_id = t.account_id
   WHERE t.status <> 'cancelled'
     AND ( v.role = 'primary_user' OR v.guest_rank = 'core'
        OR ( t.status <> 'proposed'
             AND ( t.created_by_user_id = v.id
                OR EXISTS (SELECT 1 FROM family_members fm WHERE fm.id = t.assigned_member_id AND fm.user_id = v.id)
                OR t.event_id IN (SELECT id FROM family_events_visible_to(p_viewer)) ) )
        OR ( t.status = 'proposed'
             AND EXISTS (SELECT 1 FROM family_events e WHERE e.id = t.event_id AND e.requested_by_user_id = v.id) ) )
$$;
-- Droit de modifier, assigner ou annuler : parents = toutes ; invité secondaire = les tâches qu'il a créées
CREATE FUNCTION can_manage_family_task(p_user_id uuid, p_task_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM family_tasks t JOIN users u ON u.id = p_user_id AND u.account_id = t.account_id
     WHERE t.id = p_task_id
       AND (u.role = 'primary_user' OR u.guest_rank = 'core' OR t.created_by_user_id = u.id))
$$;
-- Droit de cocher : le droit de gérer, plus les tâches assignées à son propre membre
CREATE FUNCTION can_check_family_task(p_user_id uuid, p_task_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT can_manage_family_task(p_user_id, p_task_id)
      OR EXISTS (SELECT 1 FROM family_tasks t JOIN family_members fm ON fm.id = t.assigned_member_id
                  WHERE t.id = p_task_id AND fm.user_id = p_user_id)
$$;
-- « En retard » n'est pas un statut mais un affichage : tâche à faire dont l'échéance est passée, dans le fuseau de la famille (AT-1)
CREATE VIEW v_family_tasks AS
SELECT t.*,
       (t.status = 'todo'
        AND ((t.due_date + COALESCE(t.due_time, time '23:59:59')) AT TIME ZONE a.family_timezone) < now()) AS is_overdue
  FROM family_tasks t JOIN accounts a ON a.id = t.account_id;
-- Un membre retiré (archivé, effacé ou profil supprimé) : ses tâches à faire deviennent « non assignées » (US-96 RF8),
-- ses questions d'anticipation disparaissent (information de santé indirecte), ses suivis de trajet sont arrêtés.
CREATE FUNCTION family_member_archived() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE family_tasks SET assigned_member_id = NULL
   WHERE assigned_member_id = NEW.id AND status IN ('proposed', 'todo');
  UPDATE family_task_series SET assigned_member_id = NULL
   WHERE assigned_member_id = NEW.id AND ended_at IS NULL;
  RETURN NEW;
END $$;
-- RDV déplacé : échéance des tâches liées recalculée avec l'écart conservé (US-95 RF6) ; estimations de trajet remises à zéro ;
-- RDV annulé ou ignoré : estimations supprimées ; lieu retiré : plus de suivi (US-107 RF4).
CREATE FUNCTION family_event_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tz text; v_day date;
BEGIN
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
    SELECT family_timezone INTO v_tz FROM accounts WHERE id = NEW.account_id;
    v_day := (NEW.starts_at AT TIME ZONE v_tz)::date;
    -- Tâches à faire : l'écart au RDV est conservé. Tâches proposées : jamais d'échéance passée ni après le RDV (D51)
    UPDATE family_tasks SET due_date = v_day - days_before_event
     WHERE event_id = NEW.id AND days_before_event IS NOT NULL AND status = 'todo';
    UPDATE family_tasks SET due_date = LEAST(v_day, GREATEST((now() AT TIME ZONE v_tz)::date, v_day - days_before_event))
     WHERE event_id = NEW.id AND days_before_event IS NOT NULL AND status = 'proposed';
  END IF;
  RETURN NEW;
END $$;
-- Toute modification de la liste de tâches proposées fait monter la version du RDV : une carte ou un écran périmé est refusé à la
-- confirmation (« Mis à jour »), au lieu d'enregistrer des tâches que le parent ne voyait pas (D51). Pas de montée de version quand
-- le changement vient d'un autre trigger (déplacement du RDV, retrait d'un membre, suppression en cascade).
CREATE FUNCTION family_task_proposed_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_event uuid;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'proposed' THEN v_event := NEW.event_id; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'proposed' THEN v_event := OLD.event_id; END IF;
  ELSIF OLD.status = 'proposed' AND NEW.status = 'proposed' THEN
    v_event := NEW.event_id;
  END IF;
  IF v_event IS NOT NULL THEN
    UPDATE family_events SET updated_at = now() WHERE id = v_event;
  END IF;
  RETURN NULL;
END $$;
-- Tâches : « à faire » jamais faites annulées 45 jours après l'échéance ; proposées supprimées quand le RDV a eu lieu ;
-- faites ou annulées supprimées après 90 jours ; séries terminées sans tâche supprimées. Retourne le nombre de tâches supprimées.
CREATE FUNCTION purge_expired_family_tasks() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_cancel integer; v_keep integer; v_a bigint; v_b bigint;
BEGIN
  SELECT value_text::integer INTO v_cancel FROM platform_settings WHERE setting_key = 'overdue_task_auto_cancel_days';
  SELECT value_text::integer INTO v_keep FROM platform_settings WHERE setting_key = 'task_retention_days';
  UPDATE family_tasks SET status = 'cancelled', cancel_reason = 'expired'
   WHERE status = 'todo' AND due_date < current_date - COALESCE(v_cancel, 45);
  DELETE FROM family_tasks t
   WHERE t.status = 'proposed' AND EXISTS (SELECT 1 FROM family_events e WHERE e.id = t.event_id AND e.ends_at < now());
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM family_tasks
   WHERE status IN ('done', 'cancelled') AND status_changed_at < now() - make_interval(days => COALESCE(v_keep, 90));
  GET DIAGNOSTICS v_b = ROW_COUNT;
  DELETE FROM family_task_series s
   WHERE s.ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM family_tasks t WHERE t.series_id = s.id);
  RETURN v_a + v_b;
END $$;

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
CREATE INDEX idx_task_series_account_active ON family_task_series (account_id) WHERE ended_at IS NULL;
CREATE INDEX idx_task_series_planning ON family_task_series (materialized_until) WHERE ended_at IS NULL AND event_series_id IS NULL;
CREATE INDEX idx_task_series_event_series ON family_task_series (event_series_id);
CREATE INDEX idx_task_series_member ON family_task_series (assigned_member_id);
CREATE INDEX idx_task_series_created_by ON family_task_series (created_by_user_id);
CREATE UNIQUE INDEX ux_tasks_series_occurrence ON family_tasks (series_id, occurrence_date) WHERE series_id IS NOT NULL;
CREATE INDEX idx_tasks_due ON family_tasks (account_id, due_date) WHERE status = 'todo';
CREATE INDEX idx_tasks_closed ON family_tasks (status_changed_at) WHERE status IN ('done', 'cancelled');
CREATE INDEX idx_tasks_event ON family_tasks (event_id);
CREATE INDEX idx_tasks_assigned ON family_tasks (assigned_member_id);
CREATE INDEX idx_tasks_done_by ON family_tasks (done_by_member_id);
CREATE INDEX idx_tasks_status_changed_by ON family_tasks (status_changed_by_user_id);
CREATE INDEX idx_tasks_created_by ON family_tasks (created_by_user_id);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_family_task_series_before_insert BEFORE INSERT ON family_task_series
  FOR EACH ROW EXECUTE FUNCTION family_task_series_before_insert();
CREATE TRIGGER trg_family_task_series_before_update BEFORE UPDATE ON family_task_series
  FOR EACH ROW EXECUTE FUNCTION family_task_series_before_update();
CREATE TRIGGER trg_family_tasks_before_insert BEFORE INSERT ON family_tasks
  FOR EACH ROW EXECUTE FUNCTION family_task_before_insert();
CREATE TRIGGER trg_family_tasks_before_update BEFORE UPDATE ON family_tasks
  FOR EACH ROW EXECUTE FUNCTION family_task_before_update();
-- Pas de « UPDATE OF » : quand le profil est supprimé, c'est un autre trigger (BEFORE UPDATE) qui archive le membre
CREATE TRIGGER trg_family_members_archived AFTER UPDATE ON family_members
  FOR EACH ROW WHEN (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
  EXECUTE FUNCTION family_member_archived();
CREATE TRIGGER trg_family_events_after_change AFTER UPDATE OF starts_at, status ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_after_change();
CREATE TRIGGER trg_family_tasks_proposed_changed AFTER INSERT OR UPDATE OR DELETE ON family_tasks
  FOR EACH ROW EXECUTE FUNCTION family_task_proposed_changed();
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
  ('max_tasks_per_event',                  'integer', '10', 1, NULL, $$Tâches préparatoires au plus par RDV, ou par série de RDV (US-95 RF8)$$),
  ('max_recurring_tasks_per_family',       'integer', '50', 1, NULL, $$Tâches récurrentes actives (règle propre) au plus par famille (US-110 RF11)$$),
  ('task_retention_days',                  'integer', '90', 1, NULL, $$Conservation d'une tâche faite ou annulée, en jours (US-110 RT3)$$),
  ('overdue_task_auto_cancel_days',        'integer', '45', 1, NULL, $$Une tâche « À faire » jamais faite est annulée automatiquement ce nombre de jours après son échéance (D47)$$),
  ('task_series_horizon_weeks',            'integer', '8',  1, NULL, $$Occurrences d'une tâche récurrente créées à l'avance, en semaines glissantes (US-110 RT2)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON TABLE family_task_series IS $$Tâche récurrente (règle propre, au plus 50 actives par famille) ou tâche qui s'applique à chaque séance d'une série de RDV (comptée dans les 10 tâches de la série). Les occurrences sont des lignes de family_tasks, créées 8 semaines à l'avance. [US-110, US-95 RF9, D41]$$;
COMMENT ON COLUMN family_task_series.event_series_id IS $$Mode « suit une série de RDV » : une occurrence par séance, échéance = date de la séance moins days_before_event. NULL = règle propre$$;
COMMENT ON COLUMN family_task_series.proposed IS $$Modèle de tâche proposé avec une série de RDV provisoire : confirm_family_series le passe à faux, le planificateur l'ignore tant qu'il est proposé, l'abandon de la série le supprime (D48)$$;
COMMENT ON COLUMN family_task_series.ended_at IS $$Série terminée ou annulée : plus d'occurrence créée, comptée hors des 50 tâches récurrentes actives$$;
COMMENT ON TABLE family_tasks IS $$Tâche de la famille : préparatoire (liée à un RDV), seule, ou occurrence d'une tâche récurrente. Statuts : proposée, à faire, faite, annulée ; « En retard » est un affichage calculé (v_family_tasks). [US-95, US-96, US-110, AT-1 à AT-5]$$;
COMMENT ON COLUMN family_tasks.status IS $$proposed = suggérée par l'agent, visible dans « À préparer » ; todo ; done (avec auteur et date) ; cancelled (motif obligatoire). « En retard » n'est pas un statut$$;
COMMENT ON COLUMN family_tasks.title IS $$Titre chiffré. Titre générique pour une tâche liée à un RDV médical (AT-4) ; transmis à l'agent uniquement sous forme de référence (D39)$$;
COMMENT ON COLUMN family_tasks.days_before_event IS $$Échéance relative au RDV : nombre de jours avant. L'écart est conservé quand le RDV est déplacé (US-95 RF6)$$;
COMMENT ON COLUMN family_tasks.done_by_member_id IS $$Membre qui a coché la tâche (« Faite par [prénom] ») : le membre survit à la suppression d'un profil, avec son alias$$;
COMMENT ON COLUMN family_tasks.cancel_reason IS $$user ; event_cancelled (RDV annulé ou ignoré) ; series_ended ; expired (jamais faite, annulée automatiquement 45 jours après l'échéance)$$;
COMMENT ON FUNCTION family_task_transition_allowed(task_status, task_status) IS $$Transitions permises de statut d'une tâche : proposée → à faire / annulée ; à faire → faite / annulée ; faite → à faire (le cochage s'annule). Une tâche annulée ne revient pas. [AT-1]$$;
COMMENT ON FUNCTION change_family_task_status(uuid, task_status, uuid, integer, task_cancel_reason) IS $$Change le statut d'une tâche de façon atomique (transition permise, version attendue) ; « faite par » = membre du profil. false = introuvable, modifiée ou transition interdite. [US-110 RF7, AT-1]$$;
COMMENT ON FUNCTION end_family_task_series(uuid, uuid) IS $$Termine une tâche récurrente et annule ses occurrences à faire à partir d'aujourd'hui ; les occurrences en retard restent. [US-110 RF5]$$;
COMMENT ON FUNCTION family_event_retired_task_count(uuid) IS $$Nombre de tâches annulées avec leur RDV (annulation ou abandon), pour la notification aux parents. [US-95 RF7]$$;
COMMENT ON FUNCTION family_tasks_visible_to(uuid) IS $$Tâches visibles par un profil selon son rang (décision D26, AT-2). [US-110, US-96]$$;
COMMENT ON FUNCTION can_manage_family_task(uuid, uuid) IS $$Vrai si le profil peut modifier, assigner ou annuler cette tâche (parents : toutes ; invité secondaire : ses créations). [US-96 RF3, AT-2]$$;
COMMENT ON FUNCTION can_check_family_task(uuid, uuid) IS $$Vrai si le profil peut cocher cette tâche (parents : toutes ; invité secondaire : ses créations et les tâches qui lui sont assignées). [AT-2]$$;
COMMENT ON VIEW v_family_tasks IS $$Tâches avec l'affichage « En retard » calculé (à faire, échéance passée dans le fuseau de la famille). À combiner avec family_tasks_visible_to pour la visibilité. [US-110 RF6, AT-1]$$;
COMMENT ON FUNCTION purge_expired_family_tasks() IS $$Annule les tâches jamais faites 45 jours après leur échéance, supprime les tâches proposées d'un RDV passé, les tâches faites ou annulées après 90 jours et les séries terminées. À planifier chaque jour. [US-110 RT3, US-95 RF10, D47]$$;
