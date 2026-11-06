-- MAAQ — rattrapage additif du lot 14 (décisions CR-36 et CR-37 : références sans prix, statut de conformité déclaré ; rayon « Crémerie ») pour une base qui a DÉJÀ reçu
-- lot_14_2_schema.sql dans sa version 5298e454…fce75. Une base neuve applique le lot_14_2_schema.sql régénéré (nouvelle empreinte) et n'a pas besoin de ce fichier.
-- Une seule transaction, idempotent (réappliqué, il ne change rien). Aucune ligne n'est supprimée ni réécrite : les références déjà chargées sont conservées
-- (leur statut déclaré prend la valeur « compliant », comme avant : la conformité ne se déduisait que des additifs).
--  1. Nouveau type grocery_reference_status (compliant, to_check, none_found, not_applicable) : un type créé d'un bloc, pas une valeur ajoutée à un type existant,
--     donc pas de fichier de valeurs à part.
--  2. grocery_product_references : le prix et sa date deviennent facultatifs (les deux ou aucun, prix > 0 quand il existe) ; nouvelles colonnes compliance_status
--     (défaut compliant) et composition_text (2 000 caractères au plus).
--  3. v_grocery_product_references : conformité = statut différent de « none_found » ET aucun critère actif correspondant ; colonnes ajoutées à la fin (has_price,
--     compliance_status, needs_label_check, composition_text) ; commentaires mis à jour.
--  4. Rayon de départ « Crèmerie » renommé « Crémerie » (renommé ; s'il existe déjà un rayon « Crémerie », l'ancien y est fusionné par merge_grocery_aisles()).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public' WHERE t.typname = 'grocery_reference_status') THEN
    CREATE TYPE grocery_reference_status AS ENUM ('compliant', 'to_check', 'none_found', 'not_applicable');
  END IF;
END $$;

ALTER TABLE grocery_product_references ALTER COLUMN unit_price DROP NOT NULL;
ALTER TABLE grocery_product_references ALTER COLUMN price_date DROP NOT NULL;
ALTER TABLE grocery_product_references ADD COLUMN IF NOT EXISTS compliance_status grocery_reference_status NOT NULL DEFAULT 'compliant';
ALTER TABLE grocery_product_references ADD COLUMN IF NOT EXISTS composition_text text CHECK (composition_text IS NULL OR length(composition_text) <= 2000);
ALTER TABLE grocery_product_references DROP CONSTRAINT IF EXISTS ck_grocery_product_references_price;
ALTER TABLE grocery_product_references
  ADD CONSTRAINT ck_grocery_product_references_price CHECK ((unit_price IS NULL) = (price_date IS NULL));

CREATE OR REPLACE VIEW v_grocery_product_references AS
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
       r.composition_text
  FROM grocery_product_references r;

COMMENT ON TABLE grocery_product_references IS $$Référence d'un produit dans une enseigne : nom, prix unitaire (paquet, boîte) et date du prix facultatifs (les deux ou aucun : sans prix connu, « N/A »), additifs contenus, statut de conformité déclaré, résumé de composition. Le prix perd son affichage après 12 mois. La conformité finale se calcule (v_grocery_product_references), elle n'est pas stockée : une modification des critères la recalcule d'elle-même. [US-157 RF8, US-166 RF1, RF3, US-167 RF2, CR-36, CR-37]$$;
COMMENT ON COLUMN grocery_product_references.unit_price IS $$Prix unitaire de la référence ; vide = prix inconnu (« N/A », jamais un prix inventé). Vide en même temps que la date du prix. [US-157 RF8, CR-36]$$;
COMMENT ON COLUMN grocery_product_references.compliance_status IS $$Statut du catalogue d'origine : compliant = conforme, not_applicable = sans objet (produit frais), to_check = à vérifier (ingrédients non publiés : proposée avec « Composition à vérifier sur l'étiquette »), none_found = aucun conforme trouvé (jamais proposée, listée dans « Ingrédients exclus des références proposées »). Une liste d'additifs qui correspond à un critère actif rend la référence non conforme quel que soit ce statut. [US-166, US-167, CR-37]$$;
COMMENT ON COLUMN grocery_product_references.composition_text IS $$Résumé de la composition en texte libre (2 000 caractères au plus), tel que donné par le catalogue d'origine ; facultatif. [CR-37]$$;
COMMENT ON VIEW v_grocery_product_references IS $$Références par enseigne avec leur ancienneté (fresh / aging / NULL au-delà de 12 mois ou sans prix ; has_price les distingue : sans prix, « N/A ») et leur conformité, recalculée à chaque lecture : non conforme si le statut déclaré est « aucun conforme trouvé » (none_found) ou si un additif correspond à un critère actif, quel que soit le statut (excluded_because liste alors les critères). Une référence non conforme n'est jamais proposée et sert à la rubrique « Ingrédients exclus des références proposées ». needs_label_check : référence proposée avec la mention « Composition à vérifier sur l'étiquette » (statut « à vérifier »). [US-157 RF1, RF8, US-166 RF3, US-167 RF2, CA 1.1, CR-36, CR-37]$$;

DO $$
DECLARE v_old integer; v_new integer;
BEGIN
  SELECT id INTO v_old FROM grocery_aisles WHERE grocery_norm(name) = grocery_norm('Crèmerie');
  SELECT id INTO v_new FROM grocery_aisles WHERE grocery_norm(name) = grocery_norm('Crémerie');
  IF v_old IS NOT NULL AND v_new IS NULL THEN
    UPDATE grocery_aisles SET name = 'Crémerie' WHERE id = v_old;
  ELSIF v_old IS NOT NULL AND v_new IS NOT NULL THEN
    PERFORM merge_grocery_aisles(v_old, v_new);
  END IF;
END $$;
