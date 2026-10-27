-- MAAQ — lot 8 : Trajets et « Sur place »
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_8_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
CREATE TYPE travel_origin         AS ENUM ('previous_event', 'last_position', 'live_screen', 'none');
CREATE TYPE travel_status         AS ENUM ('pending', 'first_done', 'second_done', 'skipped', 'failed');
CREATE TYPE location_consent_cause AS ENUM ('user_action', 'device_revoked', 'device_deleted');
CREATE TYPE place_search_origin   AS ENUM ('button', 'chat', 'suggestion');
CREATE TYPE place_search_status   AS ENUM ('queued', 'running', 'done', 'no_result', 'failed', 'obsolete');
CREATE TYPE place_suggestion_answer AS ENUM ('pending', 'accepted', 'declined');

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Trajets (US-107, D42, D46, D47). Jamais d'adresse de domicile. La seule position conservée est la dernière position
-- connue d'un appareil : chiffrée, 3 heures au plus, jamais visible des autres profils.
-- ---------------------------------------------------------------------
CREATE TABLE device_location_consents (
  device_id       uuid PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  withdrawn_at    timestamptz,
  notice_version  varchar(20) NOT NULL,
  purpose         text NOT NULL DEFAULT 'travel_time' CHECK (purpose ~ '^[a-z_]+$'),
  CONSTRAINT ck_location_consents_withdrawn CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);
-- Journal des consentements à la position (D54, décision du DPO) : preuve de l'accord et du retrait, par appareil. Sans clé
-- étrangère : la preuve survit à l'appareil et au profil (comme forwarding_consent_events). Alimenté par trigger.
CREATE TABLE device_location_consent_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  action          consent_action NOT NULL,
  cause           location_consent_cause NOT NULL DEFAULT 'user_action',
  notice_version  varchar(20) NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  retain_until    date NOT NULL
);
CREATE TABLE device_last_positions (
  device_id           uuid PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  -- Latitude et longitude, chiffrées par l'application
  position_encrypted  bytea NOT NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  -- Au plus 3 heures après la lecture, et jamais au-delà de la fin du RDV suivi : vérifié par la base (D47, US-107 RF12)
  expires_at          timestamptz NOT NULL,
  CONSTRAINT ck_last_positions_expiry CHECK (expires_at > captured_at AND expires_at <= captured_at + interval '3 hours')
);
-- « Suivre mon trajet » : propre à chaque profil, par RDV ou par série (D47)
CREATE TABLE travel_tracking (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  event_id    uuid,
  series_id   uuid,
  -- false sur une séance : écarte cette séance d'un suivi de série
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_travel_tracking_user FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_travel_tracking_event FOREIGN KEY (event_id, account_id) REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_travel_tracking_series FOREIGN KEY (series_id, account_id) REFERENCES family_event_series (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_travel_tracking_target CHECK (num_nonnulls(event_id, series_id) = 1)
);
-- Estimation d'un profil pour un RDV : heure de départ conseillée et durée, conservées jusqu'à la fin du RDV (RF12)
CREATE TABLE event_travel_advice (
  event_id                uuid NOT NULL,
  user_id                 uuid NOT NULL,
  account_id              uuid NOT NULL,
  status                  travel_status NOT NULL DEFAULT 'pending',
  -- D'où part l'estimation : lieu du RDV précédent, dernière position connue, écran de suivi ouvert, ou rien
  origin_kind             travel_origin NOT NULL DEFAULT 'none',
  origin_event_id         uuid REFERENCES family_events (id) ON DELETE SET NULL,
  first_computed_at       timestamptz,
  first_duration_minutes  integer CHECK (first_duration_minutes > 0),
  advised_departure_at    timestamptz,
  second_computed_at      timestamptz,
  second_duration_minutes integer CHECK (second_duration_minutes > 0),
  -- Durée sans trafic estimée à l'activation du suivi, depuis la position du téléphone si elle est autorisée (US-107 RF5, D52) ;
  -- affichée sous le lieu, propre à chaque profil (D55). Vide tant qu'aucune estimation n'est possible
  estimated_duration_minutes integer CHECK (estimated_duration_minutes > 0),
  estimated_at            timestamptz,
  notified_first_at       timestamptz,
  notified_second_at      timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CONSTRAINT fk_travel_advice_event FOREIGN KEY (event_id, account_id) REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_travel_advice_user FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_travel_advice_first CHECK ((first_computed_at IS NULL) = (first_duration_minutes IS NULL)),
  CONSTRAINT ck_travel_advice_second CHECK ((second_computed_at IS NULL) = (second_duration_minutes IS NULL)),
  CONSTRAINT ck_travel_advice_estimated CHECK ((estimated_at IS NULL) = (estimated_duration_minutes IS NULL))
);
-- ---------------------------------------------------------------------
-- « Sur place » : où se garer et où manger près d'un RDV (US-112, D52, D55). Une ligne par recherche : elle sert de travail à
-- exécuter, d'état et de résultat. Aucun point médian, aucune coordonnée arrondie, aucun texte de requête, aucun avis n'est
-- stocké. La liste des adresses est un seul bloc chiffré : elle est dérivée de l'adresse du RDV, donc aussi sensible qu'elle.
-- ---------------------------------------------------------------------
CREATE TABLE event_place_searches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_id              uuid NOT NULL,
  requested_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Rang de la recherche pour ce RDV (jamais réutilisé, même après un échec)
  seq                   integer NOT NULL CHECK (seq >= 1),
  origin                place_search_origin NOT NULL,
  status                place_search_status NOT NULL DEFAULT 'queued',
  queued_at             timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  attempts              smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- timeout, service_unavailable ou error ; obligatoire pour un échec
  failure_reason        varchar(40),
  -- Date de vérification : « Informations trouvées sur internet le [date] »
  checked_on            date,
  -- Adresses trouvées, chiffrées : pour chacune, catégorie (parking, petite faim, grande faim), nom, type, ville, distance à pied,
  -- source. Le lien « Voir les avis » est recalculé à l'affichage (nom et ville) ; aucune note ni avis n'est stocké
  result_payload        bytea,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  UNIQUE (event_id, seq),
  CONSTRAINT fk_place_searches_event FOREIGN KEY (event_id, account_id)
    REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_place_searches_payload CHECK ((status = 'done') = (result_payload IS NOT NULL)),
  CONSTRAINT ck_place_searches_failure CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT ck_place_searches_checked CHECK ((status IN ('done', 'no_result')) = (checked_on IS NOT NULL))
);
-- Suggestion automatique de la recherche : une seule fois par RDV (la clé est le RDV), « Non, merci » est mémorisé (US-112 RF3)
CREATE TABLE event_place_suggestions (
  event_id               uuid PRIMARY KEY,
  account_id             uuid NOT NULL,
  suggested_to_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  suggested_at           timestamptz NOT NULL DEFAULT now(),
  answer                 place_suggestion_answer NOT NULL DEFAULT 'pending',
  answered_at            timestamptz,
  -- Recherche lancée par la réponse « Oui »
  search_id              uuid REFERENCES event_place_searches (id) ON DELETE SET NULL,
  CONSTRAINT fk_place_suggestions_event FOREIGN KEY (event_id, account_id)
    REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_place_suggestions_answered CHECK ((answer = 'pending') = (answered_at IS NULL))
);

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
ALTER TABLE agent_conversation_messages
  DROP CONSTRAINT ck_conversation_messages_content;
