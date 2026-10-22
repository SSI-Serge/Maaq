-- =====================================================================
-- Marketplace silencieux — phase 4 : signalement d'une vitrine (US-16) et administration des vitrines (US-17).
-- Plan : docs/specs/MAAQ_Marketplace_Silencieux_Plan.md, phase 4.
-- =====================================================================

-- Suspension par l'administrateur, distincte de la pause du fournisseur : la vitrine sort des suggestions
-- jusqu'à la levée, et le fournisseur en voit la raison sur l'écran « Ma vitrine ».
ALTER TABLE storefronts
  ADD COLUMN admin_paused        boolean NOT NULL DEFAULT false,
  ADD COLUMN admin_pause_reason  varchar(300);
COMMENT ON COLUMN storefronts.admin_paused IS $$Suspendue par l'administrateur (signalement, contenu inadapté) : hors suggestions jusqu'à la levée. [US-17]$$;

CREATE OR REPLACE VIEW v_eligible_storefronts AS
SELECT s.id, s.user_id, s.display_name, s.category_code, s.services, s.description, s.postcode, s.city, s.modes,
       s.travel_areas, s.travel_note, s.availability_mode, s.availability_text, s.price_mode, s.price_min, s.price_max,
       s.languages, s.notice_text, s.qualifications_text, s.contact_method, s.last_confirmed_at, s.published_at
FROM storefronts s
WHERE s.status = 'published'
  AND NOT s.admin_paused
  AND (s.paused_until IS NULL OR s.paused_until < current_date);

-- ---------------------------------------------------------------------
-- Signalement d'une vitrine par un membre à qui elle a été suggérée : motif, commentaire, décision de l'administrateur.
-- ---------------------------------------------------------------------
CREATE TYPE listing_report_status AS ENUM ('open', 'reviewed', 'dismissed');

CREATE TABLE listing_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  storefront_id     uuid NOT NULL REFERENCES storefronts (id) ON DELETE CASCADE,
  suggestion_id     uuid REFERENCES suggestions (id) ON DELETE SET NULL,
  reason            text NOT NULL CHECK (reason IN ('misleading', 'inappropriate', 'not_a_service', 'spam', 'other')),
  comment           varchar(1000),
  status            listing_report_status NOT NULL DEFAULT 'open',
  -- Décision libre de l'administrateur : suspendue, catégorie corrigée, sans suite…
  admin_decision    varchar(300),
  admin_user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_listing_reports_status ON listing_reports (status, created_at DESC);
CREATE INDEX idx_listing_reports_storefront ON listing_reports (storefront_id);
COMMENT ON TABLE listing_reports IS $$Signalement d'une vitrine par un membre ; traité depuis Admin › Vitrines. [US-16, US-17]$$;

-- Actions d'administration sur les vitrines et les signalements, dans le journal d'administration.
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'storefront_paused';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'storefront_resumed';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'storefront_category_changed';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'report_reviewed';
