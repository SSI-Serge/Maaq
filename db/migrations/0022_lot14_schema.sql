-- MAAQ — lot 14 : Courses et repas : agent natif, catalogue commun, base commune des prix anonyme, foyer, listes, tickets, retrait d’agent (US-152 à US-175)
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_14_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
-- Courses et repas (lot 14, US-152 à US-175)
CREATE TYPE meal_tag_kind         AS ENUM ('diet', 'meat', 'allergen');
CREATE TYPE meal_entry_kind       AS ENUM ('pleasure', 'dinner', 'express');
CREATE TYPE grocery_item_state    AS ENUM ('preparing', 'validated', 'added_after_validation', 'bought');
CREATE TYPE grocery_unreferenced_kind   AS ENUM ('unknown', 'no_reference');
CREATE TYPE grocery_unreferenced_source AS ENUM ('list', 'menu', 'ticket');
CREATE TYPE grocery_unreferenced_state  AS ENUM ('to_reference', 'referenced', 'rejected');
CREATE TYPE grocery_reference_status    AS ENUM ('compliant', 'to_check', 'none_found', 'not_applicable');

-- ---------------------------------------------------------------------
-- Fonctions appelées par les contraintes des tables ci-dessous
-- ---------------------------------------------------------------------
-- Clé normalisée d'un texte (minuscules, espaces simples) : le calcul des accents, tirets et pluriels est celui de l'application (CR-25) ; la base garde la clé
-- et son unicité
CREATE FUNCTION grocery_norm(p_text text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(regexp_replace(p_text, '\s+', ' ', 'g')))
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Cuisines, catégories, étiquettes et rayons (US-165, US-169, CR-30) : des listes de la console, masquées plutôt que supprimées quand elles servent
-- ---------------------------------------------------------------------
CREATE TABLE meal_cuisines (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        varchar(60) NOT NULL CHECK (btrim(name) <> ''),
  sort_order  smallint NOT NULL DEFAULT 100,
  is_hidden   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meal_dish_categories (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        varchar(60) NOT NULL CHECK (btrim(name) <> ''),
  sort_order  smallint NOT NULL DEFAULT 100,
  is_hidden   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meal_dish_tags (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        meal_tag_kind NOT NULL,
  name        varchar(80) NOT NULL CHECK (btrim(name) <> ''),
  sort_order  smallint NOT NULL DEFAULT 100,
  is_hidden   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE grocery_aisles (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        varchar(60) NOT NULL CHECK (btrim(name) <> ''),
  sort_order  smallint NOT NULL DEFAULT 100,
  is_hidden   boolean NOT NULL DEFAULT false,
  -- Rayon frais (CR-56) : réglable dans la console ; sert à la liste du mois (« À acheter plus tard ») ; un produit sans rayon n'est pas frais
  is_fresh    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- ---------------------------------------------------------------------
-- Produits, références par enseigne, critères d'additifs et saisons (US-166 à US-168)
-- ---------------------------------------------------------------------
CREATE TABLE grocery_products (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        varchar(120) NOT NULL CHECK (btrim(name) <> ''),
  -- Nom normalisé par l'application : la base garde la clé et son unicité (CR-25)
  name_key    text NOT NULL UNIQUE CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  aisle_id    integer NOT NULL REFERENCES grocery_aisles (id) ON DELETE RESTRICT,
  -- Produit « placard » (sel, poivre, huile, épices…) : décoché par défaut dans la liste, « Vous en avez peut-être déjà » (CR-50) ; modifiable dans la console
  is_pantry   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE grocery_product_references (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id      bigint NOT NULL REFERENCES grocery_products (id) ON DELETE CASCADE,
  -- Enseigne : texte normalisé, pas une liste de la console (CR-25)
  store_chain     varchar(80) NOT NULL CHECK (store_chain <> '' AND store_chain = grocery_norm(store_chain)),
  reference_name  varchar(160) NOT NULL CHECK (btrim(reference_name) <> ''),
  -- Format du conditionnement (« 1 kg », « sachet de 250 g »), facultatif, tel que donné par le catalogue d'origine (colonne « Format » de l'import, US-166 RF2)
  package_format  varchar(80) CHECK (package_format IS NULL OR btrim(package_format) <> ''),
  -- Quantité normalisée du format, en kg ou en litres (« 500 g » = 0,5 kg), déduite de package_format ou fournie à l'import (elle prime) ; vide quand le format n'est pas compris (CR-39)
  package_amount  numeric(10,3) CHECK (package_amount > 0),
  package_unit    varchar(2) CHECK (package_unit IN ('kg', 'l')),
  -- Le prix est exprimé par article (défaut) ou par kg / par litre (produit vendu au poids ou en vrac, CR-39, CR-40)
  price_unit      varchar(4) NOT NULL DEFAULT 'unit' CHECK (price_unit IN ('unit', 'kg', 'l')),
  -- Prix et date facultatifs, les deux ou aucun : une référence peut exister sans prix connu (« N/A »), rien n'est jamais inventé (US-157 RF8, CR-36)
  unit_price      numeric(8,2) CHECK (unit_price > 0),
  price_date      date,
  -- Additifs de la référence (codes ou noms normalisés) : un critère actif qui y correspond rend la référence non conforme, quel que soit son statut
  additives       text[] NOT NULL DEFAULT '{}',
  -- Statut déclaré par le catalogue d'origine (CR-37) ; la conformité finale est calculée par v_grocery_product_references
  compliance_status grocery_reference_status NOT NULL DEFAULT 'compliant',
  -- Résumé de composition en texte libre, facultatif
  composition_text text CHECK (composition_text IS NULL OR length(composition_text) <= 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, store_chain, reference_name),
  CONSTRAINT ck_grocery_product_references_price CHECK ((unit_price IS NULL) = (price_date IS NULL)),
  CONSTRAINT ck_grocery_product_references_package CHECK ((package_amount IS NULL) = (package_unit IS NULL))
);
-- Produits du quotidien (CR-66, CR-67, US-169 RF3) : liste tenue en console, par rayon, qui complète la rubrique « Produits de mon historique » quand elle compte moins de produits que le seuil
-- (réglage de console grocery_history_min_products). Commune à tous les foyers, sans donnée de foyer, lisible par tous les profils (comme les rayons), écrite par la console seulement. Le rapprochement avec
-- l'historique, le menu et les produits ajoutés se fait dans l'application : par le produit du catalogue (product_id), puis par la clé normalisée (name_key).
CREATE TABLE grocery_daily_products (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        varchar(120) NOT NULL CHECK (btrim(name) <> ''),
  -- Clé normalisée calculée par l'application (minuscules, « œ » en « oe », accents retirés, espaces et tirets réduits à un espace), comme grocery_products.name_key ; la base garde la clé et son unicité
  name_key    text NOT NULL UNIQUE CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  aisle_id    integer NOT NULL REFERENCES grocery_aisles (id) ON DELETE RESTRICT,
  -- Produit du catalogue correspondant, facultatif ; repasse à vide s'il est supprimé
  product_id  bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  position    smallint NOT NULL DEFAULT 100 CHECK (position >= 1),
  -- Retiré par la console : n'est plus proposé (vide = actif)
  retired_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE grocery_additive_criteria (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label       varchar(80) NOT NULL CHECK (btrim(label) <> ''),
  reason      varchar(200) NOT NULL CHECK (btrim(reason) <> ''),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE grocery_product_seasons (
  product_id  bigint NOT NULL REFERENCES grocery_products (id) ON DELETE CASCADE,
  season_month  smallint NOT NULL CHECK (season_month BETWEEN 1 AND 12),
  PRIMARY KEY (product_id, season_month)
);
-- ---------------------------------------------------------------------
-- Catalogue des plats (US-164) : plats, catégories, étiquettes, ingrédients
-- ---------------------------------------------------------------------
CREATE TABLE meal_dishes (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Identifiant du classeur d'origine (A5, F12…) : sert aux plannings et aux versions allégées
  code                  varchar(12) NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9]{1,12}$'),
  name                  varchar(120) NOT NULL CHECK (btrim(name) <> ''),
  cuisine_id            integer NOT NULL REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  recipe                text,
  duration_minutes      smallint NOT NULL CHECK (duration_minutes BETWEEN 1 AND 600),
  batch_active_minutes  smallint CHECK (batch_active_minutes BETWEEN 0 AND 600),
  -- Plat express : 15 minutes au plus (US-156 RF4)
  is_express            boolean GENERATED ALWAYS AS (duration_minutes <= 15) STORED,
  -- Retiré : n'est plus proposé, reste dans l'historique des foyers (menus validés)
  retired_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meal_dish_category_links (
  dish_id      bigint NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  category_id  integer NOT NULL REFERENCES meal_dish_categories (id) ON DELETE RESTRICT,
  PRIMARY KEY (dish_id, category_id)
);
CREATE TABLE meal_dish_tag_links (
  dish_id  bigint NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  tag_id   integer NOT NULL REFERENCES meal_dish_tags (id) ON DELETE RESTRICT,
  PRIMARY KEY (dish_id, tag_id)
);
CREATE TABLE meal_dish_ingredients (
  dish_id     bigint NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  product_id  bigint NOT NULL REFERENCES grocery_products (id) ON DELETE RESTRICT,
  position    smallint NOT NULL DEFAULT 1 CHECK (position >= 1),
  PRIMARY KEY (dish_id, product_id)
);
-- ---------------------------------------------------------------------
-- Semaines types de batch cooking et correspondances avec le catalogue (US-170, US-171)
-- ---------------------------------------------------------------------
CREATE TABLE meal_batch_weeks (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                   varchar(12) NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9]{1,12}$'),
  cuisine_id             integer NOT NULL REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  theme                  varchar(120),
  -- Déroulé de la séance du dimanche
  session_text           text NOT NULL CHECK (btrim(session_text) <> ''),
  session_minutes        smallint NOT NULL CHECK (session_minutes BETWEEN 1 AND 1000),
  shared_ingredients_pct smallint CHECK (shared_ingredients_pct BETWEEN 0 AND 100),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meal_batch_week_days (
  week_id                bigint NOT NULL REFERENCES meal_batch_weeks (id) ON DELETE CASCADE,
  weekday                smallint NOT NULL CHECK (weekday BETWEEN 1 AND 5),
  -- Nom du plat tel qu'il figure dans le planning
  planning_dish_name     varchar(160) NOT NULL CHECK (btrim(planning_dish_name) <> ''),
  -- Plat du catalogue confirmé (identifiant renseigné ou correspondance confirmée par l'administrateur) : enregistré par identifiant, plus par le nom
  dish_id                bigint REFERENCES meal_dishes (id) ON DELETE RESTRICT,
  -- Plat le plus proche du catalogue, utilisé en attendant la confirmation (statut « à confirmer »)
  suggested_dish_id      bigint REFERENCES meal_dishes (id) ON DELETE RESTRICT,
  match_pct              smallint NOT NULL DEFAULT 0 CHECK (match_pct BETWEEN 0 AND 100),
  -- L'administrateur signale qu'il faut ajouter ce plat au catalogue
  needs_catalog_addition boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_id, weekday),
  CONSTRAINT ck_meal_batch_week_days_confirmed CHECK (dish_id IS NULL OR match_pct = 100)
);
-- ---------------------------------------------------------------------
-- Versions allégées (US-172) : texte et produits à retirer ou à ajouter, plat par plat
-- ---------------------------------------------------------------------
CREATE TABLE meal_light_versions (
  dish_id       bigint PRIMARY KEY REFERENCES meal_dishes (id) ON DELETE CASCADE,
  display_text  text NOT NULL CHECK (btrim(display_text) <> ''),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meal_light_version_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dish_id     bigint NOT NULL REFERENCES meal_light_versions (dish_id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('remove', 'add')),
  -- Produit du catalogue ; vide pour un produit ajouté qui n'y est pas encore (« riz basmati complet »), noté alors dans les produits à référencer
  product_id  bigint REFERENCES grocery_products (id) ON DELETE RESTRICT,
  name_key    text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  UNIQUE (dish_id, kind, name_key),
  CONSTRAINT ck_meal_light_items_remove_known CHECK (kind = 'add' OR product_id IS NOT NULL)
);
-- ---------------------------------------------------------------------
-- Produits à référencer (US-173, US-174) : journal anonyme des produits sans référence conforme, regroupés par nom normalisé
-- ---------------------------------------------------------------------
CREATE TABLE grocery_unreferenced_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name_key          text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  kind              grocery_unreferenced_kind NOT NULL,
  source            grocery_unreferenced_source NOT NULL,
  aisle_id          integer REFERENCES grocery_aisles (id) ON DELETE SET NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  -- Renseignés seulement pour un foyer qui partage ses prix (note_grocery_unreferenced) ; jamais de prénom ni d'identifiant de foyer
  seen_city         varchar(80),
  seen_reference    varchar(160),
  seen_unit_price   numeric(8,2),
  seen_store_chain  varchar(80),
  CONSTRAINT ck_grocery_unreferenced_seen CHECK (num_nonnulls(seen_city, seen_reference, seen_unit_price, seen_store_chain) IN (0, 4))
);
CREATE TABLE grocery_unreferenced_status (
  name_key             text PRIMARY KEY CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  state                grocery_unreferenced_state NOT NULL DEFAULT 'to_reference',
  changed_at           timestamptz NOT NULL DEFAULT now(),
  changed_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL
);
-- ---------------------------------------------------------------------
-- Base commune des prix (US-154, US-175) : ANONYME. Aucune colonne ne désigne un foyer, un profil ni un jour ; la date est la semaine (CR-17).
-- ---------------------------------------------------------------------
CREATE TABLE grocery_shared_prices (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id          bigint NOT NULL REFERENCES grocery_products (id) ON DELETE CASCADE,
  reference_name      varchar(160) NOT NULL CHECK (reference_name <> '' AND reference_name = grocery_norm(reference_name)),
  unit_price          numeric(8,2) NOT NULL CHECK (unit_price > 0),
  -- Unité du prix : par article (défaut), par kg ou par litre (ligne de ticket pesée, CR-39). Le poids pesé n'est jamais partagé, seulement le prix au kilo.
  price_unit          varchar(4) NOT NULL DEFAULT 'unit' CHECK (price_unit IN ('unit', 'kg', 'l')),
  store_chain         varchar(80) NOT NULL CHECK (store_chain <> '' AND store_chain = grocery_norm(store_chain)),
  city                varchar(80) NOT NULL CHECK (city <> '' AND city = grocery_norm(city)),
  -- Lundi de la semaine du relevé : jamais la date du jour
  week_start          date NOT NULL CHECK (date_part('isodow', week_start) = 1),
  -- Ligne retirée par l'administrateur : plus utilisée dans les comparatifs (US-175 RF3)
  removed_at          timestamptz,
  removed_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Une ligne identique n'est pas dupliquée : sa semaine est mise à jour (US-154 RT1)
  CONSTRAINT uq_grocery_shared_prices_line UNIQUE (product_id, reference_name, store_chain, city, unit_price, price_unit),
  CONSTRAINT ck_grocery_shared_prices_removed CHECK ((removed_at IS NULL) = (removed_by_user_id IS NULL) OR removed_by_user_id IS NULL)
);
-- Compteur des foyers par ville (CR-17, CR-22) : la ville n'est montrée aux autres foyers qu'à partir de 2 foyers. Tenu par trigger depuis
-- grocery_household_city_sharing (privé) ; ne contient que la ville et un nombre.
CREATE TABLE grocery_city_sharing (
  city_key         text PRIMARY KEY CHECK (city_key <> '' AND city_key = grocery_norm(city_key)),
  household_count  integer NOT NULL CHECK (household_count >= 0)
);
-- Preuve du consentement au partage des prix (CR-24) : comme contract_consent_events et forwarding_consent_events, sans clé étrangère vers le compte,
-- elle survit à sa suppression (conservation à valider par le DPO, CR-26)
CREATE TABLE grocery_price_sharing_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        uuid NOT NULL,
  actor_user_id     uuid,
  actor_email_hash  bytea NOT NULL,
  action_type       consent_action NOT NULL,
  legal_version_id  bigint NOT NULL REFERENCES legal_document_versions (id) ON DELETE RESTRICT,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  retain_until      date
);
-- ---------------------------------------------------------------------
-- RÉGLAGES DU FOYER (US-153, US-154) : communs au couple
-- ---------------------------------------------------------------------
CREATE TABLE grocery_household_settings (
  account_id             uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  -- Une ville, jamais une adresse (US-153 RT1)
  city                   varchar(80) CHECK (city IS NULL OR (btrim(city) <> '' AND NOT looks_like_address(city))),
  household_size         smallint CHECK (household_size BETWEEN 1 AND 12),
  shopping_days          smallint[] CHECK (shopping_days IS NULL OR iso_weekdays_valid(shopping_days)),
  goal_time              boolean NOT NULL DEFAULT false,
  goal_own_dishes        boolean NOT NULL DEFAULT false,
  goal_season            boolean NOT NULL DEFAULT false,
  -- Un plat ne revient pas avant N semaines (1 à 4) ; vide = valeur par défaut de la console (2)
  repeat_weeks           smallint CHECK (repeat_weeks BETWEEN 1 AND 4),
  replacement_source     text NOT NULL DEFAULT 'own' CHECK (replacement_source IN ('own', 'cuisine')),
  replacement_cuisine_id integer REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  budget_day             smallint NOT NULL DEFAULT 1 CHECK (budget_day BETWEEN 1 AND 31),
  -- Budget mensuel des repas, en euros, hors restaurant, boissons et réceptions (menu du mois dans le budget, CR-59) ; vide = non renseigné
  monthly_meal_budget    numeric(7,2) CHECK (monthly_meal_budget BETWEEN 1 AND 99999),
  share_prices           boolean NOT NULL DEFAULT false,
  updated_by_user_id     uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_grocery_household_replacement CHECK ((replacement_source = 'cuisine') = (replacement_cuisine_id IS NOT NULL)),
  CONSTRAINT ck_grocery_household_share_city CHECK (NOT share_prices OR city IS NOT NULL),
  CONSTRAINT fk_grocery_household_settings_updated_by FOREIGN KEY (updated_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (updated_by_user_id)
);
CREATE TABLE grocery_household_cuisines (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  cuisine_id  integer NOT NULL REFERENCES meal_cuisines (id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, cuisine_id)
);
CREATE TABLE grocery_household_stores (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  store_chain  varchar(80) NOT NULL CHECK (store_chain <> '' AND store_chain = grocery_norm(store_chain)),
  store_city   varchar(80) NOT NULL CHECK (store_city <> '' AND store_city = grocery_norm(store_city)),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, store_chain, store_city)
);
CREATE TABLE grocery_household_dietary (
  account_id          uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  -- Régimes et allergies chiffrés par l'application (étiquettes choisies et texte libre) : la base borne seulement la taille du chiffré
  diets_encrypted     bytea CHECK (diets_encrypted IS NULL OR octet_length(diets_encrypted) BETWEEN 1 AND 4000),
  allergies_encrypted bytea CHECK (allergies_encrypted IS NULL OR octet_length(allergies_encrypted) BETWEEN 1 AND 4000),
  updated_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_grocery_household_dietary_updated_by FOREIGN KEY (updated_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (updated_by_user_id)
);
-- Foyers inscrits au compteur de leur ville (privé, tenu par trigger depuis les réglages). Une ligne reste quand le partage est désactivé (CR-22).
CREATE TABLE grocery_household_city_sharing (
  account_id  uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  city_key    text NOT NULL CHECK (city_key <> '' AND city_key = grocery_norm(city_key)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- ---------------------------------------------------------------------
-- Plats personnels du foyer (US-159, CR-04) : jamais dans le catalogue commun, jamais vus d'un autre foyer
-- ---------------------------------------------------------------------
CREATE TABLE meal_household_dishes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name                 varchar(120) NOT NULL CHECK (btrim(name) <> ''),
  cuisine_id           integer NOT NULL REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  recipe               text,
  duration_minutes     smallint CHECK (duration_minutes BETWEEN 1 AND 600),
  created_by_user_id   uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_meal_household_dishes_created_by FOREIGN KEY (created_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (created_by_user_id)
);
CREATE TABLE meal_household_dish_ingredients (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_dish_id uuid NOT NULL,
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  label             varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key          text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  -- Produit du catalogue reconnu par l'application ; vide si inconnu (noté alors dans les produits à référencer)
  product_id        bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  position          smallint NOT NULL DEFAULT 1 CHECK (position >= 1),
  UNIQUE (household_dish_id, name_key),
  CONSTRAINT fk_meal_household_dish_ingredients_dish FOREIGN KEY (household_dish_id, account_id) REFERENCES meal_household_dishes (id, account_id) ON DELETE CASCADE
);
CREATE TABLE meal_household_dish_tags (
  household_dish_id uuid NOT NULL,
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  tag_id            integer NOT NULL REFERENCES meal_dish_tags (id) ON DELETE CASCADE,
  PRIMARY KEY (household_dish_id, tag_id),
  CONSTRAINT fk_meal_household_dish_tags_dish FOREIGN KEY (household_dish_id, account_id) REFERENCES meal_household_dishes (id, account_id) ON DELETE CASCADE
);
-- ---------------------------------------------------------------------
-- Plats de saison (CR-60, CR-61, CR-62, US-178 RF2, RF2bis) : base COMMUNE et ANONYME des plats obtenus de l'IA pour le menu du mois, partagée par tous les foyers, sans doublon (nom
-- normalisé). Elle est distincte du catalogue commun des plats (meal_dishes), où les plats libres n'entrent jamais (CR-04) : aucune clé ne les relie. Aucun foyer, aucun profil, aucun prix,
-- aucune date au jour près (lundi de la semaine). Une seule porte d'écriture (share_season_dish) ; lecture par fonctions ; sécurité par ligne activée sans règle, comme la base commune des prix.
-- ---------------------------------------------------------------------
CREATE TABLE meal_season_dishes (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              varchar(120) NOT NULL CHECK (btrim(name) <> ''),
  -- Nom normalisé par l'application (minuscules, accents, pluriel simple) : la base garde la clé et son unicité
  name_key          text NOT NULL UNIQUE CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  cuisine_id        integer NOT NULL REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  -- Nombre de personnes pour lequel les quantités des ingrédients sont écrites
  servings          smallint NOT NULL CHECK (servings BETWEEN 1 AND 30),
  recipe            text,
  duration_minutes  smallint CHECK (duration_minutes BETWEEN 1 AND 600),
  -- Nombre de foyers qui l'ont choisi dans un menu validé (une fois par foyer et par plat, choose_season_dish) ; ne redescend jamais
  chosen_count      integer NOT NULL DEFAULT 0 CHECK (chosen_count >= 0),
  -- Lundi de la semaine d'entrée dans la base : jamais le jour (anonymat)
  entered_week      date NOT NULL DEFAULT (current_date - (extract(isodow FROM current_date)::integer - 1)) CHECK (date_part('isodow', entered_week) = 1),
  -- Masqué par l'administrateur : n'est plus proposé (console)
  hidden_at         timestamptz,
  hidden_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_meal_season_dishes_hidden CHECK ((hidden_at IS NULL) = (hidden_by_user_id IS NULL) OR hidden_by_user_id IS NULL)
);
CREATE TABLE meal_season_dish_ingredients (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dish_id       bigint NOT NULL REFERENCES meal_season_dishes (id) ON DELETE CASCADE,
  label         varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key      text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  -- Produit du catalogue reconnu ; vide si inconnu (noté dans les produits à référencer seulement quand le plat est choisi dans un menu validé)
  product_id    bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  position      smallint NOT NULL DEFAULT 1 CHECK (position >= 1),
  quantity      numeric(10,3) CHECK (quantity > 0),
  unit          text CHECK (unit IN ('g', 'kg', 'ml', 'cl', 'l', 'piece', 'spoon', 'pinch')),
  base_unit     text GENERATED ALWAYS AS (CASE unit WHEN 'g' THEN 'g' WHEN 'kg' THEN 'g' WHEN 'ml' THEN 'ml' WHEN 'cl' THEN 'ml' WHEN 'l' THEN 'ml' WHEN 'piece' THEN 'piece' END) STORED,
  base_quantity numeric(14,3) GENERATED ALWAYS AS (CASE unit WHEN 'g' THEN quantity WHEN 'kg' THEN quantity * 1000 WHEN 'ml' THEN quantity WHEN 'cl' THEN quantity * 10 WHEN 'l' THEN quantity * 1000 WHEN 'piece' THEN quantity END) STORED,
  UNIQUE (dish_id, name_key),
  CONSTRAINT ck_meal_season_dish_ingredients_quantity CHECK ((quantity IS NULL) = (unit IS NULL))
);
CREATE TABLE meal_season_dish_months (
  dish_id      bigint NOT NULL REFERENCES meal_season_dishes (id) ON DELETE CASCADE,
  season_month smallint NOT NULL CHECK (season_month BETWEEN 1 AND 12),
  PRIMARY KEY (dish_id, season_month)
);
CREATE TABLE meal_season_dish_tag_links (
  dish_id  bigint NOT NULL REFERENCES meal_season_dishes (id) ON DELETE CASCADE,
  tag_id   integer NOT NULL REFERENCES meal_dish_tags (id) ON DELETE CASCADE,
  PRIMARY KEY (dish_id, tag_id)
);
-- Sélection du foyer : les plats de saison de la base commune retenus pour son menu du mois, gardés jusqu'à la fin du mois (CR-60, CR-62). Propre au foyer, effacée une fois le mois passé et avec le compte ;
-- le nombre de plats (10, jusqu'à 44) est contrôlé par l'application (réglages de console meal_season_dishes_count et meal_season_dishes_max). Elle ne garde pas le contenu du plat, seulement le lien.
CREATE TABLE meal_season_household_dishes (
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  dish_id      bigint NOT NULL REFERENCES meal_season_dishes (id) ON DELETE CASCADE,
  -- Premier jour du mois (heure du foyer)
  season_month date NOT NULL CHECK (date_part('day', season_month) = 1),
  PRIMARY KEY (account_id, dish_id, season_month)
);
-- ---------------------------------------------------------------------
-- Menus validés (US-156) : l'historique du foyer (12 mois), dont se servent la répétition et le choix standard ou allégé
-- ---------------------------------------------------------------------
CREATE TABLE meal_menus (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Lundi de la semaine du menu
  week_start           date NOT NULL CHECK (date_part('isodow', week_start) = 1),
  validated_at         timestamptz NOT NULL DEFAULT now(),
  validated_by_user_id uuid,
  -- Semaine type de batch cooking utilisée ; vide si MAAQ a composé le menu par ingrédients (durée estimée)
  batch_week_id        bigint REFERENCES meal_batch_weeks (id) ON DELETE SET NULL,
  session_minutes      smallint CHECK (session_minutes BETWEEN 1 AND 1000),
  session_is_estimated boolean NOT NULL DEFAULT false,
  session_over_cap     boolean NOT NULL DEFAULT false,
  -- Nombre de personnes pour lequel les recettes et les quantités du menu sont écrites (réglage du foyer au moment de la validation, CR-49) ; vide pour un menu validé avant CR-49
  servings             smallint CHECK (servings BETWEEN 1 AND 30),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, week_start),
  UNIQUE (id, account_id),
  CONSTRAINT fk_meal_menus_validated_by FOREIGN KEY (validated_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (validated_by_user_id)
);
CREATE TABLE meal_menu_entries (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  menu_id            uuid NOT NULL,
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- pleasure = plat plaisir choisi (1 ou 2) ; dinner = dîner du lundi (1) au dimanche (7) ; express = plat express (1 à 4)
  kind               meal_entry_kind NOT NULL,
  slot               smallint NOT NULL CHECK (slot BETWEEN 1 AND 7),
  -- Nom conservé tel qu'au moment de la validation : un plat retiré ou supprimé reste lisible dans l'historique (CR-25)
  dish_name          varchar(160) NOT NULL CHECK (btrim(dish_name) <> ''),
  -- Origine du plat (CR-42) : catalog = plat du catalogue, household = plat de « Mes plats », ai = plat libre composé par l'IA (jamais dans le catalogue). Sans valeur par défaut :
  -- l'application dit toujours d'où vient le plat.
  dish_origin        text NOT NULL CHECK (dish_origin IN ('catalog', 'household', 'ai')),
  dish_id            bigint REFERENCES meal_dishes (id) ON DELETE SET NULL,
  -- Plat de « Mes plats » : le plat choisi (origine household) ou la copie faite après la validation (origines ai et catalog, CR-42, CR-45)
  household_dish_id  uuid,
  -- Contenu gardé avec le menu : la cuisine et la durée d'un plat libre (CR-42) ; la recette écrite pour le nombre de personnes du foyer, pour TOUT plat (CR-49, le plat d'origine n'est pas modifié) ; les ingrédients sont dans meal_menu_entry_ingredients
  cuisine_id         integer REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  recipe             text,
  duration_minutes   smallint CHECK (duration_minutes BETWEEN 1 AND 600),
  -- Version allégée proposée par l'IA (texte et adaptation de la liste) pour un plat qui n'en a pas dans le catalogue ; light_chosen = retenue par le foyer
  light_by_ai        boolean NOT NULL DEFAULT false,
  light_text         text CHECK (light_text IS NULL OR btrim(light_text) <> ''),
  light_chosen       boolean NOT NULL DEFAULT false,
  -- Plat de la base commune des plats de saison d'où vient ce plat libre (CR-61) ; repasse à vide si le plat est supprimé de la base
  season_dish_id     bigint REFERENCES meal_season_dishes (id) ON DELETE SET NULL,
  -- Plat remplacé dans la liste déroulante : sorti de la séance de batch (inutilisé depuis CR-42)
  is_off_batch       boolean NOT NULL DEFAULT false,
  -- Plat de planning rapproché du catalogue, correspondance à confirmer (US-156 RF7, inutilisé depuis CR-42)
  planning_match_to_confirm boolean NOT NULL DEFAULT false,
  UNIQUE (id, account_id),
  UNIQUE (id, menu_id),
  UNIQUE (menu_id, kind, slot),
  CONSTRAINT ck_meal_menu_entries_slot CHECK (slot <= CASE kind WHEN 'pleasure' THEN 2 WHEN 'express' THEN 4 ELSE 7 END),
  CONSTRAINT ck_meal_menu_entries_origin CHECK (dish_origin = 'catalog' OR dish_id IS NULL),
  CONSTRAINT ck_meal_menu_entries_free_dish CHECK ((dish_origin = 'ai' AND cuisine_id IS NOT NULL) OR (dish_origin <> 'ai' AND cuisine_id IS NULL AND duration_minutes IS NULL)),
  CONSTRAINT ck_meal_menu_entries_light CHECK (light_by_ai = (light_text IS NOT NULL) AND (light_by_ai OR NOT light_chosen)),
  CONSTRAINT ck_meal_menu_entries_season CHECK (season_dish_id IS NULL OR dish_origin = 'ai'),
  CONSTRAINT fk_meal_menu_entries_menu FOREIGN KEY (menu_id, account_id) REFERENCES meal_menus (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_meal_menu_entries_household_dish FOREIGN KEY (household_dish_id, account_id) REFERENCES meal_household_dishes (id, account_id) ON DELETE SET NULL (household_dish_id)
);
-- Ingrédients d'un plat libre du menu (CR-42) : nom, clé normalisée, produit du catalogue s'il est reconnu. Conservés avec le menu, effacés avec lui.
CREATE TABLE meal_menu_entry_ingredients (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id    bigint NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  label       varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key    text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  -- Produit du catalogue reconnu par l'application ; vide si inconnu (la liste le prend sans prix, noté dans les produits à référencer)
  product_id  bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  position    smallint NOT NULL DEFAULT 1 CHECK (position >= 1),
  -- Quantité écrite par l'IA pour le nombre de personnes du foyer (CR-50) ; vide si l'IA n'en a pas donné (la liste met 1 unité, « Quantité à vérifier »)
  quantity    numeric(10,3) CHECK (quantity > 0),
  unit        text CHECK (unit IN ('g', 'kg', 'ml', 'cl', 'l', 'piece', 'spoon', 'pinch')),
  -- Quantité ramenée en g, ml ou pièce (kg x 1000, cl x 10, l x 1000) ; vide pour une cuillère, une pincée ou sans quantité
  base_unit   text GENERATED ALWAYS AS (CASE unit WHEN 'g' THEN 'g' WHEN 'kg' THEN 'g' WHEN 'ml' THEN 'ml' WHEN 'cl' THEN 'ml' WHEN 'l' THEN 'ml' WHEN 'piece' THEN 'piece' END) STORED,
  base_quantity numeric(14,3) GENERATED ALWAYS AS (CASE unit WHEN 'g' THEN quantity WHEN 'kg' THEN quantity * 1000 WHEN 'ml' THEN quantity WHEN 'cl' THEN quantity * 10 WHEN 'l' THEN quantity * 1000 WHEN 'piece' THEN quantity END) STORED,
  UNIQUE (entry_id, name_key),
  CONSTRAINT ck_meal_menu_entry_ingredients_quantity CHECK ((quantity IS NULL) = (unit IS NULL)),
  CONSTRAINT fk_meal_menu_entry_ingredients_entry FOREIGN KEY (entry_id, account_id) REFERENCES meal_menu_entries (id, account_id) ON DELETE CASCADE
);
-- Adaptation de la liste pour la version allégée proposée par l'IA : produits à retirer ou à ajouter
CREATE TABLE meal_menu_entry_light_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id    bigint NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('remove', 'add')),
  label       varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key    text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  product_id  bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  UNIQUE (entry_id, kind, name_key),
  CONSTRAINT fk_meal_menu_entry_light_items_entry FOREIGN KEY (entry_id, account_id) REFERENCES meal_menu_entries (id, account_id) ON DELETE CASCADE
);
-- Déroulé de la séance de batch rédigé par l'IA (CR-47, US-156 RF6bis, US-157 RF1ter) : étapes numérotées d'un menu qui ne reprend pas une semaine type
CREATE TABLE meal_menu_session_steps (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  menu_id     uuid NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  position    smallint NOT NULL CHECK (position >= 1),
  body        text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 2000),
  -- Plat concerné par l'étape (facultatif) : une ligne du même menu ; vide si la ligne de menu est remplacée
  entry_id    bigint,
  -- Durée approximative de l'étape, en minutes (facultative)
  duration_minutes smallint CHECK (duration_minutes BETWEEN 1 AND 600),
  -- Rang d'une étape PRÉCÉDENTE du même menu avec laquelle celle-ci se chevauche (« en même temps, pendant la cuisson ») : une étape en chevauchement n'allonge pas la séance (durée totale recalculée par l'application)
  overlaps_position smallint CHECK (overlaps_position >= 1),
  -- Conservation d'un plat (étape de fin de déroulé) : réfrigérateur ou congélateur, et jour où le sortir (jour ISO de la semaine du menu, 1 = lundi)
  storage_mode text CHECK (storage_mode IN ('fridge', 'freezer')),
  take_out_day smallint CHECK (take_out_day BETWEEN 1 AND 7),
  UNIQUE (menu_id, position),
  CONSTRAINT ck_meal_menu_session_steps_overlap CHECK (overlaps_position IS NULL OR overlaps_position < position),
  CONSTRAINT ck_meal_menu_session_steps_storage CHECK (take_out_day IS NULL OR storage_mode IS NOT NULL),
  CONSTRAINT fk_meal_menu_session_steps_menu FOREIGN KEY (menu_id, account_id) REFERENCES meal_menus (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_meal_menu_session_steps_entry FOREIGN KEY (entry_id, menu_id) REFERENCES meal_menu_entries (id, menu_id) ON DELETE SET NULL (entry_id),
  CONSTRAINT fk_meal_menu_session_steps_overlap FOREIGN KEY (menu_id, overlaps_position) REFERENCES meal_menu_session_steps (menu_id, position) ON DELETE SET NULL (overlaps_position)
);
-- Plafond de menus complets par foyer et par jour (CR-44, US-156 RF12ter) : un compteur par foyer et par jour, sans autre donnée que le compte
CREATE TABLE meal_menu_daily_counters (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  menu_date   date NOT NULL,
  menu_count  smallint NOT NULL DEFAULT 0 CHECK (menu_count >= 0),
  PRIMARY KEY (account_id, menu_date)
);
-- Version standard ou allégée choisie pour un plat, reprise au menu suivant (US-157 RF9)
CREATE TABLE meal_light_choices (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  dish_id     bigint NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  choice      text NOT NULL CHECK (choice IN ('standard', 'light')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, dish_id)
);
-- ---------------------------------------------------------------------
-- Liste de courses (US-157, US-158, US-162, CR-27, CR-28)
-- ---------------------------------------------------------------------
-- Liste du mois (CR-56, US-157 RF9ter) : validation unique de plusieurs semaines, avec un seul scénario d'achat et une seule date. Chaque semaine garde sa liste ; le regroupement les relie.
CREATE TABLE grocery_list_groups (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  scenario             smallint NOT NULL CHECK (scenario BETWEEN 1 AND 3),
  validated_at         timestamptz NOT NULL DEFAULT now(),
  validated_by_user_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_grocery_list_groups_validated_by FOREIGN KEY (validated_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (validated_by_user_id)
);
CREATE TABLE grocery_lists (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  menu_id              uuid,
  -- Liste du mois à laquelle cette semaine est regroupée (CR-56) ; vide = liste de la semaine seule
  group_id             uuid,
  -- Scénario d'achat choisi : 1 tout dans le magasin qui couvre le plus de produits, 2 chaque référence choisie, 3 mes produits habituels
  scenario             smallint NOT NULL CHECK (scenario BETWEEN 1 AND 3),
  validated_at         timestamptz NOT NULL DEFAULT now(),
  validated_by_user_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_grocery_lists_menu FOREIGN KEY (menu_id, account_id) REFERENCES meal_menus (id, account_id) ON DELETE SET NULL (menu_id),
  CONSTRAINT fk_grocery_lists_group FOREIGN KEY (group_id, account_id) REFERENCES grocery_list_groups (id, account_id) ON DELETE SET NULL (group_id),
  CONSTRAINT fk_grocery_lists_validated_by FOREIGN KEY (validated_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (validated_by_user_id)
);
CREATE TABLE grocery_list_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  list_id              uuid,
  -- Menu (donc semaine) auquel le produit appartient, pour tout produit : en préparation, validé, acheté, ajouté depuis la validation. Vide seulement pour un ajout à la main quand aucun menu n'existe (CR-54, CR-55)
  menu_id              uuid,
  -- preparing = en préparation (ingrédients du menu, produits ajoutés, historique) ; validated = dans la liste validée ; added_after_validation = ajouté
  -- depuis la validation, sans magasin ni prix (CR-28) ; bought = acheté (rejoint l'historique)
  state                grocery_item_state NOT NULL DEFAULT 'preparing',
  source               text NOT NULL DEFAULT 'added' CHECK (source IN ('menu', 'added', 'habit')),
  label                varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key             text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  product_id           bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  aisle_id             integer REFERENCES grocery_aisles (id) ON DELETE SET NULL,
  quantity             smallint NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 99),
  added_by_user_id     uuid,
  -- Inutilisé depuis CR-55 (les produits non achetés ne sont plus recopiés dans la semaine suivante : pense-bête calculé à la lecture) ; gardé pour les données existantes (CR-28)
  not_bought_last_time boolean NOT NULL DEFAULT false,
  -- Choix du scénario, posés à la validation (estimation : prix d'une unité × quantité)
  store_chain          varchar(80) CHECK (store_chain IS NULL OR (store_chain <> '' AND store_chain = grocery_norm(store_chain))),
  reference_name       varchar(160),
  unit_price           numeric(8,2) CHECK (unit_price IS NULL OR unit_price > 0),
  -- Unité du prix, copiée de la référence à la validation : un article au kilo ou au litre n'entre pas dans le total estimé (CR-40)
  price_unit           varchar(4) CHECK (price_unit IS NULL OR price_unit IN ('unit', 'kg', 'l')),
  -- Besoin du menu pour ce produit, en g, ml ou pièce (« 900 g pour le menu ») ; vide pour un produit ajouté à la main ou de l'historique (CR-50)
  needed_amount        numeric(12,3) CHECK (needed_amount > 0),
  needed_unit          text CHECK (needed_unit IN ('g', 'ml', 'piece')),
  -- Conversion impossible (format de la référence inconnu, unité incompatible, quantité absente) : 1 unité et « Quantité à vérifier »
  quantity_to_check    boolean NOT NULL DEFAULT false,
  -- Produit « placard » : « Vous en avez peut-être déjà » ; is_selected = coché pour l'achat (décoché par défaut pour un produit « placard »)
  is_pantry            boolean NOT NULL DEFAULT false,
  is_selected          boolean NOT NULL DEFAULT true,
  bought_at            timestamptz,
  bought_by_user_id    uuid,
  -- Ligne de ticket qui a servi à payer ce produit (coût réel du menu, CR-58) ; vide pour un produit coché à la main (prix estimé gardé) ; repasse à vide si le ticket est supprimé
  receipt_line_id      bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_grocery_list_items_list FOREIGN KEY (list_id, account_id) REFERENCES grocery_lists (id, account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_grocery_list_items_menu FOREIGN KEY (menu_id, account_id) REFERENCES meal_menus (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_grocery_list_items_added_by FOREIGN KEY (added_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (added_by_user_id),
  CONSTRAINT fk_grocery_list_items_bought_by FOREIGN KEY (bought_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (bought_by_user_id),
  CONSTRAINT ck_grocery_list_items_bought CHECK ((state = 'bought') = (bought_at IS NOT NULL)),
  CONSTRAINT ck_grocery_list_items_list CHECK ((state = 'preparing') = (list_id IS NULL)),
  CONSTRAINT ck_grocery_list_items_no_store CHECK (state NOT IN ('preparing', 'added_after_validation') OR (store_chain IS NULL AND reference_name IS NULL AND unit_price IS NULL AND price_unit IS NULL)),
  CONSTRAINT ck_grocery_list_items_price_store CHECK (unit_price IS NULL OR store_chain IS NOT NULL),
  CONSTRAINT ck_grocery_list_items_price_unit CHECK (price_unit IS NULL OR store_chain IS NOT NULL),
  CONSTRAINT ck_grocery_list_items_needed CHECK ((needed_amount IS NULL) = (needed_unit IS NULL)),
  CONSTRAINT ck_grocery_list_items_menu CHECK (menu_id IS NOT NULL OR (state = 'preparing' AND source = 'added')),
  CONSTRAINT ck_grocery_list_items_receipt CHECK (receipt_line_id IS NULL OR state = 'bought')
);
-- ---------------------------------------------------------------------
-- Tickets de caisse (US-161, US-163) : aucune photo (supprimée dès la lecture, CR-05), seulement le texte lu et les montants. Conservés 3 ans.
-- ---------------------------------------------------------------------
CREATE TABLE grocery_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  store_chain          varchar(80) NOT NULL CHECK (store_chain <> '' AND store_chain = grocery_norm(store_chain)),
  store_city           varchar(80) CHECK (store_city IS NULL OR (store_city <> '' AND store_city = grocery_norm(store_city))),
  purchased_on         date NOT NULL,
  -- Heure du ticket, à la seconde (secondes à 00 quand elles ne sont pas lues), heure locale du magasin ; facultative pour les anciens tickets (CR-41)
  purchased_time       time(0),
  total_amount         numeric(9,2) NOT NULL,
  recorded_by_user_id  uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_grocery_receipts_recorded_by FOREIGN KEY (recorded_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (recorded_by_user_id)
);
CREATE TABLE grocery_receipt_lines (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id       uuid NOT NULL,
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  position         smallint NOT NULL DEFAULT 1 CHECK (position >= 1),
  label            varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key         text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  reference_name   varchar(160),
  -- Prix total de la ligne ; une remise peut être négative
  line_total       numeric(9,2) NOT NULL,
  quantity         numeric(8,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  aisle_id         integer NOT NULL REFERENCES grocery_aisles (id) ON DELETE RESTRICT,
  product_id       bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  -- Poids ou volume mesuré à la caisse (« 1,234 kg ») et prix au kilo ou au litre ; vides pour une ligne vendue à la pièce (CR-39)
  measured_quantity numeric(9,3) CHECK (measured_quantity > 0),
  measure_unit      varchar(2) CHECK (measure_unit IN ('kg', 'l')),
  price_per_measure numeric(8,2) CHECK (price_per_measure > 0),
  UNIQUE (id, account_id),
  CONSTRAINT ck_grocery_receipt_lines_measure CHECK ((measured_quantity IS NULL) = (measure_unit IS NULL) AND (price_per_measure IS NULL OR measured_quantity IS NOT NULL)),
  CONSTRAINT fk_grocery_receipt_lines_receipt FOREIGN KEY (receipt_id, account_id) REFERENCES grocery_receipts (id, account_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- Retiré du catalogue (réversible, CR-34) : date et administrateur ; la contrainte ck_agents_retired est posée avec le lot 14
ALTER TABLE agents
  ADD COLUMN retired_at              timestamptz;
ALTER TABLE agents
  ADD COLUMN retired_by_user_id      uuid REFERENCES users (id) ON DELETE SET NULL;
-- Présent dans le catalogue (rubriques Pro et Perso) : faux pour un agent à tuile fixe comme l'Assistant Famille (lot 14, décision du PO du 07/11/2026) ; la plateforme ne sert plus de critère de liste
ALTER TABLE agents
  ADD COLUMN listed_in_catalog       boolean NOT NULL DEFAULT true;
ALTER TABLE grocery_list_items
  ADD CONSTRAINT fk_grocery_list_items_receipt_line FOREIGN KEY (receipt_line_id, account_id) REFERENCES grocery_receipt_lines (id, account_id) ON DELETE SET NULL (receipt_line_id);
-- Un agent retiré porte sa date de retrait ; un agent qui ne l'est pas n'en porte pas
ALTER TABLE agents
  ADD CONSTRAINT ck_agents_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL));

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
-- Réglage entier de la console, avec sa valeur par défaut si la ligne manque
CREATE FUNCTION grocery_setting_int(p_key text, p_default integer) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT value_text::integer FROM platform_settings WHERE setting_key = p_key), p_default)
$$;
-- Droit d'un profil sur l'agent : « couple » = utilisateur principal et invité 1 (tout) ; « list » = invité secondaire (liste de courses seulement) ; NULL sinon
CREATE FUNCTION grocery_access(p_user uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN u.role = 'primary_user' OR (u.role = 'guest' AND u.guest_rank = 'core') THEN 'couple'
              WHEN u.role = 'guest' AND u.guest_rank = 'secondary' THEN 'list' END
    FROM users u
   WHERE u.id = p_user AND u.status IN ('active', 'grace_period')
$$;
-- Famille du profil indiqué par l'application, si son droit est au moins celui demandé (sert aux règles de sécurité par ligne)
CREATE FUNCTION grocery_couple_account() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT u.account_id FROM users u WHERE u.id = app_current_user_id() AND grocery_access(u.id) = 'couple'
$$;
CREATE FUNCTION grocery_member_account() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT u.account_id FROM users u WHERE u.id = app_current_user_id() AND grocery_access(u.id) IS NOT NULL
$$;
-- Ancienneté d'un prix (CR-20) : fresh = moins de grocery_price_fresh_months (6) ; aging = moins de grocery_price_max_months (12) ; NULL = plus d'affichage
CREATE FUNCTION grocery_price_age(p_date date) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_date >= current_date - make_interval(months => grocery_setting_int('grocery_price_fresh_months', 6)) THEN 'fresh'
              WHEN p_date >= current_date - make_interval(months => grocery_setting_int('grocery_price_max_months', 12)) THEN 'aging' END
$$;
-- Statut d'une correspondance entre un plat de planning et le catalogue (US-171 RF1) : sûr (identifiant renseigné ou 80 % et plus), à confirmer (40 % à
-- moins de 80 %), absent (moins de 40 %, bloque la semaine). Les seuils sont des réglages de la console.
CREATE FUNCTION meal_match_status(p_pct smallint, p_dish_id bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_dish_id IS NOT NULL OR p_pct >= grocery_setting_int('meal_match_sure_pct', 80) THEN 'sure'
              WHEN p_pct >= grocery_setting_int('meal_match_check_pct', 40) THEN 'to_confirm'
              ELSE 'absent' END
$$;
-- Lecture d'un format de conditionnement (CR-39) : « 1 kg », « 500 g », « 1,5 l », « 75 cl », « sachet de 250 g », « 6 x 33 cl ». Rend une quantité en kg ou en litres,
-- ou deux valeurs vides quand le format n'est pas compris (« 6 œufs », « 1 pièce », « barquette ») : rien n'est deviné, aucun poids moyen par pièce.
CREATE FUNCTION grocery_parse_package(p_format text) RETURNS TABLE (amount numeric, unit text) LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text; m text[]; v_amount numeric;
BEGIN
  v := replace(replace(lower(btrim(COALESCE(p_format, ''))), ',', '.'), '×', 'x');
  m := regexp_match(v, '^(?:[a-zàâäçéèêëîïôöùûüÿœ''’ -]+ de\s+)?(?:(\d{1,4})\s*x\s*)?(\d{1,6}(?:\.\d{1,3})?)\s*(kg|gr|g|cl|ml|l)\.?$');
  IF m IS NULL THEN
    RETURN QUERY SELECT NULL::numeric, NULL::text;
    RETURN;
  END IF;
  v_amount := round(COALESCE(m[1]::numeric, 1) * m[2]::numeric * CASE m[3] WHEN 'g' THEN 0.001 WHEN 'gr' THEN 0.001 WHEN 'ml' THEN 0.001 WHEN 'cl' THEN 0.01 ELSE 1 END, 3);
  IF v_amount <= 0 OR v_amount >= 10000000 THEN
    RETURN QUERY SELECT NULL::numeric, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT v_amount, CASE WHEN m[3] IN ('kg', 'g', 'gr') THEN 'kg' ELSE 'l' END;
END $$;
-- Quantité normalisée d'une référence : déduite du format quand elle n'est pas fournie ; une valeur fournie (l'import) prime et n'est pas écrasée par un changement de format
CREATE FUNCTION grocery_product_reference_package_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; o record;
BEGIN
  SELECT * INTO p FROM grocery_parse_package(NEW.package_format);
  IF TG_OP = 'INSERT' THEN
    IF NEW.package_amount IS NULL AND NEW.package_unit IS NULL THEN
      NEW.package_amount := p.amount; NEW.package_unit := p.unit;
    END IF;
  ELSIF NEW.package_format IS DISTINCT FROM OLD.package_format
        AND NEW.package_amount IS NOT DISTINCT FROM OLD.package_amount AND NEW.package_unit IS NOT DISTINCT FROM OLD.package_unit THEN
    SELECT * INTO o FROM grocery_parse_package(OLD.package_format);
    IF OLD.package_amount IS NOT DISTINCT FROM o.amount AND OLD.package_unit IS NOT DISTINCT FROM o.unit THEN
      NEW.package_amount := p.amount; NEW.package_unit := p.unit;     -- les valeurs étaient déduites : elles suivent le nouveau format
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION grocery_shared_price_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.reference_name IS DISTINCT FROM OLD.reference_name OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
     OR NEW.price_unit IS DISTINCT FROM OLD.price_unit OR NEW.store_chain IS DISTINCT FROM OLD.store_chain OR NEW.city IS DISTINCT FROM OLD.city OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Une ligne de la base commune des prix ne se modifie pas : seuls son retrait et sa semaine changent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.week_start < OLD.week_start THEN
    RAISE EXCEPTION 'La semaine d''une ligne de la base commune ne recule pas' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION grocery_price_sharing_event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_type legal_document_type;
BEGIN
  SELECT document_type INTO v_type FROM legal_document_versions WHERE id = NEW.legal_version_id;
  IF v_type IS DISTINCT FROM 'grocery_price_sharing_consent' THEN
    RAISE EXCEPTION 'Le texte accepté n''est pas celui du partage des prix' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Un plat personnel a au moins un ingrédient : contrôle différé à la fin de la transaction (le plat et ses ingrédients s'écrivent ensemble)
CREATE FUNCTION meal_household_dish_needs_ingredient() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_dish uuid;
BEGIN
  IF TG_TABLE_NAME = 'meal_household_dishes' THEN
    v_dish := NEW.id;
  ELSE
    v_dish := OLD.household_dish_id;
  END IF;
  IF EXISTS (SELECT 1 FROM meal_household_dishes WHERE id = v_dish)
     AND NOT EXISTS (SELECT 1 FROM meal_household_dish_ingredients WHERE household_dish_id = v_dish) THEN
    RAISE EXCEPTION 'Un plat personnel a au moins un ingrédient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
-- Un plat de saison a au moins un ingrédient et au moins un mois : contrôle différé à la fin de la transaction (le plat, ses ingrédients et ses mois s'écrivent ensemble)
CREATE FUNCTION meal_season_dish_needs_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_dish bigint;
BEGIN
  IF TG_TABLE_NAME = 'meal_season_dishes' THEN
    v_dish := NEW.id;
  ELSE
    v_dish := OLD.dish_id;
  END IF;
  IF EXISTS (SELECT 1 FROM meal_season_dishes WHERE id = v_dish)
     AND (NOT EXISTS (SELECT 1 FROM meal_season_dish_ingredients WHERE dish_id = v_dish) OR NOT EXISTS (SELECT 1 FROM meal_season_dish_months WHERE dish_id = v_dish)) THEN
    RAISE EXCEPTION 'Un plat de saison a au moins un ingrédient et au moins un mois' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
-- Les étapes d'un déroulé écrit par l'IA n'existent que pour un menu sans semaine type : contrôle différé à la fin de la transaction (le menu est mis à jour, puis ses étapes remplacées)
CREATE FUNCTION meal_menu_session_steps_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_menu uuid;
BEGIN
  IF TG_TABLE_NAME = 'meal_menus' THEN
    v_menu := NEW.id;
  ELSE
    v_menu := NEW.menu_id;
  END IF;
  IF EXISTS (SELECT 1 FROM meal_menus WHERE id = v_menu AND batch_week_id IS NOT NULL)
     AND EXISTS (SELECT 1 FROM meal_menu_session_steps WHERE menu_id = v_menu) THEN
    RAISE EXCEPTION 'Un menu qui reprend une semaine type n''a pas de déroulé de séance enregistré : c''est celui du planning' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
-- Compte un menu complet d'un foyer et applique le plafond quotidien, de façon atomique (même principe que register_agent_request)
CREATE FUNCTION register_meal_menu(p_account uuid, p_day date, p_cap integer DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_cap integer; v_count integer;
BEGIN
  v_cap := LEAST(COALESCE(p_cap, grocery_setting_int('meal_menu_daily_cap', 10)), 32000);
  IF v_cap < 1 THEN RETURN false; END IF;
  INSERT INTO meal_menu_daily_counters AS c (account_id, menu_date, menu_count)
       VALUES (p_account, p_day, 1)
  ON CONFLICT (account_id, menu_date) DO UPDATE SET menu_count = c.menu_count + 1
        WHERE c.menu_count < v_cap
  RETURNING c.menu_count INTO v_count;
  RETURN v_count IS NOT NULL;
END $$;
-- Seule porte d'écriture de la base commune des plats de saison (CR-61) : crée le plat s'il n'existe pas (même nom normalisé), sinon rend le plat existant sans rien écraser ni fusionner (le premier est gardé,
-- la console corrige). Ne reçoit aucun foyer : aucune trace de qui l'a obtenu. Ingrédients : tableau JSON de {label, name_key, product_id, quantity, unit, position}.
CREATE FUNCTION share_season_dish(p_name text, p_name_key text, p_cuisine_id integer, p_servings integer, p_recipe text, p_duration integer, p_months integer[], p_tag_ids integer[], p_ingredients jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO meal_season_dishes (name, name_key, cuisine_id, servings, recipe, duration_minutes)
  VALUES (p_name, p_name_key, p_cuisine_id, p_servings, p_recipe, p_duration)
  ON CONFLICT (name_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT d.id INTO v_id FROM meal_season_dishes d WHERE d.name_key = p_name_key;
    RETURN v_id;
  END IF;
  INSERT INTO meal_season_dish_months (dish_id, season_month) SELECT DISTINCT v_id, m FROM unnest(COALESCE(p_months, '{}')) m;
  INSERT INTO meal_season_dish_tag_links (dish_id, tag_id) SELECT DISTINCT v_id, tg FROM unnest(COALESCE(p_tag_ids, '{}')) tg;
  INSERT INTO meal_season_dish_ingredients (dish_id, label, name_key, product_id, quantity, unit, position)
  SELECT v_id, x.label, x.name_key, x.product_id, x.quantity, x.unit, COALESCE(x.position, 1)
    FROM jsonb_to_recordset(COALESCE(p_ingredients, '[]'::jsonb)) AS x(label text, name_key text, product_id bigint, quantity numeric, unit text, position integer);
  RETURN v_id;
END $$;
-- Choix d'un plat de saison dans un menu validé : le compteur de la base commune monte une seule fois par foyer et par plat. Le foyer ne sert qu'à vérifier qu'aucune ligne de menu de ce foyer ne pointe déjà vers ce plat,
-- il n'est pas gardé. À appeler AVANT d'écrire la ligne de menu qui porte season_dish_id. Rend vrai si le compteur a monté.
CREATE FUNCTION choose_season_dish(p_account uuid, p_dish bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM meal_season_dishes WHERE id = p_dish) THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM meal_menu_entries e WHERE e.account_id = p_account AND e.season_dish_id = p_dish) THEN
    RETURN false;
  END IF;
  UPDATE meal_season_dishes SET chosen_count = chosen_count + 1 WHERE id = p_dish;
  RETURN true;
END $$;
-- Recherche des plats de saison du mois (CR-61) : plats non masqués dont le mois de saison est celui demandé, dans les cuisines données, avec toutes les étiquettes demandées et aucune étiquette exclue, sans les plats déjà
-- écartés ; les plus choisis d'abord. Les filtres viennent de l'application (les allergies et les régimes du foyer sont chiffrés et ne sont jamais lus par la base) ; l'exclusion des allergies par mots-clés se fait
-- dans l'application sur les candidats rendus. Valeur vide = pas de filtre.
CREATE FUNCTION search_season_dishes(p_month date, p_cuisines integer[] DEFAULT NULL, p_required_tags integer[] DEFAULT NULL, p_excluded_tags integer[] DEFAULT NULL,
                                     p_exclude_ids bigint[] DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS TABLE (dish_id bigint, name varchar, name_key text, cuisine_id integer, servings smallint, recipe text, duration_minutes smallint, chosen_count integer, tag_ids integer[], months smallint[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.name, d.name_key, d.cuisine_id, d.servings, d.recipe, d.duration_minutes, d.chosen_count,
         ARRAY(SELECT l.tag_id FROM meal_season_dish_tag_links l WHERE l.dish_id = d.id ORDER BY l.tag_id),
         ARRAY(SELECT m.season_month FROM meal_season_dish_months m WHERE m.dish_id = d.id ORDER BY m.season_month)
    FROM meal_season_dishes d
   WHERE d.hidden_at IS NULL
     AND EXISTS (SELECT 1 FROM meal_season_dish_months m WHERE m.dish_id = d.id AND m.season_month = extract(month FROM p_month)::smallint)
     AND (p_cuisines IS NULL OR d.cuisine_id = ANY (p_cuisines))
     AND (p_required_tags IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p_required_tags) rt WHERE NOT EXISTS (SELECT 1 FROM meal_season_dish_tag_links l WHERE l.dish_id = d.id AND l.tag_id = rt)))
     AND (p_excluded_tags IS NULL OR NOT EXISTS (SELECT 1 FROM meal_season_dish_tag_links l WHERE l.dish_id = d.id AND l.tag_id = ANY (p_excluded_tags)))
     AND (p_exclude_ids IS NULL OR d.id <> ALL (p_exclude_ids))
   ORDER BY d.chosen_count DESC, d.id
   LIMIT p_limit
$$;
CREATE FUNCTION season_dish_ingredients_for(p_dishes bigint[])
RETURNS TABLE (dish_id bigint, label varchar, name_key text, product_id bigint, quantity numeric, unit text, "position" smallint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.dish_id, i.label, i.name_key, i.product_id, i.quantity, i.unit, i.position
    FROM meal_season_dish_ingredients i
    JOIN meal_season_dishes d ON d.id = i.dish_id
   WHERE i.dish_id = ANY (p_dishes) AND d.hidden_at IS NULL
   ORDER BY i.dish_id, i.position
$$;
-- Un plat libre a au moins un ingrédient : contrôle différé à la fin de la transaction (la ligne de menu et ses ingrédients s'écrivent ensemble)
CREATE FUNCTION meal_menu_entry_needs_ingredient() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_entry bigint;
BEGIN
  IF TG_TABLE_NAME = 'meal_menu_entries' THEN
    v_entry := NEW.id;
  ELSE
    v_entry := OLD.entry_id;
  END IF;
  IF EXISTS (SELECT 1 FROM meal_menu_entries WHERE id = v_entry)
     AND NOT EXISTS (SELECT 1 FROM meal_menu_entry_ingredients WHERE entry_id = v_entry) THEN
    RAISE EXCEPTION 'Un plat du menu a au moins un ingrédient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
-- Besoins du menu par produit (CR-50, US-157 RF7bis) : les quantités des ingrédients de tous les plats du menu, plats express compris, additionnées par produit et par unité de base.
-- L'application divise ensuite par le format de la référence choisie (package_amount, package_unit) et arrondit au paquet supérieur.
CREATE VIEW v_meal_menu_needs WITH (security_invoker = true) AS
SELECT e.menu_id, e.account_id, i.product_id,
       CASE WHEN i.product_id IS NULL THEN i.name_key END AS name_key,
       i.base_unit,
       sum(i.base_quantity) AS total_quantity,
       count(*) AS ingredient_count,
       bool_or(i.quantity IS NULL) AS needs_check,
       COALESCE(bool_or(p.is_pantry), false) OR COALESCE(bool_or(i.unit IN ('spoon', 'pinch')), false) AS is_pantry
  FROM meal_menu_entry_ingredients i
  JOIN meal_menu_entries e ON e.id = i.entry_id
  LEFT JOIN grocery_products p ON p.id = i.product_id
 GROUP BY e.menu_id, e.account_id, i.product_id, CASE WHEN i.product_id IS NULL THEN i.name_key END, i.base_unit;
-- Une adaptation de version allégée n'existe que pour un plat dont l'IA a proposé une version allégée
CREATE FUNCTION meal_menu_entry_light_item_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM meal_menu_entries WHERE id = NEW.entry_id AND light_by_ai) THEN
    RAISE EXCEPTION 'Une adaptation allégée suppose une version allégée proposée par l''IA pour ce plat' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Le scénario d'une liste regroupée est celui du regroupement ; un regroupement qui n'a plus 2 listes disparaît (les listes qui restent redeviennent des listes de semaine)
CREATE FUNCTION grocery_list_group_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_scenario smallint;
BEGIN
  IF NEW.group_id IS NOT NULL THEN
    SELECT g.scenario INTO v_scenario FROM grocery_list_groups g WHERE g.id = NEW.group_id AND g.account_id = NEW.account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Le regroupement n''existe pas ou n''est pas celui du foyer' USING ERRCODE = 'foreign_key_violation';
    ELSIF NEW.scenario IS DISTINCT FROM v_scenario THEN
      RAISE EXCEPTION 'Une liste regroupée a le scénario d''achat de son regroupement' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION grocery_list_group_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.group_id IS NOT NULL AND (TG_OP = 'DELETE' OR NEW.group_id IS DISTINCT FROM OLD.group_id) THEN
    IF (SELECT count(*) FROM grocery_lists WHERE group_id = OLD.group_id) < 2 THEN
      DELETE FROM grocery_list_groups WHERE id = OLD.group_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION grocery_list_item_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_user uuid := app_current_user_id(); v_menu uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'Un produit de la liste ne change pas de foyer' USING ERRCODE = 'check_violation';
  END IF;
  -- Le produit appartient au menu de sa liste (CR-54) : rempli à partir de la liste s'il est vide, refusé s'il diffère
  IF NEW.list_id IS NOT NULL THEN
    SELECT l.menu_id INTO v_menu FROM grocery_lists l WHERE l.id = NEW.list_id AND l.account_id = NEW.account_id;
    IF NEW.menu_id IS NULL THEN
      NEW.menu_id := v_menu;
    ELSIF v_menu IS DISTINCT FROM NEW.menu_id THEN
      RAISE EXCEPTION 'Un produit de la liste appartient au menu de sa liste' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Invité secondaire (CR-10, CR-38) : il ajoute un produit en son nom, augmente sa quantité en le rajoutant, ou coche « acheté » un article de la liste validée ; rien d'autre
  IF v_user IS NOT NULL AND grocery_access(v_user) = 'list' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.state NOT IN ('preparing', 'added_after_validation') OR NEW.added_by_user_id IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'Un invité secondaire ajoute un produit en son nom, sans autre changement' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (to_jsonb(NEW) - 'quantity' - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'quantity' - 'updated_at') AND NEW.quantity > OLD.quantity THEN
      NULL;                                              -- quantité qui augmente seule
    ELSIF (to_jsonb(NEW) - 'state' - 'bought_at' - 'bought_by_user_id' - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'state' - 'bought_at' - 'bought_by_user_id' - 'updated_at')
          AND ((OLD.state IN ('validated', 'added_after_validation') AND NEW.state = 'bought' AND NEW.bought_at IS NOT NULL AND NEW.bought_by_user_id = v_user)
            OR (OLD.state = 'bought' AND OLD.bought_by_user_id = v_user AND NEW.state IN ('validated', 'added_after_validation')
                AND NEW.bought_at IS NULL AND NEW.bought_by_user_id IS NULL)) THEN
      NULL;                                              -- coche « acheté » (n'importe quel article validé) ou décoche de sa propre coche
    ELSE
      RAISE EXCEPTION 'Un invité secondaire peut seulement augmenter une quantité ou cocher « acheté » un article de la liste validée' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Un produit qui n'est plus acheté n'est plus relié à une ligne de ticket (CR-58)
  IF NEW.state IS DISTINCT FROM 'bought' THEN
    NEW.receipt_line_id := NULL;
  END IF;
  RETURN NEW;
END $$;
-- Lecture de la liste sans prix pour l'invité secondaire (CR-38) : le prix estimé est vide pour lui, intact pour le couple ; magasin et référence restent visibles
CREATE FUNCTION grocery_list_for(p_viewer uuid)
RETURNS TABLE (id uuid, list_id uuid, state grocery_item_state, source text, label varchar, name_key text, product_id bigint, aisle_id integer, quantity smallint,
               added_by_user_id uuid, not_bought_last_time boolean, store_chain varchar, reference_name varchar, unit_price numeric, bought_at timestamptz,
               bought_by_user_id uuid, package_format varchar, price_unit varchar, needed_amount numeric, needed_unit text, quantity_to_check boolean, is_pantry boolean,
               is_selected boolean, menu_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT i.id, i.list_id, i.state, i.source, i.label, i.name_key, i.product_id, i.aisle_id, i.quantity, i.added_by_user_id, i.not_bought_last_time,
         i.store_chain, i.reference_name, CASE WHEN grocery_access(p_viewer) = 'couple' THEN i.unit_price END, i.bought_at, i.bought_by_user_id,
         (SELECT r.package_format FROM grocery_product_references r
           WHERE r.product_id = i.product_id AND r.store_chain = i.store_chain AND r.reference_name = i.reference_name),
         i.price_unit, i.needed_amount, i.needed_unit, i.quantity_to_check, i.is_pantry, i.is_selected, i.menu_id
    FROM users v
    JOIN grocery_list_items i ON i.account_id = v.account_id
   WHERE v.id = p_viewer AND grocery_access(p_viewer) IS NOT NULL
$$;
-- Pas encore acheté la semaine d'avant (CR-55, US-157 RF3bis) : pense-bêtes calculés à la lecture, jamais recopiés. Source : la plus récente liste encore existante d'une semaine
-- antérieure au menu visé ; produits validés ou ajoutés après la validation, non cochés « acheté ». Ils restent sur leur liste d'origine ; ils disparaissent dès que le produit est
-- acheté sur cette liste, ou quand le produit existe dans la semaine visée (un pense-bête coché y devient un produit de la semaine).
CREATE FUNCTION grocery_leftovers_for(p_viewer uuid, p_menu uuid)
RETURNS TABLE (source_item_id uuid, origin_list_id uuid, origin_menu_id uuid, origin_week_start date, label varchar, name_key text, product_id bigint, aisle_id integer, quantity smallint,
               store_chain varchar, reference_name varchar, unit_price numeric, price_unit varchar, needed_amount numeric, needed_unit text, quantity_to_check boolean,
               is_pantry boolean, is_selected boolean)
LANGUAGE sql STABLE AS $$
  WITH target AS (
    SELECT m.id, m.account_id, m.week_start
      FROM meal_menus m
      JOIN users v ON v.account_id = m.account_id
     WHERE m.id = p_menu AND v.id = p_viewer AND grocery_access(p_viewer) IS NOT NULL),
  origin AS (
    SELECT l.id AS list_id, om.id AS menu_id, om.week_start
      FROM target t
      JOIN meal_menus om ON om.account_id = t.account_id AND om.week_start < t.week_start
      JOIN grocery_lists l ON l.menu_id = om.id AND l.account_id = om.account_id
     ORDER BY om.week_start DESC
     LIMIT 1)
  SELECT i.id, o.list_id, o.menu_id, o.week_start, i.label, i.name_key, i.product_id, i.aisle_id, i.quantity, i.store_chain, i.reference_name,
         CASE WHEN grocery_access(p_viewer) = 'couple' THEN i.unit_price END, i.price_unit, i.needed_amount, i.needed_unit, i.quantity_to_check, i.is_pantry, false
    FROM origin o
    JOIN grocery_list_items i ON i.list_id = o.list_id
   WHERE i.state IN ('validated', 'added_after_validation')
     AND NOT EXISTS (SELECT 1 FROM target t JOIN grocery_list_items n ON n.account_id = t.account_id AND n.menu_id = t.id WHERE n.name_key = i.name_key)
$$;
-- Suppression d'un menu ou d'une liste (CR-54, US-157 RF11) : vraie suppression, en une transaction, couple seulement, même avec des produits achetés. Ne touche ni les tickets, ni les prix
-- partagés, ni les plats copiés dans Mes plats, ni le compteur de menus du jour. Le profil est lu dans app.user_id (comme le garde-fou de la liste) : sans profil indiqué, pas de contrôle (H144).
CREATE FUNCTION delete_meal_menu(p_menu uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_user uuid := app_current_user_id(); v_account uuid;
BEGIN
  IF v_user IS NOT NULL AND grocery_access(v_user) IS DISTINCT FROM 'couple' THEN
    RAISE EXCEPTION 'Seul le couple du foyer supprime un menu' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT account_id INTO v_account FROM meal_menus WHERE id = p_menu;
  IF v_account IS NULL THEN
    RETURN false;
  END IF;
  IF v_user IS NOT NULL AND (SELECT grocery_couple_account()) IS DISTINCT FROM v_account THEN
    RAISE EXCEPTION 'Ce menu n''est pas celui de votre foyer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM grocery_list_items WHERE menu_id = p_menu AND account_id = v_account;
  DELETE FROM grocery_lists WHERE menu_id = p_menu AND account_id = v_account;
  DELETE FROM meal_menus WHERE id = p_menu AND account_id = v_account;
  RETURN true;
END $$;
CREATE FUNCTION delete_grocery_list(p_menu uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_user uuid := app_current_user_id(); v_account uuid; v_n integer; v_total integer := 0;
BEGIN
  IF v_user IS NOT NULL AND grocery_access(v_user) IS DISTINCT FROM 'couple' THEN
    RAISE EXCEPTION 'Seul le couple du foyer supprime une liste' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT account_id INTO v_account FROM meal_menus WHERE id = p_menu;
  IF v_account IS NULL THEN
    RETURN false;
  END IF;
  IF v_user IS NOT NULL AND (SELECT grocery_couple_account()) IS DISTINCT FROM v_account THEN
    RAISE EXCEPTION 'Ce menu n''est pas celui de votre foyer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM grocery_list_items WHERE menu_id = p_menu AND account_id = v_account;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_lists WHERE menu_id = p_menu AND account_id = v_account;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RETURN v_total > 0;
END $$;
CREATE FUNCTION grocery_receipt_line_measure_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v numeric;
BEGIN
  IF NEW.price_per_measure IS NULL AND NEW.measured_quantity > 0 AND NEW.line_total > 0 THEN
    v := round(NEW.line_total / NEW.measured_quantity, 2);
    IF v > 0 AND v < 1000000 THEN
      NEW.price_per_measure := v;
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Règles des réglages : le partage des prix ne change qu'après l'inscription de la preuve de consentement correspondante (CR-24)
CREATE FUNCTION grocery_household_settings_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_last consent_action;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.share_prices) OR (TG_OP = 'UPDATE' AND NEW.share_prices IS DISTINCT FROM OLD.share_prices) THEN
    SELECT action_type INTO v_last FROM grocery_price_sharing_events WHERE account_id = NEW.account_id ORDER BY occurred_at DESC, id DESC LIMIT 1;
    IF v_last IS DISTINCT FROM (CASE WHEN NEW.share_prices THEN 'granted' ELSE 'withdrawn' END)::consent_action THEN
      RAISE EXCEPTION 'Le partage des prix ne change qu''après l''inscription de la preuve de consentement' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Inscription du foyer au compteur de sa ville : posée à l'activation du partage, déplacée s'il change de ville en partageant, conservée à la désactivation (CR-22).
-- Exécutée avec les droits du propriétaire : le compteur n'est écrit par aucun autre rôle.
CREATE FUNCTION grocery_sync_city_sharing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.share_prices THEN
    INSERT INTO grocery_household_city_sharing (account_id, city_key) VALUES (NEW.account_id, grocery_norm(NEW.city))
    ON CONFLICT (account_id) DO UPDATE SET city_key = EXCLUDED.city_key;
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION grocery_city_counter_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE grocery_city_sharing SET household_count = household_count - 1 WHERE city_key = OLD.city_key;
    DELETE FROM grocery_city_sharing WHERE city_key = OLD.city_key AND household_count <= 0;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO grocery_city_sharing (city_key, household_count) VALUES (NEW.city_key, 1)
    ON CONFLICT (city_key) DO UPDATE SET household_count = grocery_city_sharing.household_count + 1;
  END IF;
  RETURN NULL;
END $$;
-- Porte d'écriture UNIQUE de la base commune (US-154 RT1) : refuse silencieusement si le foyer ne partage pas ; ne garde ni le foyer ni le jour
CREATE FUNCTION share_grocery_price(p_account uuid, p_product_id bigint, p_reference_name text, p_unit_price numeric, p_store_chain text, p_city text,
                                    p_purchased_on date, p_price_unit text DEFAULT 'unit') RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id bigint;
BEGIN
  IF NOT COALESCE((SELECT share_prices FROM grocery_household_settings WHERE account_id = p_account), false) THEN
    RETURN NULL;
  END IF;
  INSERT INTO grocery_shared_prices AS sp (product_id, reference_name, unit_price, price_unit, store_chain, city, week_start)
  VALUES (p_product_id, grocery_norm(p_reference_name), p_unit_price, COALESCE(p_price_unit, 'unit'), grocery_norm(p_store_chain), grocery_norm(p_city),
          p_purchased_on - (extract(isodow FROM p_purchased_on)::integer - 1))
  ON CONFLICT ON CONSTRAINT uq_grocery_shared_prices_line DO UPDATE SET week_start = greatest(sp.week_start, EXCLUDED.week_start)
  RETURNING sp.id INTO v_id;
  RETURN v_id;
END $$;
-- Lecture des prix des autres foyers (US-154 RF3, CR-12, CR-21) : réciprocité (le foyer partage), enseignes de proximité du foyer seulement, ville affichée
-- dès 2 foyers (le foyer qui consulte compte aussi dans la ville consultée, CR-35), prix de moins de 12 mois, lignes non retirées
CREATE FUNCTION grocery_shared_prices_for(p_viewer uuid)
RETURNS TABLE (product_id bigint, reference_name varchar, unit_price numeric, store_chain varchar, city varchar, week_start date, price_age text,
               price_unit varchar, measure_unit varchar, price_per_measure numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.product_id, p.reference_name, p.unit_price, p.store_chain, p.city, p.week_start, grocery_price_age(p.week_start), p.price_unit,
         CASE WHEN p.price_unit <> 'unit' THEN p.price_unit ELSE rf.package_unit END,
         CASE WHEN p.price_unit <> 'unit' THEN p.unit_price WHEN rf.package_amount IS NOT NULL THEN round(p.unit_price / rf.package_amount, 2) END
    FROM users v
    JOIN grocery_household_settings hs ON hs.account_id = v.account_id AND hs.share_prices
    JOIN grocery_household_stores s ON s.account_id = v.account_id
    JOIN grocery_shared_prices p ON p.store_chain = s.store_chain AND p.city = s.store_city
    JOIN grocery_city_sharing cs ON cs.city_key = grocery_norm(p.city)
    LEFT JOIN grocery_household_city_sharing hc ON hc.account_id = v.account_id
    LEFT JOIN LATERAL (SELECT r.package_amount, r.package_unit FROM grocery_product_references r
                        WHERE r.product_id = p.product_id AND r.store_chain = p.store_chain AND grocery_norm(r.reference_name) = p.reference_name
                          AND r.price_unit = 'unit' AND r.package_amount IS NOT NULL LIMIT 1) rf ON true
   WHERE v.id = p_viewer AND grocery_access(p_viewer) = 'couple'
     -- Le foyer qui consulte compte aussi dans la ville consultée (CR-35) : dans sa propre ville il est déjà compté, ailleurs il s'ajoute
     AND cs.household_count + CASE WHEN hc.city_key = cs.city_key THEN 0 ELSE 1 END >= grocery_setting_int('grocery_city_min_households', 2)
     AND p.removed_at IS NULL AND grocery_price_age(p.week_start) IS NOT NULL
$$;
-- Journal des produits à référencer (US-173) : la ville, la référence, le prix et le magasin ne sont gardés que pour un foyer qui partage ses prix
CREATE FUNCTION note_grocery_unreferenced(p_account uuid, p_name text, p_kind grocery_unreferenced_kind, p_source grocery_unreferenced_source,
                                           p_aisle_id integer DEFAULT NULL, p_city text DEFAULT NULL, p_reference text DEFAULT NULL,
                                           p_unit_price numeric DEFAULT NULL, p_store_chain text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_share boolean; v_id bigint; v_details boolean;
BEGIN
  v_share := COALESCE((SELECT share_prices FROM grocery_household_settings WHERE account_id = p_account), false);
  v_details := v_share AND num_nonnulls(p_city, p_reference, p_unit_price, p_store_chain) = 4;
  INSERT INTO grocery_unreferenced_events (name_key, kind, source, aisle_id, seen_city, seen_reference, seen_unit_price, seen_store_chain)
  VALUES (grocery_norm(p_name), p_kind, p_source, p_aisle_id,
          CASE WHEN v_details THEN grocery_norm(p_city) END, CASE WHEN v_details THEN grocery_norm(p_reference) END,
          CASE WHEN v_details THEN p_unit_price END, CASE WHEN v_details THEN grocery_norm(p_store_chain) END)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
-- Un produit référencé sort de la liste des produits à référencer (US-173 RF5, US-174 RF2)
CREATE FUNCTION grocery_reference_marks_referenced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO grocery_unreferenced_status (name_key, state)
  SELECT p.name_key, 'referenced' FROM grocery_products p
   WHERE p.id = NEW.product_id AND EXISTS (SELECT 1 FROM grocery_unreferenced_events e WHERE e.name_key = p.name_key)
  ON CONFLICT (name_key) DO UPDATE SET state = 'referenced', changed_at = now() WHERE grocery_unreferenced_status.state <> 'referenced';
  RETURN NULL;
END $$;
-- Budget par rayon et par mois d'un foyer (US-163) : réservé au couple ; les moyennes et le mois passé se déduisent de ces totaux (calculés par l'application)
CREATE FUNCTION grocery_monthly_spend_for(p_viewer uuid)
RETURNS TABLE (aisle_id integer, spend_month date, total numeric)
LANGUAGE sql STABLE AS $$
  SELECT l.aisle_id, date_trunc('month', r.purchased_on)::date, sum(l.line_total)
    FROM users v
    JOIN grocery_receipts r ON r.account_id = v.account_id
    JOIN grocery_receipt_lines l ON l.receipt_id = r.id AND l.account_id = r.account_id
   WHERE v.id = p_viewer AND grocery_access(p_viewer) = 'couple'
   GROUP BY l.aisle_id, date_trunc('month', r.purchased_on)
$$;
-- Fusion de deux rayons (US-169 RF2) : les produits, lignes de tickets, produits de liste, produits du quotidien et notes de l'ancien rayon passent au rayon conservé, puis l'ancien disparaît
CREATE FUNCTION merge_grocery_aisles(p_from integer, p_into integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_from = p_into THEN
    RAISE EXCEPTION 'Deux rayons différents sont nécessaires pour une fusion' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM grocery_aisles WHERE id = p_from) OR NOT EXISTS (SELECT 1 FROM grocery_aisles WHERE id = p_into) THEN
    RAISE EXCEPTION 'Rayon inconnu' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE grocery_products SET aisle_id = p_into WHERE aisle_id = p_from;
  UPDATE grocery_receipt_lines SET aisle_id = p_into WHERE aisle_id = p_from;
  UPDATE grocery_list_items SET aisle_id = p_into WHERE aisle_id = p_from;
  UPDATE grocery_unreferenced_events SET aisle_id = p_into WHERE aisle_id = p_from;
  UPDATE grocery_daily_products SET aisle_id = p_into, updated_at = now() WHERE aisle_id = p_from;
  DELETE FROM grocery_aisles WHERE id = p_from;
END $$;
-- Un agent retiré (CR-34) est invisible du catalogue et des tableaux de bord : on ne peut plus l'ajouter à un dashboard
CREATE FUNCTION profile_agent_not_retired() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.removed_at IS NULL AND (TG_OP = 'INSERT' OR OLD.removed_at IS NOT NULL)
     AND EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id AND status = 'retired') THEN
    RAISE EXCEPTION 'Cet agent est retiré du catalogue' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- ---------------------------------------------------------------------
-- Vues de la console (US-164, US-166, US-170 à US-173, US-175)
-- ---------------------------------------------------------------------
CREATE VIEW v_grocery_product_references AS
SELECT r.id AS reference_id, r.product_id, r.store_chain, r.reference_name, r.unit_price, r.price_date,
       grocery_price_age(r.price_date) AS price_age,
       (r.compliance_status <> 'none_found' AND NOT EXISTS (SELECT 1 FROM grocery_additive_criteria c WHERE c.is_active
                    AND grocery_norm(c.label) IN (SELECT grocery_norm(a) FROM unnest(r.additives) a))) AS is_compliant,
       ARRAY(SELECT c.label FROM grocery_additive_criteria c WHERE c.is_active
              AND grocery_norm(c.label) IN (SELECT grocery_norm(a) FROM unnest(r.additives) a) ORDER BY c.label) AS excluded_because,
       r.unit_price IS NOT NULL AS has_price,
       r.compliance_status,
       (r.compliance_status = 'to_check' AND NOT EXISTS (SELECT 1 FROM grocery_additive_criteria c WHERE c.is_active
                    AND grocery_norm(c.label) IN (SELECT grocery_norm(a) FROM unnest(r.additives) a))) AS needs_label_check,
       r.composition_text,
       r.package_format,
       r.package_amount,
       r.package_unit,
       r.price_unit,
       CASE WHEN r.price_unit <> 'unit' THEN r.price_unit ELSE r.package_unit END AS measure_unit,
       CASE WHEN r.unit_price IS NULL THEN NULL
            WHEN r.price_unit <> 'unit' THEN r.unit_price
            WHEN r.package_amount IS NOT NULL THEN round(r.unit_price / r.package_amount, 2) END AS price_per_measure
  FROM grocery_product_references r;
CREATE VIEW v_meal_batch_week_days AS
SELECT d.week_id, d.weekday, d.planning_dish_name, d.dish_id, d.suggested_dish_id, d.match_pct, d.needs_catalog_addition,
       meal_match_status(d.match_pct, d.dish_id) AS match_status,
       CASE WHEN d.dish_id IS NOT NULL THEN d.dish_id
            WHEN meal_match_status(d.match_pct, d.dish_id) IN ('sure', 'to_confirm') THEN d.suggested_dish_id END AS effective_dish_id,
       meal_match_status(d.match_pct, d.dish_id) = 'absent' AS blocks_week
  FROM meal_batch_week_days d;
CREATE VIEW v_meal_batch_weeks AS
SELECT w.id AS week_id, w.code, w.cuisine_id, w.theme, w.session_minutes,
       (SELECT count(*) FROM meal_batch_week_days d WHERE d.week_id = w.id) AS day_count,
       (SELECT count(*) FROM v_meal_batch_week_days d WHERE d.week_id = w.id AND d.effective_dish_id IS NOT NULL) AS linked_count,
       (SELECT count(*) FROM meal_batch_week_days d WHERE d.week_id = w.id) = 5
         AND NOT EXISTS (SELECT 1 FROM v_meal_batch_week_days d WHERE d.week_id = w.id AND d.blocks_week) AS is_usable
  FROM meal_batch_weeks w;
CREATE VIEW v_meal_dishes_console AS
SELECT d.id AS dish_id, d.code, d.name, d.cuisine_id, d.duration_minutes, d.is_express, d.retired_at,
       EXISTS (SELECT 1 FROM meal_batch_week_days b WHERE b.dish_id = d.id OR b.suggested_dish_id = d.id) AS in_batch_week,
       EXISTS (SELECT 1 FROM meal_light_versions v WHERE v.dish_id = d.id) AS has_light_version
  FROM meal_dishes d;
CREATE VIEW v_meal_season_dishes AS
SELECT d.id AS dish_id, d.name, d.name_key, d.cuisine_id, d.servings, d.duration_minutes, d.chosen_count, d.entered_week, d.hidden_at, d.hidden_by_user_id,
       d.hidden_at IS NOT NULL AS is_hidden,
       ARRAY(SELECT m.season_month FROM meal_season_dish_months m WHERE m.dish_id = d.id ORDER BY m.season_month) AS months,
       ARRAY(SELECT l.tag_id FROM meal_season_dish_tag_links l WHERE l.dish_id = d.id ORDER BY l.tag_id) AS tag_ids,
       (SELECT count(*) FROM meal_season_dish_ingredients i WHERE i.dish_id = d.id) AS ingredient_count
  FROM meal_season_dishes d;
CREATE VIEW v_grocery_unreferenced AS
SELECT e.name_key, count(*) AS occurrences, min(e.occurred_at) AS first_seen_at, max(e.occurred_at) AS last_seen_at,
       CASE WHEN bool_or(e.kind = 'unknown') THEN 'unknown' ELSE 'no_reference' END AS kind,
       max(e.aisle_id) AS aisle_id, COALESCE(s.state, 'to_reference') AS state
  FROM grocery_unreferenced_events e
  LEFT JOIN grocery_unreferenced_status s ON s.name_key = e.name_key
 GROUP BY e.name_key, s.state;
CREATE VIEW v_grocery_shared_prices_moderation AS
SELECT p.id AS price_id, p.product_id, p.reference_name, p.unit_price, p.store_chain, p.city, p.week_start, p.removed_at,
       b.basis, b.baseline,
       p.removed_at IS NULL AND CASE
         WHEN b.basis IS NOT NULL THEN p.unit_price * 100 < b.baseline * grocery_setting_int('grocery_check_low_pct', 50)
                                    OR p.unit_price * 100 > b.baseline * grocery_setting_int('grocery_check_high_pct', 200)
           ELSE p.unit_price < grocery_setting_int('grocery_check_floor_cents', 5) / 100.0
           OR p.unit_price > grocery_setting_int('grocery_check_ceiling_cents', 50000) / 100.0 END AS needs_check,
       p.price_unit
  FROM grocery_shared_prices p
  LEFT JOIN LATERAL (
    SELECT CASE WHEN m.n >= grocery_setting_int('grocery_check_min_samples', 3) THEN 'median'
                WHEN rf.ref_price IS NOT NULL THEN 'reference' END AS basis,
           CASE WHEN m.n >= grocery_setting_int('grocery_check_min_samples', 3) THEN m.median_price ELSE rf.ref_price END AS baseline
      FROM (SELECT count(*) AS n, (percentile_cont(0.5) WITHIN GROUP (ORDER BY o.unit_price))::numeric AS median_price
              FROM grocery_shared_prices o
             WHERE o.product_id = p.product_id AND o.store_chain = p.store_chain AND o.id <> p.id AND o.removed_at IS NULL
               AND o.price_unit = p.price_unit
               AND o.week_start >= current_date - make_interval(months => grocery_setting_int('grocery_check_window_months', 12))) m,
           (SELECT CASE WHEN p.price_unit = 'unit' THEN
                    COALESCE((SELECT r.unit_price FROM grocery_product_references r
                               WHERE r.product_id = p.product_id AND r.store_chain = p.store_chain AND grocery_norm(r.reference_name) = p.reference_name),
                             (SELECT avg(r.unit_price) FROM grocery_product_references r
                               WHERE r.product_id = p.product_id AND r.store_chain = p.store_chain))
                  ELSE
                    COALESCE((SELECT v.price_per_measure FROM v_grocery_product_references v
                               WHERE v.product_id = p.product_id AND v.store_chain = p.store_chain AND grocery_norm(v.reference_name) = p.reference_name
                                 AND v.measure_unit = p.price_unit),
                             (SELECT avg(v.price_per_measure) FROM v_grocery_product_references v
                               WHERE v.product_id = p.product_id AND v.store_chain = p.store_chain AND v.measure_unit = p.price_unit))
                  END AS ref_price) rf
  ) b ON true;
-- ---------------------------------------------------------------------
-- Purge (CR-23) : menus validés, tickets et lignes, produits achetés de la liste, journal des produits à référencer, preuves arrivées à échéance
-- ---------------------------------------------------------------------
CREATE FUNCTION purge_expired_grocery_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint; v_total bigint := 0;
BEGIN
  DELETE FROM meal_menus WHERE validated_at < now() - make_interval(months => grocery_setting_int('meal_menu_retention_months', 12));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  -- Tickets : l'année en cours et les deux précédentes (3 ans par défaut)
  DELETE FROM grocery_receipts
   WHERE purchased_on < make_date(extract(year FROM current_date)::integer - (grocery_setting_int('grocery_receipt_retention_years', 3) - 1), 1, 1);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_list_items
   WHERE state = 'bought' AND bought_at < now() - make_interval(months => grocery_setting_int('grocery_bought_retention_months', 3));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_lists l
   WHERE l.validated_at < now() - make_interval(months => grocery_setting_int('grocery_bought_retention_months', 3))
     AND NOT EXISTS (SELECT 1 FROM grocery_list_items i WHERE i.list_id = l.id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_unreferenced_events
   WHERE occurred_at < now() - make_interval(months => grocery_setting_int('grocery_unreferenced_retention_months', 12));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_unreferenced_status s
   WHERE s.state = 'to_reference' AND NOT EXISTS (SELECT 1 FROM grocery_unreferenced_events e WHERE e.name_key = s.name_key);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_price_sharing_events WHERE retain_until < current_date;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  -- Base commune des prix : les lignes de plus de 12 mois (fenêtre du contrôle des prix) sont supprimées, retirées ou non (CR-35) ; le catalogue n'est pas concerné
  DELETE FROM grocery_shared_prices
   WHERE week_start < current_date - make_interval(months => grocery_setting_int('grocery_check_window_months', 12));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  -- Compteurs du plafond quotidien de menus : 7 jours (CR-44)
  DELETE FROM meal_menu_daily_counters WHERE menu_date < current_date - 7;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  -- Sélection de plats de saison d'un mois passé (CR-60) : le mois du foyer est fini pour tous (marge de deux jours pour les fuseaux) ; la base commune n'est jamais purgée
  DELETE FROM meal_season_household_dishes WHERE season_month < date_trunc('month', current_date - 2)::date;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RETURN v_total;
END $$;
CREATE OR REPLACE VIEW v_dashboard_agents AS
SELECT pa.user_id, a.id AS agent_id, a.name, a.short_description, c.code AS category_code, pa.added_at,
       CASE WHEN a.status = 'blocked' THEN 'blocked'
            WHEN EXISTS (SELECT 1 FROM v_profile_agent_missing_items m WHERE m.user_id = pa.user_id AND m.agent_id = pa.agent_id)
                 THEN 'to_configure'
            ELSE 'ready' END AS display_status
  FROM profile_agents pa
  JOIN agents a ON a.id = pa.agent_id
  JOIN agent_categories c ON c.id = a.category_id
 WHERE pa.removed_at IS NULL
   AND a.status <> 'retired';

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
CREATE INDEX idx_agents_retired_by_user_id ON agents (retired_by_user_id);
CREATE UNIQUE INDEX ux_meal_cuisines_name ON meal_cuisines (grocery_norm(name));
CREATE UNIQUE INDEX ux_meal_dish_categories_name ON meal_dish_categories (grocery_norm(name));
CREATE UNIQUE INDEX ux_meal_dish_tags_name ON meal_dish_tags (kind, grocery_norm(name));
CREATE UNIQUE INDEX ux_grocery_aisles_name ON grocery_aisles (grocery_norm(name));
CREATE INDEX idx_grocery_products_aisle_id ON grocery_products (aisle_id);
-- Le nom est aussi unique tel qu'affiché (après grocery_norm : minuscules et espaces simples)
CREATE UNIQUE INDEX ux_grocery_daily_products_name ON grocery_daily_products (grocery_norm(name));
CREATE INDEX idx_grocery_daily_products_aisle ON grocery_daily_products (aisle_id, position);
CREATE INDEX idx_grocery_daily_products_product_id ON grocery_daily_products (product_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX ux_grocery_additive_criteria_label ON grocery_additive_criteria (grocery_norm(label));
CREATE INDEX idx_meal_dishes_cuisine_id ON meal_dishes (cuisine_id);
CREATE INDEX idx_meal_dish_category_links_category_id ON meal_dish_category_links (category_id);
CREATE INDEX idx_meal_dish_tag_links_tag_id ON meal_dish_tag_links (tag_id);
CREATE INDEX idx_meal_dish_ingredients_product_id ON meal_dish_ingredients (product_id);
CREATE INDEX idx_meal_batch_weeks_cuisine_id ON meal_batch_weeks (cuisine_id);
CREATE INDEX idx_meal_batch_week_days_dish_id ON meal_batch_week_days (dish_id) WHERE dish_id IS NOT NULL;
CREATE INDEX idx_meal_batch_week_days_suggested_dish_id ON meal_batch_week_days (suggested_dish_id) WHERE suggested_dish_id IS NOT NULL;
CREATE INDEX idx_meal_light_version_items_product_id ON meal_light_version_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_grocery_unreferenced_events_name ON grocery_unreferenced_events (name_key, occurred_at DESC);
CREATE INDEX idx_grocery_unreferenced_events_aisle_id ON grocery_unreferenced_events (aisle_id) WHERE aisle_id IS NOT NULL;
CREATE INDEX idx_grocery_unreferenced_events_occurred_at ON grocery_unreferenced_events (occurred_at);
CREATE INDEX idx_grocery_unreferenced_status_changed_by ON grocery_unreferenced_status (changed_by_user_id) WHERE changed_by_user_id IS NOT NULL;
CREATE INDEX idx_grocery_shared_prices_median ON grocery_shared_prices (product_id, store_chain, week_start);
CREATE INDEX idx_grocery_shared_prices_place ON grocery_shared_prices (store_chain, city);
CREATE INDEX idx_grocery_shared_prices_removed_by ON grocery_shared_prices (removed_by_user_id) WHERE removed_by_user_id IS NOT NULL;
CREATE INDEX idx_grocery_price_sharing_events_account ON grocery_price_sharing_events (account_id, occurred_at DESC);
CREATE INDEX idx_grocery_price_sharing_events_legal_version_id ON grocery_price_sharing_events (legal_version_id);
CREATE INDEX idx_grocery_price_sharing_events_retain_until ON grocery_price_sharing_events (retain_until) WHERE retain_until IS NOT NULL;
CREATE INDEX idx_grocery_household_settings_cuisine ON grocery_household_settings (replacement_cuisine_id) WHERE replacement_cuisine_id IS NOT NULL;
CREATE INDEX idx_grocery_household_settings_updated_by ON grocery_household_settings (updated_by_user_id, account_id);
CREATE INDEX idx_grocery_household_cuisines_cuisine_id ON grocery_household_cuisines (cuisine_id);
CREATE INDEX idx_grocery_household_dietary_updated_by ON grocery_household_dietary (updated_by_user_id, account_id);
CREATE INDEX idx_grocery_household_city_sharing_city ON grocery_household_city_sharing (city_key);
-- Un plat personnel peut porter le nom d'un plat du catalogue (CR-25) ; deux plats du même foyer ne portent pas le même nom
CREATE UNIQUE INDEX ux_meal_household_dishes_name ON meal_household_dishes (account_id, grocery_norm(name));
CREATE INDEX idx_meal_household_dishes_cuisine_id ON meal_household_dishes (cuisine_id);
CREATE INDEX idx_meal_household_dishes_created_by ON meal_household_dishes (created_by_user_id, account_id);
CREATE INDEX idx_meal_household_dish_ingredients_account ON meal_household_dish_ingredients (account_id);
CREATE INDEX idx_meal_household_dish_ingredients_product_id ON meal_household_dish_ingredients (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_meal_household_dish_tags_account ON meal_household_dish_tags (account_id);
CREATE INDEX idx_meal_household_dish_tags_tag_id ON meal_household_dish_tags (tag_id);
CREATE INDEX idx_meal_season_dishes_cuisine_id ON meal_season_dishes (cuisine_id);
CREATE INDEX idx_meal_season_dishes_hidden_by ON meal_season_dishes (hidden_by_user_id) WHERE hidden_by_user_id IS NOT NULL;
CREATE INDEX idx_meal_season_dish_ingredients_product_id ON meal_season_dish_ingredients (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_meal_season_dish_tag_links_tag_id ON meal_season_dish_tag_links (tag_id);
CREATE INDEX idx_meal_season_household_dishes_dish_id ON meal_season_household_dishes (dish_id);
CREATE INDEX idx_meal_menus_validated_by ON meal_menus (validated_by_user_id, account_id);
CREATE INDEX idx_meal_menus_batch_week_id ON meal_menus (batch_week_id) WHERE batch_week_id IS NOT NULL;
CREATE INDEX idx_meal_menus_validated_at ON meal_menus (validated_at);
CREATE INDEX idx_meal_menu_entries_account ON meal_menu_entries (account_id);
CREATE INDEX idx_meal_menu_entries_dish_id ON meal_menu_entries (dish_id) WHERE dish_id IS NOT NULL;
CREATE INDEX idx_meal_menu_entries_household_dish ON meal_menu_entries (household_dish_id, account_id) WHERE household_dish_id IS NOT NULL;
CREATE INDEX idx_meal_menu_entries_cuisine_id ON meal_menu_entries (cuisine_id) WHERE cuisine_id IS NOT NULL;
CREATE INDEX idx_meal_menu_entries_season_dish ON meal_menu_entries (season_dish_id, account_id) WHERE season_dish_id IS NOT NULL;
CREATE INDEX idx_meal_menu_entry_ingredients_account ON meal_menu_entry_ingredients (account_id);
CREATE INDEX idx_meal_menu_entry_ingredients_product_id ON meal_menu_entry_ingredients (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_meal_menu_entry_light_items_account ON meal_menu_entry_light_items (account_id);
CREATE INDEX idx_meal_menu_entry_light_items_product_id ON meal_menu_entry_light_items (product_id) WHERE product_id IS NOT NULL;
-- Une seule étape de conservation par plat
CREATE UNIQUE INDEX ux_meal_menu_session_steps_storage ON meal_menu_session_steps (entry_id) WHERE storage_mode IS NOT NULL AND entry_id IS NOT NULL;
CREATE INDEX idx_meal_menu_session_steps_account ON meal_menu_session_steps (account_id);
CREATE INDEX idx_meal_menu_session_steps_entry ON meal_menu_session_steps (entry_id, menu_id) WHERE entry_id IS NOT NULL;
CREATE INDEX idx_meal_light_choices_dish_id ON meal_light_choices (dish_id);
CREATE INDEX idx_grocery_list_groups_account ON grocery_list_groups (account_id, validated_at DESC);
CREATE INDEX idx_grocery_list_groups_validated_by ON grocery_list_groups (validated_by_user_id, account_id);
CREATE INDEX idx_grocery_lists_account ON grocery_lists (account_id, validated_at DESC);
-- Une liste par menu (CR-54) : chaque semaine a son menu et sa liste
CREATE UNIQUE INDEX ux_grocery_lists_menu ON grocery_lists (menu_id) WHERE menu_id IS NOT NULL;
CREATE INDEX idx_grocery_lists_group ON grocery_lists (group_id, account_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_grocery_lists_validated_by ON grocery_lists (validated_by_user_id, account_id);
-- Un produit déjà dans la liste d'une semaine n'est pas ajouté deux fois : sa quantité augmente (US-158 RF3) ; chaque semaine a ses produits (CR-54). Sans menu, les produits ajoutés à la main restent uniques par nom.
CREATE UNIQUE INDEX ux_grocery_list_items_open ON grocery_list_items (account_id, menu_id, name_key) NULLS NOT DISTINCT WHERE state <> 'bought';
CREATE INDEX idx_grocery_list_items_menu ON grocery_list_items (menu_id, account_id) WHERE menu_id IS NOT NULL;
CREATE INDEX idx_grocery_list_items_list ON grocery_list_items (list_id, account_id) WHERE list_id IS NOT NULL;
CREATE INDEX idx_grocery_list_items_history ON grocery_list_items (account_id, bought_at DESC) WHERE state = 'bought';
CREATE INDEX idx_grocery_list_items_product_id ON grocery_list_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_grocery_list_items_aisle_id ON grocery_list_items (aisle_id) WHERE aisle_id IS NOT NULL;
CREATE INDEX idx_grocery_list_items_added_by ON grocery_list_items (added_by_user_id, account_id);
CREATE INDEX idx_grocery_list_items_bought_by ON grocery_list_items (bought_by_user_id, account_id);
-- Un ticket déjà enregistré est refusé en entier (US-161 RT2, CR-41) : avec une heure, même date, même heure et même total (le magasin n'entre pas en compte) ;
-- sans heure, même magasin, même date et même total, comme avant. Les deux contrôles sont garantis par la base.
CREATE UNIQUE INDEX ux_grocery_receipts_duplicate_time ON grocery_receipts (account_id, purchased_on, purchased_time, total_amount) WHERE purchased_time IS NOT NULL;
CREATE UNIQUE INDEX ux_grocery_receipts_duplicate_no_time ON grocery_receipts (account_id, store_chain, purchased_on, total_amount) WHERE purchased_time IS NULL;
CREATE INDEX idx_grocery_receipts_recorded_by ON grocery_receipts (recorded_by_user_id, account_id);
CREATE INDEX idx_grocery_receipts_date ON grocery_receipts (account_id, purchased_on DESC);
CREATE INDEX idx_grocery_receipt_lines_receipt ON grocery_receipt_lines (receipt_id, account_id);
CREATE INDEX idx_grocery_receipt_lines_account ON grocery_receipt_lines (account_id);
CREATE INDEX idx_grocery_receipt_lines_aisle_id ON grocery_receipt_lines (aisle_id);
CREATE INDEX idx_grocery_receipt_lines_product_id ON grocery_receipt_lines (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_grocery_list_items_receipt_line ON grocery_list_items (receipt_line_id, account_id) WHERE receipt_line_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Triggers et sécurité par ligne
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_grocery_product_references_package BEFORE INSERT OR UPDATE ON grocery_product_references
  FOR EACH ROW EXECUTE FUNCTION grocery_product_reference_package_before_write();
CREATE TRIGGER trg_grocery_shared_prices_before_update BEFORE UPDATE ON grocery_shared_prices
  FOR EACH ROW EXECUTE FUNCTION grocery_shared_price_before_update();
CREATE TRIGGER trg_grocery_price_sharing_events_before_insert BEFORE INSERT ON grocery_price_sharing_events
  FOR EACH ROW EXECUTE FUNCTION grocery_price_sharing_event_before_insert();
CREATE CONSTRAINT TRIGGER trg_meal_household_dishes_ingredient AFTER INSERT ON meal_household_dishes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_household_dish_needs_ingredient();
CREATE CONSTRAINT TRIGGER trg_meal_household_dish_ingredients_delete AFTER DELETE ON meal_household_dish_ingredients
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_household_dish_needs_ingredient();
CREATE CONSTRAINT TRIGGER trg_meal_season_dishes_content AFTER INSERT ON meal_season_dishes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_season_dish_needs_content();
CREATE CONSTRAINT TRIGGER trg_meal_season_dish_ingredients_delete AFTER DELETE ON meal_season_dish_ingredients
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_season_dish_needs_content();
CREATE CONSTRAINT TRIGGER trg_meal_season_dish_months_delete AFTER DELETE ON meal_season_dish_months
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_season_dish_needs_content();
CREATE CONSTRAINT TRIGGER trg_meal_menu_session_steps_check AFTER INSERT ON meal_menu_session_steps
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_session_steps_check();
CREATE CONSTRAINT TRIGGER trg_meal_menus_session_steps_check AFTER UPDATE OF batch_week_id ON meal_menus
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_session_steps_check();
CREATE CONSTRAINT TRIGGER trg_meal_menu_entries_ingredient AFTER INSERT OR UPDATE OF dish_origin ON meal_menu_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_entry_needs_ingredient();
CREATE CONSTRAINT TRIGGER trg_meal_menu_entry_ingredients_delete AFTER DELETE ON meal_menu_entry_ingredients
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_entry_needs_ingredient();
CREATE TRIGGER trg_meal_menu_entry_light_items_before_write BEFORE INSERT OR UPDATE ON meal_menu_entry_light_items
  FOR EACH ROW EXECUTE FUNCTION meal_menu_entry_light_item_before_write();
CREATE TRIGGER trg_grocery_lists_group_check BEFORE INSERT OR UPDATE OF group_id, scenario ON grocery_lists
  FOR EACH ROW EXECUTE FUNCTION grocery_list_group_check();
CREATE TRIGGER trg_grocery_lists_group_cleanup AFTER DELETE OR UPDATE OF group_id ON grocery_lists
  FOR EACH ROW EXECUTE FUNCTION grocery_list_group_cleanup();
CREATE TRIGGER trg_grocery_list_items_before_write BEFORE INSERT OR UPDATE ON grocery_list_items
  FOR EACH ROW EXECUTE FUNCTION grocery_list_item_before_write();
CREATE TRIGGER trg_grocery_receipt_lines_measure BEFORE INSERT OR UPDATE ON grocery_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION grocery_receipt_line_measure_before_write();
CREATE TRIGGER trg_grocery_household_settings_before_write BEFORE INSERT OR UPDATE ON grocery_household_settings
  FOR EACH ROW EXECUTE FUNCTION grocery_household_settings_before_write();
CREATE TRIGGER trg_grocery_household_settings_city AFTER INSERT OR UPDATE OF share_prices, city ON grocery_household_settings
  FOR EACH ROW EXECUTE FUNCTION grocery_sync_city_sharing();
CREATE TRIGGER trg_grocery_household_city_sharing_count AFTER INSERT OR DELETE ON grocery_household_city_sharing
  FOR EACH ROW EXECUTE FUNCTION grocery_city_counter_sync();
CREATE TRIGGER trg_grocery_household_city_sharing_move AFTER UPDATE OF city_key ON grocery_household_city_sharing
  FOR EACH ROW WHEN (OLD.city_key IS DISTINCT FROM NEW.city_key) EXECUTE FUNCTION grocery_city_counter_sync();
CREATE TRIGGER trg_grocery_product_references_referenced AFTER INSERT ON grocery_product_references
  FOR EACH ROW EXECUTE FUNCTION grocery_reference_marks_referenced();
CREATE TRIGGER trg_profile_agents_not_retired BEFORE INSERT OR UPDATE ON profile_agents
  FOR EACH ROW EXECUTE FUNCTION profile_agent_not_retired();
-- ---------------------------------------------------------------------
-- Sécurité par ligne des données du foyer (activée, non forcée ; variable de session app.user_id) : le couple a tout, l'invité secondaire lit la liste et
-- y ajoute un produit. La base commune des prix n'a aucune règle : un rôle limité n'y lit rien, la lecture passe par grocery_shared_prices_for().
-- ---------------------------------------------------------------------
ALTER TABLE grocery_household_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_household_settings_couple ON grocery_household_settings
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE grocery_household_cuisines ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_household_cuisines_couple ON grocery_household_cuisines
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE grocery_household_stores ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_household_stores_couple ON grocery_household_stores
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE grocery_household_dietary ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_household_dietary_couple ON grocery_household_dietary
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_household_dishes ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_household_dishes_couple ON meal_household_dishes
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_household_dish_ingredients ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_household_dish_ingredients_couple ON meal_household_dish_ingredients
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_household_dish_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_household_dish_tags_couple ON meal_household_dish_tags
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menus ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menus_couple ON meal_menus
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menu_entries_couple ON meal_menu_entries
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_entry_ingredients ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menu_entry_ingredients_couple ON meal_menu_entry_ingredients
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_entry_light_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menu_entry_light_items_couple ON meal_menu_entry_light_items
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_session_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menu_session_steps_couple ON meal_menu_session_steps
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_daily_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menu_daily_counters_couple ON meal_menu_daily_counters
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_season_household_dishes ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_season_household_dishes_couple ON meal_season_household_dishes
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_season_dishes ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_season_dish_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_season_dish_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_season_dish_tag_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_light_choices ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_light_choices_couple ON meal_light_choices
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE grocery_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_receipts_couple ON grocery_receipts
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE grocery_receipt_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_receipt_lines_couple ON grocery_receipt_lines
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
-- Liste de courses : le couple a tout ; l'invité secondaire lit, ajoute en son nom, augmente une quantité (garde-fou du trigger) et retire ses propres ajouts
ALTER TABLE grocery_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_lists_couple ON grocery_lists
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
CREATE POLICY grocery_lists_member_read ON grocery_lists FOR SELECT
  USING (account_id = (SELECT grocery_member_account()));
ALTER TABLE grocery_list_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_list_groups_couple ON grocery_list_groups
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
CREATE POLICY grocery_list_groups_member_read ON grocery_list_groups FOR SELECT
  USING (account_id = (SELECT grocery_member_account()));
ALTER TABLE grocery_list_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_list_items_couple ON grocery_list_items
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
CREATE POLICY grocery_list_items_member_read ON grocery_list_items FOR SELECT
  USING (account_id = (SELECT grocery_member_account()));
CREATE POLICY grocery_list_items_member_add ON grocery_list_items FOR INSERT
  WITH CHECK (account_id = (SELECT grocery_member_account()) AND added_by_user_id = (SELECT app_current_user_id()));
CREATE POLICY grocery_list_items_member_update ON grocery_list_items FOR UPDATE
  USING (account_id = (SELECT grocery_member_account())) WITH CHECK (account_id = (SELECT grocery_member_account()));
CREATE POLICY grocery_list_items_member_delete ON grocery_list_items FOR DELETE
  USING (account_id = (SELECT grocery_member_account()) AND added_by_user_id = (SELECT app_current_user_id()));
ALTER TABLE grocery_shared_prices ENABLE ROW LEVEL SECURITY;
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
INSERT INTO grocery_aisles (name, sort_order) VALUES
  ('Féculents', 1), ('Fruits et légumes', 2), ('Crémerie', 3), ('Épicerie du monde', 4), ('Épices et aromates', 5), ('Huiles et condiments', 6),
  ('Légumineuses', 7), ('Charcuterie', 8), ('Conserves et surgelés', 9), ('Épicerie sucrée', 10), ('Boucherie', 11), ('Poissonnerie', 12),
  ('Volaille', 13), ('Sauces tomate', 14), ('Boissons', 15), ('Entretien', 16), ('Soins du corps', 17), ('Petit-déjeuner', 18), ('Autres', 19);
UPDATE grocery_aisles SET is_fresh = true WHERE name IN ('Fruits et légumes', 'Crémerie', 'Boucherie', 'Poissonnerie', 'Volaille', 'Charcuterie');
-- Liste de départ (décision du PO, CR-67), rattachée aux rayons par leur nom ; clés calculées comme le fait l'application
INSERT INTO grocery_daily_products (name, name_key, aisle_id, position)
SELECT v.name, v.name_key, a.id, v.position
  FROM (VALUES ('Liquide vaisselle', 'liquide vaisselle', 'Entretien', 1), ('Éponges', 'eponges', 'Entretien', 2), ('Lessive', 'lessive', 'Entretien', 3), ('Sacs poubelle', 'sacs poubelle', 'Entretien', 4),
               ('Papier toilette', 'papier toilette', 'Entretien', 5), ('Essuie-tout', 'essuie tout', 'Entretien', 6),
               ('Brosse à dents', 'brosse a dents', 'Soins du corps', 1), ('Dentifrice', 'dentifrice', 'Soins du corps', 2), ('Gel douche', 'gel douche', 'Soins du corps', 3),
               ('Shampoing', 'shampoing', 'Soins du corps', 4), ('Déodorant', 'deodorant', 'Soins du corps', 5),
               ('Lait', 'lait', 'Crémerie', 1), ('Beurre', 'beurre', 'Crémerie', 2), ('Œufs', 'oeufs', 'Crémerie', 3), ('Yaourts', 'yaourts', 'Crémerie', 4)) AS v(name, name_key, aisle, position)
  JOIN grocery_aisles a ON a.name = v.aisle;
INSERT INTO legal_document_versions (document_type, version_label, content, published_at) VALUES
  ('grocery_price_sharing_consent', '1.0', 'Les prix de vos tickets sont ajoutés, sans votre nom, à une base commune. En échange, vous voyez les prix relevés par les autres foyers.', now());
-- L'Assistant Famille a une tuile fixe : il n'est jamais listé dans le catalogue
UPDATE agents SET listed_in_catalog = false WHERE platform = 'anthropic' AND platform_agent_ref = 'assistant-famille';
-- Agent natif « Courses et repas » (US-152, décision du PO du 07/11/2026) : appelé par l'API Anthropic directe comme l'Assistant Famille, rubrique Perso, listé dans le catalogue ; sa ligne est une donnée
-- de référence (les données du foyer se rattachent au compte, pas à l'agent). Les exemples de demandes se saisissent dans la console.
INSERT INTO agents (platform, platform_agent_ref, name, category_id, short_description, full_description, status) VALUES
  ('anthropic', 'courses-repas', 'Courses et repas', (SELECT id FROM agent_categories WHERE code = 'perso'),
   'Le menu de la semaine en 5 minutes, des courses sans oubli, une séance de batch cooking de 2 h au plus et vos prix comparés.',
   '1. Penser aux courses une seule fois par semaine.
2. Utiliser vos propres recettes, ou en recevoir d''autres.
3. Établir le menu de la semaine et les recettes en 5 minutes.
4. Faire les courses sans oubli grâce à l''historique, en 5 minutes.
5. Préparer les repas de la semaine en 2 heures au plus.
6. Réduire les achats à emporter et en livraison.
7. Des références et des substituts sans ingrédients nocifs.
8. Comparer les prix aux prix de référence et à ceux des foyers proches.
9. Suivre l''évolution du budget courses et repas.
10. Comparer votre stratégie d''achat.

Réglages, listes et menus partagés par le foyer.
Partagez vos prix pour voir ceux des foyers proches.', 'available');
-- Réglages de la console (US-65) : plafond de séance, répétition, seuils de correspondance, ancienneté des prix, ville affichée, seuils « à vérifier »
-- (en centimes pour les bornes absolues), durées de conservation
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('meal_session_cap_minutes',          'integer', '120',   30, 600,      $$Plafond de la séance de batch cooking du dimanche, en minutes ; avec l'objectif « temps », seules les semaines sous ce plafond sont retenues, sinon l'alerte « Séance au-dessus de 2 h » (US-156 RF5, RT3)$$),
  ('grocery_history_min_products',      'integer', '10',    1,  50,       $$Nombre minimum de produits de la rubrique « Produits de mon historique » : en dessous, elle est complétée par les produits du quotidien de la console (US-157 RF3ter, CR-66)$$),
  ('meal_season_dishes_count',          'integer', '10',    1,  100,      $$Nombre de plats de saison demandés pour le menu du mois (US-178 RF2, CR-60)$$),
  ('meal_season_dishes_max',            'integer', '44',    1,  200,      $$Nombre maximum de plats de saison retenus pour le foyer quand ses plats ne suffisent pas à remplir les quatre semaines (US-178 RF2, CR-62)$$),
  ('meal_menu_daily_cap',               'integer', '10',    1,  100,      $$Nombre maximum de menus complets composés par un foyer et par jour, corrections comprises ; au-delà, l'agent invite à reprendre le lendemain (US-156 RF12ter, CR-44)$$),
  ('meal_repeat_weeks_default',         'integer', '2',     1,  4,        $$Nombre de semaines avant qu'un plat revienne, par défaut, pour les foyers qui n'ont pas choisi (US-153 RF2, US-156 RT3)$$),
  ('meal_match_sure_pct',               'integer', '80',    1,  100,      $$Pourcentage de correspondance à partir duquel un plat de planning est « sûr » (US-171 RF1)$$),
  ('meal_match_check_pct',              'integer', '40',    1,  99,       $$Pourcentage de correspondance à partir duquel un plat de planning est « à confirmer » ; en dessous il est « absent » et bloque sa semaine (US-171 RF1)$$),
  ('grocery_price_fresh_months',        'integer', '6',     1,  36,       $$Âge en mois jusqu'auquel un prix s'affiche « < 6 mois » (US-166 RF3, CR-20)$$),
  ('grocery_price_max_months',          'integer', '12',    1,  60,       $$Âge en mois au-delà duquel un prix n'est plus affiché (« < 12 mois » jusque-là) (US-166 RF3, CR-20)$$),
  ('grocery_city_min_households',       'integer', '2',     2,  100,      $$Nombre de foyers qui partagent leurs prix dans une ville à partir duquel la ville est affichée aux autres foyers ; ne descend pas sous 2 (US-154 RT2, CR-17)$$),
  ('grocery_check_low_pct',             'integer', '50',    1,  100,      $$Un prix partagé est « à vérifier » en dessous de ce pourcentage de la médiane (ou du prix de référence) (US-175 RF2, CR-33)$$),
  ('grocery_check_high_pct',            'integer', '200',   100, 10000,   $$Un prix partagé est « à vérifier » au-dessus de ce pourcentage de la médiane (ou du prix de référence) (US-175 RF2, CR-33)$$),
  ('grocery_check_floor_cents',         'integer', '5',     0,  100000,   $$Sans médiane ni prix de référence, un prix partagé est « à vérifier » en dessous de ce montant, en centimes (0,05 €) (US-175 RF2, CR-33)$$),
  ('grocery_check_ceiling_cents',       'integer', '50000', 1,  10000000, $$Sans médiane ni prix de référence, un prix partagé est « à vérifier » au-dessus de ce montant, en centimes (500 €) (US-175 RF2, CR-33)$$),
  ('grocery_check_min_samples',         'integer', '3',     1,  100,      $$Nombre d'autres valeurs du même produit dans la même enseigne nécessaires pour utiliser la médiane comme base du contrôle (US-175 RF2, CR-33)$$),
  ('grocery_check_window_months',       'integer', '12',    1,  36,       $$Fenêtre, en mois, des valeurs retenues pour la médiane du contrôle des prix partagés ; au-delà, les lignes de la base commune sont supprimées par la purge quotidienne (US-175 RF2, CR-33, CR-35)$$),
  ('meal_menu_retention_months',        'integer', '12',    1,  60,       $$Conservation des menus validés d'un foyer, en mois ; à confirmer par le DPO (CR-23, CR-26)$$),
  ('grocery_receipt_retention_years',   'integer', '3',     1,  10,       $$Conservation des tickets, de leurs lignes et du budget, en années civiles (l'année en cours et les précédentes : 3 = l'année en cours et deux précédentes) ; à confirmer par le DPO (CR-23, CR-26)$$),
  ('grocery_bought_retention_months',   'integer', '3',     1,  24,       $$Conservation des produits achetés de la liste de courses (« Produits de mon historique »), en mois ; à confirmer par le DPO (US-157 RF3, CR-23, CR-26)$$),
  ('grocery_unreferenced_retention_months', 'integer', '12', 1, 60,       $$Conservation du journal des produits à référencer, en mois ; à confirmer par le DPO (US-173, CR-23, CR-26)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON COLUMN agents.status IS $$available = utilisable ; blocked = maintenance, MAAQ refuse toute nouvelle demande vers cet agent (US-42 RT1) ; retired = retiré du catalogue et des tableaux de bord, réversible (CR-34)$$;
COMMENT ON COLUMN agents.listed_in_catalog IS $$Vrai = l'agent est proposé dans le catalogue (rubriques Pro et Perso) ; faux = agent à tuile fixe, jamais listé (Assistant Famille). Remplace le filtre sur la plateforme, qui ne distingue pas un agent natif à tuile fixe d'un agent natif du catalogue (Courses et repas). Vrai par défaut. [US-22, 23, 106, décision du PO du 07/11/2026]$$;
COMMENT ON COLUMN agents.retired_at IS $$Date du retrait de l'agent du catalogue ; renseignée si et seulement si le statut est « retired ». Un agent retiré est invisible du catalogue et des tableaux de bord, et se rétablit sans perte. [CR-34]$$;
COMMENT ON FUNCTION grocery_norm(text) IS $$Clé normalisée d'un texte : minuscules, espaces de début et de fin retirés, espaces multiples réduits à un. Sert de clé d'unicité aux produits, enseignes, villes et références ; la normalisation fine (accents, pluriels) est celle de l'application. [CR-25]$$;
COMMENT ON FUNCTION grocery_setting_int(text, integer) IS $$Valeur entière d'un réglage de la console (platform_settings), ou la valeur par défaut donnée si le réglage n'existe pas. Sert aux règles de Courses et repas. [US-153, US-175]$$;
COMMENT ON FUNCTION grocery_access(uuid) IS $$Droit d'un profil sur l'agent Courses et repas : couple (utilisateur principal et invité 1 : tout), list (invité secondaire : consulter la liste et y ajouter un produit), NULL (administrateur, profil retiré ou inconnu). [US-155 RF5, CR-10]$$;
COMMENT ON FUNCTION grocery_couple_account() IS $$Famille du profil indiqué par l'application (app.user_id) s'il fait partie du couple ; NULL sinon. Sert aux règles de sécurité par ligne des données du foyer. [CR-10]$$;
COMMENT ON FUNCTION grocery_member_account() IS $$Famille du profil indiqué par l'application (app.user_id) s'il est du couple ou invité secondaire ; NULL sinon. Sert aux règles de sécurité par ligne de la liste de courses. [CR-10]$$;
COMMENT ON FUNCTION grocery_price_age(date) IS $$Ancienneté d'un prix à partir de sa date : fresh (« < 6 mois »), aging (« < 12 mois »), NULL au-delà de 12 mois (le prix n'est plus affiché). Les deux durées sont des réglages de la console. [US-166 RF3, CR-20]$$;
COMMENT ON FUNCTION meal_match_status(smallint, bigint) IS $$Statut de la correspondance d'un plat de planning : sure (plat du catalogue identifié, ou pourcentage au moins égal au seuil « sûr », 80 par défaut), to_confirm (au moins le seuil « à confirmer », 40 par défaut), absent (en dessous : la semaine est bloquée). [US-171 RF1]$$;
COMMENT ON TABLE meal_cuisines IS $$Cuisines du catalogue (Afro, Français, Italien…), gérées dans la console : ordre d'affichage, masquage. Une cuisine utilisée par un plat ne se supprime pas, elle se masque. Une nouvelle cuisine est aussitôt choisissable dans les réglages des foyers. [US-165 RF1, RF2]$$;
COMMENT ON TABLE meal_dish_categories IS $$Catégories des plats (salades, soupes, viandes, végétarien…), gérées dans la console. Une catégorie utilisée ne se supprime pas, elle se masque : les plats sont classés par des données, pas devinés à partir de leur nom. [US-165 RF1, RF2]$$;
COMMENT ON TABLE meal_dish_tags IS $$Étiquettes des plats, gérées dans la console : régimes (« végétarien », « sans gluten »), viandes (« viande : poulet ») et allergènes (« contient du gluten »). Le filtrage des régimes et des allergies d'un foyer s'appuie sur elles, non sur des mots-clés codés en dur. Une étiquette utilisée ne se supprime pas, elle se masque. [US-164 RF1, CR-30]$$;
COMMENT ON COLUMN meal_dish_tags.kind IS $$diet = régime que le plat respecte ; meat = viande ou poisson que le plat contient ; allergen = allergène que le plat contient. [CR-30]$$;
COMMENT ON COLUMN grocery_aisles.is_fresh IS $$Rayon frais (Fruits et légumes, Crémerie, Boucherie, Poissonnerie, Volaille, Charcuterie au départ), réglable dans la console. Dans la liste du mois, les produits d'un rayon frais des semaines après la première sont « À acheter plus tard », décochés et hors total ; ce marquage se lit à la lecture. Un produit sans rayon n'est pas frais. [US-169 RF2bis, US-157 RF9ter, CR-56]$$;
COMMENT ON TABLE grocery_aisles IS $$Rayons de magasin, communs à tous les foyers : tickets, liste de courses et budget sont rangés de la même façon. Un rayon utilisé ne se supprime pas : il se renomme ou se fusionne avec un autre (merge_grocery_aisles). [US-169]$$;
COMMENT ON COLUMN grocery_products.is_pantry IS $$Produit « placard » (sel, poivre, huiles, vinaigres, épices, herbes séchées, bouillons en cube, sucre, farine, levure, moutarde…) : dans la liste de courses il est décoché par défaut avec « Vous en avez peut-être déjà » et ne compte dans le total que s'il est coché. Réglé produit par produit dans la console (US-166) ; une quantité en cuillère ou en pincée rend aussi un ingrédient « placard », quelle que soit cette valeur. [CR-50, CR-51]$$;
COMMENT ON TABLE grocery_products IS $$Produit du catalogue commun (lait, riz basmati…) : nom, clé normalisée unique, rayon. Les ingrédients des plats, les références par enseigne, les prix partagés et le calendrier de saison s'y rattachent. [US-166 RF1]$$;
COMMENT ON COLUMN grocery_products.name_key IS $$Nom normalisé du produit (minuscules, espaces simples) : clé d'unicité, calculée par l'application. Un produit sans ligne ici est « inconnu » (produits à référencer). [CR-25, US-173 RF1]$$;
COMMENT ON TABLE grocery_product_references IS $$Référence d'un produit dans une enseigne : nom, prix unitaire (paquet, boîte) et date du prix facultatifs (les deux ou aucun : sans prix connu, « N/A »), additifs contenus, statut de conformité déclaré, résumé de composition. Le prix perd son affichage après 12 mois. La conformité finale se calcule (v_grocery_product_references), elle n'est pas stockée : une modification des critères la recalcule d'elle-même. [US-157 RF8, US-166 RF1, RF3, US-167 RF2, CR-36, CR-37]$$;
COMMENT ON COLUMN grocery_product_references.package_format IS $$Format du conditionnement de la référence (« 1 kg », « sachet de 250 g »), 80 caractères au plus, facultatif ; colonne « format » du fichier d'import des références. Visible de tous les profils du foyer, sans prix. [US-166 RF2, US-157 RF7]$$;
COMMENT ON COLUMN grocery_product_references.package_amount IS $$Quantité du format en kilogrammes ou en litres (« 500 g » = 0,5 kg, « 75 cl » = 0,75 l, « 6 x 33 cl » = 1,98 l), vide quand le format n'est pas compris (« 6 œufs », « la pièce »). Déduite de package_format à l'écriture (grocery_parse_package) ; si l'import la fournit avec package_unit, elle prime. Aucun poids moyen par pièce n'est jamais supposé. [CR-39]$$;
COMMENT ON COLUMN grocery_product_references.package_unit IS $$Unité de package_amount : kg ou l (les grammes et les centilitres sont convertis). Vide en même temps que la quantité. [CR-39]$$;
COMMENT ON COLUMN grocery_product_references.price_unit IS $$Unité dans laquelle unit_price est exprimé : unit = par article (défaut, un paquet, une boîte), kg ou l = par kilo ou par litre (produit vendu au poids ou en vrac). Un article au kilo n'entre pas dans le total estimé de la liste. [CR-39, CR-40]$$;
COMMENT ON COLUMN grocery_product_references.unit_price IS $$Prix unitaire de la référence ; vide = prix inconnu (« N/A », jamais un prix inventé). Vide en même temps que la date du prix. [US-157 RF8, CR-36]$$;
COMMENT ON COLUMN grocery_product_references.compliance_status IS $$Statut du catalogue d'origine : compliant = conforme, not_applicable = sans objet (produit frais), to_check = à vérifier (ingrédients non publiés : proposée avec « Composition à vérifier sur l'étiquette »), none_found = aucun conforme trouvé (jamais proposée, listée dans « Ingrédients exclus des références proposées »). Une liste d'additifs qui correspond à un critère actif rend la référence non conforme quel que soit ce statut. [US-166, US-167, CR-37]$$;
COMMENT ON COLUMN grocery_product_references.composition_text IS $$Résumé de la composition en texte libre (2 000 caractères au plus), tel que donné par le catalogue d'origine ; facultatif. [CR-37]$$;
COMMENT ON COLUMN grocery_product_references.additives IS $$Additifs de la référence (codes comme E250 ou noms), normalisés par l'application ; comparés aux critères actifs de grocery_additive_criteria$$;
COMMENT ON FUNCTION grocery_parse_package(text) IS $$Lit un format de conditionnement et rend sa quantité en kg ou en litres : « 1 kg », « 500 g », « 1,5 l », « 75 cl », « sachet de 250 g », « 6 x 33 cl » (= 1,98 l). Rend des valeurs vides quand le format n'est pas compris (« 6 œufs », « 1 pièce », « barquette ») : rien n'est deviné, aucun poids moyen par pièce. [CR-39]$$;
COMMENT ON FUNCTION grocery_product_reference_package_before_write() IS $$Remplit package_amount et package_unit d'après package_format quand ils ne sont pas fournis. Un changement de format seul refait la déduction si les valeurs actuelles étaient celles du format précédent ; des valeurs fournies par l'import (différentes de la déduction) ne sont pas écrasées. [CR-39]$$;
COMMENT ON TABLE grocery_daily_products IS $$Produits du quotidien tenus en console (liquide vaisselle, éponges, lessive, brosse à dents, lait, beurre…), par rayon : ils complètent « Produits de mon historique » sous le titre « Pensez aussi à : » quand la rubrique compte moins de produits que le seuil de la console (grocery_history_min_products), décochés par défaut, sans ceux déjà dans l'historique, le menu ou les produits ajoutés. Commune à tous les foyers, sans donnée de foyer, lisible par tous les profils, écrite par la console seulement (journal d'administration : daily_product_changed). Nom et clé normalisée uniques ; retirer un produit le masque sans le supprimer. [US-157 RF3ter, US-169 RF3, CR-66, CR-67]$$;
COMMENT ON COLUMN grocery_daily_products.name_key IS $$Nom normalisé calculé par l'application, comme grocery_products.name_key (minuscules, « œ » en « oe », accents retirés, suites d'espaces et de tirets réduites à un espace, bords retirés ; les pluriels ne sont pas touchés) : sert au rapprochement par le nom quand le produit n'est pas lié au catalogue. La base garde la clé et son unicité. [US-157 RT2bis, CR-66]$$;
COMMENT ON COLUMN grocery_daily_products.product_id IS $$Produit du catalogue correspondant, facultatif : quand il est renseigné, l'application reconnaît le produit du quotidien dans l'historique, le menu et les produits ajoutés par ce produit, sinon par name_key. Repasse à vide si le produit est supprimé. [US-157 RT2bis, CR-66]$$;
COMMENT ON COLUMN grocery_daily_products.position IS $$Ordre d'affichage dans le rayon, à partir de 1. [US-169 RF3, CR-66]$$;
COMMENT ON COLUMN grocery_daily_products.retired_at IS $$Date à laquelle la console a retiré le produit (il n'est plus proposé) ; vide = actif. [US-169 RF3, CR-66]$$;
COMMENT ON TABLE grocery_additive_criteria IS $$Additifs à éviter (code ou nom, raison courte). Affichés aux foyers dans « Critères additifs appliqués » ; une référence qui en contient un actif n'est pas proposée et figure dans « Ingrédients exclus des références proposées ». [US-167 RF1, RF2]$$;
COMMENT ON TABLE grocery_product_seasons IS $$Mois de saison d'un fruit ou d'un légume. Avec l'objectif « saison », les plats dont les ingrédients sont de saison passent devant. [US-168 RF1, RF2]$$;
COMMENT ON TABLE meal_dishes IS $$Plat du catalogue commun (60 au départ, chargés depuis le classeur actuel) : identifiant, nom, cuisine, recette, durée, durée active en batch. Les catégories, étiquettes (régimes, viandes, allergènes) et ingrédients sont dans des tables de liens. Un plat retiré n'est plus proposé mais reste dans les menus déjà validés. Les plats personnels d'un foyer sont à part (meal_household_dishes). [US-164 RF1, RF3, CR-04]$$;
COMMENT ON COLUMN meal_dishes.is_express IS $$Calculé : durée de 15 minutes au plus (plat express). La console en donne le nombre. [US-156 RF4, US-164 RF4]$$;
COMMENT ON COLUMN meal_dishes.retired_at IS $$Date de retrait : le plat n'est plus proposé aux foyers ; les menus déjà validés le gardent (nom conservé). NULL = proposé. [US-164 RF3, CR-25]$$;
COMMENT ON TABLE meal_dish_category_links IS $$Catégories d'un plat du catalogue (un plat peut en avoir plusieurs). [US-164 RF1, US-165]$$;
COMMENT ON TABLE meal_dish_tag_links IS $$Étiquettes d'un plat du catalogue : régimes respectés, viandes et allergènes contenus. Le filtrage des régimes et des allergies du foyer s'appuie dessus. [US-164 RF1, CR-30]$$;
COMMENT ON TABLE meal_dish_ingredients IS $$Ingrédients d'un plat du catalogue, en produits du catalogue. Aucune quantité par ingrédient : la recette reste un texte. [US-164 RF1, CR-25]$$;
COMMENT ON TABLE meal_batch_weeks IS $$Semaine type de batch cooking (AS5…) : cuisine, thème facultatif, déroulé et durée de la séance du dimanche, part d'ingrédients mis en commun. Les 12 semaines actuelles sont conservées au premier import. Une semaine n'est utilisable que si aucun de ses plats n'est « absent » du catalogue (v_meal_batch_weeks). [US-170 RF1, RF3, RF4]$$;
COMMENT ON TABLE meal_batch_week_days IS $$Plat de chaque jour (lundi à vendredi) d'une semaine type : nom du planning, plat du catalogue confirmé, plat suggéré et pourcentage de correspondance. Le statut (sûr / à confirmer / absent) se déduit du pourcentage et des seuils de la console (meal_match_status). Une correspondance confirmée vaut 100 %. [US-170 RF1, US-171 RF1, RF5, RT1]$$;
COMMENT ON COLUMN meal_batch_week_days.match_pct IS $$Pourcentage de correspondance avec le catalogue, calculé par l'application à l'import (100 si l'identifiant du plat est renseigné ou confirmé). Le statut se déduit des seuils de la console : 80 % et plus sûr, 40 % à moins de 80 % à confirmer, en dessous absent (bloque la semaine). [US-171 RF1]$$;
COMMENT ON TABLE meal_light_versions IS $$Version allégée d'un plat du catalogue : texte affiché aux foyers. Sans produit à retirer ni à ajouter (meal_light_version_items), il n'y a pas d'adaptation automatique de la liste : le texte reste un conseil de préparation. [US-172 RF1, RF2]$$;
COMMENT ON TABLE meal_light_version_items IS $$Produits à retirer (du catalogue) et à ajouter (du catalogue, ou nom d'un produit pas encore référencé) pour passer un plat à sa version allégée. Un produit commun à deux plats n'est retiré que si tous les plats qui l'utilisent sont allégés (calculé par l'application). [US-172 RF1, RF4, US-157 RF5]$$;
COMMENT ON TABLE grocery_unreferenced_events IS $$Journal ANONYME des produits utilisés par les foyers sans référence conforme (ajoutés à la liste, issus d'un menu validé ou lus sur un ticket) : aucune colonne ne désigne un foyer ou un profil. La ville, la référence vue, le prix vu et le magasin ne sont renseignés que pour un foyer qui partage ses prix. Conservé 12 mois (réglable), purgé par purge_expired_grocery_data(). [US-173 RF1, RF3, CR-23]$$;
COMMENT ON COLUMN grocery_unreferenced_events.kind IS $$unknown = absent du catalogue ; no_reference = présent mais sans référence conforme. [US-173 RF1]$$;
COMMENT ON TABLE grocery_unreferenced_status IS $$Statut d'un produit à référencer, par nom normalisé : à référencer (défaut), référencé (sort de la liste des foyers) ou rejeté. Passé à « référencé » d'office quand une référence est importée pour le produit. [US-173 RF2, RF5, US-174 RF2]$$;
COMMENT ON TABLE grocery_shared_prices IS $$Base commune des prix partagés par les foyers qui l'ont accepté : produit, référence, prix unitaire, enseigne, ville du magasin, semaine. ANONYME PAR CONSTRUCTION : aucune colonne foyer, profil ou jour, aucun moyen de retrouver qui a partagé. Une seule porte d'écriture, share_grocery_price() ; la lecture par un foyer passe par grocery_shared_prices_for() (réciprocité, enseignes de proximité, ville affichée dès 2 foyers). Les lignes déjà partagées restent quand le partage est désactivé. [US-154, US-175, CR-03, CR-12, CR-17]$$;
COMMENT ON COLUMN grocery_shared_prices.price_unit IS $$Unité de unit_price : unit = par article (défaut), kg ou l = par kilo ou par litre (ligne de ticket pesée). Seul le prix au kilo est partagé, jamais le poids du ticket. Les comparaisons et la médiane de contrôle ne rapprochent que des prix de même unité. [CR-39]$$;
COMMENT ON COLUMN grocery_shared_prices.week_start IS $$Lundi de la semaine du relevé (jamais le jour du ticket) ; remis à la semaine la plus récente quand une ligne identique est partagée de nouveau. [CR-17, US-154 RT1]$$;
COMMENT ON COLUMN grocery_shared_prices.removed_at IS $$Retirée par l'administrateur (prix erroné) : la ligne n'est plus utilisée dans les comparatifs ni dans la médiane de contrôle. [US-175 RF3]$$;
COMMENT ON TABLE grocery_city_sharing IS $$Nombre de foyers qui partagent leurs prix, par ville : une ville n'est affichée aux autres foyers qu'à partir de 2 foyers (réglage grocery_city_min_households). Le foyer qui consulte compte parmi les deux, dans sa propre ville (déjà comptée ici) comme dans une ville voisine (ajouté à la lecture, CR-35) ; un foyer ne sort du compteur qu'à la suppression de son compte, pas à la désactivation du partage. Tenu par trigger, sans identifiant de foyer. [US-154 RT2, CR-17, CR-22, CR-35]$$;
COMMENT ON TABLE grocery_price_sharing_events IS $$Journal append-only des activations et désactivations du partage anonyme des prix (qui, quand, quelle version du texte accepté). Survit au compte, comme les consentements aux contrats ; durée de conservation à valider par le DPO. Le réglage share_prices ne change qu'après l'inscription de l'événement correspondant. [US-154 RF4bis, CR-24]$$;
COMMENT ON COLUMN grocery_price_sharing_events.account_id IS $$Identifiant du compte, SANS clé étrangère : référence conservée après suppression du compte$$;
COMMENT ON COLUMN grocery_price_sharing_events.actor_email_hash IS $$Empreinte HMAC-SHA256 de l'email de la personne qui a activé ou désactivé le partage (clé hors base) : preuve nominative sans conserver l'email$$;
COMMENT ON TABLE grocery_household_settings IS $$Réglages Courses et repas du foyer, communs au couple (un invité secondaire ne les voit pas) : ville, nombre de personnes, jours de courses, objectifs cumulables (temps, mes plats, saison), répétition, source des remplacements, jour du budget, partage anonyme des prix (désactivé par défaut). Les allergies et les régimes sont à part, chiffrés (grocery_household_dietary). [US-153 RF2, RF5, US-154 RF1, CR-01, CR-10]$$;
COMMENT ON COLUMN grocery_household_settings.repeat_weeks IS $$Un plat n'est pas servi avant N semaines (1 à 4) ; vide = valeur par défaut de la console (meal_repeat_weeks_default, 2). [US-153 RF2, US-156 RF9, RT3]$$;
COMMENT ON COLUMN grocery_household_settings.monthly_meal_budget IS $$Budget mensuel des repas du foyer, en euros (de 1 à 99 999), hors restaurant, boissons et réceptions. Sert au menu du mois dans le budget ; vide tant que le foyer ne l'a pas renseigné. [US-153, US-178, CR-59]$$;
COMMENT ON COLUMN grocery_household_settings.share_prices IS $$Partage anonyme des prix de nos tickets avec les autres foyers (réciproque) ; désactivé par défaut. Ne passe à vrai qu'après l'inscription de la preuve de consentement, avec une ville renseignée. Le désactiver arrête les envois suivants sans retirer les lignes déjà partagées. [US-154 RF1 à RF5, CR-12, CR-24]$$;
COMMENT ON COLUMN grocery_household_settings.shopping_days IS $$Jours de courses (jours ISO, 1 = lundi), au moins un, sans doublon$$;
COMMENT ON TABLE grocery_household_cuisines IS $$Cuisines préférées du foyer, parmi celles du catalogue ; aucune ligne = toutes. [US-153 RF2]$$;
COMMENT ON TABLE grocery_household_stores IS $$Enseignes de proximité gardées par le foyer, chacune avec sa ville (« Lidl — Rezé ») : proposées d'après la ville du foyer par une recherche web (seuls la ville et le type de commerce partent), gardées ou retirées par le foyer. Servent au comparatif et à la lecture des prix des autres foyers. [US-153 RF3, US-154 RF3, CR-09, CR-21]$$;
COMMENT ON TABLE grocery_household_dietary IS $$Régimes et allergies du foyer : donnée de santé, CHIFFRÉE par l'application, lue par l'application seule : elle les déchiffre pour filtrer les plats connus (filtrage indicatif) et, depuis CR-43, les envoie à l'IA pour composer le menu, sans nom ni prénom (accord du DPO à obtenir avant la production). Aucune vue ni fonction de la base ne les lit. Réservée au couple. [US-153 RF2, RF4, RT2, US-156 RT2, CR-16, CR-43]$$;
COMMENT ON TABLE grocery_household_city_sharing IS $$Inscription du foyer au compteur de sa ville, posée la première fois qu'il active le partage des prix (et déplacée s'il change de ville en partageant). Conservée quand le partage est désactivé ; supprimée avec le compte, ce qui fait baisser le compteur. Sert uniquement à tenir grocery_city_sharing ; jamais lue par une vue ni exposée. [CR-17, CR-22]$$;
COMMENT ON TABLE meal_household_dishes IS $$Plat personnel du foyer : nom, cuisine, ingrédients (au moins un), durée et recette facultatives. Propre au foyer : ni validation par l'administrateur, ni entrée dans le catalogue commun, jamais proposé à un autre foyer. Peut porter le nom d'un plat du catalogue. Modifiable et supprimable par le couple. [US-159 RF1, RF3 à RF5, CR-04, CR-25]$$;
COMMENT ON TABLE meal_household_dish_ingredients IS $$Ingrédients d'un plat personnel : nom saisi, clé normalisée, produit du catalogue s'il est reconnu. Aucune quantité par ingrédient. Un plat personnel a au moins un ingrédient (contrôlé à la validation de la transaction). [US-159 RF1, CR-25]$$;
COMMENT ON TABLE meal_household_dish_tags IS $$Étiquettes (régimes, viandes, allergènes) d'un plat personnel, pour que le filtrage des régimes et des allergies du foyer s'applique aussi à ses plats. [US-159, CR-30]$$;
COMMENT ON TABLE meal_season_dishes IS $$Plat de saison obtenu de l'IA pour le menu du mois, dans la base COMMUNE et ANONYME partagée par tous les foyers : nom (clé normalisée unique : sans doublon, le premier est gardé), cuisine, nombre de personnes des quantités, recette, durée, nombre de foyers qui l'ont choisi, lundi de la semaine d'entrée, état masqué par l'administrateur. Aucun foyer, aucun profil, aucun prix. Distincte du catalogue commun des plats (CR-04) : aucune clé vers meal_dishes. Ne s'efface pas en fin de mois ni avec un compte ; conservation sans limite pour l'instant (à soumettre au DPO avec CR-43). Écrite par share_season_dish() seulement. [US-178 RF2, RF2bis, CR-60, CR-61, CR-62]$$;
COMMENT ON COLUMN meal_season_dishes.servings IS $$Nombre de personnes pour lequel les quantités des ingrédients sont écrites ; l'application met à l'échelle le foyer. [CR-61]$$;
COMMENT ON COLUMN meal_season_dishes.chosen_count IS $$Nombre de foyers qui ont choisi ce plat dans un menu validé : une fois par foyer et par plat (choose_season_dish, vérifié par les lignes de menu du foyer), sans rien garder du foyer. Ne redescend pas après une suppression ou une purge de menu. Les plus choisis sont proposés en premier. [CR-61, CR-62]$$;
COMMENT ON COLUMN meal_season_dishes.entered_week IS $$Lundi de la semaine d'entrée du plat dans la base (jamais le jour : un jour précis, rapproché d'un foyer, permettrait de deviner qui l'a obtenu). [CR-61]$$;
COMMENT ON COLUMN meal_season_dishes.hidden_at IS $$Date à laquelle l'administrateur a masqué le plat (il n'est plus proposé) ; vide = visible. [CR-61]$$;
COMMENT ON TABLE meal_season_dish_ingredients IS $$Ingrédients d'un plat de saison de la base commune, avec leur quantité et leur unité pour le nombre de personnes du plat (mêmes unités que les ingrédients de menu, ramenées en g, ml ou pièce). Un plat a au moins un ingrédient (contrôlé à la validation de la transaction). Anonyme : aucun foyer. [US-178 RF2, RF2bis, CR-50, CR-61]$$;
COMMENT ON TABLE meal_season_dish_months IS $$Mois de saison d'un plat de la base commune (un à douze, donnés par l'IA, corrigeables dans la console). La recherche des plats du mois cherche le mois en cours dans cette liste. Un plat a au moins un mois. [US-178 RF2bis, CR-61]$$;
COMMENT ON TABLE meal_season_dish_tag_links IS $$Étiquettes (régimes, viandes, allergènes) d'un plat de la base commune, prises dans la liste de la console (meal_dish_tags, CR-30), corrigeables par l'administrateur. [US-178 RF2bis, CR-30, CR-61]$$;
COMMENT ON TABLE meal_season_household_dishes IS $$Sélection du foyer pour son menu du mois : les plats de saison de la base commune qu'il garde jusqu'à la fin du mois (10, jusqu'à 44 si ses plats ne suffisent pas, contrôle par l'application). Réservée au couple ; effacée une fois le mois passé (purge, heure du foyer) et avec le compte ; ne touche jamais la base commune. [US-178 RF2, RF2bis, CR-60, CR-62]$$;
COMMENT ON COLUMN meal_season_household_dishes.season_month IS $$Premier jour du mois civil de la sélection, calculé par l'application à l'heure du foyer. [CR-60]$$;
COMMENT ON FUNCTION meal_season_dish_needs_content() IS $$Contrôle différé : un plat de saison de la base commune a au moins un ingrédient et au moins un mois de saison à la fin de la transaction. [CR-61]$$;
COMMENT ON TABLE meal_menus IS $$Menu validé d'un foyer pour une semaine (le menu proposé n'est pas gardé tant qu'il n'est pas validé) : semaine type utilisée, durée de la séance du dimanche, indication « estimée » ou « au-dessus du plafond ». Une validation par semaine. Conservé 12 mois (réglable), purgé par purge_expired_grocery_data(). [US-156 RF5, RF6, RF12, CR-23]$$;
COMMENT ON COLUMN meal_menus.servings IS $$Nombre de personnes pour lequel l'IA a écrit les recettes et les quantités du menu (« Pour 6 personnes »), gardé avec le menu : le foyer peut changer ensuite. Vide pour un menu validé avant CR-49. [US-156 RF11, CR-49]$$;
COMMENT ON COLUMN meal_menus.session_is_estimated IS $$Vrai si aucune semaine type n'était adaptée : la durée est estimée (le plat le plus long, plus 40 % des autres) et signalée comme telle. [US-156 RF6]$$;
COMMENT ON TABLE meal_menu_entries IS $$Plats d'un menu validé : 7 dîners et plats express (le type « plaisir » n'est plus utilisé depuis CR-42). Chaque ligne garde le nom du plat tel qu'il était et son origine : catalogue, Mes plats ou plat libre composé par l'IA. Un plat libre garde dans la ligne sa cuisine, sa recette et sa durée, et ses ingrédients dans meal_menu_entry_ingredients : il n'entre jamais dans le catalogue commun (CR-04) et part avec le menu (12 mois). Après la validation, un plat (libre ou du catalogue) ajouté à Mes plats y est copié et la ligne en garde le lien (household_dish_id). La ligne peut porter une version allégée proposée par l'IA (texte, adaptation dans meal_menu_entry_light_items, choix du foyer). Un plat retiré ou supprimé ensuite reste lisible dans les menus déjà validés. Un menu remplacé par un autre de la même semaine garde son identifiant et voit ses lignes remplacées. [US-156 RF3 à RF10, RT4, CR-25, CR-42, CR-45]$$;
COMMENT ON COLUMN meal_menu_entries.dish_origin IS $$Origine du plat : catalog (plat du catalogue commun), household (plat de Mes plats) ou ai (plat libre composé par l'IA avec le foyer, avec ses ingrédients, jamais dans le catalogue). Renseignée par l'application, sans valeur par défaut ; les menus déjà validés avant CR-42 ont reçu household s'ils pointaient vers un plat personnel, sinon catalog. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.household_dish_id IS $$Plat de Mes plats : le plat choisi (origine household) ou, après « Ajouter à vos plats », la copie faite dans Mes plats d'un plat libre ou du catalogue (la ligne garde son contenu). Vide si le foyer a supprimé ce plat ensuite. [US-156 RF10, CR-42, CR-45]$$;
COMMENT ON COLUMN meal_menu_entries.season_dish_id IS $$Plat de la base commune des plats de saison d'où vient ce plat libre (origine ai), quand il a été choisi parmi eux (CR-61) ; repasse à vide si le plat est supprimé de la base. Sert à n'écarter ni ne compter deux fois un plat déjà présent dans les menus du foyer : le compteur de la base commune ne monte qu'une fois par foyer et par plat. [US-178 RF2bis, CR-61, CR-62]$$;
COMMENT ON COLUMN meal_menu_entries.cuisine_id IS $$Cuisine d'un plat libre (origine ai, obligatoire) ; vide pour un plat du catalogue ou de Mes plats. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.recipe IS $$Recette en texte, écrite par l'IA pour le nombre de personnes du foyer (meal_menus.servings), pour tout plat du menu : plat libre, plat du catalogue ou de Mes plats (le plat d'origine n'est pas modifié). Vide si le plat de Mes plats n'a pas de recette. [US-156 RF11, CR-42, CR-49]$$;
COMMENT ON COLUMN meal_menu_entries.duration_minutes IS $$Durée d'un plat libre en minutes (1 à 600) ; vide pour un plat du catalogue ou de Mes plats. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.light_by_ai IS $$Vrai si une version allégée a été proposée par l'IA pour ce plat (texte dans light_text, adaptation de la liste dans meal_menu_entry_light_items) ; possible pour toute origine dont le plat n'a pas de version allégée dans le catalogue. [US-157 RF5, CR-42, CR-45]$$;
COMMENT ON COLUMN meal_menu_entries.light_text IS $$Texte de la version allégée proposée par l'IA ; renseigné si et seulement si light_by_ai. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.light_chosen IS $$Le foyer a retenu la version allégée proposée par l'IA (la liste suit l'adaptation). Ne peut être vrai que si light_by_ai. Pour les plats du catalogue, le choix reste dans meal_light_choices. [US-157 RF9, CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.is_off_batch IS $$Inutilisé depuis CR-42 (plus de liste déroulante de remplacements) : laissé à faux ; les dîners du samedi et du dimanche, hors séance de batch, se déduisent du rang. [US-156 RF8, CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.planning_match_to_confirm IS $$Inutilisé depuis CR-42 (le menu ne vient plus d'un planning à rapprocher du catalogue) : laissé à faux. Les correspondances des semaines types (US-170, US-171) restent dans meal_batch_week_days. [US-156 RF7, CR-42]$$;
COMMENT ON TABLE meal_menu_entry_ingredients IS $$Ingrédients d'un plat d'un menu validé, de toute origine : nom, clé normalisée, produit du catalogue s'il est reconnu (un ingrédient inconnu entre dans la liste sans prix et dans les produits à référencer), quantité et unité écrites par l'IA pour le nombre de personnes du foyer (CR-50, qui remplace CR-25 pour les menus ; les plats du catalogue et de Mes plats ne changent pas). Tout plat du menu a au moins un ingrédient (contrôlé à la validation de la transaction). Les quantités, additionnées par produit (v_meal_menu_needs) puis divisées par le format de la référence, donnent le nombre d'unités à acheter. Jamais dans le catalogue commun ; conservé et purgé avec le menu. [US-156 RF8, RF11, RT3, RT4, US-157 RF7bis, CR-04, CR-42, CR-49, CR-50]$$;
COMMENT ON COLUMN meal_menu_entry_ingredients.quantity IS $$Quantité de l'ingrédient pour le nombre de personnes du foyer, dans l'unité unit ; vide si l'IA n'en a pas donné (la liste met alors 1 unité, « Quantité à vérifier »). Vide en même temps que l'unité. [CR-50]$$;
COMMENT ON COLUMN meal_menu_entry_ingredients.unit IS $$Unité de la quantité : g, kg, ml, cl, l, piece (pièce), spoon (cuillère) ou pinch (pincée). Une cuillère et une pincée rendent l'ingrédient « placard » et ne se convertissent pas. [CR-50, CR-51]$$;
COMMENT ON COLUMN meal_menu_entry_ingredients.base_unit IS $$Unité de base calculée par la base : g (g, kg), ml (ml, cl, l) ou piece ; vide pour une cuillère, une pincée ou une quantité absente. [CR-50]$$;
COMMENT ON COLUMN meal_menu_entry_ingredients.base_quantity IS $$Quantité ramenée en g, ml ou pièce (kg x 1000, cl x 10, l x 1000), calculée par la base ; vide en même temps que base_unit. [CR-50]$$;
COMMENT ON TABLE meal_menu_entry_light_items IS $$Produits à retirer et à ajouter pour passer un plat du menu à la version allégée proposée par l'IA (la ligne de menu porte le texte, light_by_ai). Un produit inconnu du catalogue est noté dans les produits à référencer. Conservé et purgé avec le menu. [US-157 RF5, CR-42]$$;
COMMENT ON TABLE meal_menu_session_steps IS $$Déroulé de la séance de batch du dimanche, rédigé par l'IA pour un menu qui ne reprend pas une semaine type : étapes numérotées (texte, plat concerné facultatif, durée approximative facultative). Le déroulé finit par la conservation de chaque plat, écrite comme des étapes de fin de déroulé : plat concerné, réfrigérateur ou congélateur, jour où le sortir. Une étape peut se chevaucher avec une étape précédente (elle n'allonge alors pas la séance). Réservé aux menus sans semaine type (batch_week_id vide) : avec une semaine type, le déroulé est celui du planning (US-170) et rien n'est enregistré ici. Conservé et purgé avec le menu (12 mois), effacé avec le compte. [US-156 RF6bis, US-157 RF1ter, CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.position IS $$Rang de l'étape dans le déroulé, à partir de 1 [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.body IS $$Texte de l'étape (2 000 caractères au plus), rédigé par l'IA [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.entry_id IS $$Plat concerné par l'étape : une ligne du même menu (facultatif) ; repasse à vide si cette ligne est supprimée, l'étape reste lisible [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.duration_minutes IS $$Durée approximative de l'étape en minutes, 1 à 600 (facultative) [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.overlaps_position IS $$Rang d'une étape précédente du même menu avec laquelle cette étape se chevauche (« en même temps, pendant la cuisson ») ; facultatif, toujours inférieur au rang de l'étape (pas de cycle). Une étape en chevauchement n'allonge pas la séance : l'application recalcule la durée totale. Repasse à vide si l'étape référencée est supprimée. [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.storage_mode IS $$Étape de conservation d'un plat : fridge (réfrigérateur) ou freezer (congélateur) ; le plat est entry_id. Vide pour une étape ordinaire. Une seule étape de conservation par plat. [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.take_out_day IS $$Jour où sortir le plat, jour ISO de la semaine du menu (1 = lundi … 7 = dimanche) ; facultatif, uniquement pour une étape de conservation. [CR-47]$$;
COMMENT ON FUNCTION meal_menu_session_steps_check() IS $$Contrôle différé : un menu qui reprend une semaine type (batch_week_id renseigné) n'a aucune étape de déroulé enregistrée, son déroulé étant celui du planning. [US-156 RF6bis, CR-47]$$;
COMMENT ON TABLE meal_menu_daily_counters IS $$Nombre de menus complets composés par un foyer un jour donné, pour le plafond quotidien (réglage de la console meal_menu_daily_cap, 10 par défaut) : chaque menu proposé et chaque correction compte comme un menu. Aucune donnée personnelle hors le compte ; incrémenté seulement par register_meal_menu() ; purgé après 7 jours (purge_expired_grocery_data) ; effacé avec le compte. [US-156 RF12ter, CR-44]$$;
COMMENT ON COLUMN meal_menu_daily_counters.menu_date IS $$Jour du décompte, calculé par l'application dans le fuseau du foyer [CR-44]$$;
COMMENT ON COLUMN meal_menu_daily_counters.menu_count IS $$Menus complets déjà acceptés ce jour-là ; borné par le plafond, jamais au-dessus [CR-44]$$;
COMMENT ON FUNCTION register_meal_menu(uuid, date, integer) IS $$Compte un menu complet d'un foyer pour un jour et applique le plafond quotidien : true = accepté (le compteur est incrémenté), false = plafond atteint (rien n'est compté). Le plafond est le paramètre ou, s'il est vide, le réglage de la console meal_menu_daily_cap (10 par défaut). Atomique : deux demandes simultanées ne dépassent jamais le plafond. [US-156 RF12ter, CR-44]$$;
COMMENT ON FUNCTION share_season_dish(text, text, integer, integer, text, integer, integer[], integer[], jsonb) IS $$Seule porte d'écriture de la base commune des plats de saison : crée le plat (avec ses mois, ses étiquettes et ses ingrédients) si son nom normalisé n'existe pas, sinon rend l'identifiant du plat existant sans rien modifier (le premier est gardé). Ne reçoit ni foyer ni profil. Exécutée avec les droits du propriétaire. [US-178 RF2bis, CR-61]$$;
COMMENT ON FUNCTION choose_season_dish(uuid, bigint) IS $$Compte le choix d'un plat de saison dans un menu validé, une seule fois par foyer et par plat : le compteur de la base commune ne monte que si aucune ligne de menu du foyer ne pointe déjà vers ce plat. Le foyer n'est pas gardé. À appeler avant d'écrire la ligne de menu (season_dish_id). Rend vrai si le compteur a monté. Le compteur peut remonter après une purge ou une suppression de menu (accepté). Exécutée avec les droits du propriétaire. [US-178 RF2bis, CR-61, CR-62]$$;
COMMENT ON FUNCTION search_season_dishes(date, integer[], integer[], integer[], bigint[], integer) IS $$Plats de saison de la base commune pour un mois : non masqués, de saison dans le mois demandé, dans les cuisines données, portant toutes les étiquettes demandées et aucune étiquette exclue, hors des plats déjà écartés ; les plus choisis d'abord. Les filtres viennent de l'application : la base ne lit jamais les allergies ni les régimes du foyer (chiffrés), l'application filtre les allergies sur les candidats rendus. Exécutée avec les droits du propriétaire. [US-178 RF2bis, CR-61]$$;
COMMENT ON FUNCTION season_dish_ingredients_for(bigint[]) IS $$Ingrédients (avec quantité et unité pour le nombre de personnes du plat) des plats de saison demandés, hors plats masqués. Exécutée avec les droits du propriétaire. [US-178 RF2bis, CR-61]$$;
COMMENT ON FUNCTION meal_menu_entry_needs_ingredient() IS $$Contrôle différé : tout plat d'un menu, de toute origine, a au moins un ingrédient à la fin de la transaction (les lignes de menus validés avant CR-49 ne sont pas revérifiées). [US-156 RF8, RT3, CR-42, CR-49, CR-51]$$;
COMMENT ON VIEW v_meal_menu_needs IS $$Besoins d'un menu validé par produit (ou par nom d'ingrédient inconnu du catalogue) et par unité de base (g, ml, piece) : total des quantités, nombre d'ingrédients additionnés, needs_check (une quantité manque : 1 unité et « Quantité à vérifier »), is_pantry (produit « placard » ou quantité en cuillère ou en pincée : décoché par défaut). Les cuillères, pincées et quantités absentes ont une unité de base vide. L'application divise ensuite le total par le format de la référence choisie et arrondit au paquet supérieur. Vue à droits de l'appelant : la sécurité par ligne du couple s'applique. [US-157 RF7bis, CR-50]$$;
COMMENT ON FUNCTION meal_menu_entry_light_item_before_write() IS $$Refuse une adaptation de version allégée sur un plat de menu qui n'a pas de version allégée proposée par l'IA. [US-157 RF5, CR-42]$$;
COMMENT ON TABLE meal_light_choices IS $$Choix du foyer, plat par plat, entre la version standard et la version allégée : enregistré à « Valider ma liste » et repris au menu suivant. Un retour à la version standard rétablit la liste. [US-157 RF5, RF9]$$;
COMMENT ON TABLE grocery_list_groups IS $$Regroupement de plusieurs semaines en une « Liste du mois » : un seul scénario d'achat et une seule date de validation pour toutes les semaines regroupées. Chaque semaine garde sa liste (grocery_lists.group_id). Supprimer une semaine la retire du regroupement ; le regroupement disparaît s'il reste moins de 2 listes. [US-157 RF9ter, RF11, CR-56]$$;
COMMENT ON TABLE grocery_lists IS $$Liste de courses validée (« Valider ma liste ») : scénario d'achat choisi, menu d'origine (une seule liste par menu, donc par semaine, CR-54), date, profil. « Ma liste de courses » est la liste de la semaine affichée, consultée en magasin par magasin puis par rayon. La liste vide de tout produit est supprimée par la purge. Supprimée avec son menu (delete_meal_menu) ou seule (delete_grocery_list) ; elle quitte alors son regroupement en liste du mois, qui disparaît s'il reste moins de 2 listes. [US-157 RF7, RF9, RF9bis, RF9ter, RF11, CR-54, CR-56]$$;
COMMENT ON COLUMN grocery_lists.group_id IS $$Liste du mois (grocery_list_groups) à laquelle cette semaine est regroupée ; vide = liste de la semaine seule. Son scénario d'achat est celui du regroupement (vérifié). Repasse à vide si le regroupement disparaît. [US-157 RF9ter, CR-56]$$;
COMMENT ON FUNCTION grocery_list_group_check() IS $$Une liste regroupée (liste du mois) a le même scénario d'achat que son regroupement. [US-157 RF9ter, CR-56]$$;
COMMENT ON FUNCTION grocery_list_group_cleanup() IS $$Quand une liste quitte son regroupement ou est supprimée (suppression d'une semaine, d'un menu ou purge), le regroupement disparaît s'il reste moins de 2 listes ; les listes restantes redeviennent des listes de semaine. [US-157 RF9ter, RF11, CR-56]$$;
COMMENT ON TABLE grocery_list_items IS $$Produit de la liste de courses du foyer, avec son état : en préparation, validé, ajouté depuis la validation (sans magasin ni prix, en tête de « Ma liste de courses »), acheté. Un produit n'est qu'une fois dans la liste ouverte d'une semaine (la quantité augmente) ; chaque produit appartient à un menu (menu_id). Les produits non achetés d'une semaine ne sont plus recopiés : la semaine suivante les voit en pense-bête décoché (grocery_leftovers_for), ils restent sur leur liste. Les produits achetés forment l'historique du foyer, conservé 3 mois (réglable). Le couple retire tout ; un invité secondaire ne retire que ses propres ajouts, n'augmente que les quantités et peut cocher « acheté » (CR-38), sans voir aucun prix (grocery_list_for). [US-157 RF3, RF3bis, RF9, US-158, US-162, CR-10, CR-27, CR-28, CR-54, CR-55]$$;
COMMENT ON COLUMN grocery_list_items.needed_amount IS $$Besoin du menu pour ce produit, additionné sur tous les plats (plats express compris) pour le nombre de personnes du foyer, en g, ml ou pièce ; sert à afficher l'origine de la quantité (« 2 paquets · 900 g pour le menu »). Pour un produit au poids, poids x prix au kilo entre dans le total. Vide pour un produit ajouté à la main ou de l'historique (1 par défaut). [US-157 RF7bis, RF8, CR-50]$$;
COMMENT ON COLUMN grocery_list_items.needed_unit IS $$Unité de needed_amount : g, ml ou piece. Vide en même temps que la quantité. [CR-50]$$;
COMMENT ON COLUMN grocery_list_items.quantity_to_check IS $$Vrai quand la quantité n'a pas pu être calculée (format de la référence inconnu, unité incompatible comme « 2 pièces » pour une référence en grammes, quantité absente) : 1 unité, avec la mention « Quantité à vérifier ». [US-157 RF7bis, CR-50]$$;
COMMENT ON COLUMN grocery_list_items.is_pantry IS $$Produit « placard » (étiquette du produit ou quantité en cuillère ou en pincée) : affiché avec « Vous en avez peut-être déjà ». [US-157 RF7bis, CR-50]$$;
COMMENT ON COLUMN grocery_list_items.is_selected IS $$Coché pour l'achat. Un produit « placard » démarre décoché et ne compte dans le total que s'il est coché. [US-157 RF7bis, CR-50]$$;
COMMENT ON COLUMN grocery_list_items.price_unit IS $$Unité de unit_price, copiée de la référence choisie à la validation : unit (ou vide) = par article, kg ou l = par kilo ou par litre. Un article au kilo ou au litre s'affiche « x,xx €/kg » avec la mention « prix au kilo, non totalisé » et n'entre pas dans le total estimé : l'application ne totalise que les articles dont price_unit est vide ou unit. Aucun poids n'est supposé. [CR-40]$$;
COMMENT ON COLUMN grocery_list_items.menu_id IS $$Menu (donc semaine) du produit, renseigné pour tout produit : en préparation, validé, acheté ou ajouté depuis la validation. Il suit toujours le menu de la liste du produit (rempli à partir de la liste s'il est vide, refusé s'il diffère). Vide seulement pour un ajout à la main en préparation quand aucun menu n'existe ; le premier menu validé le reprend (application). Supprimé avec son menu (cascade). [US-157 RF3bis, RF9bis, RF11, CR-54, CR-55]$$;
COMMENT ON COLUMN grocery_list_items.state IS $$preparing = en préparation (aucun magasin, aucun prix) ; validated = dans la liste validée, avec son magasin, sa référence et son prix estimé ; added_after_validation = ajouté depuis la validation, sans magasin ni prix ; bought = acheté (date et profil). [US-157 RF9, US-158 RF3bis, CR-28]$$;
COMMENT ON FUNCTION grocery_list_item_before_write() IS $$Garde-fou de la liste de courses : un invité secondaire (profil indiqué dans app.user_id) peut ajouter un produit en son nom, augmenter une quantité, cocher « acheté » n'importe quel article de la liste validée (état validé ou ajouté depuis la validation, à son nom) et décocher ce qu'il a lui-même coché ; il ne change jamais un magasin, une référence, un prix, une quantité en même temps ni le libellé. Il rattache aussi le produit au menu de sa liste (rempli s'il est vide, refusé s'il diffère, CR-54) et vide son lien vers une ligne de ticket quand il n'est plus acheté (CR-58). Sans profil indiqué, le garde-fou de l'invité secondaire ne s'applique pas (H144). [US-158 RF2, RF3, US-162, CR-10, CR-38, CR-54]$$;
COMMENT ON FUNCTION grocery_list_for(uuid) IS $$Articles de la liste de courses de la famille d'un profil, pour l'affichage : le prix estimé n'est rendu qu'au couple, l'invité secondaire ne voit aucun prix (il voit le magasin, la référence, le format du conditionnement et l'unité du prix, sans prix). L'application l'utilise pour lire la liste ; tant qu'elle se connecte avec un seul rôle, la protection effective des colonnes est cette fonction et le code (H150). [US-157 RF7bis, RF8, RF9bis, US-158, CR-10, CR-38, CR-40, CR-50, CR-54]$$;
COMMENT ON FUNCTION grocery_leftovers_for(uuid, uuid) IS $$Pense-bêtes « Pas encore acheté (semaine du …) » d'un menu : les produits validés ou ajoutés après la validation, non achetés, de la plus récente liste encore existante d'une semaine antérieure à ce menu (une semaine sautée ne bloque rien ; sans liste précédente, rien n'est repris). Calculés à la lecture : décochés (is_selected faux), hors total tant que l'utilisateur ne les coche pas, toujours présents sur leur liste d'origine ; ils disparaissent quand le produit est acheté sur cette liste ou quand le produit existe déjà dans la semaine visée (un pense-bête coché y devient un produit, copié par l'application). Le prix estimé n'est rendu qu'au couple. Remplace grocery_carry_over_unbought. [US-157 RF3bis, CR-55]$$;
COMMENT ON FUNCTION delete_meal_menu(uuid) IS $$Supprime définitivement un menu validé : ses produits de liste (achetés et ajoutés à la main compris), sa liste de courses, son déroulé de séance, ses lignes de menu, leurs ingrédients et leurs quantités. Ne touche ni les tickets, ni les prix, ni les plats copiés dans Mes plats, ni le compteur de menus du jour (un menu supprimé reste compté). Réservée au couple du foyer (profil lu dans app.user_id) ; rend faux si le menu n'existe pas. Le menu sort de l'historique (« déjà servi le … »). Sa liste quitte son regroupement en liste du mois, qui disparaît s'il reste moins de 2 listes. [US-156 RF1bis, US-157 RF9ter, RF11, RT3, CR-54, CR-56]$$;
COMMENT ON FUNCTION delete_grocery_list(uuid) IS $$Supprime définitivement la liste de courses d'un menu et tous ses produits (achetés et ajoutés à la main compris) ; le menu, ses recettes et son déroulé sont gardés, la liste repart de zéro à partir du menu. Ne touche ni les tickets, ni les prix, ni le compteur de menus du jour. Réservée au couple du foyer (profil lu dans app.user_id) ; rend vrai si quelque chose a été supprimé. La liste quitte son regroupement en liste du mois, qui disparaît s'il reste moins de 2 listes. [US-157 RF9ter, RF11, RT3, CR-54, CR-55, CR-56]$$;
COMMENT ON TABLE grocery_receipts IS $$Ticket de caisse enregistré : magasin, ville, date, heure, total, profil. Aucune photo ni image (supprimée dès la lecture, confirmée ou non), le nom et la carte de fidélité sont masqués avant que l'agent ne reçoive le texte. Un doublon est refusé en entier par la base : même date, même heure exacte et même total (le magasin n'entre pas en compte) ; sans heure (anciens tickets), même magasin, même date et même total. Source du budget par rayon. Conservé 3 ans (année en cours et deux précédentes, réglable). [US-161, US-163, CR-05, CR-08, CR-23, CR-41]$$;
COMMENT ON COLUMN grocery_receipts.purchased_time IS $$Heure du ticket (heures, minutes et secondes si elles sont lues, sinon secondes à 00), heure locale du magasin. Lue sur le ticket ou saisie par l'utilisateur quand elle n'est pas lue. Vide pour les tickets enregistrés avant CR-41 : leur contrôle de doublon reste magasin, date et total. [CR-41, US-161 RT2]$$;
COMMENT ON COLUMN grocery_list_items.receipt_line_id IS $$Ligne de ticket de caisse qui a servi à payer ce produit acheté : le coût réel du menu est la somme des lignes reliées aux produits de ses listes. Vide pour un produit coché à la main (le prix estimé est gardé) ; repasse à vide si le ticket est supprimé ou si le produit n'est plus acheté. Un ingrédient inconnu du catalogue est rapproché par son nom, moins fiable. [US-157 RF8, US-177, CR-58]$$;
COMMENT ON COLUMN grocery_receipt_lines.measured_quantity IS $$Poids ou volume mesuré à la caisse, en kilogrammes ou en litres (« 1,234 kg ») ; vide pour une ligne vendue à la pièce. Les grammes et les centilitres sont convertis avant l'écriture. Reste dans le foyer : jamais partagé. quantity (nombre d'articles) ne le porte pas. [CR-39]$$;
COMMENT ON COLUMN grocery_receipt_lines.measure_unit IS $$Unité du poids ou du volume mesuré : kg ou l. Vide en même temps que la quantité mesurée ; vide = vendu à la pièce. [CR-39]$$;
COMMENT ON COLUMN grocery_receipt_lines.price_per_measure IS $$Prix au kilo ou au litre lu sur le ticket (« 1,49 €/kg »). S'il n'est pas lu et que le poids est connu, il est calculé (total de la ligne divisé par le poids, arrondi à 2 décimales) ; le prix lu l'emporte toujours. Vide sans poids, sur une remise, ou si le calcul sort des bornes. [CR-39, CR-40]$$;
COMMENT ON TABLE grocery_receipt_lines IS $$Ligne d'un ticket : produit, référence, prix total de la ligne, quantité, poids ou volume mesuré et prix au kilo ou au litre pour un article pesé, rayon (choisi dans la liste des rayons). Les lignes alimentent le budget par rayon, les prix du foyer et les produits de son historique. [US-161 RF2 à RF5, US-163, CR-39]$$;
COMMENT ON FUNCTION grocery_receipt_line_measure_before_write() IS $$Calcule le prix au kilo ou au litre d'une ligne pesée quand le ticket ne le donne pas : total de la ligne divisé par le poids, arrondi à 2 décimales. Le prix lu sur le ticket l'emporte toujours ; rien n'est calculé sans poids, sur une remise ou hors bornes. [CR-39, CR-40]$$;
COMMENT ON FUNCTION grocery_sync_city_sharing() IS $$Inscrit le foyer au compteur de sa ville quand il partage ses prix (et le déplace s'il change de ville en partageant) ; ne le retire jamais à la désactivation du partage. Exécutée avec les droits du propriétaire. [CR-17, CR-22]$$;
COMMENT ON FUNCTION grocery_city_counter_sync() IS $$Tient le compteur des foyers par ville : +1 à l'inscription d'un foyer, déplacement s'il change de ville, -1 à la suppression de son compte (la ligne du compteur disparaît à zéro). Exécutée avec les droits du propriétaire. [CR-17, CR-22]$$;
COMMENT ON FUNCTION share_grocery_price(uuid, bigint, text, numeric, text, text, date, text) IS $$Seule porte d'écriture de la base commune des prix. Le prix est par article, par kg ou par litre (p_price_unit : unit, kg, l) ; un article pesé est partagé avec son prix au kilo, jamais avec son poids. Reçoit le foyer pour vérifier qu'il partage ses prix (sinon ne fait rien et retourne NULL) mais ne le garde pas : la date du ticket devient le lundi de sa semaine. Une ligne identique (même unité de prix comprise) n'est pas dupliquée : sa semaine est mise à jour. Exécutée avec les droits du propriétaire. [US-154 RF1, RF2, RF4, RT1, CR-17, CR-39]$$;
COMMENT ON FUNCTION grocery_shared_prices_for(uuid) IS $$Prix des autres foyers lisibles par un profil du couple : seulement s'il partage lui-même ses prix (réciprocité), pour ses enseignes de proximité (enseigne et ville), dans une ville où au moins 2 foyers partagent, le foyer qui consulte comptant aussi dans la ville consultée (une ville voisine est visible dès qu'un autre foyer y est inscrit ; dans sa propre ville il est déjà compté), hors lignes retirées et au plus 12 mois. Chaque prix porte son enseigne, sa ville et son ancienneté, son unité (par article, kg ou litre) et, quand il peut l'être, son prix au kilo ou au litre (le prix lui-même s'il est déjà au kilo, sinon le prix divisé par la quantité du format de la référence ; vide sans format connu, jamais estimé). Aucun lien avec un foyer. Exécutée avec les droits du propriétaire. [US-154 RF3, RT2, US-157 RF4, US-166 RF3, CR-12, CR-17, CR-21, CR-35, CR-39]$$;
COMMENT ON FUNCTION note_grocery_unreferenced(uuid, text, grocery_unreferenced_kind, grocery_unreferenced_source, integer, text, text, numeric, text) IS $$Note un produit sans référence conforme (liste, menu validé ou ticket), sans rien demander au foyer et sans garder le foyer. La ville, la référence vue, le prix vu et le magasin ne sont gardés que si le foyer partage ses prix et que les quatre sont donnés ; sinon ils restent vides. Exécutée avec les droits du propriétaire. [US-173 RF1, RF3, CA 3.1]$$;
COMMENT ON FUNCTION grocery_reference_marks_referenced() IS $$À l'ajout d'une référence, passe au statut « référencé » le produit du même nom normalisé dans la liste des produits à référencer, qui sort alors de la liste des foyers. [US-173 RF5, US-174 RF2]$$;
COMMENT ON FUNCTION grocery_monthly_spend_for(uuid) IS $$Dépenses d'un foyer par rayon et par mois, d'après ses tickets enregistrés seulement (sans ticket, aucun prix : le budget n'en tient pas compte). Aucune ligne pour un invité secondaire : il n'a pas accès au budget. [US-163 RF1, RF2, RF4, CR-10]$$;
COMMENT ON FUNCTION merge_grocery_aisles(integer, integer) IS $$Fusionne le premier rayon dans le second : produits, lignes de tickets (donc budget passé), produits de liste, produits à référencer et produits du quotidien sont rangés dans le rayon conservé, puis le premier rayon est supprimé. Exécutée avec les droits du propriétaire (touche les données de tous les foyers). [US-169 RF2, CA 2.1]$$;
COMMENT ON FUNCTION profile_agent_not_retired() IS $$Refuse l'ajout (ou le ré-ajout) d'un agent retiré à un dashboard. Un agent retiré est réversible et invisible du catalogue et des tableaux de bord. [CR-34]$$;
COMMENT ON VIEW v_grocery_product_references IS $$Références par enseigne avec leur ancienneté (fresh / aging / NULL au-delà de 12 mois ou sans prix ; has_price les distingue : sans prix, « N/A ») et leur conformité, recalculée à chaque lecture : non conforme si le statut déclaré est « aucun conforme trouvé » (none_found) ou si un additif correspond à un critère actif, quel que soit le statut (excluded_because liste alors les critères). Une référence non conforme n'est jamais proposée et sert à la rubrique « Ingrédients exclus des références proposées ». needs_label_check : référence proposée avec la mention « Composition à vérifier sur l'étiquette » (statut « à vérifier »). package_format : format du conditionnement. package_amount, package_unit : sa quantité en kg ou en litres. price_unit : le prix est par article, par kg ou par litre. measure_unit, price_per_measure : prix au kilo ou au litre, calculé (le prix tel quel s'il est déjà au kilo, sinon le prix divisé par la quantité du format) ; vide sans prix ou sans quantité connue, jamais estimé. [US-157 RF1, RF8, US-166 RF3, US-167 RF2, CA 1.1, CR-36, CR-37, CR-39]$$;
COMMENT ON VIEW v_meal_batch_week_days IS $$Plats de planning avec leur statut de correspondance (sure / to_confirm / absent, d'après les seuils de la console), le plat du catalogue effectivement utilisé (le plat confirmé, sinon le plat suggéré tant que la correspondance est sûre par son pourcentage ou à confirmer) et s'ils bloquent leur semaine (« absent »). Alimente la liste des correspondances à corriger. [US-171 RF1, RF2, CA 1.1]$$;
COMMENT ON VIEW v_meal_batch_weeks IS $$Semaines types avec leur durée, le nombre de plats reliés au catalogue et si elles sont utilisables : cinq jours renseignés et aucun plat « absent » du catalogue. Une semaine bloquée n'est pas proposée aux foyers. [US-170 RF4, US-171 CA 1.1]$$;
COMMENT ON VIEW v_meal_dishes_console IS $$Plats du catalogue pour la console : plat express (15 minutes au plus), retiré ou non, présence dans une semaine type et d'une version allégée. Permet de signaler les plats sans semaine type et de compter les plats express. [US-164 RF2, RF4]$$;
COMMENT ON VIEW v_meal_season_dishes IS $$Liste de console des plats de saison de la base commune : nom, cuisine, nombre de personnes des quantités, mois de saison, étiquettes, nombre de foyers qui l'ont choisi, lundi d'entrée, masqué ou visible, nombre d'ingrédients. Aucune colonne ne retrouve un foyer. L'administrateur masque un plat et corrige ses étiquettes et ses mois (journal d'administration : seasonal_dish_changed). [US-178 RF2bis, CR-61]$$;
COMMENT ON VIEW v_grocery_unreferenced IS $$Produits à référencer regroupés par nom normalisé, avec leur nombre d'occurrences (du plus demandé au moins demandé), leur type (inconnu / sans référence), leur rayon et leur statut (à référencer par défaut). Aucune donnée de foyer. [US-173 RF2, CA 2.1]$$;
COMMENT ON VIEW v_grocery_shared_prices_moderation IS $$Base commune pour la modération, avec le signalement « à vérifier » : le prix est comparé à la médiane du même produit dans la même enseigne sur 12 mois (au moins 3 autres valeurs), sinon au prix de référence de l'enseigne ; il est à vérifier sous 50 % ou au-dessus de 200 % de cette base. Sans aucune base : sous 0,05 € ou au-dessus de 500 €. Les quatre bornes, le nombre de valeurs et la fenêtre sont des réglages de la console. Une ligne retirée n'est jamais signalée. Aucune colonne ne retrouve le foyer. Un prix au kilo ou au litre n'est comparé qu'à des prix de même unité (médiane) ou, à défaut, au prix au kilo ou au litre des références (price_unit, en dernière colonne). [US-175 RF1 à RF4, CR-33, CR-39]$$;
COMMENT ON FUNCTION purge_expired_grocery_data() IS $$Supprime les menus validés de plus de 12 mois, les tickets (avec leurs lignes) antérieurs à l'année en cours moins deux, les produits achetés de la liste de plus de 3 mois (et les listes validées devenues vides), les entrées du journal des produits à référencer de plus de 12 mois, les preuves de consentement arrivées à échéance, les lignes de la base commune des prix de plus de 12 mois (réglage de la fenêtre grocery_check_window_months ; le catalogue n'est pas concerné) les compteurs du plafond quotidien de menus de plus de 7 jours, et les sélections de plats de saison d'un mois passé (la base commune des plats de saison n'est jamais purgée). Les durées sont des réglages de la console (à confirmer par le DPO, CR-26). À planifier chaque jour. [CR-23, CR-35, CR-44]$$;
COMMENT ON VIEW v_dashboard_agents IS $$Agents actifs d'un profil avec statut Prêt / À configurer / Bloqué ; les agents retirés du catalogue n'y figurent pas. [US-22, 29, 31, 42, CR-34]$$;