ALTER TABLE agent_conversation_messages
  ADD CONSTRAINT ck_conversation_messages_content CHECK (kind IN ('image', 'place_suggestion', 'place_results') OR content IS NOT NULL);
-- Coordonnées chiffrées du lieu (latitude, longitude), supprimées avec le RDV. Jamais pour un RDV médical ; jamais une adresse de domicile (D47)
ALTER TABLE family_events
  ADD COLUMN location_point          bytea;
ALTER TABLE family_events
  ADD CONSTRAINT ck_family_events_location_point CHECK (location_point IS NULL OR location IS NOT NULL);
-- Messages du tchat : le message « Sur place » ne porte que le lien vers la recherche (le contenu vient de la ligne de recherche,
-- gardée jusqu'à la fin du RDV, alors que les messages sont supprimés à 4 jours)
ALTER TABLE agent_conversation_messages
  ADD COLUMN place_search_id uuid REFERENCES event_place_searches (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION family_member_archived() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE OR REPLACE FUNCTION family_event_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR (NEW.status IN ('cancelled', 'dismissed') AND NEW.status IS DISTINCT FROM OLD.status) THEN
    DELETE FROM event_travel_advice WHERE event_id = NEW.id;
    UPDATE scheduled_notifications SET status = 'cancelled'
     WHERE event_id = NEW.id AND kind IN ('travel_first', 'travel_second') AND status = 'scheduled';
  END IF;
  IF NEW.location_point IS NULL AND OLD.location_point IS NOT NULL THEN
    DELETE FROM travel_tracking WHERE event_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION family_event_series_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_point IS NULL AND OLD.location_point IS NOT NULL THEN
    DELETE FROM travel_tracking WHERE series_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
-- Un membre retiré d'un RDV ou d'une série n'est plus concerné : son suivi de trajet s'arrête
CREATE FUNCTION family_event_member_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'family_event_members' THEN
    DELETE FROM travel_tracking t USING family_members fm
     WHERE t.event_id = OLD.event_id AND fm.id = OLD.member_id AND fm.user_id = t.user_id;
  ELSE
    DELETE FROM travel_tracking t USING family_members fm
     WHERE t.series_id = OLD.series_id AND fm.id = OLD.member_id AND fm.user_id = t.user_id;
  END IF;
  RETURN OLD;
END $$;
-- Suivi de trajet : jamais pour un RDV médical, jamais sans lieu, seulement pour un RDV qui concerne le profil (US-107 RF4, D46, D47)
CREATE FUNCTION travel_tracking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_type integer; v_point bytea; v_whole boolean; v_concerned boolean;
BEGIN
  IF NOT NEW.enabled THEN RETURN NEW; END IF;
  IF NEW.event_id IS NOT NULL THEN
    SELECT event_type_id, location_point, whole_family INTO v_type, v_point, v_whole FROM family_events WHERE id = NEW.event_id;
    v_concerned := v_whole OR EXISTS (SELECT 1 FROM family_event_members m JOIN family_members fm ON fm.id = m.member_id
                                       WHERE m.event_id = NEW.event_id AND fm.user_id = NEW.user_id);
  ELSE
    SELECT event_type_id, location_point, whole_family INTO v_type, v_point, v_whole FROM family_event_series WHERE id = NEW.series_id;
    v_concerned := v_whole OR EXISTS (SELECT 1 FROM family_event_series_members m JOIN family_members fm ON fm.id = m.member_id
                                       WHERE m.series_id = NEW.series_id AND fm.user_id = NEW.user_id);
  END IF;
  IF EXISTS (SELECT 1 FROM event_types WHERE id = v_type AND code = 'medical') THEN
    RAISE EXCEPTION 'Pas de suivi de trajet pour un RDV médical' USING ERRCODE = 'check_violation';
  END IF;
  IF v_point IS NULL THEN
    RAISE EXCEPTION 'Le suivi de trajet exige l''adresse du RDV' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT COALESCE(v_concerned, false) THEN
    RAISE EXCEPTION 'Ce RDV ne concerne pas ce profil' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Dernière position : refusée sans consentement actif de l'appareil ; échéance par défaut = 3 heures (le CHECK interdit davantage)
CREATE FUNCTION device_position_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expires_at IS NULL THEN
    NEW.expires_at := NEW.captured_at + interval '3 hours';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM device_location_consents c JOIN devices d ON d.id = c.device_id
                  WHERE c.device_id = NEW.device_id AND c.withdrawn_at IS NULL AND d.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Position refusée : aucun consentement actif de cet appareil' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Suppression immédiate de la dernière position : consentement retiré, appareil révoqué, déconnexion (dernière session de l'appareil)
CREATE FUNCTION erase_device_position_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'device_location_consents' THEN
    DELETE FROM device_last_positions WHERE device_id = NEW.device_id;
  ELSIF TG_TABLE_NAME = 'devices' THEN
    DELETE FROM device_last_positions WHERE device_id = NEW.id;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = NEW.device_id AND s.id <> NEW.id
                    AND s.revoked_at IS NULL AND s.expires_at > now()) THEN
      DELETE FROM device_last_positions WHERE device_id = NEW.device_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Lecture de la dernière position : seulement si elle n'est pas échue et si le consentement est actif
