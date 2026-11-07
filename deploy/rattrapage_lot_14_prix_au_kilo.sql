-- MAAQ — rattrapage additif du lot 14 (prix au kilo ou au litre, décisions CR-39 et CR-40) pour une base qui a DÉJÀ reçu lot_14_2_schema.sql (5298e454…),
-- rattrapage_lot_14_references_sans_prix.sql (ebbb0218…), rattrapage_lot_14_secondaire_et_agent.sql (9e3600f1…) et rattrapage_lot_14_format_references.sql (deeeda5e…),
-- dans cet ordre. Une base neuve applique le lot_14_2_schema.sql régénéré (nouvelle empreinte) et n'a pas besoin de ce fichier. Une seule transaction, idempotent.
-- Aucune valeur d'énumération (contraintes CHECK sur du texte) : pas de fichier de valeurs à part. Une seule instruction touche des lignes (point 2, remplissage unique).
--  1. grocery_receipt_lines : poids ou volume mesuré (measured_quantity, measure_unit kg ou l) et prix au kilo ou au litre (price_per_measure), facultatifs ; trigger qui
--     calcule le prix quand le ticket ne le donne pas (total ÷ poids, arrondi à 2 décimales ; le prix lu l'emporte).
--  2. grocery_product_references : package_amount et package_unit (quantité du format en kg ou l), price_unit (prix par article, kg ou l) ; fonction grocery_parse_package()
--     (jamais de poids moyen par pièce) ; trigger de déduction à l'écriture ; REMPLISSAGE UNIQUE des références existantes dont le format est compris (une instruction UPDATE) ;
--     v_grocery_product_references : colonnes ajoutées à la fin.
--  3. grocery_shared_prices : price_unit (unit, kg, l, défaut unit) ; la contrainte d'unicité uq_grocery_shared_prices_line est REMPLACÉE (même nom, price_unit en plus) ;
--     le trigger d'immutabilité est remplacé ; share_grocery_price() est SUPPRIMÉE puis recréée (8e paramètre p_price_unit, valeur par défaut : les appels à 7 arguments
--     continuent de marcher) ; grocery_shared_prices_for() est SUPPRIMÉE puis recréée (trois colonnes de plus) ; v_grocery_shared_prices_moderation : médiane par unité.
--  4. grocery_list_items : price_unit (copié de la référence à la validation) ; contrainte ck_grocery_list_items_no_store REMPLACÉE ; grocery_carry_over_unbought() remplacée ;
--     grocery_list_for() est SUPPRIMÉE puis recréée (price_unit en dernière colonne).

-- 1. Lignes de ticket
ALTER TABLE grocery_receipt_lines ADD COLUMN IF NOT EXISTS measured_quantity numeric(9,3) CHECK (measured_quantity > 0);
ALTER TABLE grocery_receipt_lines ADD COLUMN IF NOT EXISTS measure_unit varchar(2) CHECK (measure_unit IN ('kg', 'l'));
ALTER TABLE grocery_receipt_lines ADD COLUMN IF NOT EXISTS price_per_measure numeric(8,2) CHECK (price_per_measure > 0);
ALTER TABLE grocery_receipt_lines DROP CONSTRAINT IF EXISTS ck_grocery_receipt_lines_measure;
ALTER TABLE grocery_receipt_lines
  ADD CONSTRAINT ck_grocery_receipt_lines_measure CHECK ((measured_quantity IS NULL) = (measure_unit IS NULL) AND (price_per_measure IS NULL OR measured_quantity IS NOT NULL));
