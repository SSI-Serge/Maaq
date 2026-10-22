-- =====================================================================
-- Marketplace silencieux — phase 2b : suggestions déclenchées par l'agenda.
-- Plan : docs/specs/MAAQ_Marketplace_Silencieux_Plan.md (phase 2b, décision 7).
-- =====================================================================

-- Zone approximative du profil (code postal seul) : sert par défaut aux demandes de service, et aux suggestions
-- issues de l'agenda, qui ne passent pas par une demande écrite.
ALTER TABLE users ADD COLUMN postcode varchar(5) CHECK (postcode ~ '^[0-9]{5}$');
COMMENT ON COLUMN users.postcode IS $$Code postal du profil, jamais une adresse : zone par défaut des suggestions de services. [US-09, phase 2b]$$;

-- Consentement propre à la lecture de l'agenda, distinct des suggestions : son texte, sa version, sa date.
ALTER TABLE marketplace_prefs
  ADD COLUMN agenda_opt_in_at timestamptz,
  ADD COLUMN agenda_consent_version text;

-- Une demande peut venir du tchat ou de l'agenda. Issue de l'agenda, elle est « proposed » : l'agent demande
-- d'abord si la personne veut qu'on cherche, et ne cherche que sur son oui.
ALTER TYPE service_request_status ADD VALUE IF NOT EXISTS 'proposed' BEFORE 'open';
ALTER TABLE service_requests
  ADD COLUMN source text NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'agenda')),
  -- Clé de l'événement d'agenda à l'origine de la demande (dédoublonnage) et sa date ; jamais le titre
  ADD COLUMN agenda_event_key text,
  ADD COLUMN agenda_event_date date;
CREATE UNIQUE INDEX uq_service_requests_agenda_event ON service_requests (user_id, agenda_event_key) WHERE agenda_event_key IS NOT NULL;
COMMENT ON COLUMN service_requests.source IS $$chat : écrite par la personne ; agenda : déduite d'un événement de son agenda, avec son consentement propre$$;

-- Événements d'agenda déjà examinés, qu'ils aient donné une demande ou non : chacun n'est évalué qu'une fois.
-- Seule une clé opaque est conservée, jamais le titre.
CREATE TABLE agenda_events_seen (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event_key   text NOT NULL,
  seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_key)
);
COMMENT ON TABLE agenda_events_seen IS $$Clés des événements d'agenda déjà examinés par le marketplace silencieux ; aucun titre conservé. [phase 2b]$$;
