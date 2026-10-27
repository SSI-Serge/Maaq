-- Copié TEL QUEL de la session « base de données » : migrations/lot_2_2_schema.sql (SHA-256 3d9ce40679a72246…, le 27/10/2026).
-- Lot 2 du MVP2 (US-113). Ne jamais modifier à la main ; chaque fichier est appliqué dans sa propre transaction.
-- MAAQ — lot 2 : US-113 : notification de l'autre parent
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_2_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
CREATE TYPE notification_channel  AS ENUM ('push', 'none');

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
CREATE TABLE user_assistant_settings (
  user_id                      uuid PRIMARY KEY,
  account_id                   uuid NOT NULL,
  -- « Être prévenu des RDV ajoutés par l'autre parent » (parent) ou « qui me concernent » (invité secondaire) ; actif par défaut (US-113 RF14, D58)
  notify_events_added          boolean NOT NULL DEFAULT true,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_user_assistant_settings_user FOREIGN KEY (user_id, account_id)
    REFERENCES users (id, account_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- Horodatage ISO 8601 avec fuseau (ex. 2026-11-02T08:00:00+01:00)
ALTER TABLE platform_settings
  ADD CONSTRAINT ck_platform_settings_timestamp CHECK (
    value_type <> 'timestamp' OR value_text IS NULL OR value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    );
-- Canal d'une notification « RDV ajouté » ou « RDV à confirmer » (US-113 RT4) : push sur les appareils autorisés, ou « none » quand
-- le destinataire n'en a aucun (la ligne est écrite quand même, pour ne pas réessayer ni renvoyer un arriéré). Jamais par email.
ALTER TABLE scheduled_notifications
  ADD COLUMN channel notification_channel;
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT ck_scheduled_notifications_channel CHECK (
    (kind IN ('event_added', 'event_to_confirm')) = (channel IS NOT NULL)
    AND (channel IS DISTINCT FROM 'none' OR (status = 'not_applicable' AND push_sent_at IS NULL AND email_sent_at IS NULL))
    AND (kind NOT IN ('event_added', 'event_to_confirm') OR email_sent_at IS NULL));

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
-- Date de mise en service (ou toute autre réglage de type horodatage) ; NULL si non renseignée
CREATE FUNCTION platform_setting_timestamp(p_key text) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN value_type = 'timestamp' AND value_text IS NOT NULL THEN value_text::timestamptz END
    FROM platform_settings WHERE setting_key = p_key
$$;
-- Une notification due entre 21 h et 8 h (fuseau de la famille) est reportée à 8 h (AF-2, US-113 RF12)
CREATE FUNCTION shift_to_morning(p_account_id uuid, p_at timestamptz DEFAULT now()) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE v_tz text; v_local timestamp;
BEGIN
  SELECT family_timezone INTO v_tz FROM accounts WHERE id = p_account_id;
  v_local := p_at AT TIME ZONE v_tz;
  RETURN CASE WHEN v_local::time >= time '21:00' THEN ((v_local::date + 1) + time '08:00') AT TIME ZONE v_tz
              WHEN v_local::time < time '08:00' THEN (v_local::date + time '08:00') AT TIME ZONE v_tz
              ELSE p_at END;
END $$;
-- Destinataires possibles d'une notification « RDV ajouté » (event_added) ou « RDV à confirmer » (event_to_confirm), avec la présence
-- d'au moins un appareil autorisé (canal). Règles : jamais le demandeur ni celui qui confirme ; seuls les RDV proposés après la date de
-- mise en service ; réglage personnel actif par défaut. Parents : « à confirmer » si le RDV est provisoire, « ajouté » s'il a été confirmé
-- par l'autre parent ou le demandeur dans le délai de 10 minutes (pas pour un enregistrement d'office, qui a son propre avis).
-- Invité secondaire nommé parmi les membres du RDV (un RDV de toute la famille ne désigne personne) : « ajouté » seulement, à toute confirmation, y compris d'office,
-- jamais « à confirmer ». Une série n'a qu'une notification : l'application désigne sa première séance.
CREATE FUNCTION family_event_notice_recipients(p_event_id uuid, p_kind notification_kind)
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
             OR (v_e.confirmed_at <= v_e.created_at + make_interval(mins => v_delay))
           ELSE
             p_kind = 'event_added'
             AND EXISTS (SELECT 1 FROM family_event_members m JOIN family_members fm ON fm.id = m.member_id
                          WHERE m.event_id = v_e.id AND fm.user_id = u.id)
         END;
END $$;
-- Réservation atomique de l'envoi : une ligne par RDV et par destinataire, tous types confondus (index unique). Les deux chemins (tentative
-- immédiate après la confirmation, puis planificateur) passent ici et ne produisent jamais de doublon. Canal « none » (statut
-- not_applicable) sans appareil autorisé : rien n'est envoyé, rien n'est retenté. Heure d'envoi reportée à 8 h la nuit. Retourne l'identifiant
-- de la ligne réservée, NULL si le destinataire n'est pas éligible ou si une notification existe déjà pour ce RDV.
CREATE FUNCTION reserve_event_notice(p_event_id uuid, p_recipient uuid, p_kind notification_kind) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_has boolean; v_account uuid; v_id bigint;
BEGIN
  SELECT r.has_device INTO v_has FROM family_event_notice_recipients(p_event_id, p_kind) r WHERE r.user_id = p_recipient;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT account_id INTO v_account FROM family_events WHERE id = p_event_id;
  INSERT INTO scheduled_notifications (event_id, recipient_user_id, kind, due_at, status, channel)
  VALUES (p_event_id, p_recipient, p_kind, shift_to_morning(v_account, now()),
          CASE WHEN v_has THEN 'scheduled'::notification_status ELSE 'not_applicable'::notification_status END,
          CASE WHEN v_has THEN 'push'::notification_channel ELSE 'none'::notification_channel END)
  ON CONFLICT (event_id, recipient_user_id) WHERE kind IN ('event_added', 'event_to_confirm') DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
