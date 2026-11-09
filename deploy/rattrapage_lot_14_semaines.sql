-- MAAQ — rattrapage additif du lot 14 (deux semaines : chaque produit de liste est rattaché à son menu, reprise des produits non achetés en pense-bête calculé à la lecture, suppression d'un menu
-- ou d'une liste ; décisions CR-54 et CR-55), À APPLIQUER APRÈS rattrapage_lot_14_quantites.sql (9f702bf4…) pour une base qui a déjà reçu lot_14_2_schema.sql (5298e454…) et les huit
-- rattrapages du lot 14 précédents, dans cet ordre. Une base neuve applique le lot_14_2_schema.sql régénéré (nouvelle empreinte) et n'a pas besoin de ce fichier. Une seule transaction,
-- idempotent. Aucune valeur d'énumération, aucune table nouvelle. Une seule instruction réécrit des lignes : le remplissage de grocery_list_items.menu_id des produits existants, fait UNE SEULE
-- FOIS à la création de la colonne (via la liste pour les produits validés, achetés ou ajoutés après la validation ; via le menu le plus récent du foyer pour les produits en préparation).
-- SI des données existantes ne peuvent pas être rattachées à un menu (produit d'une liste sans menu, ou deux listes pour un même menu), le fichier S'ARRÊTE avec un message qui dit quoi
-- corriger, sans rien supprimer.
--  1. grocery_list_items.menu_id (clé composite vers meal_menus, suppression en cascade) ; contrainte ck_grocery_list_items_menu ; l'index unique des produits ouverts devient (foyer, menu, nom).
--  2. grocery_lists : une seule liste par menu (index unique ux_grocery_lists_menu, qui remplace idx_grocery_lists_menu).
--  3. grocery_list_item_before_write() REMPLACÉE : le produit suit le menu de sa liste (rempli s'il est vide, refusé s'il diffère).
--  4. grocery_carry_over_unbought(compte) est SUPPRIMÉE : la reprise par semaine est la fonction de lecture grocery_leftovers_for(profil, menu) (pense-bêtes, rien n'est recopié).
--  5. grocery_list_for() SUPPRIMÉE puis recréée (menu_id en dernière colonne).
--  6. delete_meal_menu(menu) et delete_grocery_list(menu) : suppressions définitives, couple seulement.

DO $$
DECLARE v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grocery_list_items' AND column_name = 'menu_id') THEN
    SELECT count(*) INTO v_n FROM (SELECT menu_id FROM grocery_lists WHERE menu_id IS NOT NULL GROUP BY menu_id HAVING count(*) > 1) d;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'Rattrapage arrêté, rien n''a été modifié : % menu(s) ont plus d''une liste. Corriger avant : SELECT menu_id, count(*) FROM grocery_lists WHERE menu_id IS NOT NULL GROUP BY menu_id HAVING count(*) > 1;', v_n;
    END IF;
    ALTER TABLE grocery_list_items ADD COLUMN menu_id uuid;
    UPDATE grocery_list_items i SET menu_id = l.menu_id FROM grocery_lists l WHERE i.list_id = l.id AND i.account_id = l.account_id;
    UPDATE grocery_list_items i SET menu_id = (SELECT m.id FROM meal_menus m WHERE m.account_id = i.account_id ORDER BY m.week_start DESC LIMIT 1)
     WHERE i.menu_id IS NULL AND i.list_id IS NULL;
    SELECT count(*) INTO v_n FROM grocery_list_items WHERE menu_id IS NULL AND NOT (state = 'preparing' AND source = 'added');
    IF v_n > 0 THEN
      RAISE EXCEPTION 'Rattrapage arrêté, rien n''a été modifié : % produit(s) de liste ne peuvent pas être rattachés à un menu (liste sans menu, ou produit du menu sans menu). Voir : SELECT id, account_id, state, source, list_id FROM grocery_list_items WHERE menu_id IS NULL AND NOT (state = ''preparing'' AND source = ''added'');', v_n;
    END IF;
  END IF;
END $$;

ALTER TABLE grocery_list_items DROP CONSTRAINT IF EXISTS fk_grocery_list_items_menu;
ALTER TABLE grocery_list_items
  ADD CONSTRAINT fk_grocery_list_items_menu FOREIGN KEY (menu_id, account_id) REFERENCES meal_menus (id, account_id) ON DELETE CASCADE;
ALTER TABLE grocery_list_items DROP CONSTRAINT IF EXISTS ck_grocery_list_items_menu;
ALTER TABLE grocery_list_items
  ADD CONSTRAINT ck_grocery_list_items_menu CHECK (menu_id IS NOT NULL OR (state = 'preparing' AND source = 'added'));
DROP INDEX IF EXISTS ux_grocery_list_items_open;
CREATE UNIQUE INDEX ux_grocery_list_items_open ON grocery_list_items (account_id, menu_id, name_key) NULLS NOT DISTINCT WHERE state <> 'bought';
CREATE INDEX IF NOT EXISTS idx_grocery_list_items_menu ON grocery_list_items (menu_id, account_id) WHERE menu_id IS NOT NULL;
DROP INDEX IF EXISTS idx_grocery_lists_menu;
CREATE UNIQUE INDEX IF NOT EXISTS ux_grocery_lists_menu ON grocery_lists (menu_id) WHERE menu_id IS NOT NULL;

CREATE OR REPLACE FUNCTION grocery_list_item_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END $$;
DROP FUNCTION IF EXISTS grocery_carry_over_unbought(uuid);
DROP FUNCTION IF EXISTS grocery_list_for(uuid);
CREATE OR REPLACE FUNCTION grocery_list_for(p_viewer uuid)
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

CREATE OR REPLACE FUNCTION grocery_leftovers_for(p_viewer uuid, p_menu uuid)
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

CREATE OR REPLACE FUNCTION delete_meal_menu(p_menu uuid) RETURNS boolean LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION delete_grocery_list(p_menu uuid) RETURNS boolean LANGUAGE plpgsql AS $$
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

COMMENT ON TABLE grocery_lists IS $$Liste de courses validée (« Valider ma liste ») : scénario d'achat choisi, menu d'origine (une seule liste par menu, donc par semaine, CR-54), date, profil. « Ma liste de courses » est la liste de la semaine affichée, consultée en magasin par magasin puis par rayon. La liste vide de tout produit est supprimée par la purge. Supprimée avec son menu (delete_meal_menu) ou seule (delete_grocery_list). [US-157 RF7, RF9, RF9bis, RF11, CR-54]$$;
COMMENT ON TABLE grocery_list_items IS $$Produit de la liste de courses du foyer, avec son état : en préparation, validé, ajouté depuis la validation (sans magasin ni prix, en tête de « Ma liste de courses »), acheté. Un produit n'est qu'une fois dans la liste ouverte d'une semaine (la quantité augmente) ; chaque produit appartient à un menu (menu_id). Les produits non achetés d'une semaine ne sont plus recopiés : la semaine suivante les voit en pense-bête décoché (grocery_leftovers_for), ils restent sur leur liste. Les produits achetés forment l'historique du foyer, conservé 3 mois (réglable). Le couple retire tout ; un invité secondaire ne retire que ses propres ajouts, n'augmente que les quantités et peut cocher « acheté » (CR-38), sans voir aucun prix (grocery_list_for). [US-157 RF3, RF3bis, RF9, US-158, US-162, CR-10, CR-27, CR-28, CR-54, CR-55]$$;
COMMENT ON COLUMN grocery_list_items.menu_id IS $$Menu (donc semaine) du produit, renseigné pour tout produit : en préparation, validé, acheté ou ajouté depuis la validation. Il suit toujours le menu de la liste du produit (rempli à partir de la liste s'il est vide, refusé s'il diffère). Vide seulement pour un ajout à la main en préparation quand aucun menu n'existe ; le premier menu validé le reprend (application). Supprimé avec son menu (cascade). [US-157 RF3bis, RF9bis, RF11, CR-54, CR-55]$$;
COMMENT ON FUNCTION grocery_list_item_before_write() IS $$Garde-fou de la liste de courses : un invité secondaire (profil indiqué dans app.user_id) peut ajouter un produit en son nom, augmenter une quantité, cocher « acheté » n'importe quel article de la liste validée (état validé ou ajouté depuis la validation, à son nom) et décocher ce qu'il a lui-même coché ; il ne change jamais un magasin, une référence, un prix, une quantité en même temps ni le libellé. Il rattache aussi le produit au menu de sa liste (rempli s'il est vide, refusé s'il diffère, CR-54). Sans profil indiqué, le garde-fou de l'invité secondaire ne s'applique pas (H144). [US-158 RF2, RF3, US-162, CR-10, CR-38, CR-54]$$;
COMMENT ON FUNCTION grocery_list_for(uuid) IS $$Articles de la liste de courses de la famille d'un profil, pour l'affichage : le prix estimé n'est rendu qu'au couple, l'invité secondaire ne voit aucun prix (il voit le magasin, la référence, le format du conditionnement et l'unité du prix, sans prix). L'application l'utilise pour lire la liste ; tant qu'elle se connecte avec un seul rôle, la protection effective des colonnes est cette fonction et le code (H150). [US-157 RF7bis, RF8, RF9bis, US-158, CR-10, CR-38, CR-40, CR-50, CR-54]$$;
COMMENT ON FUNCTION grocery_leftovers_for(uuid, uuid) IS $$Pense-bêtes « Pas encore acheté (semaine du …) » d'un menu : les produits validés ou ajoutés après la validation, non achetés, de la plus récente liste encore existante d'une semaine antérieure à ce menu (une semaine sautée ne bloque rien ; sans liste précédente, rien n'est repris). Calculés à la lecture : décochés (is_selected faux), hors total tant que l'utilisateur ne les coche pas, toujours présents sur leur liste d'origine ; ils disparaissent quand le produit est acheté sur cette liste ou quand le produit existe déjà dans la semaine visée (un pense-bête coché y devient un produit, copié par l'application). Le prix estimé n'est rendu qu'au couple. Remplace grocery_carry_over_unbought. [US-157 RF3bis, CR-55]$$;
COMMENT ON FUNCTION delete_meal_menu(uuid) IS $$Supprime définitivement un menu validé : ses produits de liste (achetés et ajoutés à la main compris), sa liste de courses, son déroulé de séance, ses lignes de menu, leurs ingrédients et leurs quantités. Ne touche ni les tickets, ni les prix, ni les plats copiés dans Mes plats, ni le compteur de menus du jour (un menu supprimé reste compté). Réservée au couple du foyer (profil lu dans app.user_id) ; rend faux si le menu n'existe pas. Le menu sort de l'historique (« déjà servi le … »). [US-156 RF1bis, US-157 RF11, RT3, CR-54]$$;
COMMENT ON FUNCTION delete_grocery_list(uuid) IS $$Supprime définitivement la liste de courses d'un menu et tous ses produits (achetés et ajoutés à la main compris) ; le menu, ses recettes et son déroulé sont gardés, la liste repart de zéro à partir du menu. Ne touche ni les tickets, ni les prix, ni le compteur de menus du jour. Réservée au couple du foyer (profil lu dans app.user_id) ; rend vrai si quelque chose a été supprimé. [US-157 RF11, RT3, CR-54, CR-55]$$;
