-- Assistant Famille, étape 3a : rappels et relances par email (US-81, US-82, US-83).
-- Les échéances sont calculées à chaque passage du planificateur à partir du rendez-vous et des réglages ; seuls les envois sont enregistrés.

-- Instant à partir duquel les rappels d'un rendez-vous confirmé s'appliquent : sa confirmation, ou son dernier changement d'horaire.
-- Un rappel dont l'échéance précède cet instant n'est pas envoyé (« Non applicable », US-81 RF5, RF9).
ALTER TABLE family_events ADD COLUMN reminders_from timestamptz;
COMMENT ON COLUMN family_events.reminders_from IS $$Les rappels dont l'échéance précède cet instant sont « Non applicables » ; vide : date du dernier changement de statut [US-81 RF5, RF9]$$;

-- Délais de rappel par type de rendez-vous, communs à toute la famille (US-82). Sans ligne, les trois rappels sont actifs.
CREATE TABLE family_reminder_settings (
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_type         family_event_type NOT NULL,
  d7                 boolean NOT NULL DEFAULT true,
  d1                 boolean NOT NULL DEFAULT true,
  d0                 boolean NOT NULL DEFAULT true,
  updated_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, event_type)
);
COMMENT ON TABLE family_reminder_settings IS $$Rappels J-7, J-1 et Jour J actifs, par famille et par type de rendez-vous. [US-82]$$;

-- Rappels et relances envoyés. La clé unique garantit qu'un même envoi ne part jamais deux fois au même destinataire,
-- même si deux passages du planificateur se chevauchent (US-81 RF7, RT2).
CREATE TABLE family_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_id          uuid NOT NULL REFERENCES family_events (id) ON DELETE CASCADE,
  kind              varchar(10) NOT NULL CHECK (kind IN ('d7', 'd1', 'd0', 'nudge24', 'nudge48')),
  recipient_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel           varchar(10) NOT NULL DEFAULT 'email',
  -- « claimed » : réservé par un passage, en cours d'envoi ; « sent » : parti. Une réservation restée sans envoi est reprise au bout de 10 minutes.
  status            varchar(10) NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent')),
  claimed_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  UNIQUE (event_id, kind, recipient_user_id)
);
CREATE INDEX idx_family_notifications_account ON family_notifications (account_id, sent_at);
COMMENT ON TABLE family_notifications IS $$Rappels (d7, d1, d0) et relances (nudge24, nudge48) envoyés pour un rendez-vous. Ne contient aucun titre ni lieu. [US-81 RT2, US-83 RT1]$$;
