-- MAAQ — rattrapage additif du lot 14 (menu composé en conversation libre avec l'IA : plats libres gardés avec le menu, origine des plats, version allégée proposée par l'IA,
-- copie dans Mes plats ; décisions CR-42, CR-43 et CR-45) pour une base qui a DÉJÀ reçu lot_14_2_schema.sql (5298e454…) et les cinq rattrapages du lot 14 précédents
-- (references_sans_prix ebbb0218…, secondaire_et_agent 9e3600f1…, format_references deeeda5e…, prix_au_kilo 0c296b9f…, ticket_heure 0674f835…), dans cet ordre.
-- Une base neuve applique le lot_14_2_schema.sql régénéré (nouvelle empreinte) et n'a pas besoin de ce fichier. Une seule transaction, idempotent. Aucune valeur d'énumération.
-- Une seule instruction réécrit des lignes : le remplissage de meal_menu_entries.dish_origin des menus déjà validés (household si la ligne pointe vers un plat de Mes plats,
-- sinon catalog, seule autre source avant CR-42), fait une seule fois, au moment où la colonne est créée.
--  1. meal_menu_entries : dish_origin (sans valeur par défaut : l'application dit toujours d'où vient le plat), cuisine_id, recipe, duration_minutes (contenu d'un plat libre),
--     light_by_ai, light_text, light_chosen (version allégée proposée par l'IA) ; UNIQUE (id, compte) ; la contrainte ck_meal_menu_entries_one_dish est REMPLACÉE par
--     ck_meal_menu_entries_origin (un plat du catalogue peut porter aussi la copie dans Mes plats), ck_meal_menu_entries_free_dish et ck_meal_menu_entries_light.
--  2. Trois tables : meal_menu_entry_ingredients, meal_menu_entry_light_items et meal_menu_session_steps (déroulé de la séance de batch rédigé par l'IA, CR-47), avec leurs index,
--     leur sécurité par ligne (couple) et leurs commentaires ; UNIQUE (id, menu) sur meal_menu_entries pour rattacher une étape à une ligne du même menu.
--  3. Trois fonctions et cinq déclencheurs : un plat libre a au moins un ingrédient (différé) ; une adaptation allégée suppose une version allégée proposée par l'IA ; un menu qui reprend
--     une semaine type n'a pas d'étape de déroulé (différé).
--  4. Commentaires reformulés (CR-43) : les régimes et allergies sont envoyés à l'IA par l'application, sans nom ni prénom ; aucune vue ni fonction de la base ne les lit.
--  Inutilisés depuis CR-42, laissés en place : meal_menu_entries.is_off_batch et planning_match_to_confirm, valeur « pleasure » de meal_entry_kind.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'meal_menu_entries' AND column_name = 'dish_origin') THEN
    ALTER TABLE meal_menu_entries ADD COLUMN dish_origin text NOT NULL DEFAULT 'catalog' CHECK (dish_origin IN ('catalog', 'household', 'ai'));
    UPDATE meal_menu_entries SET dish_origin = 'household' WHERE household_dish_id IS NOT NULL;
    ALTER TABLE meal_menu_entries ALTER COLUMN dish_origin DROP DEFAULT;
  END IF;
END $$;
ALTER TABLE meal_menu_entries ADD COLUMN IF NOT EXISTS cuisine_id integer REFERENCES meal_cuisines (id) ON DELETE RESTRICT;
ALTER TABLE meal_menu_entries ADD COLUMN IF NOT EXISTS recipe text;
ALTER TABLE meal_menu_entries ADD COLUMN IF NOT EXISTS duration_minutes smallint CHECK (duration_minutes BETWEEN 1 AND 600);
ALTER TABLE meal_menu_entries ADD COLUMN IF NOT EXISTS light_by_ai boolean NOT NULL DEFAULT false;
ALTER TABLE meal_menu_entries ADD COLUMN IF NOT EXISTS light_text text CHECK (light_text IS NULL OR btrim(light_text) <> '');
ALTER TABLE meal_menu_entries ADD COLUMN IF NOT EXISTS light_chosen boolean NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meal_menu_entries_id_account_id_key' AND conrelid = 'meal_menu_entries'::regclass) THEN
    ALTER TABLE meal_menu_entries ADD CONSTRAINT meal_menu_entries_id_account_id_key UNIQUE (id, account_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meal_menu_entries_id_menu_id_key' AND conrelid = 'meal_menu_entries'::regclass) THEN
    ALTER TABLE meal_menu_entries ADD CONSTRAINT meal_menu_entries_id_menu_id_key UNIQUE (id, menu_id);
  END IF;
END $$;
ALTER TABLE meal_menu_entries DROP CONSTRAINT IF EXISTS ck_meal_menu_entries_one_dish;
ALTER TABLE meal_menu_entries DROP CONSTRAINT IF EXISTS ck_meal_menu_entries_origin;
ALTER TABLE meal_menu_entries
  ADD CONSTRAINT ck_meal_menu_entries_origin CHECK (dish_origin = 'catalog' OR dish_id IS NULL);
ALTER TABLE meal_menu_entries DROP CONSTRAINT IF EXISTS ck_meal_menu_entries_free_dish;
ALTER TABLE meal_menu_entries
  ADD CONSTRAINT ck_meal_menu_entries_free_dish CHECK ((dish_origin = 'ai' AND cuisine_id IS NOT NULL) OR (dish_origin <> 'ai' AND cuisine_id IS NULL AND recipe IS NULL AND duration_minutes IS NULL));
ALTER TABLE meal_menu_entries DROP CONSTRAINT IF EXISTS ck_meal_menu_entries_light;
ALTER TABLE meal_menu_entries
  ADD CONSTRAINT ck_meal_menu_entries_light CHECK (light_by_ai = (light_text IS NOT NULL) AND (light_by_ai OR NOT light_chosen));
CREATE INDEX IF NOT EXISTS idx_meal_menu_entries_cuisine_id ON meal_menu_entries (cuisine_id) WHERE cuisine_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meal_menu_entry_ingredients (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id    bigint NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  label       varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key    text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  -- Produit du catalogue reconnu par l'application ; vide si inconnu (la liste le prend sans prix, noté dans les produits à référencer)
  product_id  bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  position    smallint NOT NULL DEFAULT 1 CHECK (position >= 1),
  UNIQUE (entry_id, name_key),
  CONSTRAINT fk_meal_menu_entry_ingredients_entry FOREIGN KEY (entry_id, account_id) REFERENCES meal_menu_entries (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_meal_menu_entry_ingredients_account ON meal_menu_entry_ingredients (account_id);
CREATE INDEX IF NOT EXISTS idx_meal_menu_entry_ingredients_product_id ON meal_menu_entry_ingredients (product_id) WHERE product_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meal_menu_entry_light_items (
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
CREATE INDEX IF NOT EXISTS idx_meal_menu_entry_light_items_account ON meal_menu_entry_light_items (account_id);
CREATE INDEX IF NOT EXISTS idx_meal_menu_entry_light_items_product_id ON meal_menu_entry_light_items (product_id) WHERE product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION meal_menu_entry_needs_ingredient() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_entry bigint;
BEGIN
  IF TG_TABLE_NAME = 'meal_menu_entries' THEN
    v_entry := NEW.id;
  ELSE
    v_entry := OLD.entry_id;
  END IF;
  IF EXISTS (SELECT 1 FROM meal_menu_entries WHERE id = v_entry AND dish_origin = 'ai')
     AND NOT EXISTS (SELECT 1 FROM meal_menu_entry_ingredients WHERE entry_id = v_entry) THEN
    RAISE EXCEPTION 'Un plat libre du menu a au moins un ingrédient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_meal_menu_entries_ingredient ON meal_menu_entries;
CREATE CONSTRAINT TRIGGER trg_meal_menu_entries_ingredient AFTER INSERT OR UPDATE OF dish_origin ON meal_menu_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_entry_needs_ingredient();
DROP TRIGGER IF EXISTS trg_meal_menu_entry_ingredients_delete ON meal_menu_entry_ingredients;
CREATE CONSTRAINT TRIGGER trg_meal_menu_entry_ingredients_delete AFTER DELETE ON meal_menu_entry_ingredients
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_entry_needs_ingredient();

CREATE OR REPLACE FUNCTION meal_menu_entry_light_item_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM meal_menu_entries WHERE id = NEW.entry_id AND light_by_ai) THEN
    RAISE EXCEPTION 'Une adaptation allégée suppose une version allégée proposée par l''IA pour ce plat' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_meal_menu_entry_light_items_before_write ON meal_menu_entry_light_items;
CREATE TRIGGER trg_meal_menu_entry_light_items_before_write BEFORE INSERT OR UPDATE ON meal_menu_entry_light_items
  FOR EACH ROW EXECUTE FUNCTION meal_menu_entry_light_item_before_write();

CREATE TABLE IF NOT EXISTS meal_menu_session_steps (
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_meal_menu_session_steps_storage ON meal_menu_session_steps (entry_id) WHERE storage_mode IS NOT NULL AND entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meal_menu_session_steps_account ON meal_menu_session_steps (account_id);
CREATE INDEX IF NOT EXISTS idx_meal_menu_session_steps_entry ON meal_menu_session_steps (entry_id, menu_id) WHERE entry_id IS NOT NULL;

CREATE OR REPLACE FUNCTION meal_menu_session_steps_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS trg_meal_menu_session_steps_check ON meal_menu_session_steps;
CREATE CONSTRAINT TRIGGER trg_meal_menu_session_steps_check AFTER INSERT ON meal_menu_session_steps
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_session_steps_check();
DROP TRIGGER IF EXISTS trg_meal_menus_session_steps_check ON meal_menus;
CREATE CONSTRAINT TRIGGER trg_meal_menus_session_steps_check AFTER UPDATE OF batch_week_id ON meal_menus
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_session_steps_check();

ALTER TABLE meal_menu_entry_ingredients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meal_menu_entry_ingredients_couple ON meal_menu_entry_ingredients;
CREATE POLICY meal_menu_entry_ingredients_couple ON meal_menu_entry_ingredients
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_entry_light_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meal_menu_entry_light_items_couple ON meal_menu_entry_light_items;
CREATE POLICY meal_menu_entry_light_items_couple ON meal_menu_entry_light_items
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_session_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meal_menu_session_steps_couple ON meal_menu_session_steps;
CREATE POLICY meal_menu_session_steps_couple ON meal_menu_session_steps
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));

COMMENT ON TABLE meal_menu_entries IS $$Plats d'un menu validé : 7 dîners et plats express (le type « plaisir » n'est plus utilisé depuis CR-42). Chaque ligne garde le nom du plat tel qu'il était et son origine : catalogue, Mes plats ou plat libre composé par l'IA. Un plat libre garde dans la ligne sa cuisine, sa recette et sa durée, et ses ingrédients dans meal_menu_entry_ingredients : il n'entre jamais dans le catalogue commun (CR-04) et part avec le menu (12 mois). Après la validation, un plat (libre ou du catalogue) ajouté à Mes plats y est copié et la ligne en garde le lien (household_dish_id). La ligne peut porter une version allégée proposée par l'IA (texte, adaptation dans meal_menu_entry_light_items, choix du foyer). Un plat retiré ou supprimé ensuite reste lisible dans les menus déjà validés. Un menu remplacé par un autre de la même semaine garde son identifiant et voit ses lignes remplacées. [US-156 RF3 à RF10, RT4, CR-25, CR-42, CR-45]$$;
COMMENT ON COLUMN meal_menu_entries.dish_origin IS $$Origine du plat : catalog (plat du catalogue commun), household (plat de Mes plats) ou ai (plat libre composé par l'IA avec le foyer, avec ses ingrédients, jamais dans le catalogue). Renseignée par l'application, sans valeur par défaut ; les menus déjà validés avant CR-42 ont reçu household s'ils pointaient vers un plat personnel, sinon catalog. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.household_dish_id IS $$Plat de Mes plats : le plat choisi (origine household) ou, après « Ajouter à vos plats », la copie faite dans Mes plats d'un plat libre ou du catalogue (la ligne garde son contenu). Vide si le foyer a supprimé ce plat ensuite. [US-156 RF10, CR-42, CR-45]$$;
COMMENT ON COLUMN meal_menu_entries.cuisine_id IS $$Cuisine d'un plat libre (origine ai, obligatoire) ; vide pour un plat du catalogue ou de Mes plats. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.recipe IS $$Recette en texte d'un plat libre ; vide pour un plat du catalogue ou de Mes plats. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.duration_minutes IS $$Durée d'un plat libre en minutes (1 à 600) ; vide pour un plat du catalogue ou de Mes plats. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.light_by_ai IS $$Vrai si une version allégée a été proposée par l'IA pour ce plat (texte dans light_text, adaptation de la liste dans meal_menu_entry_light_items) ; possible pour toute origine dont le plat n'a pas de version allégée dans le catalogue. [US-157 RF5, CR-42, CR-45]$$;
COMMENT ON COLUMN meal_menu_entries.light_text IS $$Texte de la version allégée proposée par l'IA ; renseigné si et seulement si light_by_ai. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.light_chosen IS $$Le foyer a retenu la version allégée proposée par l'IA (la liste suit l'adaptation). Ne peut être vrai que si light_by_ai. Pour les plats du catalogue, le choix reste dans meal_light_choices. [US-157 RF9, CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.is_off_batch IS $$Inutilisé depuis CR-42 (plus de liste déroulante de remplacements) : laissé à faux ; les dîners du samedi et du dimanche, hors séance de batch, se déduisent du rang. [US-156 RF8, CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.planning_match_to_confirm IS $$Inutilisé depuis CR-42 (le menu ne vient plus d'un planning à rapprocher du catalogue) : laissé à faux. Les correspondances des semaines types (US-170, US-171) restent dans meal_batch_week_days. [US-156 RF7, CR-42]$$;
COMMENT ON TABLE meal_menu_entry_ingredients IS $$Ingrédients d'un plat libre d'un menu validé : nom saisi, clé normalisée, produit du catalogue s'il est reconnu (un ingrédient inconnu entre dans la liste sans prix et dans les produits à référencer). Aucune quantité par ingrédient. Un plat libre a au moins un ingrédient (contrôlé à la validation de la transaction). Jamais dans le catalogue commun ; conservé et purgé avec le menu. [US-156 RF8, RT4, CR-04, CR-42]$$;
COMMENT ON TABLE meal_menu_entry_light_items IS $$Produits à retirer et à ajouter pour passer un plat du menu à la version allégée proposée par l'IA (la ligne de menu porte le texte, light_by_ai). Un produit inconnu du catalogue est noté dans les produits à référencer. Conservé et purgé avec le menu. [US-157 RF5, CR-42]$$;
COMMENT ON FUNCTION meal_menu_entry_needs_ingredient() IS $$Contrôle différé : un plat libre d'un menu (origine ai) a au moins un ingrédient à la fin de la transaction. [US-156 RF8, RT3, CR-42]$$;
COMMENT ON FUNCTION meal_menu_entry_light_item_before_write() IS $$Refuse une adaptation de version allégée sur un plat de menu qui n'a pas de version allégée proposée par l'IA. [US-157 RF5, CR-42]$$;
COMMENT ON TABLE meal_menu_session_steps IS $$Déroulé de la séance de batch du dimanche, rédigé par l'IA pour un menu qui ne reprend pas une semaine type : étapes numérotées (texte, plat concerné facultatif, durée approximative facultative). Le déroulé finit par la conservation de chaque plat, écrite comme des étapes de fin de déroulé : plat concerné, réfrigérateur ou congélateur, jour où le sortir. Une étape peut se chevaucher avec une étape précédente (elle n'allonge alors pas la séance). Réservé aux menus sans semaine type (batch_week_id vide) : avec une semaine type, le déroulé est celui du planning (US-170) et rien n'est enregistré ici. Conservé et purgé avec le menu (12 mois), effacé avec le compte. [US-156 RF6bis, US-157 RF1ter, CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.position IS $$Rang de l'étape dans le déroulé, à partir de 1 [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.body IS $$Texte de l'étape (2 000 caractères au plus), rédigé par l'IA [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.entry_id IS $$Plat concerné par l'étape : une ligne du même menu (facultatif) ; repasse à vide si cette ligne est supprimée, l'étape reste lisible [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.duration_minutes IS $$Durée approximative de l'étape en minutes, 1 à 600 (facultative) [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.overlaps_position IS $$Rang d'une étape précédente du même menu avec laquelle cette étape se chevauche (« en même temps, pendant la cuisson ») ; facultatif, toujours inférieur au rang de l'étape (pas de cycle). Une étape en chevauchement n'allonge pas la séance : l'application recalcule la durée totale. Repasse à vide si l'étape référencée est supprimée. [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.storage_mode IS $$Étape de conservation d'un plat : fridge (réfrigérateur) ou freezer (congélateur) ; le plat est entry_id. Vide pour une étape ordinaire. Une seule étape de conservation par plat. [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.take_out_day IS $$Jour où sortir le plat, jour ISO de la semaine du menu (1 = lundi … 7 = dimanche) ; facultatif, uniquement pour une étape de conservation. [CR-47]$$;
COMMENT ON FUNCTION meal_menu_session_steps_check() IS $$Contrôle différé : un menu qui reprend une semaine type (batch_week_id renseigné) n'a aucune étape de déroulé enregistrée, son déroulé étant celui du planning. [US-156 RF6bis, CR-47]$$;
COMMENT ON TABLE grocery_household_dietary IS $$Régimes et allergies du foyer : donnée de santé, CHIFFRÉE par l'application, lue par l'application seule : elle les déchiffre pour filtrer les plats connus (filtrage indicatif) et, depuis CR-43, les envoie à l'IA pour composer le menu, sans nom ni prénom (accord du DPO à obtenir avant la production). Aucune vue ni fonction de la base ne les lit. Réservée au couple. [US-153 RF2, RF4, RT2, US-156 RT2, CR-16, CR-43]$$;
