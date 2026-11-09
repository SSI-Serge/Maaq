-- MAAQ — rattrapage additif du lot 14 (quantités des recettes et des scénarios d'achat : recettes écrites pour le nombre de personnes du foyer pour tout plat, quantité et unité par ingrédient,
-- besoins du menu par produit, produits « placard » ; décisions CR-49, CR-50 et CR-51), À APPLIQUER APRÈS rattrapage_lot_14_menu_libre.sql (b4ca9553…) ET rattrapage_lot_14_plafond_menus.sql
-- (288a9a44…), qui ne sont pas modifiés. Une base neuve applique le lot_14_2_schema.sql régénéré (nouvelle empreinte) et n'a pas besoin de ce fichier. Une seule transaction, idempotent.
-- Aucune valeur d'énumération. UNE SEULE instruction réécrit des lignes (décision CR-51) : le marquage « placard » des produits déjà chargés, d'après leur nom normalisé, fait UNE SEULE FOIS au
-- moment où la colonne est créée (une nouvelle application du fichier ne remet jamais en cause les corrections faites ensuite dans la console) ; le nombre de produits marqués et leurs noms
-- sont donnés par un message (NOTICE) à l'exécution.
--  1. grocery_products.is_pantry (faux par défaut) ; marquage initial des produits dont le nom contient : sel, poivre, huile(s), vinaigre(s), sucre, farine, levure, moutarde, bouillon(s), épice(s),
--     quatre-épices, cumin, paprika, curry, cannelle, curcuma, muscade, herbes de Provence, herbes séchées ou sèches (mots entiers). Le nom normalisé du catalogue peut être écrit AVEC ou SANS
--     accents (la normalisation fine est celle de l'application) : le motif accepte les deux (« epices », « épices », « quatre epices », « quatre-épices », « herbes sechees », « herbes séchées »).
--  2. meal_menus.servings : nombre de personnes pour lequel le menu est écrit.
--  3. meal_menu_entries : la contrainte ck_meal_menu_entries_free_dish est REMPLACÉE (la recette est permise pour toute origine ; la cuisine et la durée restent réservées au plat libre).
--  4. meal_menu_entry_ingredients : quantity, unit (g, kg, ml, cl, l, piece, spoon, pinch) et deux colonnes calculées base_unit et base_quantity ; contrainte ck_meal_menu_entry_ingredients_quantity.
--     meal_menu_entry_needs_ingredient() REMPLACÉE : tout plat du menu, de toute origine, a au moins un ingrédient (contrôle différé, nouvelles lignes seulement).
--  5. Vue v_meal_menu_needs (besoins d'un menu par produit et par unité de base, à droits de l'appelant).
--  6. grocery_list_items : needed_amount, needed_unit, quantity_to_check, is_pantry, is_selected ; grocery_carry_over_unbought() REMPLACÉE ; grocery_list_for() SUPPRIMÉE puis recréée (cinq colonnes de plus).

DO $$
DECLARE v_n integer; v_names text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grocery_products' AND column_name = 'is_pantry') THEN
    ALTER TABLE grocery_products ADD COLUMN is_pantry boolean NOT NULL DEFAULT false;
    WITH m AS (
      UPDATE grocery_products SET is_pantry = true
       WHERE name_key ~ '(^| )(sel|poivre|huiles?|vinaigres?|sucre|farine|levure|moutarde|bouillons?|[eé]pices?|quatre[- ][eé]pices|cumin|paprika|curry|cannelle|curcuma|muscade|herbes de provence|herbes s[eé]ch[eé]es|herbes s[eèé]ches)( |$)'
      RETURNING name_key)
    SELECT count(*), string_agg(name_key, ', ' ORDER BY name_key) INTO v_n, v_names FROM m;
    RAISE NOTICE 'Produits marqués « placard » : % (%)', v_n, COALESCE(v_names, 'aucun');
  END IF;
END $$;

ALTER TABLE meal_menus ADD COLUMN IF NOT EXISTS servings smallint CHECK (servings BETWEEN 1 AND 30);

ALTER TABLE meal_menu_entries DROP CONSTRAINT IF EXISTS ck_meal_menu_entries_free_dish;
ALTER TABLE meal_menu_entries
  ADD CONSTRAINT ck_meal_menu_entries_free_dish CHECK ((dish_origin = 'ai' AND cuisine_id IS NOT NULL) OR (dish_origin <> 'ai' AND cuisine_id IS NULL AND duration_minutes IS NULL));

ALTER TABLE meal_menu_entry_ingredients ADD COLUMN IF NOT EXISTS quantity numeric(10,3) CHECK (quantity > 0);
ALTER TABLE meal_menu_entry_ingredients ADD COLUMN IF NOT EXISTS unit text CHECK (unit IN ('g', 'kg', 'ml', 'cl', 'l', 'piece', 'spoon', 'pinch'));
ALTER TABLE meal_menu_entry_ingredients ADD COLUMN IF NOT EXISTS base_unit text GENERATED ALWAYS AS (CASE unit WHEN 'g' THEN 'g' WHEN 'kg' THEN 'g' WHEN 'ml' THEN 'ml' WHEN 'cl' THEN 'ml' WHEN 'l' THEN 'ml' WHEN 'piece' THEN 'piece' END) STORED;
ALTER TABLE meal_menu_entry_ingredients ADD COLUMN IF NOT EXISTS base_quantity numeric(14,3) GENERATED ALWAYS AS (CASE unit WHEN 'g' THEN quantity WHEN 'kg' THEN quantity * 1000 WHEN 'ml' THEN quantity WHEN 'cl' THEN quantity * 10 WHEN 'l' THEN quantity * 1000 WHEN 'piece' THEN quantity END) STORED;
ALTER TABLE meal_menu_entry_ingredients DROP CONSTRAINT IF EXISTS ck_meal_menu_entry_ingredients_quantity;
ALTER TABLE meal_menu_entry_ingredients
  ADD CONSTRAINT ck_meal_menu_entry_ingredients_quantity CHECK ((quantity IS NULL) = (unit IS NULL));
CREATE OR REPLACE FUNCTION meal_menu_entry_needs_ingredient() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE VIEW v_meal_menu_needs WITH (security_invoker = true) AS
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

ALTER TABLE grocery_list_items ADD COLUMN IF NOT EXISTS needed_amount numeric(12,3) CHECK (needed_amount > 0);
ALTER TABLE grocery_list_items ADD COLUMN IF NOT EXISTS needed_unit text CHECK (needed_unit IN ('g', 'ml', 'piece'));
ALTER TABLE grocery_list_items ADD COLUMN IF NOT EXISTS quantity_to_check boolean NOT NULL DEFAULT false;
ALTER TABLE grocery_list_items ADD COLUMN IF NOT EXISTS is_pantry boolean NOT NULL DEFAULT false;
ALTER TABLE grocery_list_items ADD COLUMN IF NOT EXISTS is_selected boolean NOT NULL DEFAULT true;
ALTER TABLE grocery_list_items DROP CONSTRAINT IF EXISTS ck_grocery_list_items_needed;
ALTER TABLE grocery_list_items
  ADD CONSTRAINT ck_grocery_list_items_needed CHECK ((needed_amount IS NULL) = (needed_unit IS NULL));
CREATE OR REPLACE FUNCTION grocery_carry_over_unbought(p_account uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  UPDATE grocery_list_items
     SET state = 'preparing', list_id = NULL, store_chain = NULL, reference_name = NULL, unit_price = NULL, price_unit = NULL, not_bought_last_time = true,
         needed_amount = NULL, needed_unit = NULL, quantity_to_check = false, is_pantry = false, is_selected = true
   WHERE account_id = p_account AND state IN ('validated', 'added_after_validation');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
DROP FUNCTION IF EXISTS grocery_list_for(uuid);
CREATE OR REPLACE FUNCTION grocery_list_for(p_viewer uuid)
RETURNS TABLE (id uuid, list_id uuid, state grocery_item_state, source text, label varchar, name_key text, product_id bigint, aisle_id integer, quantity smallint,
               added_by_user_id uuid, not_bought_last_time boolean, store_chain varchar, reference_name varchar, unit_price numeric, bought_at timestamptz,
               bought_by_user_id uuid, package_format varchar, price_unit varchar, needed_amount numeric, needed_unit text, quantity_to_check boolean, is_pantry boolean,
               is_selected boolean)
LANGUAGE sql STABLE AS $$
  SELECT i.id, i.list_id, i.state, i.source, i.label, i.name_key, i.product_id, i.aisle_id, i.quantity, i.added_by_user_id, i.not_bought_last_time,
         i.store_chain, i.reference_name, CASE WHEN grocery_access(p_viewer) = 'couple' THEN i.unit_price END, i.bought_at, i.bought_by_user_id,
         (SELECT r.package_format FROM grocery_product_references r
           WHERE r.product_id = i.product_id AND r.store_chain = i.store_chain AND r.reference_name = i.reference_name),
         i.price_unit, i.needed_amount, i.needed_unit, i.quantity_to_check, i.is_pantry, i.is_selected
    FROM users v
    JOIN grocery_list_items i ON i.account_id = v.account_id
   WHERE v.id = p_viewer AND grocery_access(p_viewer) IS NOT NULL
$$;

COMMENT ON COLUMN grocery_products.is_pantry IS $$Produit « placard » (sel, poivre, huiles, vinaigres, épices, herbes séchées, bouillons en cube, sucre, farine, levure, moutarde…) : dans la liste de courses il est décoché par défaut avec « Vous en avez peut-être déjà » et ne compte dans le total que s'il est coché. Réglé produit par produit dans la console (US-166) ; une quantité en cuillère ou en pincée rend aussi un ingrédient « placard », quelle que soit cette valeur. [CR-50, CR-51]$$;
COMMENT ON COLUMN grocery_products.name_key IS $$Nom normalisé du produit (minuscules, espaces simples) : clé d'unicité, calculée par l'application. Un produit sans ligne ici est « inconnu » (produits à référencer). [CR-25, US-173 RF1]$$;
COMMENT ON COLUMN meal_menus.servings IS $$Nombre de personnes pour lequel l'IA a écrit les recettes et les quantités du menu (« Pour 6 personnes »), gardé avec le menu : le foyer peut changer ensuite. Vide pour un menu validé avant CR-49. [US-156 RF11, CR-49]$$;
COMMENT ON COLUMN meal_menu_entries.recipe IS $$Recette en texte, écrite par l'IA pour le nombre de personnes du foyer (meal_menus.servings), pour tout plat du menu : plat libre, plat du catalogue ou de Mes plats (le plat d'origine n'est pas modifié). Vide si le plat de Mes plats n'a pas de recette. [US-156 RF11, CR-42, CR-49]$$;
COMMENT ON TABLE meal_menu_entry_ingredients IS $$Ingrédients d'un plat d'un menu validé, de toute origine : nom, clé normalisée, produit du catalogue s'il est reconnu (un ingrédient inconnu entre dans la liste sans prix et dans les produits à référencer), quantité et unité écrites par l'IA pour le nombre de personnes du foyer (CR-50, qui remplace CR-25 pour les menus ; les plats du catalogue et de Mes plats ne changent pas). Tout plat du menu a au moins un ingrédient (contrôlé à la validation de la transaction). Les quantités, additionnées par produit (v_meal_menu_needs) puis divisées par le format de la référence, donnent le nombre d'unités à acheter. Jamais dans le catalogue commun ; conservé et purgé avec le menu. [US-156 RF8, RF11, RT3, RT4, US-157 RF7bis, CR-04, CR-42, CR-49, CR-50]$$;
COMMENT ON COLUMN meal_menu_entry_ingredients.quantity IS $$Quantité de l'ingrédient pour le nombre de personnes du foyer, dans l'unité unit ; vide si l'IA n'en a pas donné (la liste met alors 1 unité, « Quantité à vérifier »). Vide en même temps que l'unité. [CR-50]$$;
COMMENT ON COLUMN meal_menu_entry_ingredients.unit IS $$Unité de la quantité : g, kg, ml, cl, l, piece (pièce), spoon (cuillère) ou pinch (pincée). Une cuillère et une pincée rendent l'ingrédient « placard » et ne se convertissent pas. [CR-50, CR-51]$$;
COMMENT ON COLUMN meal_menu_entry_ingredients.base_unit IS $$Unité de base calculée par la base : g (g, kg), ml (ml, cl, l) ou piece ; vide pour une cuillère, une pincée ou une quantité absente. [CR-50]$$;
COMMENT ON COLUMN meal_menu_entry_ingredients.base_quantity IS $$Quantité ramenée en g, ml ou pièce (kg x 1000, cl x 10, l x 1000), calculée par la base ; vide en même temps que base_unit. [CR-50]$$;
COMMENT ON FUNCTION meal_menu_entry_needs_ingredient() IS $$Contrôle différé : tout plat d'un menu, de toute origine, a au moins un ingrédient à la fin de la transaction (les lignes de menus validés avant CR-49 ne sont pas revérifiées). [US-156 RF8, RT3, CR-42, CR-49, CR-51]$$;
COMMENT ON VIEW v_meal_menu_needs IS $$Besoins d'un menu validé par produit (ou par nom d'ingrédient inconnu du catalogue) et par unité de base (g, ml, piece) : total des quantités, nombre d'ingrédients additionnés, needs_check (une quantité manque : 1 unité et « Quantité à vérifier »), is_pantry (produit « placard » ou quantité en cuillère ou en pincée : décoché par défaut). Les cuillères, pincées et quantités absentes ont une unité de base vide. L'application divise ensuite le total par le format de la référence choisie et arrondit au paquet supérieur. Vue à droits de l'appelant : la sécurité par ligne du couple s'applique. [US-157 RF7bis, CR-50]$$;
COMMENT ON COLUMN grocery_list_items.needed_amount IS $$Besoin du menu pour ce produit, additionné sur tous les plats (plats express compris) pour le nombre de personnes du foyer, en g, ml ou pièce ; sert à afficher l'origine de la quantité (« 2 paquets · 900 g pour le menu »). Pour un produit au poids, poids x prix au kilo entre dans le total. Vide pour un produit ajouté à la main ou de l'historique (1 par défaut). [US-157 RF7bis, RF8, CR-50]$$;
COMMENT ON COLUMN grocery_list_items.needed_unit IS $$Unité de needed_amount : g, ml ou piece. Vide en même temps que la quantité. [CR-50]$$;
COMMENT ON COLUMN grocery_list_items.quantity_to_check IS $$Vrai quand la quantité n'a pas pu être calculée (format de la référence inconnu, unité incompatible comme « 2 pièces » pour une référence en grammes, quantité absente) : 1 unité, avec la mention « Quantité à vérifier ». [US-157 RF7bis, CR-50]$$;
COMMENT ON COLUMN grocery_list_items.is_pantry IS $$Produit « placard » (étiquette du produit ou quantité en cuillère ou en pincée) : affiché avec « Vous en avez peut-être déjà ». [US-157 RF7bis, CR-50]$$;
COMMENT ON COLUMN grocery_list_items.is_selected IS $$Coché pour l'achat. Un produit « placard » démarre décoché et ne compte dans le total que s'il est coché. [US-157 RF7bis, CR-50]$$;
COMMENT ON FUNCTION grocery_carry_over_unbought(uuid) IS $$Reprend dans la préparation suivante les produits non achetés de la liste validée et du bloc « Ajoutés depuis la validation » : ils redeviennent « en préparation », sans magasin ni prix, avec la mention « pas acheté la dernière fois ». Retourne le nombre de produits repris. À appeler à l'ouverture de la préparation de la liste. [US-162 RF4, CR-28]$$;
COMMENT ON FUNCTION grocery_list_for(uuid) IS $$Articles de la liste de courses de la famille d'un profil, pour l'affichage : le prix estimé n'est rendu qu'au couple, l'invité secondaire ne voit aucun prix (il voit le magasin, la référence, le format du conditionnement et l'unité du prix, sans prix). L'application l'utilise pour lire la liste ; tant qu'elle se connecte avec un seul rôle, la protection effective des colonnes est cette fonction et le code (H150). [US-157 RF7bis, RF8, US-158, CR-10, CR-38, CR-40, CR-50]$$;