CREATE OR REPLACE FUNCTION grocery_receipt_line_measure_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS trg_grocery_receipt_lines_measure ON grocery_receipt_lines;
CREATE TRIGGER trg_grocery_receipt_lines_measure BEFORE INSERT OR UPDATE ON grocery_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION grocery_receipt_line_measure_before_write();
COMMENT ON COLUMN grocery_receipt_lines.measured_quantity IS $$Poids ou volume mesuré à la caisse, en kilogrammes ou en litres (« 1,234 kg ») ; vide pour une ligne vendue à la pièce. Les grammes et les centilitres sont convertis avant l'écriture. Reste dans le foyer : jamais partagé. quantity (nombre d'articles) ne le porte pas. [CR-39]$$;
COMMENT ON COLUMN grocery_receipt_lines.measure_unit IS $$Unité du poids ou du volume mesuré : kg ou l. Vide en même temps que la quantité mesurée ; vide = vendu à la pièce. [CR-39]$$;
COMMENT ON COLUMN grocery_receipt_lines.price_per_measure IS $$Prix au kilo ou au litre lu sur le ticket (« 1,49 €/kg »). S'il n'est pas lu et que le poids est connu, il est calculé (total de la ligne divisé par le poids, arrondi à 2 décimales) ; le prix lu l'emporte toujours. Vide sans poids, sur une remise, ou si le calcul sort des bornes. [CR-39, CR-40]$$;
COMMENT ON TABLE grocery_receipt_lines IS $$Ligne d'un ticket : produit, référence, prix total de la ligne, quantité, poids ou volume mesuré et prix au kilo ou au litre pour un article pesé, rayon (choisi dans la liste des rayons). Les lignes alimentent le budget par rayon, les prix du foyer et les produits de son historique. [US-161 RF2 à RF5, US-163, CR-39]$$;
COMMENT ON FUNCTION grocery_receipt_line_measure_before_write() IS $$Calcule le prix au kilo ou au litre d'une ligne pesée quand le ticket ne le donne pas : total de la ligne divisé par le poids, arrondi à 2 décimales. Le prix lu sur le ticket l'emporte toujours ; rien n'est calculé sans poids, sur une remise ou hors bornes. [CR-39, CR-40]$$;

-- 2. Références
ALTER TABLE grocery_product_references ADD COLUMN IF NOT EXISTS package_amount numeric(10,3) CHECK (package_amount > 0);
ALTER TABLE grocery_product_references ADD COLUMN IF NOT EXISTS package_unit varchar(2) CHECK (package_unit IN ('kg', 'l'));
ALTER TABLE grocery_product_references ADD COLUMN IF NOT EXISTS price_unit varchar(4) NOT NULL DEFAULT 'unit' CHECK (price_unit IN ('unit', 'kg', 'l'));
ALTER TABLE grocery_product_references DROP CONSTRAINT IF EXISTS ck_grocery_product_references_package;
ALTER TABLE grocery_product_references
  ADD CONSTRAINT ck_grocery_product_references_package CHECK ((package_amount IS NULL) = (package_unit IS NULL));
CREATE OR REPLACE FUNCTION grocery_parse_package(p_format text) RETURNS TABLE (amount numeric, unit text) LANGUAGE plpgsql IMMUTABLE AS $$
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
CREATE OR REPLACE FUNCTION grocery_product_reference_package_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS trg_grocery_product_references_package ON grocery_product_references;
CREATE TRIGGER trg_grocery_product_references_package BEFORE INSERT OR UPDATE ON grocery_product_references
  FOR EACH ROW EXECUTE FUNCTION grocery_product_reference_package_before_write();

