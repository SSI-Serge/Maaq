-- MAAQ — rattrapage additif du lot 14 (produits du quotidien en console et seuil de la rubrique « Produits de mon historique » ; décisions CR-66 et CR-67), fichier 2/2, À APPLIQUER APRÈS
-- rattrapage_lot_14_quotidien_1_valeurs_enumerees.sql, lui-même après rattrapage_lot_14_mois_2_schema.sql (050778da…). Une base neuve applique les lot_14_1 et lot_14_2 régénérés (nouvelles empreintes)
-- et n'a pas besoin de ces fichiers. Une seule transaction, idempotent. Aucune ligne existante réécrite : les 15 produits de départ sont des lignes NOUVELLES, insérées une seule fois (seulement si la table
-- est vide), rattachées aux rayons Entretien, Soins du corps et Crémerie par leur nom (un rayon absent ou renommé en console fait sauter ses produits) ; un produit du catalogue de même clé normalisée est
-- relié automatiquement ; un message (NOTICE) donne le nombre de produits ajoutés et reliés.
--  1. grocery_daily_products : nom, clé normalisée (calculée par l'application), rayon, produit du catalogue facultatif, position, retiré, dates ; commune, sans sécurité par ligne (comme les rayons).
--  2. Réglage de console grocery_history_min_products (10 par défaut, de 1 à 50).
--  3. merge_grocery_aisles() REMPLACÉE : la fusion de deux rayons range aussi les produits du quotidien de l'ancien rayon dans le rayon conservé (sans cela, la suppression de l'ancien rayon serait refusée).

CREATE TABLE IF NOT EXISTS grocery_daily_products (
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_grocery_daily_products_name ON grocery_daily_products (grocery_norm(name));
CREATE INDEX IF NOT EXISTS idx_grocery_daily_products_aisle ON grocery_daily_products (aisle_id, position);
CREATE INDEX IF NOT EXISTS idx_grocery_daily_products_product_id ON grocery_daily_products (product_id) WHERE product_id IS NOT NULL;

DO $$
DECLARE v_n integer; v_lies integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM grocery_daily_products) THEN
    INSERT INTO grocery_daily_products (name, name_key, aisle_id, product_id, position)
    SELECT v.name, v.name_key, a.id, (SELECT p.id FROM grocery_products p WHERE p.name_key = v.name_key), v.position
      FROM (VALUES ('Liquide vaisselle', 'liquide vaisselle', 'Entretien', 1), ('Éponges', 'eponges', 'Entretien', 2), ('Lessive', 'lessive', 'Entretien', 3), ('Sacs poubelle', 'sacs poubelle', 'Entretien', 4), ('Papier toilette', 'papier toilette', 'Entretien', 5), ('Essuie-tout', 'essuie tout', 'Entretien', 6), ('Brosse à dents', 'brosse a dents', 'Soins du corps', 1), ('Dentifrice', 'dentifrice', 'Soins du corps', 2), ('Gel douche', 'gel douche', 'Soins du corps', 3), ('Shampoing', 'shampoing', 'Soins du corps', 4), ('Déodorant', 'deodorant', 'Soins du corps', 5), ('Lait', 'lait', 'Crémerie', 1), ('Beurre', 'beurre', 'Crémerie', 2), ('Œufs', 'oeufs', 'Crémerie', 3), ('Yaourts', 'yaourts', 'Crémerie', 4)) AS v(name, name_key, aisle, position)
      JOIN grocery_aisles a ON a.name = v.aisle;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    SELECT count(*) INTO v_lies FROM grocery_daily_products WHERE product_id IS NOT NULL;
    RAISE NOTICE 'Produits du quotidien ajoutés : % (reliés à un produit du catalogue : %)', v_n, v_lies;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION merge_grocery_aisles(p_from integer, p_into integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
COMMENT ON FUNCTION merge_grocery_aisles(integer, integer) IS $$Fusionne le premier rayon dans le second : produits, lignes de tickets (donc budget passé), produits de liste, produits à référencer et produits du quotidien sont rangés dans le rayon conservé, puis le premier rayon est supprimé. Exécutée avec les droits du propriétaire (touche les données de tous les foyers). [US-169 RF2, CA 2.1]$$;

INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('grocery_history_min_products',      'integer', '10',    1,  50,       $$Nombre minimum de produits de la rubrique « Produits de mon historique » : en dessous, elle est complétée par les produits du quotidien de la console (US-157 RF3ter, CR-66)$$)
ON CONFLICT (setting_key) DO NOTHING;

COMMENT ON TABLE grocery_daily_products IS $$Produits du quotidien tenus en console (liquide vaisselle, éponges, lessive, brosse à dents, lait, beurre…), par rayon : ils complètent « Produits de mon historique » sous le titre « Pensez aussi à : » quand la rubrique compte moins de produits que le seuil de la console (grocery_history_min_products), décochés par défaut, sans ceux déjà dans l'historique, le menu ou les produits ajoutés. Commune à tous les foyers, sans donnée de foyer, lisible par tous les profils, écrite par la console seulement (journal d'administration : daily_product_changed). Nom et clé normalisée uniques ; retirer un produit le masque sans le supprimer. [US-157 RF3ter, US-169 RF3, CR-66, CR-67]$$;
COMMENT ON COLUMN grocery_daily_products.name_key IS $$Nom normalisé calculé par l'application, comme grocery_products.name_key (minuscules, « œ » en « oe », accents retirés, suites d'espaces et de tirets réduites à un espace, bords retirés ; les pluriels ne sont pas touchés) : sert au rapprochement par le nom quand le produit n'est pas lié au catalogue. La base garde la clé et son unicité. [US-157 RT2bis, CR-66]$$;
COMMENT ON COLUMN grocery_daily_products.product_id IS $$Produit du catalogue correspondant, facultatif : quand il est renseigné, l'application reconnaît le produit du quotidien dans l'historique, le menu et les produits ajoutés par ce produit, sinon par name_key. Repasse à vide si le produit est supprimé. [US-157 RT2bis, CR-66]$$;
COMMENT ON COLUMN grocery_daily_products.position IS $$Ordre d'affichage dans le rayon, à partir de 1. [US-169 RF3, CR-66]$$;
COMMENT ON COLUMN grocery_daily_products.retired_at IS $$Date à laquelle la console a retiré le produit (il n'est plus proposé) ; vide = actif. [US-169 RF3, CR-66]$$;
