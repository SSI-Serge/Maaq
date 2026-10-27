-- Copié TEL QUEL de la session « base de données » : migrations/lot_4_2_schema.sql (SHA-256 79f4db535440dd65…, le 27/10/2026).
-- Lot 4 du MVP2 (RDV récurrents, US-109). Ne jamais modifier à la main ; appliqué dans sa propre transaction.
-- MAAQ — lot 4 : RDV récurrents
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_4_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
-- MVP2 « Calendrier intelligent » : séries, tâches, anticipation, point hebdomadaire, trajets
CREATE TYPE series_repeat_unit    AS ENUM ('day', 'week', 'month');
CREATE TYPE series_month_mode     AS ENUM ('day_of_month', 'nth_weekday');
CREATE TYPE series_end_kind       AS ENUM ('date', 'count', 'never');
CREATE TYPE change_scope          AS ENUM ('this', 'following', 'all');

-- ---------------------------------------------------------------------
-- Fonctions appelées par les contraintes des tables ci-dessous
-- ---------------------------------------------------------------------
-- Règle de répétition valide, partagée par les séries de RDV et de tâches (US-109 RF2, US-110 RF3)
CREATE FUNCTION series_rule_valid(
  p_unit series_repeat_unit, p_interval smallint, p_weekdays smallint[],
  p_month_mode series_month_mode, p_month_day smallint, p_month_nth smallint, p_month_weekday smallint
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(CASE p_unit
    WHEN 'day' THEN p_interval = 1 AND p_weekdays IS NULL AND p_month_mode IS NULL
                    AND p_month_day IS NULL AND p_month_nth IS NULL AND p_month_weekday IS NULL
    WHEN 'week' THEN p_interval IN (1, 2) AND p_weekdays IS NOT NULL
                    AND cardinality(p_weekdays) BETWEEN 1 AND 7
                    AND p_weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
                    AND (SELECT count(DISTINCT w) FROM unnest(p_weekdays) w) = cardinality(p_weekdays)
                    AND p_month_mode IS NULL AND p_month_day IS NULL AND p_month_nth IS NULL AND p_month_weekday IS NULL
    WHEN 'month' THEN p_interval = 1 AND p_weekdays IS NULL AND (
                      (p_month_mode = 'day_of_month' AND p_month_day BETWEEN 1 AND 31
                         AND p_month_nth IS NULL AND p_month_weekday IS NULL)
                   OR (p_month_mode = 'nth_weekday' AND p_month_nth IN (1, 2, 3, 4, -1)
                         AND p_month_weekday BETWEEN 1 AND 7 AND p_month_day IS NULL))
    ELSE false END, false)
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
CREATE TABLE family_event_series (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_type_id           integer NOT NULL REFERENCES event_types (id) ON DELETE RESTRICT,
  -- Modèle des séances. Chiffrés ; titre NULL pour un RDV médical (comme family_events)
  title                   bytea,
  location                bytea,
  -- Coordonnées du lieu (latitude, longitude), chiffrées. Jamais pour un RDV médical ; jamais une adresse de domicile (D47)
  location_point          bytea,
  note                    bytea,
  -- Heure locale de début (dans series_timezone) et durée : un changement d'heure ne décale pas l'heure locale (US-109 RT4)
  start_time              time NOT NULL,
  duration_minutes        integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 1 AND 1440),
  all_day                 boolean NOT NULL DEFAULT false,
  whole_family            boolean NOT NULL DEFAULT false,
  series_timezone         text NOT NULL DEFAULT 'Europe/Paris' CHECK (series_timezone ~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$'),
  -- Première date de la règle (ancre de « toutes les deux semaines »)
  first_date              date NOT NULL,
  repeat_unit             series_repeat_unit NOT NULL,
  repeat_interval         smallint NOT NULL DEFAULT 1,
  -- Jours de la semaine, ISO : 1 = lundi … 7 = dimanche
  weekdays                smallint[],
  month_mode              series_month_mode,
  month_day               smallint,
  -- 1 à 4 = premier à quatrième, -1 = dernier ; month_weekday : ISO 1 à 7
  month_nth               smallint,
  month_weekday           smallint,
  end_kind                series_end_kind NOT NULL DEFAULT 'never',
  until_date              date,
  -- Nombre de séances réellement tenues, hors vacances sautées (D47)
  occurrence_count        integer CHECK (occurrence_count > 0),
  skip_school_holidays    boolean NOT NULL DEFAULT false,
  status                  event_status NOT NULL DEFAULT 'provisional',
  status_changed_at       timestamptz NOT NULL DEFAULT now(),
  -- Dernière date pour laquelle les séances ont été créées : le planificateur ne complète que vers l'avant
  materialized_until      date,
  -- Renseignée quand la règle n'a plus de séance à venir ou que la série est annulée : la série n'est plus « active »
  ended_at                timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  source                  event_source NOT NULL,
  requested_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  source_at               timestamptz,
  source_message_id       bigint REFERENCES agent_conversation_messages (id) ON DELETE SET NULL,
  source_inbound_email_id uuid REFERENCES inbound_emails (id) ON DELETE SET NULL,
  created_via_agent_id    bigint REFERENCES agents (id) ON DELETE RESTRICT,
  confirmed_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  confirmed_at            timestamptz,
  -- « Cette séance et les suivantes » : la série est scindée, la nouvelle garde un lien vers l'ancienne
  split_from_series_id    uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_event_series_split FOREIGN KEY (split_from_series_id, account_id)
    REFERENCES family_event_series (id, account_id) ON DELETE SET NULL (split_from_series_id),
  CONSTRAINT ck_event_series_unit CHECK (repeat_unit <> 'day'),
  CONSTRAINT ck_event_series_rule CHECK (series_rule_valid(repeat_unit, repeat_interval, weekdays, month_mode, month_day, month_nth, month_weekday)),
  CONSTRAINT ck_event_series_end CHECK (
    (end_kind = 'date') = (until_date IS NOT NULL) AND (end_kind = 'count') = (occurrence_count IS NOT NULL)
    AND (until_date IS NULL OR until_date >= first_date)),
  CONSTRAINT ck_event_series_status CHECK (status IN ('provisional', 'confirmed', 'cancelled', 'dismissed')),
  CONSTRAINT ck_event_series_confirmed CHECK ((status IN ('confirmed', 'cancelled')) = (confirmed_at IS NOT NULL)),
  CONSTRAINT ck_event_series_location_point CHECK (location_point IS NULL OR location IS NOT NULL)
);
-- Membres concernés par la série ; les séances les recopient à leur création (comme family_event_members)
CREATE TABLE family_event_series_members (
  series_id   uuid NOT NULL,
  member_id   uuid NOT NULL,
  account_id  uuid NOT NULL,
  PRIMARY KEY (series_id, member_id),
  CONSTRAINT fk_series_members_series FOREIGN KEY (series_id, account_id)
    REFERENCES family_event_series (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_series_members_member FOREIGN KEY (member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED
);
-- ---------------------------------------------------------------------
-- Réglages : famille (zone scolaire, catalogue d'anticipation) et profil (rappels de tâches, point hebdomadaire)
-- ---------------------------------------------------------------------
CREATE TABLE family_settings (
  account_id            uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  -- Zone scolaire (A, B ou C) pour « Sauf vacances scolaires » ; NULL = non réglée, l'option n'est pas proposée (US-109 RF4)
  school_zone           char(1) CHECK (school_zone IN ('A', 'B', 'C')),
  updated_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- Vacances scolaires par zone, chargées chaque année depuis la source officielle (US-109 RT3)
CREATE TABLE school_holiday_periods (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zone         char(1) NOT NULL CHECK (zone IN ('A', 'B', 'C')),
  school_year  varchar(9) NOT NULL CHECK (school_year ~ '^[0-9]{4}-[0-9]{4}$'),
  label        varchar(80) NOT NULL,
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  UNIQUE (zone, starts_on),
  CONSTRAINT ck_school_holiday_period CHECK (ends_on >= starts_on)
);

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- MVP2 : séance d'une série (US-109). La série supprimée, la séance reste un RDV ordinaire (SET NULL)
ALTER TABLE family_events
  ADD COLUMN series_id               uuid;
-- Date locale d'origine de la séance dans la série : clé stable, même si la séance est déplacée
ALTER TABLE family_events
  ADD COLUMN occurrence_date         date;
-- Séance modifiée seule, qui reste rattachée à la série (mention « Modifiée », US-109 RF8)
ALTER TABLE family_events
  ADD COLUMN is_modified             boolean NOT NULL DEFAULT false;
ALTER TABLE family_events
  ADD CONSTRAINT fk_family_events_series FOREIGN KEY (series_id, account_id)
    REFERENCES family_event_series (id, account_id) ON DELETE SET NULL (series_id);
ALTER TABLE family_events
  ADD CONSTRAINT ck_family_events_series CHECK (series_id IS NULL OR occurrence_date IS NOT NULL);
-- MVP2 : série concernée et portée du changement ; l'onglet « Famille » regroupe en une ligne les changements d'une même série
ALTER TABLE family_event_history
  ADD COLUMN series_id    uuid REFERENCES family_event_series (id) ON DELETE SET NULL;
ALTER TABLE family_event_history
  ADD COLUMN scope        change_scope;

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
-- Hebdomadaire ou plus fréquent : seul le rappel J-1 est envoyé pour chaque séance. Toutes les deux semaines et chaque mois
-- suivent les délais de rappel du type de RDV (décision du PO du 26/10/2026, D46).
CREATE FUNCTION series_only_d1_reminder(p_unit series_repeat_unit, p_interval smallint) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_unit IN ('day', 'week') AND p_interval = 1
$$;
CREATE OR REPLACE FUNCTION family_event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  -- Les séances d'une série n'entrent pas dans ce plafond : une série compte pour un RDV (US-109)
  IF NEW.source_inbound_email_id IS NOT NULL AND NEW.series_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family_events_mail:' || NEW.source_inbound_email_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_events_per_email';
    SELECT count(*) INTO v_count FROM family_events WHERE source_inbound_email_id = NEW.source_inbound_email_id AND series_id IS NULL;
    IF v_count >= COALESCE(v_max, 30) THEN
      RAISE EXCEPTION 'Au plus % RDV par mail', COALESCE(v_max, 30) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP FUNCTION change_family_event_status(uuid, event_status, uuid, integer, event_change_reason);
CREATE FUNCTION change_family_event_status(
  p_event_id uuid, p_to event_status, p_user_id uuid,
  p_expected_version integer DEFAULT NULL, p_reason event_change_reason DEFAULT 'user_request',
  p_scope change_scope DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_event family_events%ROWTYPE;
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
  INSERT INTO family_event_history (event_id, user_id, action, from_status, to_status, reason, series_id, scope)
  VALUES (p_event_id, p_user_id,
          CASE p_to WHEN 'confirmed' THEN 'confirmed' WHEN 'set_aside' THEN 'set_aside'
                    WHEN 'dismissed' THEN 'dismissed' ELSE 'cancelled' END::event_action,
          v_event.status, p_to, p_reason, v_event.series_id, CASE WHEN v_event.series_id IS NOT NULL THEN p_scope END);
  RETURN true;
END $$;
CREATE OR REPLACE VIEW v_family_logbook AS
-- Une série confirmée ou annulée en une fois produit une seule ligne (même série, même action, même auteur, même transaction)
(SELECT DISTINCT ON (COALESCE(h.series_id, h.event_id), h.action, h.user_id, h.occurred_at, CASE WHEN h.series_id IS NULL THEN h.id END)
        h.event_id AS family_event_id, NULL::uuid AS inbound_email_id, e.account_id, h.occurred_at,
        h.user_id AS actor_user_id,
        CASE h.action WHEN 'confirmed' THEN CASE WHEN h.user_id IS NULL AND h.reason = 'no_response' THEN 'event_auto_confirmed' ELSE 'event_confirmed' END
                      WHEN 'set_aside' THEN 'event_set_aside'
                      WHEN 'dismissed' THEN 'event_dismissed' WHEN 'modified' THEN 'event_modified'
                      ELSE 'event_cancelled' END AS entry_kind
   FROM family_event_history h JOIN family_events e ON e.id = h.event_id
  WHERE h.action IN ('confirmed', 'set_aside', 'dismissed', 'modified', 'cancelled')
    AND (h.user_id IS NOT NULL OR h.action IN ('modified', 'cancelled') OR (h.action = 'confirmed' AND h.reason = 'no_response'))
  ORDER BY COALESCE(h.series_id, h.event_id), h.action, h.user_id, h.occurred_at, CASE WHEN h.series_id IS NULL THEN h.id END, h.event_id)
UNION ALL
SELECT p.event_id, p.source_inbound_email_id, p.account_id, p.decided_at, p.decided_by_user_id,
       CASE p.status WHEN 'accepted' THEN 'proposal_accepted' ELSE 'proposal_declined' END
  FROM family_event_change_proposals p WHERE p.status IN ('accepted', 'declined')
UNION ALL
SELECT NULL::uuid, i.id, i.account_id, i.received_at, i.forwarded_by_user_id,
       CASE i.status WHEN 'processed' THEN 'mail_received' WHEN 'irrelevant' THEN 'mail_not_retained'
                     WHEN 'no_date_found' THEN 'mail_no_date' WHEN 'known_event' THEN 'mail_known_event'
                     ELSE 'mail_no_matching_event' END
  FROM inbound_emails i
 WHERE i.status IN ('processed', 'irrelevant', 'no_date_found', 'known_event', 'no_matching_event');
CREATE OR REPLACE FUNCTION purge_expired_family_events() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_closed integer; v_past integer; v_msg bigint[]; v_mail uuid[]; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_closed FROM platform_settings WHERE setting_key = 'family_event_closed_retention_days';
  SELECT value_text::integer INTO v_past FROM platform_settings WHERE setting_key = 'family_event_past_retention_months';
  WITH del AS (
    DELETE FROM family_events
     WHERE (status IN ('cancelled', 'dismissed') AND status_changed_at < now() - make_interval(days => COALESCE(v_closed, 30)))
        OR ends_at < now() - make_interval(months => COALESCE(v_past, 24))
    RETURNING source_message_id, source_inbound_email_id)
  SELECT COALESCE(array_agg(DISTINCT source_message_id) FILTER (WHERE source_message_id IS NOT NULL), '{}'),
         COALESCE(array_agg(DISTINCT source_inbound_email_id) FILTER (WHERE source_inbound_email_id IS NOT NULL), '{}'),
         count(*)
    INTO v_msg, v_mail, v_n FROM del;
  PERFORM delete_orphan_sources(v_msg, v_mail);
  -- MVP2 : une série terminée ou annulée disparaît quand il ne lui reste plus aucune séance
  DELETE FROM family_event_series s
   WHERE (s.ended_at IS NOT NULL OR s.status IN ('cancelled', 'dismissed'))
     AND NOT EXISTS (SELECT 1 FROM family_events e WHERE e.series_id = s.id);
  RETURN v_n;
END $$;
-- Pas de coordonnées de lieu pour un RDV médical : il n'a pas de suivi de trajet (D46, D47)
CREATE FUNCTION location_point_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_point IS NOT NULL
     AND EXISTS (SELECT 1 FROM event_types WHERE id = NEW.event_type_id AND code = 'medical') THEN
    RAISE EXCEPTION 'Pas de coordonnées de lieu pour un RDV médical (pas de suivi de trajet)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Série de RDV : au plus 30 séries actives par famille (D47)
CREATE FUNCTION family_event_series_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  IF NEW.ended_at IS NULL AND NEW.status IN ('provisional', 'confirmed') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family_event_series:' || NEW.account_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_active_event_series_per_family';
    SELECT count(*) INTO v_count FROM family_event_series
     WHERE account_id = NEW.account_id AND ended_at IS NULL AND status IN ('provisional', 'confirmed');
    IF v_count >= COALESCE(v_max, 30) THEN
      RAISE EXCEPTION 'Nombre maximal de séries de RDV actives atteint (%)', COALESCE(v_max, 30) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Mêmes transitions que les RDV (provisoire → confirmée ou ignorée ; confirmée → annulée), version, « toute la famille »
CREATE FUNCTION family_event_series_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT family_event_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Transition de statut interdite pour la série : % vers %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
  END IF;
  IF NEW.whole_family AND NOT OLD.whole_family
     AND EXISTS (SELECT 1 FROM family_event_series_members WHERE series_id = NEW.id) THEN
    RAISE EXCEPTION 'Une série « toute la famille » n''a pas de membres désignés' USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE FUNCTION family_event_series_member_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM family_event_series WHERE id = NEW.series_id AND whole_family) THEN
    RAISE EXCEPTION 'Une série « toute la famille » n''a pas de membres désignés' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Confirmation d'une série d'un seul geste : toutes les séances à venir sont confirmées, ou aucune (US-109 RF6, RT2).
-- Retourne le nombre de séances confirmées ; NULL si la série est introuvable, déjà traitée ou modifiée entre-temps.
CREATE FUNCTION confirm_family_series(p_series_id uuid, p_user_id uuid, p_expected_version integer DEFAULT NULL)
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
-- Annulation de toute la série : séances à venir annulées (série confirmée) ou ignorées (série provisoire), tâches liées retirées,
-- tâches qui suivent la série terminées (US-109 RF8, US-95 RF7). Retourne le nombre de séances traitées.
CREATE FUNCTION cancel_family_series(p_series_id uuid, p_user_id uuid, p_expected_version integer DEFAULT NULL,
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
  RETURN v_n;
END $$;
-- Une série jamais confirmée est fermée (ignorée) au début de sa première séance, avec ses séances restantes et ses modèles de
-- tâches proposés : sans cela elle resterait ouverte et compterait parmi les 30 séries actives. Une série n'est jamais
-- enregistrée d'office (D51). À planifier avec le planificateur de 5 minutes. Retourne le nombre de séries fermées.
CREATE FUNCTION dismiss_unconfirmed_family_series() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_n integer := 0;
BEGIN
  FOR v_id IN SELECT s.id FROM family_event_series s
               WHERE s.status = 'provisional' AND s.ended_at IS NULL
                 AND (SELECT min(e.starts_at) FROM family_events e WHERE e.series_id = s.id) <= now()
               ORDER BY s.created_at LOOP
    IF cancel_family_series(v_id, NULL, NULL, 'event_started') IS NOT NULL THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $$;
CREATE OR REPLACE FUNCTION family_event_auto_confirm_at() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_delay integer; v_lead integer;
BEGIN
  NEW.auto_confirm_at := NULL;
  IF NEW.status = 'provisional' AND NEW.series_id IS NULL AND family_event_auto_confirmable_source(NEW.source) THEN
    SELECT value_text::integer INTO v_delay FROM platform_settings WHERE setting_key = 'auto_confirm_delay_hours';
    SELECT value_text::integer INTO v_lead FROM platform_settings WHERE setting_key = 'auto_confirm_min_lead_hours';
    IF NEW.starts_at - NEW.created_at >= make_interval(hours => COALESCE(v_lead, 2)) THEN
      NEW.auto_confirm_at := LEAST(NEW.created_at + make_interval(hours => COALESCE(v_delay, 72)),
                                   NEW.starts_at - make_interval(hours => COALESCE(v_lead, 2)));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION plan_event_notices(p_event_id uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_activation timestamptz; v_delay integer; v_ev record; v_r record; v_kind notification_kind; v_n integer := 0;
BEGIN
  v_activation := platform_setting_timestamp('event_notice_activation_at');
  IF v_activation IS NULL THEN RETURN 0; END IF;
  SELECT COALESCE(value_text::integer, 10) INTO v_delay FROM platform_settings WHERE setting_key = 'event_notice_delay_minutes';
  FOR v_ev IN
    SELECT e.id, e.status FROM family_events e
     WHERE (p_event_id IS NULL OR e.id = p_event_id)
       AND e.created_at >= v_activation AND e.ends_at > now()
       AND (e.series_id IS NULL
            OR e.id = (SELECT x.id FROM family_events x WHERE x.series_id = e.series_id ORDER BY x.occurrence_date, x.id LIMIT 1))
       AND ((e.status = 'provisional' AND e.created_at <= now() - make_interval(mins => v_delay) AND e.created_at > now() - interval '3 days')
         OR (e.status = 'confirmed' AND e.confirmed_at > now() - interval '3 days'))
     ORDER BY e.created_at
  LOOP
    v_kind := CASE WHEN v_ev.status = 'provisional' THEN 'event_to_confirm' ELSE 'event_added' END;
    FOR v_r IN SELECT r.user_id FROM family_event_notice_recipients(v_ev.id, v_kind) r LOOP
      IF reserve_event_notice(v_ev.id, v_r.user_id, v_kind) IS NOT NULL THEN v_n := v_n + 1; END IF;
    END LOOP;
  END LOOP;
  RETURN v_n;
END $$;
CREATE FUNCTION purge_old_school_holidays() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM school_holiday_periods WHERE ends_on < current_date - interval '2 years';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
CREATE INDEX idx_event_series_account_id ON family_event_series (account_id);
CREATE INDEX idx_event_series_planning ON family_event_series (materialized_until) WHERE status IN ('provisional', 'confirmed') AND ended_at IS NULL;
CREATE INDEX idx_event_series_cleanup ON family_event_series (status_changed_at) WHERE ended_at IS NOT NULL OR status IN ('cancelled', 'dismissed');
CREATE INDEX idx_event_series_event_type_id ON family_event_series (event_type_id);
CREATE INDEX idx_event_series_requested_by ON family_event_series (requested_by_user_id);
CREATE INDEX idx_event_series_confirmed_by ON family_event_series (confirmed_by_user_id);
CREATE INDEX idx_event_series_source_message_id ON family_event_series (source_message_id);
CREATE INDEX idx_event_series_source_email_id ON family_event_series (source_inbound_email_id);
CREATE INDEX idx_event_series_created_via_agent_id ON family_event_series (created_via_agent_id);
CREATE INDEX idx_event_series_split_from ON family_event_series (split_from_series_id);
CREATE INDEX idx_series_members_member ON family_event_series_members (member_id, series_id);
CREATE INDEX idx_series_members_account_id ON family_event_series_members (account_id);
-- Clé d'idempotence du planificateur : une seule séance par date d'origine et par série
CREATE UNIQUE INDEX ux_family_events_series_occurrence ON family_events (series_id, occurrence_date) WHERE series_id IS NOT NULL;
CREATE INDEX idx_family_event_history_series ON family_event_history (series_id) WHERE series_id IS NOT NULL;
CREATE INDEX idx_family_settings_updated_by ON family_settings (updated_by_user_id);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_family_event_series_location_point BEFORE INSERT OR UPDATE OF location_point, event_type_id ON family_event_series
  FOR EACH ROW EXECUTE FUNCTION location_point_guard();
CREATE TRIGGER trg_family_event_series_before_insert BEFORE INSERT ON family_event_series
  FOR EACH ROW EXECUTE FUNCTION family_event_series_before_insert();
CREATE TRIGGER trg_family_event_series_before_update BEFORE UPDATE ON family_event_series
  FOR EACH ROW EXECUTE FUNCTION family_event_series_before_update();
CREATE TRIGGER trg_family_event_series_members_before_insert BEFORE INSERT ON family_event_series_members
  FOR EACH ROW EXECUTE FUNCTION family_event_series_member_before_insert();
CREATE OR REPLACE TRIGGER trg_family_events_auto_confirm_at BEFORE INSERT OR UPDATE OF starts_at, status, source, series_id, created_at ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_auto_confirm_at();
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
  ('max_active_event_series_per_family',   'integer', '30', 1, NULL, $$Séries de RDV actives au plus par famille (US-109 RF3)$$),
  ('event_series_horizon_months',          'integer', '6',  1, NULL, $$Séances d'une série de RDV créées à l'avance, en mois glissants (US-109 RT1)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON FUNCTION series_rule_valid(series_repeat_unit, smallint, smallint[], series_month_mode, smallint, smallint, smallint) IS $$Vrai si la règle de répétition est cohérente : chaque jour, chaque semaine (un ou plusieurs jours) ou toutes les deux semaines, chaque mois (même jour du mois, ou n-ième jour de la semaine). [US-109 RF2, US-110 RF3]$$;
COMMENT ON FUNCTION series_only_d1_reminder(series_repeat_unit, smallint) IS $$Vrai pour une série hebdomadaire ou plus fréquente (rappel J-1 seul) ; faux pour une série toutes les deux semaines ou mensuelle (délais du type de RDV). [US-109 RF9, D46]$$;
COMMENT ON TABLE family_event_series IS $$Série de RDV récurrents : la règle de répétition, le modèle des séances et l'état de confirmation (tout ou rien). Les séances sont des lignes de family_events. [US-109, D43]$$;
COMMENT ON COLUMN family_event_series.location_point IS $$Coordonnées chiffrées du lieu (proposées par l'API Adresse), supprimées avec la série. NULL pour un RDV médical (pas de suivi de trajet). Jamais une adresse de domicile (D47)$$;
COMMENT ON COLUMN family_event_series.start_time IS $$Heure locale de début, dans le fuseau de la série : un changement d'heure ne décale pas l'heure locale d'une séance$$;
COMMENT ON COLUMN family_event_series.first_date IS $$Première date de la règle (ancre de « toutes les deux semaines »)$$;
COMMENT ON COLUMN family_event_series.weekdays IS $$Jours de la semaine (ISO, 1 = lundi à 7 = dimanche) d'une série hebdomadaire$$;
COMMENT ON COLUMN family_event_series.month_nth IS $$Série mensuelle « n-ième jour de la semaine » : 1 à 4, ou -1 pour le dernier$$;
COMMENT ON COLUMN family_event_series.occurrence_count IS $$Fin « après N séances » : compte les séances réellement tenues, hors vacances sautées (D47)$$;
COMMENT ON COLUMN family_event_series.status IS $$provisional, confirmed, cancelled ou dismissed. La confirmation est atomique (confirm_family_series) : toutes les séances à venir sont confirmées, ou aucune$$;
COMMENT ON COLUMN family_event_series.materialized_until IS $$Dernière date pour laquelle les séances sont créées (6 mois glissants) ; le planificateur ne complète que vers l'avant, sans recréer une séance déjà purgée$$;
COMMENT ON COLUMN family_event_series.ended_at IS $$Série terminée ou annulée : elle ne compte plus parmi les 30 séries actives et sera supprimée quand il ne lui restera plus de séance$$;
COMMENT ON COLUMN family_event_series.split_from_series_id IS $$Série d'origine quand « Cette séance et les suivantes » a scindé la série$$;
COMMENT ON TABLE family_event_series_members IS $$Membres concernés par une série de RDV (un ou plusieurs). « Toute la famille » = indicateur whole_family de la série. [US-109, D27]$$;
COMMENT ON COLUMN family_events.series_id IS $$Série dont ce RDV est une séance (US-109). Série supprimée : la séance devient un RDV ordinaire$$;
COMMENT ON COLUMN family_events.occurrence_date IS $$Date locale d'origine de la séance dans la série (clé stable, même après un déplacement)$$;
COMMENT ON COLUMN family_events.is_modified IS $$Séance modifiée seule : elle reste rattachée à la série avec la mention « Modifiée » et n'est plus touchée par « Toute la série » (D47)$$;
COMMENT ON TABLE family_settings IS $$Réglages de l'Assistant Famille communs à la famille : zone scolaire, catalogue d'anticipation actif ou non. Absence de ligne = valeurs par défaut. [US-102 RF9, US-108 RF8, US-109 RF4]$$;
COMMENT ON TABLE school_holiday_periods IS $$Périodes de vacances scolaires par zone (A, B, C), chargées chaque année depuis la source officielle ; les années de plus de 2 ans sont purgées. [US-109 RF4, RT3]$$;
COMMENT ON FUNCTION change_family_event_status(uuid, event_status, uuid, integer, event_change_reason, change_scope) IS $$Change le statut d'un RDV de façon atomique (transition permise, version attendue), écrit l'historique, passe les tâches proposées à « à faire » à la confirmation et retire les tâches proposées ou à faire d'un RDV annulé ou ignoré (un RDV écarté garde ses tâches proposées). Auteur NULL et motif no_response = confirmation d'office. false = déjà traité ou modifié. [US-75, 77, 80, 83, 95 RF7, 109, D48, D49]$$;
COMMENT ON FUNCTION confirm_family_series(uuid, uuid, integer) IS $$Confirme une série et toutes ses séances à venir en une seule transaction : tout ou rien. NULL = déjà traitée ou modifiée. [US-109 RF6, RT2]$$;
COMMENT ON FUNCTION cancel_family_series(uuid, uuid, integer, event_change_reason) IS $$Annule (ou ignore, si provisoire) toute la série : séances à venir, tâches liées, tâches qui suivent la série ; les modèles de tâches proposés sont supprimés. Auteur NULL et motif event_started pour la fermeture automatique. Retourne le nombre de séances traitées. [US-109 RF8, US-95 RF7, D48]$$;
COMMENT ON FUNCTION dismiss_unconfirmed_family_series() IS $$Ferme (statut ignoré) les séries jamais confirmées dont la première séance a commencé : séances restantes ignorées, modèles de tâches proposés supprimés. À planifier toutes les 5 minutes. [US-109, US-83 RF6, D51]$$;
COMMENT ON FUNCTION purge_old_school_holidays() IS $$Supprime les périodes de vacances scolaires terminées depuis plus de 2 ans. À planifier chaque année. [US-109 RT3]$$;
