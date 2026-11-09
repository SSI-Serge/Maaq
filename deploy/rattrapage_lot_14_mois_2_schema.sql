-- MAAQ — rattrapage additif du lot 14, fichier 2/2 : regroupé CR-56 à CR-63 (quatre semaines et liste du mois, coût réel du menu, budget mensuel des repas, base commune des plats de saison),
-- À APPLIQUER APRÈS rattrapage_lot_14_mois_1_valeurs_enumerees.sql, lui-même après rattrapage_lot_14_semaines.sql (c7304fb6…), pour une base qui a déjà reçu lot_14_2_schema.sql (5298e454…) et les
-- neuf rattrapages du lot 14 précédents, dans cet ordre. Une base neuve applique le lot_14_1 et le lot_14_2 régénérés (nouvelles empreintes) et n'a pas besoin de ces fichiers. Une seule
-- transaction, idempotent. Une seule instruction réécrit des lignes : le marquage « rayon frais » des rayons de départ, fait UNE SEULE FOIS à la création de la colonne (une nouvelle application ne
-- remet jamais en cause les corrections de la console) ; le nombre de rayons marqués est donné par un message (NOTICE).
--  1. grocery_aisles.is_fresh ; grocery_household_settings.monthly_meal_budget.
--  2. Liste du mois : grocery_list_groups, grocery_lists.group_id, contrôle du scénario et nettoyage du regroupement (moins de 2 listes).
--  3. Coût réel : grocery_receipt_lines UNIQUE (id, compte), grocery_list_items.receipt_line_id (clé composite, repasse à vide si le ticket est supprimé) ; grocery_list_item_before_write() REMPLACÉE.
--  4. Base commune des plats de saison (anonyme, distincte du catalogue des plats) : meal_season_dishes, ses ingrédients, ses mois, ses étiquettes ; la sélection du foyer meal_season_household_dishes ;
--     meal_menu_entries.season_dish_id ; share_season_dish(), choose_season_dish(), search_season_dishes(), season_dish_ingredients_for() ; v_meal_season_dishes ; deux réglages de console.
--  5. purge_expired_grocery_data() REMPLACÉE : elle supprime aussi les sélections de plats de saison d'un mois passé.

DO $$
DECLARE v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grocery_aisles' AND column_name = 'is_fresh') THEN
    ALTER TABLE grocery_aisles ADD COLUMN is_fresh boolean NOT NULL DEFAULT false;
    UPDATE grocery_aisles SET is_fresh = true WHERE name IN ('Fruits et légumes', 'Crémerie', 'Crèmerie', 'Boucherie', 'Poissonnerie', 'Volaille', 'Charcuterie');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'Rayons marqués « rayon frais » : %', v_n;
  END IF;
