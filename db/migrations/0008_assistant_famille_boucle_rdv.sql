-- =====================================================================
-- Assistant Famille, étape 2 (boucle de RDV, US-74 à US-80) : cycle de vie des rendez-vous.
-- - RT5 (US-75) : titre, lieu et note peuvent contenir des données de santé : ils sont chiffrés en base ;
-- - RT1 (US-76) : numéro de version pour refuser une modification fondée sur une version dépassée ;
-- - RT4 (US-75) : chaque changement de statut est historisé (auteur, date, motif) ;
-- - D27 : un RDV « toute la famille » ; AF-5 : une couleur par membre.
-- La migration 0007 n'a été appliquée nulle part (branche de travail) : elle refuse de continuer si des rendez-vous existent déjà,
-- car le titre, le lieu et la note en clair ne peuvent être chiffrés que par l'application.
-- =====================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM family_events) THEN
    RAISE EXCEPTION 'family_events contient déjà des rendez-vous : chiffrer title, place et notes avant cette migration';
  END IF;
END $$;

ALTER TABLE family_events
  DROP COLUMN title,
  DROP COLUMN place,
  DROP COLUMN notes,
  ADD COLUMN title_encrypted bytea NOT NULL,
  ADD COLUMN place_encrypted bytea,
  ADD COLUMN notes_encrypted bytea,
  -- D27 : concerne toute la famille ; aucune ligne dans family_event_members n'est alors nécessaire
  ADD COLUMN all_family boolean NOT NULL DEFAULT false,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Dernier changement de statut (AF-1) : sert à « Confirmé par Julien le 24/10 à 9 h 12 » et à l'expiration des RDV écartés
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN status_changed_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX idx_family_events_account_status ON family_events (account_id, status, starts_at);
COMMENT ON COLUMN family_events.title_encrypted IS $$Titre chiffré (AES-256-GCM, clé de l'application) : peut contenir un prénom ou une donnée de santé. [US-75 RT5]$$;
COMMENT ON COLUMN family_events.place_encrypted IS $$Lieu chiffré. Jamais transmis à l'assistant (D31).$$;
COMMENT ON COLUMN family_events.notes_encrypted IS $$Note chiffrée. Jamais transmise à l'assistant (D31).$$;
COMMENT ON COLUMN family_events.all_family IS $$Concerne toute la famille (D27) : en conflit avec tout rendez-vous qui le chevauche$$;
COMMENT ON COLUMN family_events.version IS $$Numéro de version : incrémenté à chaque modification ou changement de statut ; une modification fondée sur une version dépassée est refusée [US-76 RT1]$$;
COMMENT ON COLUMN family_events.status_changed_by_user_id IS $$Auteur du dernier changement de statut ; vide pour un changement fait par le système$$;

ALTER TABLE family_members
  ADD COLUMN color varchar(7) CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$');
COMMENT ON COLUMN family_members.color IS $$Couleur du membre dans le calendrier (AF-5), au format #rrggbb$$;

-- Historique des changements de statut et des modifications (US-75 RT4, US-77, US-80 RT2). Alimente l'onglet « Famille » du carnet (US-40).
CREATE TABLE family_event_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_id     uuid NOT NULL REFERENCES family_events (id) ON DELETE CASCADE,
  action       varchar(30) NOT NULL CHECK (action IN ('created', 'confirmed', 'modified', 'set_aside', 'ignored', 'canceled')),
  from_status  family_event_status,
  to_status    family_event_status NOT NULL,
  -- Vide pour un changement fait par le système
  by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_family_event_history_event ON family_event_history (event_id, created_at);
CREATE INDEX idx_family_event_history_account ON family_event_history (account_id, created_at);
COMMENT ON TABLE family_event_history IS $$Historique des changements d'un rendez-vous : statut, auteur, date, motif. Ne contient aucun titre ni lieu. [US-75 RT4]$$;