-- Remplissage unique : les références existantes dont le format est compris reçoivent leur quantité en kg ou en litres (les autres restent vides)
UPDATE grocery_product_references r
   SET package_amount = p.amount, package_unit = p.unit
  FROM (SELECT x.id, f.amount, f.unit
          FROM grocery_product_references x
         CROSS JOIN LATERAL grocery_parse_package(x.package_format) f
         WHERE x.package_format IS NOT NULL AND x.package_amount IS NULL AND x.package_unit IS NULL AND f.amount IS NOT NULL) p
 WHERE r.id = p.id;

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
COMMENT ON COLUMN grocery_product_references.package_format IS $$Format du conditionnement de la référence (« 1 kg », « sachet de 250 g »), 80 caractères au plus, facultatif ; colonne « format » du fichier d'import des références. Visible de tous les profils du foyer, sans prix. [US-166 RF2, US-157 RF7]$$;
COMMENT ON COLUMN grocery_product_references.package_amount IS $$Quantité du format en kilogrammes ou en litres (« 500 g » = 0,5 kg, « 75 cl » = 0,75 l, « 6 x 33 cl » = 1,98 l), vide quand le format n'est pas compris (« 6 œufs », « la pièce »). Déduite de package_format à l'écriture (grocery_parse_package) ; si l'import la fournit avec package_unit, elle prime. Aucun poids moyen par pièce n'est jamais supposé. [CR-39]$$;
COMMENT ON COLUMN grocery_product_references.package_unit IS $$Unité de package_amount : kg ou l (les grammes et les centilitres sont convertis). Vide en même temps que la quantité. [CR-39]$$;
COMMENT ON COLUMN grocery_product_references.price_unit IS $$Unité dans laquelle unit_price est exprimé : unit = par article (défaut, un paquet, une boîte), kg ou l = par kilo ou par litre (produit vendu au poids ou en vrac). Un article au kilo n'entre pas dans le total estimé de la liste. [CR-39, CR-40]$$;
COMMENT ON COLUMN grocery_product_references.unit_price IS $$Prix unitaire de la référence ; vide = prix inconnu (« N/A », jamais un prix inventé). Vide en même temps que la date du prix. [US-157 RF8, CR-36]$$;
COMMENT ON COLUMN grocery_product_references.compliance_status IS $$Statut du catalogue d'origine : compliant = conforme, not_applicable = sans objet (produit frais), to_check = à vérifier (ingrédients non publiés : proposée avec « Composition à vérifier sur l'étiquette »), none_found = aucun conforme trouvé (jamais proposée, listée dans « Ingrédients exclus des références proposées »). Une liste d'additifs qui correspond à un critère actif rend la référence non conforme quel que soit ce statut. [US-166, US-167, CR-37]$$;
COMMENT ON COLUMN grocery_product_references.composition_text IS $$Résumé de la composition en texte libre (2 000 caractères au plus), tel que donné par le catalogue d'origine ; facultatif. [CR-37]$$;
COMMENT ON COLUMN grocery_product_references.additives IS $$Additifs de la référence (codes comme E250 ou noms), normalisés par l'application ; comparés aux critères actifs de grocery_additive_criteria$$;
COMMENT ON VIEW v_grocery_product_references IS $$Références par enseigne avec leur ancienneté (fresh / aging / NULL au-delà de 12 mois ou sans prix ; has_price les distingue : sans prix, « N/A ») et leur conformité, recalculée à chaque lecture : non conforme si le statut déclaré est « aucun conforme trouvé » (none_found) ou si un additif correspond à un critère actif, quel que soit le statut (excluded_because liste alors les critères). Une référence non conforme n'est jamais proposée et sert à la rubrique « Ingrédients exclus des références proposées ». needs_label_check : référence proposée avec la mention « Composition à vérifier sur l'étiquette » (statut « à vérifier »). package_format : format du conditionnement. package_amount, package_unit : sa quantité en kg ou en litres. price_unit : le prix est par article, par kg ou par litre. measure_unit, price_per_measure : prix au kilo ou au litre, calculé (le prix tel quel s'il est déjà au kilo, sinon le prix divisé par la quantité du format) ; vide sans prix ou sans quantité connue, jamais estimé. [US-157 RF1, RF8, US-166 RF3, US-167 RF2, CA 1.1, CR-36, CR-37, CR-39]$$;
COMMENT ON FUNCTION grocery_parse_package(text) IS $$Lit un format de conditionnement et rend sa quantité en kg ou en litres : « 1 kg », « 500 g », « 1,5 l », « 75 cl », « sachet de 250 g », « 6 x 33 cl » (= 1,98 l). Rend des valeurs vides quand le format n'est pas compris (« 6 œufs », « 1 pièce », « barquette ») : rien n'est deviné, aucun poids moyen par pièce. [CR-39]$$;
COMMENT ON FUNCTION grocery_product_reference_package_before_write() IS $$Remplit package_amount et package_unit d'après package_format quand ils ne sont pas fournis. Un changement de format seul refait la déduction si les valeurs actuelles étaient celles du format précédent ; des valeurs fournies par l'import (différentes de la déduction) ne sont pas écrasées. [CR-39]$$;

-- 3. Base commune des prix
ALTER TABLE grocery_shared_prices ADD COLUMN IF NOT EXISTS price_unit varchar(4) NOT NULL DEFAULT 'unit' CHECK (price_unit IN ('unit', 'kg', 'l'));
ALTER TABLE grocery_shared_prices DROP CONSTRAINT IF EXISTS uq_grocery_shared_prices_line;
ALTER TABLE grocery_shared_prices
  ADD CONSTRAINT uq_grocery_shared_prices_line UNIQUE (product_id, reference_name, store_chain, city, unit_price, price_unit);
CREATE OR REPLACE FUNCTION grocery_shared_price_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP FUNCTION IF EXISTS share_grocery_price(uuid, bigint, text, numeric, text, text, date);
CREATE OR REPLACE FUNCTION share_grocery_price(p_account uuid, p_product_id bigint, p_reference_name text, p_unit_price numeric, p_store_chain text, p_city text,
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
DROP FUNCTION IF EXISTS grocery_shared_prices_for(uuid);
CREATE OR REPLACE FUNCTION grocery_shared_prices_for(p_viewer uuid)
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
CREATE OR REPLACE VIEW v_grocery_shared_prices_moderation AS
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
COMMENT ON TABLE grocery_shared_prices IS $$Base commune des prix partagés par les foyers qui l'ont accepté : produit, référence, prix unitaire, enseigne, ville du magasin, semaine. ANONYME PAR CONSTRUCTION : aucune colonne foyer, profil ou jour, aucun moyen de retrouver qui a partagé. Une seule porte d'écriture, share_grocery_price() ; la lecture par un foyer passe par grocery_shared_prices_for() (réciprocité, enseignes de proximité, ville affichée dès 2 foyers). Les lignes déjà partagées restent quand le partage est désactivé. [US-154, US-175, CR-03, CR-12, CR-17]$$;
COMMENT ON COLUMN grocery_shared_prices.price_unit IS $$Unité de unit_price : unit = par article (défaut), kg ou l = par kilo ou par litre (ligne de ticket pesée). Seul le prix au kilo est partagé, jamais le poids du ticket. Les comparaisons et la médiane de contrôle ne rapprochent que des prix de même unité. [CR-39]$$;
COMMENT ON COLUMN grocery_shared_prices.week_start IS $$Lundi de la semaine du relevé (jamais le jour du ticket) ; remis à la semaine la plus récente quand une ligne identique est partagée de nouveau. [CR-17, US-154 RT1]$$;
COMMENT ON COLUMN grocery_shared_prices.removed_at IS $$Retirée par l'administrateur (prix erroné) : la ligne n'est plus utilisée dans les comparatifs ni dans la médiane de contrôle. [US-175 RF3]$$;
COMMENT ON FUNCTION share_grocery_price(uuid, bigint, text, numeric, text, text, date, text) IS $$Seule porte d'écriture de la base commune des prix. Le prix est par article, par kg ou par litre (p_price_unit : unit, kg, l) ; un article pesé est partagé avec son prix au kilo, jamais avec son poids. Reçoit le foyer pour vérifier qu'il partage ses prix (sinon ne fait rien et retourne NULL) mais ne le garde pas : la date du ticket devient le lundi de sa semaine. Une ligne identique (même unité de prix comprise) n'est pas dupliquée : sa semaine est mise à jour. Exécutée avec les droits du propriétaire. [US-154 RF1, RF2, RF4, RT1, CR-17, CR-39]$$;
COMMENT ON FUNCTION grocery_shared_prices_for(uuid) IS $$Prix des autres foyers lisibles par un profil du couple : seulement s'il partage lui-même ses prix (réciprocité), pour ses enseignes de proximité (enseigne et ville), dans une ville où au moins 2 foyers partagent, le foyer qui consulte comptant aussi dans la ville consultée (une ville voisine est visible dès qu'un autre foyer y est inscrit ; dans sa propre ville il est déjà compté), hors lignes retirées et au plus 12 mois. Chaque prix porte son enseigne, sa ville et son ancienneté, son unité (par article, kg ou litre) et, quand il peut l'être, son prix au kilo ou au litre (le prix lui-même s'il est déjà au kilo, sinon le prix divisé par la quantité du format de la référence ; vide sans format connu, jamais estimé). Aucun lien avec un foyer. Exécutée avec les droits du propriétaire. [US-154 RF3, RT2, US-157 RF4, US-166 RF3, CR-12, CR-17, CR-21, CR-35, CR-39]$$;
COMMENT ON VIEW v_grocery_shared_prices_moderation IS $$Base commune pour la modération, avec le signalement « à vérifier » : le prix est comparé à la médiane du même produit dans la même enseigne sur 12 mois (au moins 3 autres valeurs), sinon au prix de référence de l'enseigne ; il est à vérifier sous 50 % ou au-dessus de 200 % de cette base. Sans aucune base : sous 0,05 € ou au-dessus de 500 €. Les quatre bornes, le nombre de valeurs et la fenêtre sont des réglages de la console. Une ligne retirée n'est jamais signalée. Aucune colonne ne retrouve le foyer. Un prix au kilo ou au litre n'est comparé qu'à des prix de même unité (médiane) ou, à défaut, au prix au kilo ou au litre des références (price_unit, en dernière colonne). [US-175 RF1 à RF4, CR-33, CR-39]$$;