-- Planificateur (toutes les 5 minutes) et tentative immédiate après une confirmation (avec l'identifiant du RDV) : réserve les notifications
-- dues. « À confirmer » : RDV toujours provisoire 10 minutes après sa proposition. « Ajouté » : RDV confirmé (dans les 10 minutes pour
-- les parents, à tout moment pour l'invité secondaire concerné). Seuls les RDV récents sont examinés ; une série n'est notifiée que par
-- sa première séance. Retourne le nombre de notifications réservées.
CREATE FUNCTION plan_event_notices(p_event_id uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_activation timestamptz; v_delay integer; v_ev record; v_r record; v_kind notification_kind; v_n integer := 0;
BEGIN
  v_activation := platform_setting_timestamp('event_notice_activation_at');
  IF v_activation IS NULL THEN RETURN 0; END IF;
  SELECT COALESCE(value_text::integer, 10) INTO v_delay FROM platform_settings WHERE setting_key = 'event_notice_delay_minutes';
  FOR v_ev IN
    SELECT e.id, e.status FROM family_events e
     WHERE (p_event_id IS NULL OR e.id = p_event_id)
       AND e.created_at >= v_activation AND e.ends_at > now()
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
-- À l'envoi (à 8 h pour une notification reportée la nuit), c'est l'état du RDV qui décide la notification envoyée (RF12, CA 12.1 et 12.2) :
-- une notification en attente peut donc changer de type. RDV encore provisoire : « à confirmer » ; RDV confirmé entre-temps :
-- « à confirmer » devient « ajouté » (la ligne réservée est mise à jour, l'index unique le permet), sauf pour celui qui a confirmé, le demandeur,
-- un enregistrement d'office (avis propre) ou un réglage personnel désactivé ; RDV écarté, annulé ou ignoré : la notification est annulée.
-- Cette conversion ne vaut que pour une notification pas encore envoyée : après l'envoi effectif d'un « à confirmer », plus rien ne part (RF4).
-- Retourne le nombre de lignes modifiées (converties ou annulées).
CREATE FUNCTION revalidate_event_notices() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_a integer; v_b integer;
BEGIN
  UPDATE scheduled_notifications n SET kind = 'event_added'
    FROM family_events e
   WHERE e.id = n.event_id AND n.status = 'scheduled' AND n.kind = 'event_to_confirm' AND e.status = 'confirmed'
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
CREATE INDEX idx_user_assistant_settings_account_id ON user_assistant_settings (account_id);
-- Une seule notification « RDV ajouté » ou « RDV à confirmer » par RDV et par destinataire, tous types confondus : jamais les deux,
-- et aucune confirmation après une notification de RDV provisoire (US-113 RF1, RF4, RT2, RT4)
CREATE UNIQUE INDEX ux_scheduled_notifications_event_notice ON scheduled_notifications (event_id, recipient_user_id)
  WHERE kind IN ('event_added', 'event_to_confirm');

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
  ('event_notice_delay_minutes',           'integer', '10', 1, NULL, $$Délai après la proposition d'un RDV pour la notification de l'autre parent : confirmé dans ce délai = « ajouté », sinon « à confirmer » (US-113 RF2, RF3, D57)$$),
  ('event_notice_activation_at',           'timestamp', NULL, NULL, NULL, $$Garde-fou de mise en service de la notification de l'autre parent : seuls les RDV proposés après cette date sont notifiés ; vide = notification désactivée (US-113 RT5)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON TABLE user_assistant_settings IS $$Réglages personnels d'un profil, une colonne par réglage : prévenu des RDV ajoutés (US-113), rappel quotidien des tâches, point de la semaine. Créée à la première modification ; absence de ligne = valeurs par défaut. [US-97 RF8, US-98 RF7]$$;
COMMENT ON FUNCTION platform_setting_timestamp(text) IS $$Valeur d'un réglage de type horodatage, NULL si non renseigné. [US-113 RT5]$$;
COMMENT ON FUNCTION shift_to_morning(uuid, timestamptz) IS $$Reporte à 8 h (fuseau de la famille) une heure comprise entre 21 h et 8 h. [AF-2, US-113 RF12]$$;
COMMENT ON FUNCTION family_event_notice_recipients(uuid, notification_kind) IS $$Destinataires d'une notification « RDV ajouté » ou « RDV à confirmer » avec leur canal (appareil autorisé ou non) : jamais le demandeur ni celui qui confirme, seulement après la date de mise en service, réglage personnel respecté ; invité secondaire seulement pour « ajouté ». [US-113 RF1 à RF11, RF14]$$;
COMMENT ON FUNCTION reserve_event_notice(uuid, uuid, notification_kind) IS $$Réserve l'envoi d'une notification « RDV ajouté » ou « RDV à confirmer » : une seule par RDV et par destinataire, canal « none » sans appareil autorisé, report à 8 h la nuit. NULL si non éligible ou déjà réservée. [US-113 RF16, RT1, RT4]$$;
COMMENT ON FUNCTION plan_event_notices(uuid) IS $$Réserve les notifications « RDV ajouté » et « RDV à confirmer » dues (planificateur de 5 minutes, ou tentative immédiate après une confirmation avec l'identifiant du RDV). Idempotent. [US-113 RF2, RF3, RF10, RT1]$$;
COMMENT ON FUNCTION revalidate_event_notices() IS $$Remet les notifications « RDV ajouté » ou « RDV à confirmer » en attente en accord avec l'état du RDV : un « à confirmer » devient « ajouté » si le RDV a été confirmé entre-temps (sauf pour celui qui confirme, le demandeur, un enregistrement d'office), et la notification est annulée si le RDV est écarté, annulé ou ignoré ou si le réglage personnel est désactivé. Ne touche jamais une notification déjà envoyée. À appeler avant l'envoi des notifications dues. [US-113 RF4, RF5, RF12, CA 12.1, CA 12.2]$$;