END $$;
ALTER TABLE grocery_household_settings ADD COLUMN IF NOT EXISTS monthly_meal_budget numeric(7,2) CHECK (monthly_meal_budget BETWEEN 1 AND 99999);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grocery_receipt_lines_id_account_id_key' AND conrelid = 'grocery_receipt_lines'::regclass) THEN
    ALTER TABLE grocery_receipt_lines ADD CONSTRAINT grocery_receipt_lines_id_account_id_key UNIQUE (id, account_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS grocery_list_groups (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  scenario             smallint NOT NULL CHECK (scenario BETWEEN 1 AND 3),
  validated_at         timestamptz NOT NULL DEFAULT now(),
  validated_by_user_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_grocery_list_groups_validated_by FOREIGN KEY (validated_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (validated_by_user_id)
);
CREATE INDEX IF NOT EXISTS idx_grocery_list_groups_account ON grocery_list_groups (account_id, validated_at DESC);
CREATE INDEX IF NOT EXISTS idx_grocery_list_groups_validated_by ON grocery_list_groups (validated_by_user_id, account_id);

ALTER TABLE grocery_lists ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE grocery_lists DROP CONSTRAINT IF EXISTS fk_grocery_lists_group;
ALTER TABLE grocery_lists
  ADD CONSTRAINT fk_grocery_lists_group FOREIGN KEY (group_id, account_id) REFERENCES grocery_list_groups (id, account_id) ON DELETE SET NULL (group_id);
CREATE INDEX IF NOT EXISTS idx_grocery_lists_group ON grocery_lists (group_id, account_id) WHERE group_id IS NOT NULL;
CREATE OR REPLACE FUNCTION grocery_list_group_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS trg_grocery_lists_group_check ON grocery_lists;
CREATE TRIGGER trg_grocery_lists_group_check BEFORE INSERT OR UPDATE OF group_id, scenario ON grocery_lists
  FOR EACH ROW EXECUTE FUNCTION grocery_list_group_check();
CREATE OR REPLACE FUNCTION grocery_list_group_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.group_id IS NOT NULL AND (TG_OP = 'DELETE' OR NEW.group_id IS DISTINCT FROM OLD.group_id) THEN
    IF (SELECT count(*) FROM grocery_lists WHERE group_id = OLD.group_id) < 2 THEN
      DELETE FROM grocery_list_groups WHERE id = OLD.group_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_grocery_lists_group_cleanup ON grocery_lists;
CREATE TRIGGER trg_grocery_lists_group_cleanup AFTER DELETE OR UPDATE OF group_id ON grocery_lists
  FOR EACH ROW EXECUTE FUNCTION grocery_list_group_cleanup();
ALTER TABLE grocery_list_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS grocery_list_groups_couple ON grocery_list_groups;
CREATE POLICY grocery_list_groups_couple ON grocery_list_groups
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
DROP POLICY IF EXISTS grocery_list_groups_member_read ON grocery_list_groups;
CREATE POLICY grocery_list_groups_member_read ON grocery_list_groups FOR SELECT
  USING (account_id = (SELECT grocery_member_account()));

ALTER TABLE grocery_list_items ADD COLUMN IF NOT EXISTS receipt_line_id bigint;
ALTER TABLE grocery_list_items DROP CONSTRAINT IF EXISTS fk_grocery_list_items_receipt_line;
ALTER TABLE grocery_list_items
  ADD CONSTRAINT fk_grocery_list_items_receipt_line FOREIGN KEY (receipt_line_id, account_id) REFERENCES grocery_receipt_lines (id, account_id) ON DELETE SET NULL (receipt_line_id);
ALTER TABLE grocery_list_items DROP CONSTRAINT IF EXISTS ck_grocery_list_items_receipt;
ALTER TABLE grocery_list_items
  ADD CONSTRAINT ck_grocery_list_items_receipt CHECK (receipt_line_id IS NULL OR state = 'bought');
CREATE INDEX IF NOT EXISTS idx_grocery_list_items_receipt_line ON grocery_list_items (receipt_line_id, account_id) WHERE receipt_line_id IS NOT NULL;
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
  -- Un produit qui n'est plus acheté n'est plus relié à une ligne de ticket (CR-58)
  IF NEW.state IS DISTINCT FROM 'bought' THEN
    NEW.receipt_line_id := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE IF NOT EXISTS meal_season_dishes (
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
CREATE INDEX IF NOT EXISTS idx_meal_season_dishes_cuisine_id ON meal_season_dishes (cuisine_id);
CREATE INDEX IF NOT EXISTS idx_meal_season_dishes_hidden_by ON meal_season_dishes (hidden_by_user_id) WHERE hidden_by_user_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS meal_season_dish_ingredients (
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
CREATE INDEX IF NOT EXISTS idx_meal_season_dish_ingredients_product_id ON meal_season_dish_ingredients (product_id) WHERE product_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS meal_season_dish_months (
  dish_id      bigint NOT NULL REFERENCES meal_season_dishes (id) ON DELETE CASCADE,
  season_month smallint NOT NULL CHECK (season_month BETWEEN 1 AND 12),
  PRIMARY KEY (dish_id, season_month)
);
CREATE TABLE IF NOT EXISTS meal_season_dish_tag_links (
  dish_id  bigint NOT NULL REFERENCES meal_season_dishes (id) ON DELETE CASCADE,
  tag_id   integer NOT NULL REFERENCES meal_dish_tags (id) ON DELETE CASCADE,
  PRIMARY KEY (dish_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_meal_season_dish_tag_links_tag_id ON meal_season_dish_tag_links (tag_id);
CREATE TABLE IF NOT EXISTS meal_season_household_dishes (
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  dish_id      bigint NOT NULL REFERENCES meal_season_dishes (id) ON DELETE CASCADE,
  -- Premier jour du mois (heure du foyer)
  season_month date NOT NULL CHECK (date_part('day', season_month) = 1),
  PRIMARY KEY (account_id, dish_id, season_month)
);
CREATE INDEX IF NOT EXISTS idx_meal_season_household_dishes_dish_id ON meal_season_household_dishes (dish_id);
CREATE OR REPLACE FUNCTION meal_season_dish_needs_content() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS trg_meal_season_dishes_content ON meal_season_dishes;
CREATE CONSTRAINT TRIGGER trg_meal_season_dishes_content AFTER INSERT ON meal_season_dishes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_season_dish_needs_content();
DROP TRIGGER IF EXISTS trg_meal_season_dish_ingredients_delete ON meal_season_dish_ingredients;
CREATE CONSTRAINT TRIGGER trg_meal_season_dish_ingredients_delete AFTER DELETE ON meal_season_dish_ingredients
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_season_dish_needs_content();
DROP TRIGGER IF EXISTS trg_meal_season_dish_months_delete ON meal_season_dish_months;
CREATE CONSTRAINT TRIGGER trg_meal_season_dish_months_delete AFTER DELETE ON meal_season_dish_months
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_season_dish_needs_content();
ALTER TABLE meal_season_household_dishes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meal_season_household_dishes_couple ON meal_season_household_dishes;
CREATE POLICY meal_season_household_dishes_couple ON meal_season_household_dishes
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_season_dishes ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_season_dish_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_season_dish_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_season_dish_tag_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE meal_menu_entries ADD COLUMN IF NOT EXISTS season_dish_id bigint REFERENCES meal_season_dishes (id) ON DELETE SET NULL;
ALTER TABLE meal_menu_entries DROP CONSTRAINT IF EXISTS ck_meal_menu_entries_season;
ALTER TABLE meal_menu_entries
  ADD CONSTRAINT ck_meal_menu_entries_season CHECK (season_dish_id IS NULL OR dish_origin = 'ai');
CREATE INDEX IF NOT EXISTS idx_meal_menu_entries_season_dish ON meal_menu_entries (season_dish_id, account_id) WHERE season_dish_id IS NOT NULL;

CREATE OR REPLACE FUNCTION share_season_dish(p_name text, p_name_key text, p_cuisine_id integer, p_servings integer, p_recipe text, p_duration integer, p_months integer[], p_tag_ids integer[], p_ingredients jsonb)
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
CREATE OR REPLACE FUNCTION choose_season_dish(p_account uuid, p_dish bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
CREATE OR REPLACE FUNCTION search_season_dishes(p_month date, p_cuisines integer[] DEFAULT NULL, p_required_tags integer[] DEFAULT NULL, p_excluded_tags integer[] DEFAULT NULL,
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
CREATE OR REPLACE FUNCTION season_dish_ingredients_for(p_dishes bigint[])
RETURNS TABLE (dish_id bigint, label varchar, name_key text, product_id bigint, quantity numeric, unit text, "position" smallint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.dish_id, i.label, i.name_key, i.product_id, i.quantity, i.unit, i.position
    FROM meal_season_dish_ingredients i
    JOIN meal_season_dishes d ON d.id = i.dish_id
   WHERE i.dish_id = ANY (p_dishes) AND d.hidden_at IS NULL
   ORDER BY i.dish_id, i.position
$$;
CREATE OR REPLACE FUNCTION purge_expired_grocery_data() RETURNS bigint LANGUAGE plpgsql AS $$
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

INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('meal_season_dishes_count',          'integer', '10',    1,  100,      $$Nombre de plats de saison demandés pour le menu du mois (US-178 RF2, CR-60)$$),
  ('meal_season_dishes_max',            'integer', '44',    1,  200,      $$Nombre maximum de plats de saison retenus pour le foyer quand ses plats ne suffisent pas à remplir les quatre semaines (US-178 RF2, CR-62)$$)
ON CONFLICT (setting_key) DO NOTHING;

CREATE OR REPLACE VIEW v_meal_season_dishes AS
SELECT d.id AS dish_id, d.name, d.name_key, d.cuisine_id, d.servings, d.duration_minutes, d.chosen_count, d.entered_week, d.hidden_at, d.hidden_by_user_id,
       d.hidden_at IS NOT NULL AS is_hidden,
       ARRAY(SELECT m.season_month FROM meal_season_dish_months m WHERE m.dish_id = d.id ORDER BY m.season_month) AS months,
       ARRAY(SELECT l.tag_id FROM meal_season_dish_tag_links l WHERE l.dish_id = d.id ORDER BY l.tag_id) AS tag_ids,
       (SELECT count(*) FROM meal_season_dish_ingredients i WHERE i.dish_id = d.id) AS ingredient_count
  FROM meal_season_dishes d;

COMMENT ON COLUMN grocery_aisles.is_fresh IS $$Rayon frais (Fruits et légumes, Crémerie, Boucherie, Poissonnerie, Volaille, Charcuterie au départ), réglable dans la console. Dans la liste du mois, les produits d'un rayon frais des semaines après la première sont « À acheter plus tard », décochés et hors total ; ce marquage se lit à la lecture. Un produit sans rayon n'est pas frais. [US-169 RF2bis, US-157 RF9ter, CR-56]$$;
COMMENT ON TABLE grocery_aisles IS $$Rayons de magasin, communs à tous les foyers : tickets, liste de courses et budget sont rangés de la même façon. Un rayon utilisé ne se supprime pas : il se renomme ou se fusionne avec un autre (merge_grocery_aisles). [US-169]$$;
COMMENT ON COLUMN grocery_household_settings.monthly_meal_budget IS $$Budget mensuel des repas du foyer, en euros (de 1 à 99 999), hors restaurant, boissons et réceptions. Sert au menu du mois dans le budget ; vide tant que le foyer ne l'a pas renseigné. [US-153, US-178, CR-59]$$;
COMMENT ON TABLE grocery_list_groups IS $$Regroupement de plusieurs semaines en une « Liste du mois » : un seul scénario d'achat et une seule date de validation pour toutes les semaines regroupées. Chaque semaine garde sa liste (grocery_lists.group_id). Supprimer une semaine la retire du regroupement ; le regroupement disparaît s'il reste moins de 2 listes. [US-157 RF9ter, RF11, CR-56]$$;
COMMENT ON TABLE grocery_lists IS $$Liste de courses validée (« Valider ma liste ») : scénario d'achat choisi, menu d'origine (une seule liste par menu, donc par semaine, CR-54), date, profil. « Ma liste de courses » est la liste de la semaine affichée, consultée en magasin par magasin puis par rayon. La liste vide de tout produit est supprimée par la purge. Supprimée avec son menu (delete_meal_menu) ou seule (delete_grocery_list) ; elle quitte alors son regroupement en liste du mois, qui disparaît s'il reste moins de 2 listes. [US-157 RF7, RF9, RF9bis, RF9ter, RF11, CR-54, CR-56]$$;
COMMENT ON COLUMN grocery_lists.group_id IS $$Liste du mois (grocery_list_groups) à laquelle cette semaine est regroupée ; vide = liste de la semaine seule. Son scénario d'achat est celui du regroupement (vérifié). Repasse à vide si le regroupement disparaît. [US-157 RF9ter, CR-56]$$;
COMMENT ON FUNCTION grocery_list_group_check() IS $$Une liste regroupée (liste du mois) a le même scénario d'achat que son regroupement. [US-157 RF9ter, CR-56]$$;
COMMENT ON FUNCTION grocery_list_group_cleanup() IS $$Quand une liste quitte son regroupement ou est supprimée (suppression d'une semaine, d'un menu ou purge), le regroupement disparaît s'il reste moins de 2 listes ; les listes restantes redeviennent des listes de semaine. [US-157 RF9ter, RF11, CR-56]$$;
COMMENT ON COLUMN grocery_list_items.receipt_line_id IS $$Ligne de ticket de caisse qui a servi à payer ce produit acheté : le coût réel du menu est la somme des lignes reliées aux produits de ses listes. Vide pour un produit coché à la main (le prix estimé est gardé) ; repasse à vide si le ticket est supprimé ou si le produit n'est plus acheté. Un ingrédient inconnu du catalogue est rapproché par son nom, moins fiable. [US-157 RF8, US-177, CR-58]$$;
COMMENT ON FUNCTION grocery_list_item_before_write() IS $$Garde-fou de la liste de courses : un invité secondaire (profil indiqué dans app.user_id) peut ajouter un produit en son nom, augmenter une quantité, cocher « acheté » n'importe quel article de la liste validée (état validé ou ajouté depuis la validation, à son nom) et décocher ce qu'il a lui-même coché ; il ne change jamais un magasin, une référence, un prix, une quantité en même temps ni le libellé. Il rattache aussi le produit au menu de sa liste (rempli s'il est vide, refusé s'il diffère, CR-54) et vide son lien vers une ligne de ticket quand il n'est plus acheté (CR-58). Sans profil indiqué, le garde-fou de l'invité secondaire ne s'applique pas (H144). [US-158 RF2, RF3, US-162, CR-10, CR-38, CR-54]$$;
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
COMMENT ON COLUMN meal_menu_entries.season_dish_id IS $$Plat de la base commune des plats de saison d'où vient ce plat libre (origine ai), quand il a été choisi parmi eux (CR-61) ; repasse à vide si le plat est supprimé de la base. Sert à n'écarter ni ne compter deux fois un plat déjà présent dans les menus du foyer : le compteur de la base commune ne monte qu'une fois par foyer et par plat. [US-178 RF2bis, CR-61, CR-62]$$;
COMMENT ON FUNCTION share_season_dish(text, text, integer, integer, text, integer, integer[], integer[], jsonb) IS $$Seule porte d'écriture de la base commune des plats de saison : crée le plat (avec ses mois, ses étiquettes et ses ingrédients) si son nom normalisé n'existe pas, sinon rend l'identifiant du plat existant sans rien modifier (le premier est gardé). Ne reçoit ni foyer ni profil. Exécutée avec les droits du propriétaire. [US-178 RF2bis, CR-61]$$;
COMMENT ON FUNCTION choose_season_dish(uuid, bigint) IS $$Compte le choix d'un plat de saison dans un menu validé, une seule fois par foyer et par plat : le compteur de la base commune ne monte que si aucune ligne de menu du foyer ne pointe déjà vers ce plat. Le foyer n'est pas gardé. À appeler avant d'écrire la ligne de menu (season_dish_id). Rend vrai si le compteur a monté. Le compteur peut remonter après une purge ou une suppression de menu (accepté). Exécutée avec les droits du propriétaire. [US-178 RF2bis, CR-61, CR-62]$$;
COMMENT ON FUNCTION search_season_dishes(date, integer[], integer[], integer[], bigint[], integer) IS $$Plats de saison de la base commune pour un mois : non masqués, de saison dans le mois demandé, dans les cuisines données, portant toutes les étiquettes demandées et aucune étiquette exclue, hors des plats déjà écartés ; les plus choisis d'abord. Les filtres viennent de l'application : la base ne lit jamais les allergies ni les régimes du foyer (chiffrés), l'application filtre les allergies sur les candidats rendus. Exécutée avec les droits du propriétaire. [US-178 RF2bis, CR-61]$$;
COMMENT ON FUNCTION season_dish_ingredients_for(bigint[]) IS $$Ingrédients (avec quantité et unité pour le nombre de personnes du plat) des plats de saison demandés, hors plats masqués. Exécutée avec les droits du propriétaire. [US-178 RF2bis, CR-61]$$;
COMMENT ON VIEW v_meal_season_dishes IS $$Liste de console des plats de saison de la base commune : nom, cuisine, nombre de personnes des quantités, mois de saison, étiquettes, nombre de foyers qui l'ont choisi, lundi d'entrée, masqué ou visible, nombre d'ingrédients. Aucune colonne ne retrouve un foyer. L'administrateur masque un plat et corrige ses étiquettes et ses mois (journal d'administration : seasonal_dish_changed). [US-178 RF2bis, CR-61]$$;
COMMENT ON FUNCTION purge_expired_grocery_data() IS $$Supprime les menus validés de plus de 12 mois, les tickets (avec leurs lignes) antérieurs à l'année en cours moins deux, les produits achetés de la liste de plus de 3 mois (et les listes validées devenues vides), les entrées du journal des produits à référencer de plus de 12 mois, les preuves de consentement arrivées à échéance, les lignes de la base commune des prix de plus de 12 mois (réglage de la fenêtre grocery_check_window_months ; le catalogue n'est pas concerné) les compteurs du plafond quotidien de menus de plus de 7 jours, et les sélections de plats de saison d'un mois passé (la base commune des plats de saison n'est jamais purgée). Les durées sont des réglages de la console (à confirmer par le DPO, CR-26). À planifier chaque jour. [CR-23, CR-35, CR-44]$$;
COMMENT ON FUNCTION delete_meal_menu(uuid) IS $$Supprime définitivement un menu validé : ses produits de liste (achetés et ajoutés à la main compris), sa liste de courses, son déroulé de séance, ses lignes de menu, leurs ingrédients et leurs quantités. Ne touche ni les tickets, ni les prix, ni les plats copiés dans Mes plats, ni le compteur de menus du jour (un menu supprimé reste compté). Réservée au couple du foyer (profil lu dans app.user_id) ; rend faux si le menu n'existe pas. Le menu sort de l'historique (« déjà servi le … »). Sa liste quitte son regroupement en liste du mois, qui disparaît s'il reste moins de 2 listes. [US-156 RF1bis, US-157 RF9ter, RF11, RT3, CR-54, CR-56]$$;
COMMENT ON FUNCTION delete_grocery_list(uuid) IS $$Supprime définitivement la liste de courses d'un menu et tous ses produits (achetés et ajoutés à la main compris) ; le menu, ses recettes et son déroulé sont gardés, la liste repart de zéro à partir du menu. Ne touche ni les tickets, ni les prix, ni le compteur de menus du jour. Réservée au couple du foyer (profil lu dans app.user_id) ; rend vrai si quelque chose a été supprimé. La liste quitte son regroupement en liste du mois, qui disparaît s'il reste moins de 2 listes. [US-157 RF9ter, RF11, RT3, CR-54, CR-55, CR-56]$$;