CREATE FUNCTION device_last_position(p_device_id uuid) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT p.position_encrypted FROM device_last_positions p
   WHERE p.device_id = p_device_id AND p.expires_at > now()
     AND EXISTS (SELECT 1 FROM device_location_consents c WHERE c.device_id = p.device_id AND c.withdrawn_at IS NULL)
$$;
-- Journal des consentements à la position : chaque accord, retrait ou nouvelle version acceptée est inscrit, avec la durée de
-- conservation du réglage. Un retrait provoqué par la révocation de l'appareil (trigger imbriqué) porte la cause « device_revoked ».
CREATE FUNCTION device_location_consent_log() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_user uuid; v_months integer; v_action consent_action; v_cause location_consent_cause := 'user_action';
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'granted';
  ELSIF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    v_action := 'withdrawn';
    IF pg_trigger_depth() > 1 THEN v_cause := 'device_revoked'; END IF;
  ELSIF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS NULL THEN
    v_action := 'granted';
  ELSIF NEW.withdrawn_at IS NULL AND NEW.notice_version IS DISTINCT FROM OLD.notice_version THEN
    v_action := 'granted';
  ELSE
    RETURN NEW;
  END IF;
  SELECT user_id INTO v_user FROM devices WHERE id = NEW.device_id;
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'location_consent_proof_retention_months';
  INSERT INTO device_location_consent_events (device_id, user_id, action, cause, notice_version, retain_until)
  VALUES (NEW.device_id, v_user, v_action, v_cause, NEW.notice_version, (now() + make_interval(months => COALESCE(v_months, 60)))::date);
  RETURN NEW;
