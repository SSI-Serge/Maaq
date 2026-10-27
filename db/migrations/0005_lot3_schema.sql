-- Copié TEL QUEL de la session « base de données » : migrations/lot_3_2_schema.sql (SHA-256 ecd8c2c28c765dba…, le 27/10/2026).
-- Lot 3 du MVP2 (enregistrement d'office, AT-8). Ne jamais modifier à la main ; chaque fichier est appliqué dans sa propre transaction.
-- MAAQ — lot 3 : Enregistrement d'office
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_3_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- D49 : échéance d'enregistrement automatique (NULL = jamais), tenue par trigger ; confirmé d'office au nom de « MAAQ (sans réponse) »
ALTER TABLE family_events
  ADD COLUMN auto_confirm_at         timestamptz;
ALTER TABLE family_events
  ADD COLUMN auto_confirmed          boolean NOT NULL DEFAULT false;
-- Une confirmation d'office n'a pas de profil confirmeur ; elle ne peut exister que pour un RDV confirmé (puis éventuellement annulé)
ALTER TABLE family_events
  ADD CONSTRAINT ck_family_events_auto_confirmed CHECK (NOT auto_confirmed OR (confirmed_by_user_id IS NULL AND status IN ('confirmed', 'cancelled')));

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION change_family_event_status(
  p_event_id uuid, p_to event_status, p_user_id uuid,
  p_expected_version integer DEFAULT NULL, p_reason event_change_reason DEFAULT 'user_request'
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
  INSERT INTO family_event_history (event_id, user_id, action, from_status, to_status, reason)
  VALUES (p_event_id, p_user_id,
          CASE p_to WHEN 'confirmed' THEN 'confirmed' WHEN 'set_aside' THEN 'set_aside'
                    WHEN 'dismissed' THEN 'dismissed' ELSE 'cancelled' END::event_action,
          v_event.status, p_to, p_reason);
  RETURN true;
END $$;
CREATE OR REPLACE VIEW v_family_logbook AS
SELECT h.event_id AS family_event_id, NULL::uuid AS inbound_email_id, e.account_id, h.occurred_at,
       h.user_id AS actor_user_id,
       CASE h.action WHEN 'confirmed' THEN CASE WHEN h.user_id IS NULL AND h.reason = 'no_response' THEN 'event_auto_confirmed' ELSE 'event_confirmed' END
                     WHEN 'set_aside' THEN 'event_set_aside'
                     WHEN 'dismissed' THEN 'event_dismissed' WHEN 'modified' THEN 'event_modified'
                     ELSE 'event_cancelled' END AS entry_kind
  FROM family_event_history h JOIN family_events e ON e.id = h.event_id
 WHERE h.action IN ('confirmed', 'set_aside', 'dismissed', 'modified', 'cancelled')
   AND (h.user_id IS NOT NULL OR h.action IN ('modified', 'cancelled') OR (h.action = 'confirmed' AND h.reason = 'no_response'))
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
-- Sources dont le RDV peut être confirmé d'office : texte, dictée, photo envoyés dans le tchat. Le mail transféré, le partage
-- Android, WhatsApp, la synchronisation d'agenda et toute future source exigent une confirmation (valeur par défaut sûre).
CREATE FUNCTION family_event_auto_confirmable_source(p_source event_source) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_source IN ('chat_text', 'voice', 'photo')
$$;
-- Échéance d'enregistrement automatique : le plus petit de (proposition + 72 h) et (début - 2 h). Le délai court depuis la
-- proposition (created_at) même si un parent modifie le RDV. NULL si le RDV ne peut jamais être confirmé d'office : statut autre
-- que provisoire (un RDV écarté n'est jamais concerné), source non autorisée, séance d'une série (une série n'est jamais
-- enregistrée d'office), ou RDV proposé moins de 2 h avant son début.
CREATE FUNCTION family_event_auto_confirm_at() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_delay integer; v_lead integer;
BEGIN
  NEW.auto_confirm_at := NULL;
  IF NEW.status = 'provisional' AND family_event_auto_confirmable_source(NEW.source) THEN
    SELECT value_text::integer INTO v_delay FROM platform_settings WHERE setting_key = 'auto_confirm_delay_hours';
    SELECT value_text::integer INTO v_lead FROM platform_settings WHERE setting_key = 'auto_confirm_min_lead_hours';
    IF NEW.starts_at - NEW.created_at >= make_interval(hours => COALESCE(v_lead, 2)) THEN
      NEW.auto_confirm_at := LEAST(NEW.created_at + make_interval(hours => COALESCE(v_delay, 72)),
                                   NEW.starts_at - make_interval(hours => COALESCE(v_lead, 2)));
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Traitement du planificateur (toutes les 5 minutes) : confirme au nom de « MAAQ (sans réponse) » les RDV provisoires dont
-- l'échéance est atteinte depuis moins de la tolérance (60 minutes). Exceptions évaluées ici, car elles changent : RDV en conflit,
-- RDV dont le membre est à préciser. Chaque RDV est traité sous verrou (SKIP LOCKED) : si un parent confirme au même instant,
-- un seul gagne. Les tâches proposées passent à « à faire » avec le RDV. Les parents (et l'auteur de la demande) sont prévenus ;
-- la nuit (21 h à 8 h, fuseau de la famille), la notification est décalée à 8 h. Retourne le nombre de RDV confirmés.
CREATE FUNCTION auto_confirm_family_events() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_grace integer; v_ev record; v_n integer := 0; v_tz text; v_local timestamp; v_due timestamptz;
BEGIN
  SELECT value_text::integer INTO v_grace FROM platform_settings WHERE setting_key = 'auto_confirm_grace_minutes';
  FOR v_ev IN
    SELECT id, account_id, starts_at, ends_at, whole_family, requested_by_user_id FROM family_events
     WHERE status = 'provisional' AND auto_confirm_at IS NOT NULL AND auto_confirm_at <= now()
       AND now() < auto_confirm_at + make_interval(mins => COALESCE(v_grace, 60)) AND starts_at > now()
     ORDER BY auto_confirm_at FOR UPDATE SKIP LOCKED
  LOOP
    CONTINUE WHEN NOT v_ev.whole_family AND NOT EXISTS (SELECT 1 FROM family_event_members WHERE event_id = v_ev.id);
    CONTINUE WHEN EXISTS (SELECT 1 FROM find_family_event_conflicts(
        v_ev.account_id, ARRAY(SELECT member_id FROM family_event_members WHERE event_id = v_ev.id),
        v_ev.whole_family, v_ev.starts_at, v_ev.ends_at, v_ev.id));
    BEGIN
      IF NOT change_family_event_status(v_ev.id, 'confirmed', NULL, NULL, 'no_response') THEN CONTINUE; END IF;
    EXCEPTION WHEN check_violation THEN CONTINUE;
    END;
    v_n := v_n + 1;
    SELECT family_timezone INTO v_tz FROM accounts WHERE id = v_ev.account_id;
    v_local := now() AT TIME ZONE v_tz;
    v_due := CASE WHEN v_local::time >= time '21:00' THEN ((v_local::date + 1) + time '08:00') AT TIME ZONE v_tz
                  WHEN v_local::time < time '08:00' THEN (v_local::date + time '08:00') AT TIME ZONE v_tz
                  ELSE now() END;
    UPDATE scheduled_notifications SET status = 'cancelled'
     WHERE event_id = v_ev.id AND kind IN ('follow_up_24h', 'follow_up_48h') AND status = 'scheduled';
    INSERT INTO scheduled_notifications (event_id, recipient_user_id, kind, due_at)
    SELECT v_ev.id, u.id, 'auto_confirmed', v_due FROM users u
     WHERE u.account_id = v_ev.account_id AND u.status <> 'removed'
       AND (u.role = 'primary_user' OR u.guest_rank = 'core' OR u.id = v_ev.requested_by_user_id)
    ON CONFLICT (event_id, kind, recipient_user_id, due_at) WHERE event_id IS NOT NULL DO NOTHING;
  END LOOP;
  RETURN v_n;
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
CREATE OR REPLACE FUNCTION revalidate_event_notices() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_a integer; v_b integer;
BEGIN
  UPDATE scheduled_notifications n SET kind = 'event_added'
    FROM family_events e
   WHERE e.id = n.event_id AND n.status = 'scheduled' AND n.kind = 'event_to_confirm' AND e.status = 'confirmed'
     AND NOT e.auto_confirmed
     AND n.recipient_user_id IS DISTINCT FROM e.confirmed_by_user_id
     AND n.recipient_user_id IS DISTINCT FROM e.requested_by_user_id
     AND COALESCE((SELECT s.notify_events_added FROM user_assistant_settings s WHERE s.user_id = n.recipient_user_id), true);
  GET DIAGNOSTICS v_a = ROW_COUNT;
  UPDATE scheduled_notifications n SET status = 'cancelled'
    FROM family_events e
   WHERE e.id = n.event_id AND n.status = 'scheduled' AND n.kind IN ('event_added', 'event_to_confirm')
     AND ((n.kind = 'event_to_confirm' AND e.status <> 'provisional')
       OR (n.kind = 'event_added' AND e.status <> 'confirmed')
       OR NOT COALESCE((SELECT s.notify_events_added FROM user_assistant_settings s WHERE s.user_id = n.recipient_user_id), true));
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
-- RDV provisoires à enregistrer d'office (planificateur de 5 minutes)
CREATE INDEX idx_family_events_auto_confirm ON family_events (auto_confirm_at) WHERE status = 'provisional' AND auto_confirm_at IS NOT NULL;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_family_events_auto_confirm_at BEFORE INSERT OR UPDATE OF starts_at, status, source, created_at ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_auto_confirm_at();

-- ---------------------------------------------------------------------
-- Données de référence
-- ---------------------------------------------------------------------
-- Réglages du MVP2 (US-65)
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('auto_confirm_delay_hours',              'integer', '72', 1, NULL, $$Un RDV provisoire sans réponse est confirmé automatiquement ce nombre d'heures après sa proposition (AT-8, D49)$$),
  ('auto_confirm_min_lead_hours',           'integer', '2',  1, NULL, $$Le RDV est confirmé au plus tard ce nombre d'heures avant son début ; un RDV proposé moins de ce délai avant son début n'est jamais confirmé automatiquement (AT-8)$$),
  ('auto_confirm_grace_minutes',            'integer', '60', 1, NULL, $$Tolérance après l'échéance d'enregistrement automatique, en minutes : au-delà, le RDV reste à confirmer jusqu'à son début (D51)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON COLUMN family_events.auto_confirm_at IS $$Échéance d'enregistrement sans réponse : le plus petit de (proposition + 72 h) et (début - 2 h). NULL = jamais : RDV non provisoire, source hors tchat, séance de série, ou proposé moins de 2 h avant son début. Le délai court depuis la proposition même si le RDV est modifié$$;
COMMENT ON COLUMN family_events.auto_confirmed IS $$Confirmé d'office, au nom de « MAAQ (sans réponse) » : confirmed_by_user_id est alors vide, et l'historique porte le motif no_response. À distinguer d'une confirmation dont l'auteur a été supprimé$$;
COMMENT ON FUNCTION family_event_auto_confirmable_source(event_source) IS $$Vrai pour les RDV envoyés dans le tchat par texte, dictée ou photo ; faux pour toute information transmise hors de l'application (mail, partage Android, WhatsApp) et pour toute future source. [AT-8, D51]$$;
COMMENT ON FUNCTION auto_confirm_family_events() IS $$Confirme d'office, au nom de « MAAQ (sans réponse) », les RDV provisoires sans réponse dont l'échéance est atteinte (hors conflit et membre à préciser), avec leurs tâches proposées, et prévient les parents. À planifier toutes les 5 minutes. [AT-8, D49, D51, US-83]$$;
