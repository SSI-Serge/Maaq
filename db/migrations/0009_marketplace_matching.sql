-- =====================================================================
-- Marketplace silencieux — phase 2 : besoin d'un acheteur, suggestions et mises en relation
-- (agent « coup_de_main », rubrique Perso). Plan : docs/specs/MAAQ_Marketplace_Silencieux_Plan.md
-- (US-09 à US-12, US-14). Les préférences (marketplace_prefs) existent depuis la migration 0008.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Besoin exprimé par un acheteur : texte libre, catégorie et code postal si connus, moment souhaité.
-- Une demande ouverte marquée notify_later est réexaminée par le traitement périodique quand une
-- vitrine est publiée ou reconfirmée. Supprimée avec le profil (CASCADE), exportée avec ses données.
-- ---------------------------------------------------------------------
CREATE TYPE service_request_status AS ENUM ('open', 'suggested', 'closed');

CREATE TABLE service_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  text             text NOT NULL,
  category_code    text REFERENCES service_categories (code) ON DELETE SET NULL,
  -- Zone approximative de l'acheteur : code postal seul, jamais une adresse
  postcode         varchar(5) CHECK (postcode ~ '^[0-9]{5}$'),
  -- L'acheteur accepte un service à distance : la zone n'est alors pas indispensable
  remote_ok        boolean NOT NULL DEFAULT false,
  timing_text      varchar(200),
  status           service_request_status NOT NULL DEFAULT 'open',
  notify_later     boolean NOT NULL DEFAULT false,
  -- Dernier passage du service de mise en relation (explicite ou périodique)
  last_matched_at  timestamptz,
  -- Journal du dernier passage, par vitrine candidate : règles d'éligibilité et pertinence (lecture opérateur)
  match_log        jsonb NOT NULL DEFAULT '[]'::jsonb,
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_requests_user ON service_requests (user_id, created_at DESC);
CREATE INDEX idx_service_requests_notify ON service_requests (notify_later) WHERE status = 'open' AND notify_later;
COMMENT ON TABLE service_requests IS $$Besoin de service exprimé à l'agent coup_de_main ; sort du compte seulement dans le texte d'une mise en relation approuvée. [US-11, US-12]$$;
COMMENT ON COLUMN service_requests.match_log IS $$Pourquoi chaque vitrine candidate a été retenue ou écartée au dernier passage, pour l'opérateur. [US-17]$$;

-- ---------------------------------------------------------------------
-- Suggestion d'une vitrine à un acheteur : la raison affichée (reason) et la raison complète pour
-- l'opérateur (internal_reason : règles d'éligibilité, score, réserves). Une seule suggestion active par
-- couple (acheteur, vitrine) ; une suggestion écartée bloque le couple pendant la période de carence
-- (90 jours, règle dans marketplace/rules.ts).
-- ---------------------------------------------------------------------
CREATE TYPE suggestion_status AS ENUM ('shown', 'interested', 'dismissed', 'muted', 'expired');

CREATE TABLE suggestions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL pour une suggestion proactive sans demande explicite (phase ultérieure)
  request_id       uuid REFERENCES service_requests (id) ON DELETE SET NULL,
  buyer_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  storefront_id    uuid NOT NULL REFERENCES storefronts (id) ON DELETE CASCADE,
  -- Raison en langage courant, montrée à l'acheteur
  reason           text NOT NULL,
  -- Raison complète : chaque règle d'éligibilité, score, réserves du modèle (jamais affichée à l'acheteur)
  internal_reason  text NOT NULL,
  score            numeric(3, 2) CHECK (score >= 0 AND score <= 1),
  -- strong : affirmée ; possible : présentée comme une question
  fit              text NOT NULL CHECK (fit IN ('strong', 'possible')),
  status           suggestion_status NOT NULL DEFAULT 'shown',
  shown_at         timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_suggestions_active ON suggestions (buyer_user_id, storefront_id) WHERE status IN ('shown', 'interested');
CREATE INDEX idx_suggestions_buyer ON suggestions (buyer_user_id, shown_at DESC);
CREATE INDEX idx_suggestions_storefront ON suggestions (storefront_id);
COMMENT ON TABLE suggestions IS $$Vitrine proposée à un acheteur, avec la raison affichée et la raison complète pour l'opérateur. [US-11, US-14, US-17]$$;
COMMENT ON COLUMN suggestions.internal_reason IS $$Règles d'éligibilité et pertinence, lisibles sans ouvrir le tchat$$;

-- ---------------------------------------------------------------------
-- Mise en relation : créée uniquement à la validation d'une carte par l'acheteur. shared_text est
-- exactement le texte approuvé, transmis au fournisseur. Une seule mise en relation ouverte par couple.
-- Les statuts accepted / declined / question / connected arrivent avec la réponse du fournisseur (phase 3).
-- ---------------------------------------------------------------------
CREATE TYPE introduction_status AS ENUM ('requested', 'accepted', 'declined', 'question', 'connected', 'expired');

CREATE TABLE introductions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id     uuid REFERENCES suggestions (id) ON DELETE SET NULL,
  buyer_user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  storefront_id     uuid NOT NULL REFERENCES storefronts (id) ON DELETE CASCADE,
  -- Texte exactement tel qu'approuvé par l'acheteur sur la carte
  shared_text       text NOT NULL,
  channel           text NOT NULL DEFAULT 'app' CHECK (channel IN ('app', 'whatsapp')),
  status            introduction_status NOT NULL DEFAULT 'requested',
  supplier_message  text,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  answered_at       timestamptz,
  connected_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_introductions_open ON introductions (buyer_user_id, storefront_id) WHERE status IN ('requested', 'question', 'accepted');
CREATE INDEX idx_introductions_buyer ON introductions (buyer_user_id, requested_at DESC);
CREATE INDEX idx_introductions_storefront ON introductions (storefront_id, status);
COMMENT ON TABLE introductions IS $$Mise en relation demandée par un acheteur après validation de la carte ; le contact n'est révélé qu'après acceptation du fournisseur. [US-12, US-07, US-08]$$;
COMMENT ON COLUMN introductions.shared_text IS $$Texte approuvé par l'acheteur, transmis tel quel au fournisseur$$;