END $$;
-- Appareil révoqué : son consentement prend fin (retrait inscrit au journal). Appareil supprimé (ou profil, foyer) : retrait inscrit
-- avant la suppression, la preuve survivant sans clé étrangère.
CREATE FUNCTION device_location_consent_device_end() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_version varchar(20);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    UPDATE device_location_consents SET withdrawn_at = now() WHERE device_id = NEW.id AND withdrawn_at IS NULL;
    RETURN NEW;
  END IF;
  SELECT notice_version INTO v_version FROM device_location_consents WHERE device_id = OLD.id AND withdrawn_at IS NULL;
  IF FOUND THEN
    SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'location_consent_proof_retention_months';
    INSERT INTO device_location_consent_events (device_id, user_id, action, cause, notice_version, retain_until)
    VALUES (OLD.id, OLD.user_id, 'withdrawn', 'device_deleted', v_version, (now() + make_interval(months => COALESCE(v_months, 60)))::date);
  END IF;
  RETURN OLD;
END $$;
CREATE FUNCTION purge_location_consent_events() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM device_location_consent_events WHERE retain_until < current_date;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- Garde-fous de toute recherche, même insérée directement : RDV non médical, avec un lieu, à venir, ni annulé ni ignoré ;
-- au plus 3 recherches non échouées par RDV ; rang attribué sans réutilisation.
CREATE FUNCTION event_place_search_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_e family_events%ROWTYPE; v_max integer; v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('place_searches:' || NEW.event_id::text, 0));
  SELECT * INTO v_e FROM family_events WHERE id = NEW.event_id;
  IF EXISTS (SELECT 1 FROM event_types WHERE id = v_e.event_type_id AND code = 'medical') THEN
    RAISE EXCEPTION 'Pas de recherche « Sur place » pour un RDV médical' USING ERRCODE = 'check_violation';
  END IF;
  IF v_e.location IS NULL THEN
    RAISE EXCEPTION 'La recherche « Sur place » exige un lieu' USING ERRCODE = 'check_violation';
  END IF;
  IF v_e.status IN ('cancelled', 'dismissed') OR v_e.ends_at <= now() THEN
    RAISE EXCEPTION 'Ce RDV est terminé, annulé ou ignoré' USING ERRCODE = 'check_violation';
  END IF;
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_place_searches_per_event';
  SELECT count(*) INTO v_count FROM event_place_searches WHERE event_id = NEW.event_id AND status <> 'failed';
  IF v_count >= COALESCE(v_max, 3) THEN
    RAISE EXCEPTION 'Au plus % recherches par RDV', COALESCE(v_max, 3) USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(max(seq), 0) + 1 INTO NEW.seq FROM event_place_searches WHERE event_id = NEW.event_id;
  RETURN NEW;
END $$;
-- La suggestion automatique ne vise qu'un RDV familial ou personnel, avec un lieu
CREATE FUNCTION event_place_suggestion_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM family_events e JOIN event_types t ON t.id = e.event_type_id
                  WHERE e.id = NEW.event_id AND t.code IN ('family', 'personal') AND e.location IS NOT NULL) THEN
    RAISE EXCEPTION 'La suggestion ne vise qu''un RDV familial ou personnel avec un lieu' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Adresse du RDV modifiée : les résultats sont effacés (statut obsolète) mais les recherches restent comptées. RDV devenu médical :
-- recherches et suggestion supprimées. L'application ne doit réécrire `location` que si l'adresse change.
CREATE FUNCTION family_event_place_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM event_types WHERE id = NEW.event_type_id AND code = 'medical') THEN
    DELETE FROM event_place_searches WHERE event_id = NEW.id;
    DELETE FROM event_place_suggestions WHERE event_id = NEW.id;
  ELSIF NEW.location IS DISTINCT FROM OLD.location OR NEW.location_point IS DISTINCT FROM OLD.location_point THEN
    UPDATE event_place_searches
       SET status = 'obsolete', result_payload = NULL, checked_on = NULL
     WHERE event_id = NEW.id AND status IN ('queued', 'running', 'done', 'no_result');
  END IF;
  RETURN NEW;
END $$;
-- Demande de recherche, atomique : RDV visible du profil, non médical, avec un lieu, à venir ; plafond de 3 par RDV (hors échecs) ;
-- puis plafond quotidien du profil (compté en dernier, pour ne rien compter quand le RDV refuse). Retourne la recherche créée (en
-- attente) ou le motif du refus : not_found, medical, no_location, ended, event_limit, daily_limit.
CREATE FUNCTION request_place_search(p_event_id uuid, p_user_id uuid, p_origin place_search_origin, p_request_date date DEFAULT NULL)
RETURNS TABLE (search_id uuid, refusal text) LANGUAGE plpgsql AS $$
DECLARE v_e family_events%ROWTYPE; v_max integer; v_count integer; v_tz text; v_id uuid;
BEGIN
  SELECT * INTO v_e FROM family_events_visible_to(p_user_id) WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, 'not_found'; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM event_types WHERE id = v_e.event_type_id AND code = 'medical') THEN
    RETURN QUERY SELECT NULL::uuid, 'medical'; RETURN; END IF;
  IF v_e.location IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'no_location'; RETURN; END IF;
  IF v_e.ends_at <= now() THEN RETURN QUERY SELECT NULL::uuid, 'ended'; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('place_searches:' || p_event_id::text, 0));
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_place_searches_per_event';
  SELECT count(*) INTO v_count FROM event_place_searches WHERE event_id = p_event_id AND status <> 'failed';
  IF v_count >= COALESCE(v_max, 3) THEN RETURN QUERY SELECT NULL::uuid, 'event_limit'; RETURN; END IF;
  SELECT family_timezone INTO v_tz FROM accounts WHERE id = v_e.account_id;
  IF NOT register_agent_request(p_user_id, COALESCE(p_request_date, (now() AT TIME ZONE v_tz)::date)) THEN
    RETURN QUERY SELECT NULL::uuid, 'daily_limit'; RETURN; END IF;
  INSERT INTO event_place_searches (account_id, event_id, requested_by_user_id, seq, origin)
  VALUES (v_e.account_id, p_event_id, p_user_id, 0, p_origin) RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, NULL::text;
