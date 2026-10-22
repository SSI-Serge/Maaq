-- =====================================================================
-- Marketplace silencieux — phase 1 : vitrine d'un fournisseur (agent « vitrine », rubrique Pro),
-- catégories de services, préférences de suggestion d'un acheteur.
-- Plan : docs/specs/MAAQ_Marketplace_Silencieux_Plan.md (US-01 à US-06, US-09, US-13).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Catégories de services : liste de référence sur laquelle filtre l'éligibilité. Les services
-- précis (« tresses », « buffet froid ») restent en texte libre dans la vitrine.
-- ---------------------------------------------------------------------
CREATE TABLE service_categories (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]+$'),
  label       varchar(80) NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 1,
  is_active   boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE service_categories IS $$Catégories de services du marketplace silencieux ; l'administrateur peut en ajouter ou en désactiver. [US-13, US-17]$$;

INSERT INTO service_categories (code, label, sort_order) VALUES
  ('coiffure',       'Coiffure et barbier',            1),
  ('beaute',         'Beauté et bien-être',            2),
  ('traiteur',       'Traiteur et cuisine',            3),
  ('menage',         'Ménage et repassage',            4),
  ('garde_enfants',  'Garde d''enfants',               5),
  ('cours',          'Cours et soutien scolaire',      6),
  ('bricolage',      'Bricolage et petits travaux',    7),
  ('jardinage',      'Jardinage',                      8),
  ('informatique',   'Informatique et téléphonie',     9),
  ('couture',        'Couture et retouches',          10),
  ('photo',          'Photo et vidéo',                11),
  ('evenementiel',   'Événementiel et animation',     12),
  ('transport',      'Transport et déménagement',     13),
  ('animaux',        'Animaux',                       14),
  ('autre',          'Autre service',                 99);

-- ---------------------------------------------------------------------
-- Vitrine : une par profil. Première donnée lisible depuis un autre compte, une fois publiée : seuls les
-- champs visibles par un acheteur sortent du compte, jamais l'adresse ni le contact avant une mise en
-- relation acceptée. Supprimée avec le profil (CASCADE), exportée avec ses données.
--
-- Provenance de chaque groupe de champs (colonne `provenance`, clé = groupe) :
--   stated    = dit par le fournisseur, extrait de ses mots ;
--   proposed  = proposé par l'agent (exemple, valeur par défaut), à confirmer ;
--   confirmed = relu et confirmé explicitement par le fournisseur (écran de relecture ou relecture dans le tchat).
-- La publication exige les groupes obligatoires renseignés et non « proposed », et les groupes critiques
-- (zone, tarif s'il y en a un, contact) confirmés. Cette règle vit dans le code (marketplace/model.ts).
-- ---------------------------------------------------------------------
CREATE TYPE storefront_status AS ENUM ('draft', 'published', 'paused');
CREATE TYPE storefront_contact AS ENUM ('maaq_intro', 'whatsapp');

CREATE TABLE storefronts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  status                  storefront_status NOT NULL DEFAULT 'draft',
  display_name            varchar(100),
  category_code           text REFERENCES service_categories (code) ON DELETE RESTRICT,
  -- Services précis, courts : ["tresses", "twists"]
  services                jsonb NOT NULL DEFAULT '[]'::jsonb,
  description             text,
  -- Zone : code postal et ville approximatifs, jamais une adresse. Modes : at_supplier | travels | remote.
  postcode                varchar(5) CHECK (postcode ~ '^[0-9]{5}$'),
  city                    varchar(100),
  modes                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Départements supplémentaires où le fournisseur se déplace : ["69", "01"]
  travel_areas            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Précision sur le déplacement, telle que dite : « le samedi seulement »
  travel_note             varchar(200),
  availability_mode       text CHECK (availability_mode IN ('hours', 'by_arrangement')),
  availability_text       varchar(300),
  -- Tarif : NULL = non précisé, affiché « Sur devis » ; from = à partir de price_min ; range = price_min à price_max
  price_mode              text CHECK (price_mode IN ('quote', 'from', 'range')),
  price_min               numeric(10, 2) CHECK (price_min >= 0),
  price_max               numeric(10, 2) CHECK (price_max >= 0),
  languages               jsonb NOT NULL DEFAULT '[]'::jsonb,
  notice_text             varchar(200),
  qualifications_text     varchar(500),
  contact_method          storefront_contact,
  -- Numéro ou email révélé seulement après une mise en relation acceptée (AES-256-GCM, clé ENCRYPTION_KEY)
  contact_value_encrypted bytea,
  -- Indisponibilité temporaire : exclue des recherches jusqu'à cette date incluse, sans toucher au statut
  paused_until            date,
  -- Recherche publique : prévue mais inactive dans la première version (suggestion silencieuse seule)
  searchable              boolean NOT NULL DEFAULT false,
  -- { "<groupe>": { "source": "stated|proposed|confirmed", "at": "<ISO>" } }
  provenance              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_confirmed_at       timestamptz,
  published_at            timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_storefronts_price_range CHECK (price_max IS NULL OR price_min IS NULL OR price_max >= price_min),
  CONSTRAINT ck_storefronts_published_at CHECK ((status = 'draft') = (published_at IS NULL))
);
CREATE INDEX idx_storefronts_eligible ON storefronts (category_code, postcode) WHERE status = 'published';
COMMENT ON TABLE storefronts IS $$Vitrine d'un fournisseur créée par l'agent vitrine. Visible hors du compte seulement si publiée. [US-01 à US-06, US-13]$$;
COMMENT ON COLUMN storefronts.provenance IS $$Origine de chaque groupe de champs : dit par le fournisseur, proposé par l'agent, ou confirmé. Les groupes proposés ne se publient pas$$;
COMMENT ON COLUMN storefronts.contact_value_encrypted IS $$Contact révélé après une mise en relation acceptée : jamais affiché dans une suggestion$$;

-- Vitrines éligibles à une recherche : publiées, hors pause temporaire. La complétude des champs est garantie
-- à la publication par le code ; une vitrine en pause (status) ou indisponible (paused_until) sort du lot.
CREATE VIEW v_eligible_storefronts AS
SELECT s.id, s.user_id, s.display_name, s.category_code, s.services, s.description, s.postcode, s.city, s.modes,
       s.travel_areas, s.travel_note, s.availability_mode, s.availability_text, s.price_mode, s.price_min, s.price_max,
       s.languages, s.notice_text, s.qualifications_text, s.contact_method, s.last_confirmed_at, s.published_at
FROM storefronts s
WHERE s.status = 'published'
  AND (s.paused_until IS NULL OR s.paused_until < current_date);
COMMENT ON VIEW v_eligible_storefronts IS $$Fiche structurée lue par le service de mise en relation : rien d'autre ne sort du compte du fournisseur. [US-13]$$;

-- ---------------------------------------------------------------------
-- Préférences d'un acheteur : consentement aux suggestions proactives, distinct de l'accès à l'agenda
-- (réservé à une phase ultérieure, stocké dès maintenant) et des notifications.
-- ---------------------------------------------------------------------
CREATE TABLE marketplace_prefs (
  user_id             uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  suggestions_opt_in  boolean NOT NULL DEFAULT false,
  agenda_opt_in       boolean NOT NULL DEFAULT false,
  muted_categories    jsonb NOT NULL DEFAULT '[]'::jsonb,
  opt_in_at           timestamptz,
  consent_version     text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE marketplace_prefs IS $$Consentement d'un profil aux suggestions de services et catégories coupées. [US-09, US-10]$$;