-- 4. Liste de courses
ALTER TABLE grocery_list_items ADD COLUMN IF NOT EXISTS price_unit varchar(4) CHECK (price_unit IS NULL OR price_unit IN ('unit', 'kg', 'l'));
ALTER TABLE grocery_list_items DROP CONSTRAINT IF EXISTS ck_grocery_list_items_no_store;
ALTER TABLE grocery_list_items
  ADD CONSTRAINT ck_grocery_list_items_no_store CHECK (state NOT IN ('preparing', 'added_after_validation') OR (store_chain IS NULL AND reference_name IS NULL AND unit_price IS NULL AND price_unit IS NULL));
ALTER TABLE grocery_list_items DROP CONSTRAINT IF EXISTS ck_grocery_list_items_price_unit;
ALTER TABLE grocery_list_items
  ADD CONSTRAINT ck_grocery_list_items_price_unit CHECK (price_unit IS NULL OR store_chain IS NOT NULL);
CREATE OR REPLACE FUNCTION grocery_carry_over_unbought(p_account uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  UPDATE grocery_list_items
     SET state = 'preparing', list_id = NULL, store_chain = NULL, reference_name = NULL, unit_price = NULL, price_unit = NULL, not_bought_last_time = true
   WHERE account_id = p_account AND state IN ('validated', 'added_after_validation');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
DROP FUNCTION IF EXISTS grocery_list_for(uuid);
CREATE OR REPLACE FUNCTION grocery_list_for(p_viewer uuid)
RETURNS TABLE (id uuid, list_id uuid, state grocery_item_state, source text, label varchar, name_key text, product_id bigint, aisle_id integer, quantity smallint,
               added_by_user_id uuid, not_bought_last_time boolean, store_chain varchar, reference_name varchar, unit_price numeric, bought_at timestamptz,
               bought_by_user_id uuid, package_format varchar, price_unit varchar)
LANGUAGE sql STABLE AS $$
  SELECT i.id, i.list_id, i.state, i.source, i.label, i.name_key, i.product_id, i.aisle_id, i.quantity, i.added_by_user_id, i.not_bought_last_time,
         i.store_chain, i.reference_name, CASE WHEN grocery_access(p_viewer) = 'couple' THEN i.unit_price END, i.bought_at, i.bought_by_user_id,
         (SELECT r.package_format FROM grocery_product_references r
           WHERE r.product_id = i.product_id AND r.store_chain = i.store_chain AND r.reference_name = i.reference_name),
         i.price_unit
    FROM users v
    JOIN grocery_list_items i ON i.account_id = v.account_id
   WHERE v.id = p_viewer AND grocery_access(p_viewer) IS NOT NULL
$$;
COMMENT ON COLUMN grocery_list_items.price_unit IS $$Unité de unit_price, copiée de la référence choisie à la validation : unit (ou vide) = par article, kg ou l = par kilo ou par litre. Un article au kilo ou au litre s'affiche « x,xx €/kg » avec la mention « prix au kilo, non totalisé » et n'entre pas dans le total estimé : l'application ne totalise que les articles dont price_unit est vide ou unit. Aucun poids n'est supposé. [CR-40]$$;
COMMENT ON FUNCTION grocery_carry_over_unbought(uuid) IS $$Reprend dans la préparation suivante les produits non achetés de la liste validée et du bloc « Ajoutés depuis la validation » : ils redeviennent « en préparation », sans magasin ni prix, avec la mention « pas acheté la dernière fois ». Retourne le nombre de produits repris. À appeler à l'ouverture de la préparation de la liste. [US-162 RF4, CR-28]$$;
COMMENT ON FUNCTION grocery_list_for(uuid) IS $$Articles de la liste de courses de la famille d'un profil, pour l'affichage : le prix estimé n'est rendu qu'au couple, l'invité secondaire ne voit aucun prix (il voit le magasin, la référence, le format du conditionnement et l'unité du prix, sans prix). L'application l'utilise pour lire la liste ; tant qu'elle se connecte avec un seul rôle, la protection effective des colonnes est cette fonction et le code (H150). [US-157 RF8, US-158, CR-10, CR-38, CR-40]$$;