END $$;
-- Prise d'une recherche par l'exécuteur lancé dès la demande (avec son identifiant) ou par le planificateur de 5 minutes, filet de
-- sécurité (sans identifiant : la plus ancienne recherche en attente depuis plus de 30 secondes, SKIP LOCKED). NULL si rien à prendre.
CREATE FUNCTION claim_place_search(p_search_id uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_grace integer; v_id uuid;
BEGIN
  IF p_search_id IS NOT NULL THEN
    v_id := p_search_id;
  ELSE
    SELECT value_text::integer INTO v_grace FROM platform_settings WHERE setting_key = 'place_search_queue_grace_seconds';
    SELECT id INTO v_id FROM event_place_searches
     WHERE status = 'queued' AND queued_at < now() - make_interval(secs => COALESCE(v_grace, 30))
     ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF v_id IS NULL THEN RETURN NULL; END IF;
  END IF;
  UPDATE event_place_searches SET status = 'running', started_at = now(), attempts = attempts + 1
   WHERE id = v_id AND status = 'queued' RETURNING id INTO v_id;
  RETURN v_id;
END $$;
-- Fin d'une recherche en cours : terminée, aucune information ou échec. Retourne false si la recherche n'est plus en cours (par exemple
-- devenue obsolète parce que l'adresse du RDV a changé : le résultat est alors à jeter). p_notify : prévenir le profil demandeur
-- (« le résultat est prêt »), quand il a quitté le tchat.
CREATE FUNCTION complete_place_search(
  p_search_id uuid, p_status place_search_status, p_payload bytea DEFAULT NULL, p_failure_reason text DEFAULT NULL,
  p_checked_on date DEFAULT NULL, p_notify boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_s event_place_searches%ROWTYPE;
BEGIN
  IF p_status NOT IN ('done', 'no_result', 'failed') THEN
    RAISE EXCEPTION 'État final de recherche invalide : %', p_status USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_s FROM event_place_searches WHERE id = p_search_id AND status = 'running' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE event_place_searches
     SET status = p_status, finished_at = now(),
         result_payload = CASE WHEN p_status = 'done' THEN p_payload END,
         failure_reason = CASE WHEN p_status = 'failed' THEN COALESCE(p_failure_reason, 'error') END,
         checked_on = CASE WHEN p_status IN ('done', 'no_result') THEN COALESCE(p_checked_on, current_date) END
   WHERE id = p_search_id;
  IF p_notify AND p_status IN ('done', 'no_result') AND v_s.requested_by_user_id IS NOT NULL THEN
    INSERT INTO scheduled_notifications (event_id, recipient_user_id, kind, due_at)
    VALUES (v_s.event_id, v_s.requested_by_user_id, 'place_search_ready', now())
    ON CONFLICT (event_id, kind, recipient_user_id, due_at) WHERE event_id IS NOT NULL DO NOTHING;
  END IF;
  RETURN true;
END $$;
-- Filet de sécurité du planificateur : une recherche en cours depuis plus de 120 secondes échoue (« La recherche n'a pas abouti »,
-- bouton « Réessayer ») ; une recherche en attente depuis plus de 15 minutes échoue aussi (service indisponible). Retourne le nombre.
CREATE FUNCTION fail_stale_place_searches() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_timeout integer; v_a integer; v_b integer;
BEGIN
  SELECT value_text::integer INTO v_timeout FROM platform_settings WHERE setting_key = 'place_search_timeout_seconds';
  UPDATE event_place_searches SET status = 'failed', failure_reason = 'timeout', finished_at = now()
   WHERE status = 'running' AND started_at < now() - make_interval(secs => COALESCE(v_timeout, 120));
  GET DIAGNOSTICS v_a = ROW_COUNT;
  UPDATE event_place_searches SET status = 'failed', failure_reason = 'service_unavailable', finished_at = now()
   WHERE status = 'queued' AND queued_at < now() - interval '15 minutes';
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
-- Les résultats sont gardés jusqu'à la fin du RDV, puis supprimés (RT4) ; ceux d'un RDV annulé ou ignoré partent aussi.
CREATE FUNCTION purge_place_searches() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM event_place_searches s USING family_events e
   WHERE e.id = s.event_id AND (e.ends_at < now() OR e.status IN ('cancelled', 'dismissed'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- Durée du trajet sous le lieu : chaque profil ne voit que la sienne (D55) ; celle de l'autre parent révélerait où il se trouve.
CREATE FUNCTION travel_advice_visible_to(p_viewer uuid) RETURNS SETOF event_travel_advice
LANGUAGE sql STABLE AS $$
  SELECT a.* FROM event_travel_advice a WHERE a.user_id = p_viewer
$$;
-- Trajets : estimations et suivis des RDV terminés, suivis des séries terminées ou annulées. À planifier chaque heure.
CREATE FUNCTION purge_travel_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_a bigint; v_b bigint; v_c bigint;
BEGIN
  DELETE FROM event_travel_advice a USING family_events e WHERE e.id = a.event_id AND e.ends_at < now();
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM travel_tracking t USING family_events e WHERE t.event_id = e.id AND e.ends_at < now();
  GET DIAGNOSTICS v_b = ROW_COUNT;
  DELETE FROM travel_tracking t USING family_event_series s
   WHERE t.series_id = s.id AND (s.ended_at IS NOT NULL OR s.status IN ('cancelled', 'dismissed'));
  GET DIAGNOSTICS v_c = ROW_COUNT;
  RETURN v_a + v_b + v_c;
END $$;
-- Dernière position : supprimée à l'échéance (3 heures au plus). À planifier toutes les 5 minutes ; la lecture ignore déjà les lignes échues.
CREATE FUNCTION purge_expired_device_positions() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM device_last_positions WHERE expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
CREATE INDEX idx_location_consent_events_device ON device_location_consent_events (device_id, occurred_at);
CREATE INDEX idx_location_consent_events_user ON device_location_consent_events (user_id);
CREATE INDEX idx_location_consent_events_retain_until ON device_location_consent_events (retain_until);
CREATE INDEX idx_last_positions_expiry ON device_last_positions (expires_at);
CREATE UNIQUE INDEX ux_travel_tracking_event ON travel_tracking (user_id, event_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX ux_travel_tracking_series ON travel_tracking (user_id, series_id) WHERE series_id IS NOT NULL;
CREATE INDEX idx_travel_tracking_event ON travel_tracking (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_travel_tracking_series ON travel_tracking (series_id) WHERE series_id IS NOT NULL;
CREATE INDEX idx_travel_tracking_account_id ON travel_tracking (account_id);
CREATE INDEX idx_travel_advice_user ON event_travel_advice (user_id);
CREATE INDEX idx_travel_advice_account_id ON event_travel_advice (account_id);
CREATE INDEX idx_travel_advice_origin_event ON event_travel_advice (origin_event_id);
CREATE INDEX idx_place_searches_pending ON event_place_searches (status, queued_at) WHERE status IN ('queued', 'running');
CREATE INDEX idx_place_searches_account_id ON event_place_searches (account_id);
CREATE INDEX idx_place_searches_requested_by ON event_place_searches (requested_by_user_id);
CREATE INDEX idx_place_suggestions_account_id ON event_place_suggestions (account_id);
CREATE INDEX idx_place_suggestions_user ON event_place_suggestions (suggested_to_user_id);
CREATE INDEX idx_place_suggestions_search ON event_place_suggestions (search_id);
CREATE INDEX idx_conversation_messages_place_search_id ON agent_conversation_messages (place_search_id) WHERE place_search_id IS NOT NULL;
-- Notification de trajet : au plus une par profil et par RDV, ligne mise à jour en place lors d'un nouvel essai (US-107 RT4)
CREATE UNIQUE INDEX ux_scheduled_notifications_travel ON scheduled_notifications (event_id, kind, recipient_user_id)
  WHERE kind IN ('travel_first', 'travel_second');

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_family_events_location_point BEFORE INSERT OR UPDATE OF location_point, event_type_id ON family_events
  FOR EACH ROW EXECUTE FUNCTION location_point_guard();
CREATE OR REPLACE TRIGGER trg_family_events_after_change AFTER UPDATE OF starts_at, status, location_point ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_after_change();
CREATE TRIGGER trg_family_event_series_after_change AFTER UPDATE OF location_point ON family_event_series
  FOR EACH ROW EXECUTE FUNCTION family_event_series_after_change();
CREATE TRIGGER trg_family_event_members_removed AFTER DELETE ON family_event_members
  FOR EACH ROW EXECUTE FUNCTION family_event_member_removed();
CREATE TRIGGER trg_family_event_series_members_removed AFTER DELETE ON family_event_series_members
  FOR EACH ROW EXECUTE FUNCTION family_event_member_removed();
CREATE TRIGGER trg_travel_tracking_guard BEFORE INSERT OR UPDATE OF enabled, event_id, series_id, user_id ON travel_tracking
  FOR EACH ROW EXECUTE FUNCTION travel_tracking_guard();
CREATE TRIGGER trg_device_last_positions_guard BEFORE INSERT OR UPDATE ON device_last_positions
  FOR EACH ROW EXECUTE FUNCTION device_position_guard();
CREATE TRIGGER trg_location_consents_withdrawn AFTER UPDATE OF withdrawn_at ON device_location_consents
  FOR EACH ROW WHEN (NEW.withdrawn_at IS NOT NULL) EXECUTE FUNCTION erase_device_position_trigger();
CREATE TRIGGER trg_devices_revoked_position AFTER UPDATE OF revoked_at ON devices
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION erase_device_position_trigger();
CREATE TRIGGER trg_sessions_revoked_position AFTER UPDATE OF revoked_at ON sessions
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION erase_device_position_trigger();
CREATE TRIGGER trg_device_location_consents_log AFTER INSERT OR UPDATE ON device_location_consents
  FOR EACH ROW EXECUTE FUNCTION device_location_consent_log();
CREATE TRIGGER trg_devices_location_consent_revoked AFTER UPDATE OF revoked_at ON devices
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION device_location_consent_device_end();
CREATE TRIGGER trg_devices_location_consent_deleted BEFORE DELETE ON devices
  FOR EACH ROW EXECUTE FUNCTION device_location_consent_device_end();
CREATE TRIGGER trg_event_place_searches_before_insert BEFORE INSERT ON event_place_searches
  FOR EACH ROW EXECUTE FUNCTION event_place_search_before_insert();
CREATE TRIGGER trg_event_place_suggestions_before_insert BEFORE INSERT ON event_place_suggestions
  FOR EACH ROW EXECUTE FUNCTION event_place_suggestion_before_insert();
CREATE TRIGGER trg_family_events_place_changed AFTER UPDATE OF location, location_point, event_type_id ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_place_changed();
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
  ('travel_gap_alert_minutes',             'integer', '30', 1, NULL, $$Écart en dessous duquel deux RDV d'un même membre déclenchent l'alerte « RDV rapproché », en minutes (US-107 RF1)$$),
  ('location_consent_proof_retention_months', 'integer', '60', 1, NULL, $$Conservation du journal des consentements à la position après l'événement, en mois (D54, décision du DPO)$$),
  ('max_place_searches_per_event',         'integer', '3',  1, NULL, $$Recherches « Sur place » au plus par RDV, hors recherches en échec (US-112 RF9)$$),
  ('place_search_timeout_seconds',         'integer', '120', 1, NULL, $$Une recherche « Sur place » en cours depuis plus longtemps échoue (US-112 RF11)$$),
  ('place_search_queue_grace_seconds',     'integer', '30', 1, NULL, $$Délai après lequel le planificateur prend une recherche « Sur place » restée en attente (filet de sécurité, US-112 RT5)$$),
  ('place_search_max_walk_minutes',        'integer', '15', 1, NULL, $$Distance à pied maximale des adresses « Sur place », en minutes (US-112 RF6, décision du PM)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON COLUMN family_events.location_point IS $$Coordonnées chiffrées du lieu, supprimées avec le RDV. NULL pour un RDV médical (pas de suivi de trajet). Jamais une adresse de domicile (D47)$$;
COMMENT ON TABLE device_location_consents IS $$Consentement à la lecture de la position, par appareil, avec sa date et sa version d'information ; retirable à tout moment. Chaque changement est inscrit dans device_location_consent_events. [US-107 RF11, RT5]$$;
COMMENT ON TABLE device_location_consent_events IS $$Journal des consentements à la position : appareil, profil (identifiant seul), accord ou retrait, version du texte, date. Sans clé étrangère, conservé 5 ans après l'événement (réglable). [US-107 RF11, RT5, D54]$$;
COMMENT ON COLUMN device_location_consent_events.cause IS $$user_action = choix de l'utilisateur ; device_revoked = appareil révoqué ; device_deleted = appareil ou profil supprimé$$;
COMMENT ON TABLE device_last_positions IS $$Dernière position connue d'un appareil (une ligne, remplacée à chaque lecture), chiffrée, conservée 3 heures au plus et jamais au-delà de la fin du RDV suivi. Jamais affichée aux autres profils. [US-107 RF5, RF12, D46, D47]$$;
COMMENT ON COLUMN device_last_positions.expires_at IS $$Fin de conservation : au plus captured_at + 3 heures (contrôle en base), ramenée à la fin du RDV suivi par l'application. La purge tourne toutes les 5 minutes et la lecture ignore les lignes échues$$;
COMMENT ON TABLE travel_tracking IS $$Suivi du trajet activé par un profil pour un RDV ou une série qui le concerne. Seuls les profils qui l'ont activé sont notifiés. Jamais pour un RDV médical, ni sans lieu. [US-107 RF4, D47]$$;
COMMENT ON TABLE event_travel_advice IS $$Estimation de trajet d'un profil pour un RDV : base de départ, durées, heure de départ conseillée, notifications envoyées. Aucune position. Supprimée à la fin du RDV. [US-107 RF5 à RF8, RF12]$$;
COMMENT ON TABLE event_place_searches IS $$Recherche « Sur place » d'un RDV (où se garer, où manger) : travail à exécuter, état (en attente, en cours, terminée, aucune information, échec, obsolète) et résultat chiffré. Au plus 3 recherches non échouées par RDV ; supprimée à la fin du RDV. [US-112 RF8, RF9, RT4, RT5, D52]$$;
COMMENT ON COLUMN event_place_searches.status IS $$queued = demandée, pas encore prise ; running = en cours ; done = résultat disponible ; no_result = aucune information fiable ; failed = échec (n'est pas comptée dans les 3 par RDV) ; obsolete = l'adresse du RDV a changé, résultat effacé mais recherche comptée$$;
COMMENT ON COLUMN event_place_searches.result_payload IS $$Adresses trouvées (1 ou 2 parkings, 2 « petite faim », 2 « grande faim » : nom, type, ville, distance à pied, source), JSON chiffré par l'application. Aucun avis ni note ; aucune coordonnée$$;
COMMENT ON COLUMN event_place_searches.seq IS $$Rang de la recherche pour le RDV, attribué par trigger et jamais réutilisé$$;
COMMENT ON TABLE event_place_suggestions IS $$Suggestion automatique de la recherche « Sur place », faite une seule fois par RDV, pour un lieu public identifiable ou en cas de doute, jugé par l'agent à la proposition du RDV, avec la réponse (« Oui », « Non, merci »). Un lieu manifestement privé n'est jamais suggéré ; aucun calcul de distance. [US-112 RF3, D60]$$;
COMMENT ON COLUMN agent_conversation_messages.place_search_id IS $$Message « Sur place » : recherche dont il présente le résultat (sans copie du contenu)$$;
COMMENT ON FUNCTION device_last_position(uuid) IS $$Dernière position connue d'un appareil (chiffrée), uniquement si elle n'est pas échue et si le consentement est actif. Aucun autre accès : jamais lisible par un autre profil. [US-107 RF5, RF12]$$;
COMMENT ON FUNCTION purge_location_consent_events() IS $$Supprime les inscriptions du journal des consentements à la position au-delà de leur durée de conservation (5 ans par défaut). À planifier chaque jour. [US-107 RT5, D54]$$;
COMMENT ON FUNCTION request_place_search(uuid, uuid, place_search_origin, date) IS $$Crée une recherche « Sur place » en attente, ou retourne le motif du refus (not_found, medical, no_location, ended, event_limit, daily_limit). La recherche compte dans le plafond quotidien du profil ; 3 par RDV hors échecs. [US-112 RF1, RF9, RT5]$$;
COMMENT ON FUNCTION claim_place_search(uuid) IS $$Passe une recherche de « en attente » à « en cours ». Avec un identifiant : l'exécuteur lancé dès la demande. Sans identifiant : le planificateur reprend la plus ancienne recherche en attente depuis plus de 30 secondes. NULL si rien à prendre ou déjà prise. [US-112 RT5]$$;
COMMENT ON FUNCTION complete_place_search(uuid, place_search_status, bytea, text, date, boolean) IS $$Termine une recherche en cours (done, no_result ou failed) ; false si elle n'est plus en cours (obsolète). Peut prévenir le profil demandeur. [US-112 RF4, RF10, RF11]$$;
COMMENT ON FUNCTION fail_stale_place_searches() IS $$Fait échouer les recherches « Sur place » en cours depuis plus de 120 secondes (réglable) ou en attente depuis plus de 15 minutes. À planifier toutes les 5 minutes. [US-112 RF11, RT5]$$;
COMMENT ON FUNCTION purge_place_searches() IS $$Supprime les recherches « Sur place » (et leurs résultats) des RDV terminés, annulés ou ignorés. À planifier chaque heure. [US-112 RT4]$$;
COMMENT ON FUNCTION travel_advice_visible_to(uuid) IS $$Estimations de trajet d'un profil : uniquement les siennes, jamais celles d'un autre profil (D55). [US-107, US-112]$$;
COMMENT ON FUNCTION purge_travel_data() IS $$Supprime les estimations de trajet et les suivis des RDV terminés, et les suivis des séries terminées ou annulées. À planifier chaque heure. [US-107 RF12]$$;
COMMENT ON FUNCTION purge_expired_device_positions() IS $$Supprime les dernières positions échues (3 heures au plus, jamais au-delà de la fin du RDV). À planifier toutes les 5 minutes. [US-107 RF12, D47]$$;
