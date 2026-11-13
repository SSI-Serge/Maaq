-- MAAQ — lot 15 : Tâches ménagères guidées : catalogue commun (tâches, gestes, contenus), réglage du foyer, bacs de poubelles, séries de tâches (US-181 à US-183)
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_15_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
-- Tâches ménagères guidées (US-181 à US-183) : jours d'une tâche et nature d'une note du catalogue
CREATE TYPE chore_schedule_mode   AS ENUM ('weekdays', 'day_before_collection');
CREATE TYPE chore_note_kind       AS ENUM ('intro', 'before_start', 'other');

-- ---------------------------------------------------------------------
-- Fonctions appelées par les contraintes des tables ci-dessous
-- ---------------------------------------------------------------------
CREATE FUNCTION chore_steps_valid(p_steps text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(cardinality(p_steps) BETWEEN 1 AND 30
                  AND NOT EXISTS (SELECT 1 FROM unnest(p_steps) s WHERE s IS NULL OR btrim(s) = '' OR length(s) > 500), false)
$$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Catalogue commun
-- ---------------------------------------------------------------------
CREATE TABLE chore_tasks (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name               varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  position           smallint NOT NULL CHECK (position >= 1),
  -- weekdays = les jours choisis par le foyer ; day_before_collection = la veille des jours de collecte de chaque bac (Sorties de poubelles)
  schedule_mode      chore_schedule_mode NOT NULL DEFAULT 'weekdays',
  default_days       smallint[],
  suggested_minutes  smallint NOT NULL CHECK (suggested_minutes BETWEEN 1 AND 600),
  -- Masquée = n'est plus proposée aux foyers ; les séries des foyers qui l'avaient activée continuent. Une nouvelle tâche est masquée tant qu'elle n'est pas rendue active (TM-08)
  is_active          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_chore_tasks_days CHECK ((schedule_mode = 'weekdays') = (default_days IS NOT NULL) AND (default_days IS NULL OR iso_weekdays_valid(default_days)))
);
CREATE TABLE chore_gestures (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id   integer NOT NULL REFERENCES chore_tasks (id) ON DELETE RESTRICT,
  position  smallint NOT NULL CHECK (position >= 1),
  name      varchar(150) NOT NULL CHECK (btrim(name) <> ''),
  -- Produit utilisé (« Spray savon noir ») ; vide = aucun
  product   varchar(200) CHECK (product IS NULL OR btrim(product) <> ''),
  minutes   smallint CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 240),
  -- Étapes dans l'ordre, une par élément (le numéro est calculé à l'affichage)
  steps     text[] NOT NULL CHECK (chore_steps_valid(steps))
);
CREATE TABLE chore_golden_rules (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  position  smallint NOT NULL CHECK (position >= 1),
  title     varchar(150) NOT NULL CHECK (btrim(title) <> ''),
  body      text NOT NULL CHECK (btrim(body) <> '')
);
CREATE TABLE chore_materials (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  position  smallint NOT NULL CHECK (position >= 1),
  name      varchar(150) NOT NULL CHECK (btrim(name) <> ''),
  detail    text CHECK (detail IS NULL OR length(btrim(detail)) BETWEEN 1 AND 500)
);
CREATE TABLE chore_products (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  position     smallint NOT NULL CHECK (position >= 1),
  name         varchar(150) NOT NULL CHECK (btrim(name) <> ''),
  used_for     text NOT NULL CHECK (btrim(used_for) <> ''),
  avoid_on     text CHECK (avoid_on IS NULL OR btrim(avoid_on) <> ''),
  -- Produit facultatif du guide (cristaux de soude, percarbonate), pour le linge et les cas difficiles
  is_optional  boolean NOT NULL DEFAULT false
);
CREATE TABLE chore_recipes (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  position  smallint NOT NULL CHECK (position >= 1),
  name      varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  dosage    text NOT NULL CHECK (btrim(dosage) <> ''),
  used_for  text NOT NULL CHECK (btrim(used_for) <> '')
);
-- « À ne jamais faire » : consignes de sécurité rattachées à une ou plusieurs tâches, toujours visibles en haut de la tâche
CREATE TABLE chore_never_do (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  position  smallint NOT NULL CHECK (position >= 1),
  body      text NOT NULL CHECK (btrim(body) <> '')
);
CREATE TABLE chore_never_do_tasks (
  never_do_id  integer NOT NULL REFERENCES chore_never_do (id) ON DELETE CASCADE,
  task_id      integer NOT NULL REFERENCES chore_tasks (id) ON DELETE RESTRICT,
  PRIMARY KEY (never_do_id, task_id)
);
CREATE TABLE chore_troubleshooting (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  position    smallint NOT NULL CHECK (position >= 1),
  problem     text NOT NULL CHECK (btrim(problem) <> ''),
  solution    text NOT NULL CHECK (btrim(solution) <> ''),
  -- Dernière ligne FIXE du dépannage (« Problème que ce guide ne couvre pas ») : une seule, ni modifiée, ni supprimée, toujours en dernier, jamais rattachée à une tâche
  is_closing  boolean NOT NULL DEFAULT false
);
CREATE TABLE chore_troubleshooting_tasks (
  troubleshooting_id  integer NOT NULL REFERENCES chore_troubleshooting (id) ON DELETE CASCADE,
  task_id             integer NOT NULL REFERENCES chore_tasks (id) ON DELETE RESTRICT,
  PRIMARY KEY (troubleshooting_id, task_id)
);
-- Rattachement à chaque tâche du matériel, des produits et des recettes (maquette v89) : « Avant de commencer » n'affiche que ceux de la tâche ; les règles d'or restent communes
CREATE TABLE chore_task_materials (
  task_id      integer NOT NULL REFERENCES chore_tasks (id) ON DELETE RESTRICT,
  material_id  integer NOT NULL REFERENCES chore_materials (id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, material_id)
);
CREATE TABLE chore_task_products (
  task_id     integer NOT NULL REFERENCES chore_tasks (id) ON DELETE RESTRICT,
  product_id  integer NOT NULL REFERENCES chore_products (id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, product_id)
);
CREATE TABLE chore_task_recipes (
  task_id    integer NOT NULL REFERENCES chore_tasks (id) ON DELETE RESTRICT,
  recipe_id  integer NOT NULL REFERENCES chore_recipes (id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, recipe_id)
);
-- Contenus propres à une tâche : réglages par tissu (Repassage), notes (introduction, « Avant de commencer », autres déchets…), bacs (Sorties de poubelles)
CREATE TABLE chore_fabric_settings (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id            integer NOT NULL REFERENCES chore_tasks (id) ON DELETE RESTRICT,
  position           smallint NOT NULL CHECK (position >= 1),
  fabric             varchar(150) NOT NULL CHECK (btrim(fabric) <> ''),
  iron_points        smallint NOT NULL CHECK (iron_points BETWEEN 1 AND 3),
  max_temperature_c  smallint NOT NULL CHECK (max_temperature_c BETWEEN 40 AND 250),
  advice             text NOT NULL CHECK (btrim(advice) <> '')
);
CREATE TABLE chore_task_notes (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id   integer NOT NULL REFERENCES chore_tasks (id) ON DELETE RESTRICT,
  -- intro : phrase avant les gestes ; before_start : « Avant de commencer » propre à la tâche (étapes de préparation) ; other : autres notes (ordre de la séance, tri, autres déchets)
  kind      chore_note_kind NOT NULL,
  position  smallint NOT NULL CHECK (position >= 1),
  title     varchar(150) CHECK (title IS NULL OR btrim(title) <> ''),
  body      text NOT NULL CHECK (btrim(body) <> '')
);
CREATE TABLE chore_bins (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id          integer NOT NULL REFERENCES chore_tasks (id) ON DELETE RESTRICT,
  position         smallint NOT NULL CHECK (position >= 1),
  name             varchar(150) NOT NULL CHECK (btrim(name) <> ''),
  contents         text NOT NULL CHECK (btrim(contents) <> ''),
  collection_hint  text CHECK (collection_hint IS NULL OR btrim(collection_hint) <> ''),
  -- Titre de la tâche du foyer pour ce bac (« Sortir le bac jaune »), lu dans le catalogue : le titre d'une série ménagère n'est pas stocké
  task_title       varchar(150) NOT NULL CHECK (btrim(task_title) <> ''),
  UNIQUE (id, task_id)
);
-- ---------------------------------------------------------------------
-- Réglage du foyer : tâches activées, jours, personne ; jours de collecte des bacs. Les deux parents écrivent, les invités secondaires lisent.
-- ---------------------------------------------------------------------
CREATE TABLE chore_household_tasks (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  task_id     integer NOT NULL REFERENCES chore_tasks (id) ON DELETE RESTRICT,
  is_enabled  boolean NOT NULL DEFAULT false,
  -- Jours du foyer (1 = lundi … 7 = dimanche, au moins un) pour une tâche « weekdays » ; vides pour une tâche à collecte (les jours viennent des bacs)
  weekdays        smallint[],
  -- Personne facultative : tout membre actif du foyer, enfants compris (TM-04) ; vide = personne
  member_id   uuid,
  -- Série de tâches liée (posée à la création de la série, vidée à sa fin)
  chore_series_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, task_id),
  CONSTRAINT ck_chore_household_tasks_days CHECK (weekdays IS NULL OR iso_weekdays_valid(weekdays)),
  CONSTRAINT fk_chore_household_tasks_member FOREIGN KEY (member_id, account_id)
    REFERENCES family_members (id, account_id) ON DELETE SET NULL (member_id),
  CONSTRAINT fk_chore_household_tasks_series FOREIGN KEY (chore_series_id, account_id)
    REFERENCES family_task_series (id, account_id) ON DELETE SET NULL (chore_series_id)
);
CREATE TABLE chore_household_bins (
  account_id      uuid NOT NULL,
  bin_id          integer NOT NULL,
  task_id         integer NOT NULL,
  -- Jour de collecte (1 = lundi … 7 = dimanche) ; vide = « Pas de collecte » (par exemple le verre en colonne). Aucune adresse.
  collection_day  smallint CHECK (collection_day IS NULL OR collection_day BETWEEN 1 AND 7),
  -- Heure de la tâche de la veille, réglable par le foyer (19 h par défaut, TM-10)
  due_time        time NOT NULL DEFAULT '19:00',
  chore_series_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, bin_id),
  CONSTRAINT fk_chore_household_bins_bin FOREIGN KEY (bin_id, task_id) REFERENCES chore_bins (id, task_id) ON DELETE RESTRICT,
  CONSTRAINT fk_chore_household_bins_task FOREIGN KEY (account_id, task_id) REFERENCES chore_household_tasks (account_id, task_id) ON DELETE CASCADE,
  CONSTRAINT fk_chore_household_bins_series FOREIGN KEY (chore_series_id, account_id)
    REFERENCES family_task_series (id, account_id) ON DELETE SET NULL (chore_series_id)
);

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Séries de tâches : source « household_chore », liée à la tâche du catalogue et, pour Sorties de poubelles, au bac. Le titre n'est pas stocké (vide) : il est lu dans le catalogue.
-- ---------------------------------------------------------------------
ALTER TABLE family_task_series ADD COLUMN chore_task_id integer REFERENCES chore_tasks (id) ON DELETE RESTRICT;
ALTER TABLE family_task_series ADD COLUMN chore_bin_id integer;
ALTER TABLE family_task_series
  ADD CONSTRAINT fk_task_series_chore_bin FOREIGN KEY (chore_bin_id, chore_task_id) REFERENCES chore_bins (id, task_id) ON DELETE RESTRICT;
ALTER TABLE family_task_series
  ADD CONSTRAINT ck_task_series_chore CHECK ((source = 'household_chore') = (chore_task_id IS NOT NULL)
    AND (chore_bin_id IS NULL OR chore_task_id IS NOT NULL)
    AND (source <> 'household_chore' OR (event_series_id IS NULL AND repeat_unit = 'week' AND repeat_interval = 1 AND octet_length(title) = 0)));
ALTER TABLE family_tasks
  ADD CONSTRAINT ck_tasks_chore CHECK (source <> 'household_chore' OR (series_id IS NOT NULL AND octet_length(title) = 0));

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION family_task_series_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  IF NEW.assigned_member_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM family_members WHERE id = NEW.assigned_member_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Une tâche ne peut être assignée qu''à un membre actif' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ended_at IS NOT NULL THEN RETURN NEW; END IF;
  -- Les séries des tâches ménagères guidées (une par tâche activée, une par bac collecté) ne comptent pas dans les 50 tâches récurrentes (D75, US-110 RF11)
  IF NEW.source = 'household_chore' THEN RETURN NEW; END IF;
  IF NEW.event_series_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family_task_series:' || NEW.account_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_recurring_tasks_per_family';
    SELECT count(*) INTO v_count FROM family_task_series
     WHERE account_id = NEW.account_id AND event_series_id IS NULL AND ended_at IS NULL AND source <> 'household_chore';
    IF v_count >= COALESCE(v_max, 50) THEN
      RAISE EXCEPTION 'Nombre maximal de tâches récurrentes atteint (%)', COALESCE(v_max, 50) USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('event_tasks:' || NEW.event_series_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_tasks_per_event';
    SELECT count(*) INTO v_count FROM family_task_series WHERE event_series_id = NEW.event_series_id AND ended_at IS NULL;
    IF v_count >= COALESCE(v_max, 10) THEN
      RAISE EXCEPTION 'Au plus % tâches préparatoires par série de RDV', COALESCE(v_max, 10) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Jour de la veille d'une collecte (1 = lundi … 7 = dimanche) : la tâche « Sortir le bac » apparaît la veille
CREATE FUNCTION chore_day_before(p_day smallint) RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE WHEN p_day = 1 THEN 7 ELSE p_day - 1 END)::smallint
$$;
-- Gardes du catalogue
CREATE FUNCTION chore_tasks_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active)
     AND NOT EXISTS (SELECT 1 FROM chore_gestures g WHERE g.task_id = NEW.id) THEN
    RAISE EXCEPTION 'Ajoutez au moins un geste.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION chore_tasks_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Une tâche ménagère n''est jamais supprimée : masquez-la' USING ERRCODE = 'restrict_violation';
END $$;
CREATE FUNCTION chore_gesture_keep_one() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.task_id = OLD.task_id THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM chore_tasks t WHERE t.id = OLD.task_id AND t.is_active)
     AND NOT EXISTS (SELECT 1 FROM chore_gestures g WHERE g.task_id = OLD.task_id AND g.id <> OLD.id) THEN
    RAISE EXCEPTION 'Une tâche active garde au moins un geste' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE FUNCTION chore_bin_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chore_tasks t WHERE t.id = NEW.task_id AND t.schedule_mode = 'day_before_collection') THEN
    RAISE EXCEPTION 'Un bac se rattache à une tâche à collecte (Sorties de poubelles)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION chore_troubleshooting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.is_closing THEN
    RAISE EXCEPTION 'La dernière ligne du dépannage est fixe' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.is_closing THEN
    RAISE EXCEPTION 'La dernière ligne du dépannage est fixe' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE FUNCTION chore_troubleshooting_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM chore_troubleshooting x WHERE x.id = NEW.troubleshooting_id AND x.is_closing) THEN
    RAISE EXCEPTION 'La dernière ligne du dépannage est fixe : elle s''applique à toutes les tâches qui ont un dépannage' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Gardes du réglage du foyer
CREATE FUNCTION chore_household_task_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_mode chore_schedule_mode; v_active boolean;
BEGIN
  SELECT t.schedule_mode, t.is_active INTO v_mode, v_active FROM chore_tasks t WHERE t.id = NEW.task_id;
  IF v_mode = 'weekdays' THEN
    IF NEW.weekdays IS NULL OR NOT iso_weekdays_valid(NEW.weekdays) THEN
      RAISE EXCEPTION 'Choisissez au moins un jour.' USING ERRCODE = 'check_violation';
    END IF;
    NEW.weekdays := ARRAY(SELECT d FROM unnest(NEW.weekdays) d ORDER BY d);
  ELSIF NEW.weekdays IS NOT NULL THEN
    RAISE EXCEPTION 'Les jours de cette tâche viennent des jours de collecte des bacs' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.is_enabled AND (TG_OP = 'INSERT' OR NOT OLD.is_enabled) AND NOT v_active THEN
    RAISE EXCEPTION 'Cette tâche n''est plus proposée.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION chore_household_collection_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_account uuid; v_task integer;
BEGIN
  v_account := COALESCE(NEW.account_id, OLD.account_id);
  v_task := COALESCE(NEW.task_id, OLD.task_id);
  IF EXISTS (SELECT 1 FROM chore_household_tasks h JOIN chore_tasks t ON t.id = h.task_id
              WHERE h.account_id = v_account AND h.task_id = v_task AND h.is_enabled AND t.schedule_mode = 'day_before_collection')
     AND NOT EXISTS (SELECT 1 FROM chore_household_bins b WHERE b.account_id = v_account AND b.task_id = v_task AND b.collection_day IS NOT NULL) THEN
    RAISE EXCEPTION 'Choisissez au moins un jour de collecte.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
-- Les séries : jours et personne viennent du réglage du foyer ; la série d'un bac tombe la veille de sa collecte
CREATE FUNCTION family_task_series_chore_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_days smallint[]; v_member uuid; v_day smallint; v_time time;
BEGIN
  IF NEW.ended_at IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.chore_bin_id IS NULL THEN
    SELECT h.weekdays, h.member_id INTO v_days, v_member FROM chore_household_tasks h
     WHERE h.account_id = NEW.account_id AND h.task_id = NEW.chore_task_id AND h.is_enabled;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cette tâche ménagère n''est pas activée dans le foyer' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT b.collection_day, b.due_time, h.member_id INTO v_day, v_time, v_member FROM chore_household_bins b
      JOIN chore_household_tasks h ON h.account_id = b.account_id AND h.task_id = b.task_id AND h.is_enabled
     WHERE b.account_id = NEW.account_id AND b.bin_id = NEW.chore_bin_id;
    IF NOT FOUND OR v_day IS NULL THEN
      RAISE EXCEPTION 'Ce bac n''a pas de jour de collecte dans le foyer' USING ERRCODE = 'check_violation';
    END IF;
    v_days := ARRAY[chore_day_before(v_day)]::smallint[];
    NEW.due_time := v_time;
  END IF;
  NEW.weekdays := v_days;
  NEW.assigned_member_id := v_member;
  RETURN NEW;
END $$;
CREATE FUNCTION family_task_series_chore_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.chore_bin_id IS NULL THEN
      UPDATE chore_household_tasks SET chore_series_id = NEW.id WHERE account_id = NEW.account_id AND task_id = NEW.chore_task_id;
    ELSE
      UPDATE chore_household_bins SET chore_series_id = NEW.id WHERE account_id = NEW.account_id AND bin_id = NEW.chore_bin_id;
    END IF;
  ELSE
    UPDATE chore_household_tasks SET chore_series_id = NULL WHERE chore_series_id = NEW.id;
    UPDATE chore_household_bins SET chore_series_id = NULL WHERE chore_series_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
-- Un changement du réglage s'applique à la série dès le lendemain (date locale de la famille) : nouveaux jours et nouvelle personne, occurrences à venir des jours retirés supprimées
CREATE FUNCTION chore_resync_series(p_series uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_today date; v_account uuid; v_days smallint[]; v_member uuid; v_time time;
BEGIN
  SELECT s.account_id INTO v_account FROM family_task_series s WHERE s.id = p_series AND s.ended_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT (now() AT TIME ZONE a.family_timezone)::date INTO v_today FROM accounts a WHERE a.id = v_account;
  v_today := COALESCE(v_today, current_date);
  UPDATE family_task_series SET materialized_until = LEAST(materialized_until, v_today) WHERE id = p_series;
  SELECT s.weekdays, s.assigned_member_id, s.due_time INTO v_days, v_member, v_time FROM family_task_series s WHERE s.id = p_series;
  DELETE FROM family_tasks t
   WHERE t.series_id = p_series AND t.status IN ('proposed', 'todo') AND t.due_date > v_today
     AND NOT (date_part('isodow', t.due_date)::smallint = ANY (v_days));
  UPDATE family_tasks t SET assigned_member_id = v_member, due_time = v_time
   WHERE t.series_id = p_series AND t.status IN ('proposed', 'todo') AND t.due_date > v_today
     AND (t.assigned_member_id IS DISTINCT FROM v_member OR t.due_time IS DISTINCT FROM v_time);
END $$;
-- Termine une série ménagère : comme end_family_task_series (les occurrences à faire à partir d'aujourd'hui sont annulées, les passées restent), sans personne qui agit
CREATE FUNCTION chore_end_series(p_series uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE family_task_series SET ended_at = COALESCE(ended_at, now()) WHERE id = p_series;
  UPDATE family_tasks SET status = 'cancelled', cancel_reason = 'series_ended'
   WHERE series_id = p_series AND status IN ('proposed', 'todo') AND due_date >= current_date;
END $$;
CREATE FUNCTION chore_household_task_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_s record;
BEGIN
  FOR v_s IN SELECT id FROM family_task_series WHERE account_id = NEW.account_id AND chore_task_id = NEW.task_id AND ended_at IS NULL LOOP
    IF NEW.is_enabled THEN
      PERFORM chore_resync_series(v_s.id);
    ELSE
      PERFORM chore_end_series(v_s.id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE FUNCTION chore_household_bin_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_s record;
BEGIN
  FOR v_s IN SELECT id FROM family_task_series WHERE account_id = NEW.account_id AND chore_bin_id = NEW.bin_id AND ended_at IS NULL LOOP
    IF NEW.collection_day IS NULL THEN
      PERFORM chore_end_series(v_s.id);
    ELSE
      PERFORM chore_resync_series(v_s.id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
-- Un membre retiré ou effacé n'est plus la personne d'une tâche ménagère
CREATE FUNCTION chore_member_released() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE chore_household_tasks SET member_id = NULL WHERE member_id = NEW.id;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX ux_chore_tasks_name ON chore_tasks (lower(btrim(name)));
CREATE INDEX idx_chore_tasks_position ON chore_tasks (position, id);
CREATE INDEX idx_chore_gestures_task ON chore_gestures (task_id, position, id);
CREATE INDEX idx_chore_never_do_tasks_task ON chore_never_do_tasks (task_id);
CREATE UNIQUE INDEX ux_chore_troubleshooting_closing ON chore_troubleshooting (is_closing) WHERE is_closing;
CREATE INDEX idx_chore_troubleshooting_tasks_task ON chore_troubleshooting_tasks (task_id);
CREATE INDEX idx_chore_task_materials_material ON chore_task_materials (material_id);
CREATE INDEX idx_chore_task_products_product ON chore_task_products (product_id);
CREATE INDEX idx_chore_task_recipes_recipe ON chore_task_recipes (recipe_id);
CREATE INDEX idx_chore_fabric_settings_task ON chore_fabric_settings (task_id, position);
CREATE INDEX idx_chore_task_notes_task ON chore_task_notes (task_id, kind, position);
CREATE INDEX idx_chore_bins_task ON chore_bins (task_id, position);
CREATE INDEX idx_chore_household_tasks_task ON chore_household_tasks (task_id);
CREATE INDEX idx_chore_household_tasks_member ON chore_household_tasks (member_id, account_id) WHERE member_id IS NOT NULL;
CREATE INDEX idx_chore_household_tasks_series ON chore_household_tasks (chore_series_id, account_id) WHERE chore_series_id IS NOT NULL;
CREATE INDEX idx_chore_household_bins_bin ON chore_household_bins (bin_id, task_id);
CREATE INDEX idx_chore_household_bins_task ON chore_household_bins (account_id, task_id);
CREATE INDEX idx_chore_household_bins_series ON chore_household_bins (chore_series_id, account_id) WHERE chore_series_id IS NOT NULL;
CREATE UNIQUE INDEX ux_task_series_chore_task ON family_task_series (account_id, chore_task_id)
  WHERE chore_task_id IS NOT NULL AND chore_bin_id IS NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX ux_task_series_chore_bin ON family_task_series (account_id, chore_bin_id)
  WHERE chore_bin_id IS NOT NULL AND ended_at IS NULL;
CREATE INDEX idx_task_series_chore_task ON family_task_series (chore_task_id) WHERE chore_task_id IS NOT NULL;
CREATE INDEX idx_task_series_chore_bin ON family_task_series (chore_bin_id, chore_task_id) WHERE chore_bin_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Triggers et sécurité par ligne
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_chore_tasks_before_write BEFORE INSERT OR UPDATE ON chore_tasks
  FOR EACH ROW EXECUTE FUNCTION chore_tasks_before_write();
CREATE TRIGGER trg_chore_tasks_no_delete BEFORE DELETE ON chore_tasks
  FOR EACH ROW EXECUTE FUNCTION chore_tasks_no_delete();
CREATE TRIGGER trg_chore_gestures_keep_one BEFORE DELETE OR UPDATE OF task_id ON chore_gestures
  FOR EACH ROW EXECUTE FUNCTION chore_gesture_keep_one();
CREATE TRIGGER trg_chore_bins_before_write BEFORE INSERT OR UPDATE OF task_id ON chore_bins
  FOR EACH ROW EXECUTE FUNCTION chore_bin_before_write();
CREATE TRIGGER trg_chore_troubleshooting_guard BEFORE UPDATE OR DELETE ON chore_troubleshooting
  FOR EACH ROW EXECUTE FUNCTION chore_troubleshooting_guard();
CREATE TRIGGER trg_chore_troubleshooting_tasks_guard BEFORE INSERT OR UPDATE ON chore_troubleshooting_tasks
  FOR EACH ROW EXECUTE FUNCTION chore_troubleshooting_link_guard();
CREATE TRIGGER trg_chore_household_tasks_before_write BEFORE INSERT OR UPDATE ON chore_household_tasks
  FOR EACH ROW EXECUTE FUNCTION chore_household_task_before_write();
CREATE TRIGGER trg_chore_household_tasks_not_hidden BEFORE INSERT OR UPDATE OF member_id ON chore_household_tasks
  FOR EACH ROW EXECUTE FUNCTION family_member_not_hidden_guard('member_id');
CREATE CONSTRAINT TRIGGER trg_chore_household_tasks_collection AFTER INSERT OR UPDATE ON chore_household_tasks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION chore_household_collection_check();
CREATE CONSTRAINT TRIGGER trg_chore_household_bins_collection AFTER INSERT OR UPDATE OR DELETE ON chore_household_bins
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION chore_household_collection_check();
CREATE TRIGGER trg_family_task_series_chore_sync BEFORE INSERT OR UPDATE ON family_task_series
  FOR EACH ROW WHEN (NEW.source = 'household_chore') EXECUTE FUNCTION family_task_series_chore_sync();
CREATE TRIGGER trg_family_task_series_chore_link_insert AFTER INSERT ON family_task_series
  FOR EACH ROW WHEN (NEW.source = 'household_chore') EXECUTE FUNCTION family_task_series_chore_link();
CREATE TRIGGER trg_family_task_series_chore_link_end AFTER UPDATE OF ended_at ON family_task_series
  FOR EACH ROW WHEN (NEW.source = 'household_chore' AND OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL) EXECUTE FUNCTION family_task_series_chore_link();
CREATE TRIGGER trg_chore_household_tasks_changed AFTER UPDATE OF is_enabled, weekdays, member_id ON chore_household_tasks
  FOR EACH ROW WHEN (OLD.is_enabled IS DISTINCT FROM NEW.is_enabled OR OLD.weekdays IS DISTINCT FROM NEW.weekdays OR OLD.member_id IS DISTINCT FROM NEW.member_id)
  EXECUTE FUNCTION chore_household_task_changed();
CREATE TRIGGER trg_chore_household_bins_changed AFTER UPDATE OF collection_day, due_time ON chore_household_bins
  FOR EACH ROW WHEN (OLD.collection_day IS DISTINCT FROM NEW.collection_day OR OLD.due_time IS DISTINCT FROM NEW.due_time) EXECUTE FUNCTION chore_household_bin_changed();
CREATE TRIGGER trg_family_members_chore_released AFTER UPDATE OF archived_at, anonymized_at ON family_members
  FOR EACH ROW WHEN ((OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL) OR (OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL))
  EXECUTE FUNCTION chore_member_released();
-- Sécurité par ligne du réglage du foyer (activée, non forcée ; app.user_id) : les deux parents écrivent, les invités secondaires lisent
ALTER TABLE chore_household_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY chore_household_tasks_read ON chore_household_tasks FOR SELECT USING (account_id = (SELECT grocery_member_account()));
CREATE POLICY chore_household_tasks_insert ON chore_household_tasks FOR INSERT WITH CHECK (account_id = (SELECT grocery_couple_account()));
CREATE POLICY chore_household_tasks_update ON chore_household_tasks FOR UPDATE
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
CREATE POLICY chore_household_tasks_delete ON chore_household_tasks FOR DELETE USING (account_id = (SELECT grocery_couple_account()));
ALTER TABLE chore_household_bins ENABLE ROW LEVEL SECURITY;
CREATE POLICY chore_household_bins_read ON chore_household_bins FOR SELECT USING (account_id = (SELECT grocery_member_account()));
CREATE POLICY chore_household_bins_insert ON chore_household_bins FOR INSERT WITH CHECK (account_id = (SELECT grocery_couple_account()));
CREATE POLICY chore_household_bins_update ON chore_household_bins FOR UPDATE
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
CREATE POLICY chore_household_bins_delete ON chore_household_bins FOR DELETE USING (account_id = (SELECT grocery_couple_account()));
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
-- Premier chargement du catalogue : le « Guide ménage de la semaine — pas à pas » du 12/11/2026, repris tel quel (TM-01, US-183 RF6), sans le geste « Repassage » de la tâche Linge (TM-06).
-- Les tâches sont créées masquées, reçoivent leurs gestes, puis sont rendues actives.
INSERT INTO chore_tasks (name, position, schedule_mode, default_days, suggested_minutes) VALUES
  ('Cuisine', 1, 'weekdays', ARRAY[1]::smallint[], 35),
  ('Salle de bains', 2, 'weekdays', ARRAY[2]::smallint[], 30),
  ('Toilettes', 3, 'weekdays', ARRAY[2]::smallint[], 10),
  ('Sols', 4, 'weekdays', ARRAY[4]::smallint[], 45),
  ('Chambres et pièces de vie', 5, 'weekdays', ARRAY[3]::smallint[], 35),
  ('Linge', 6, 'weekdays', ARRAY[5]::smallint[], 60),
  ('Repassage', 7, 'weekdays', ARRAY[5]::smallint[], 30),
  ('Sorties de poubelles', 8, 'day_before_collection', NULL, 10);
INSERT INTO chore_gestures (task_id, position, name, product, minutes, steps)
SELECT t.id, v.position, v.name, v.product, v.minutes, v.steps
  FROM (VALUES
  ('Cuisine', 1, 'Plan de travail, table', 'Spray savon noir', 5, ARRAY['Tout débarrasser', 'Pulvériser', 'Attendre 2 min', 'Essuyer et sécher']::text[]),
  ('Cuisine', 2, 'Évier, robinet', 'Bicarbonate + vinaigre', 7, ARRAY['Bicarbonate + éponge sur l''évier', 'Vinaigre sur le robinet, attendre 10 min', 'Rincer', 'Essuyer le robinet']::text[]),
  ('Cuisine', 3, 'Plaques de cuisson', 'Bicarbonate (gaz) ou vinaigre (induction)', 5, ARRAY['Plaques froides', 'Appliquer le produit, attendre 5 min', 'Frotter doucement', 'Rincer et sécher']::text[]),
  ('Cuisine', 4, 'Micro-ondes', 'Citron ou vinaigre', 3, ARRAY['Bol d''eau + citron', 'Chauffer 3 min', 'Attendre 5 min', 'Essuyer']::text[]),
  ('Cuisine', 5, 'Réfrigérateur', 'Eau + vinaigre', 10, ARRAY['Jeter les périmés', 'Essuyer étagères et bacs', 'Nettoyer les joints', 'Sécher et ranger']::text[]),
  ('Cuisine', 6, 'Poubelle', 'Vinaigre + bicarbonate', 3, ARRAY['Vider', 'Pulvériser le vinaigre', 'Essuyer', 'Bicarbonate au fond, nouveau sac']::text[]),
  ('Salle de bains', 1, 'Douche, baignoire', 'Vinaigre chaud + bicarbonate', 15, ARRAY['Pulvériser le vinaigre', 'Attendre 10 min', 'Frotter (bicarbonate sur les taches)', 'Rincer', 'Raclette sur les parois']::text[]),
  ('Salle de bains', 2, 'Pommeau de douche', 'Vinaigre', 2, ARRAY['Sac rempli de vinaigre attaché autour', 'Attendre 30 min', 'Retirer le sac', 'Faire couler l''eau']::text[]),
  ('Salle de bains', 3, 'Lavabo', 'Bicarbonate', 5, ARRAY['Mouiller', 'Frotter avec bicarbonate', 'Rincer', 'Essuyer']::text[]),
  ('Salle de bains', 4, 'Miroir', 'Eau + vinaigre', 2, ARRAY['Pulvériser sur le chiffon', 'Essuyer en zigzag', 'Repasser avec un chiffon sec']::text[]),
  ('Salle de bains', 5, 'Joints noircis', 'Vinaigre pur', 5, ARRAY['Pulvériser', 'Attendre 30 min', 'Brosser', 'Rincer']::text[]),
  ('Toilettes', 1, 'Cuvette', 'Vinaigre ou acide citrique', 5, ARRAY['Verser un verre de vinaigre sous le rebord', 'Attendre 15 à 30 min', 'Brosser', 'Tirer la chasse']::text[]),
  ('Toilettes', 2, 'Lunette, abattant, chasse', 'Alcool ménager 70°', 3, ARRAY['Pulvériser le chiffon rouge', 'Essuyer : bouton, réservoir, abattant, lunette, extérieur', 'Laver le chiffon à 60 °C']::text[]),
  ('Toilettes', 3, 'Brosse', 'Vinaigre', 1, ARRAY['Rincer sous la chasse', 'Vinaigre dans le support', 'Laisser sécher']::text[]),
  ('Sols', 1, 'Aspirer', 'Aspirateur', 20, ARRAY['Commencer par la pièce du fond', 'Dessous des meubles et plinthes', 'Tapis dans les deux sens', 'Vider le bac']::text[]),
  ('Sols', 2, 'Laver carrelage', 'Savon noir (1 c. à soupe pour 5 L d''eau tiède)', 25, ARRAY['Remplir le seau', 'Bien essorer', 'Laver en reculant vers la sortie', 'Changer l''eau si elle est sale', 'Finir par les toilettes']::text[]),
  ('Sols', 3, 'Parquet, stratifié', 'Savon noir très dilué (1 c. à café par litre)', 15, ARRAY['Aspirer', 'Serpillière presque sèche', 'Dans le sens des lames. Pas de vinaigre, pas trop d''eau']::text[]),
  ('Chambres et pièces de vie', 1, 'Dépoussiérer', 'Chiffon vert humide', 15, ARRAY['Humidifier et essorer le chiffon', 'Travailler du haut vers le bas', 'Rincer dès qu''il est gris. Écrans : chiffon presque sec']::text[]),
  ('Chambres et pièces de vie', 2, 'Poignées, interrupteurs, télécommandes', 'Alcool ménager 70°', 5, ARRAY['Pulvériser sur le chiffon', 'Essuyer', 'Laisser sécher']::text[]),
  ('Chambres et pièces de vie', 3, 'Canapé, coussins', 'Bicarbonate si odeur', 5, ARRAY['Secouer les coussins', 'Aspirer', 'Si odeur : bicarbonate, attendre 15 min, aspirer']::text[]),
  ('Chambres et pièces de vie', 4, 'Aérer', NULL, 10, ARRAY['Ouvrir toutes les fenêtres en grand']::text[]),
  ('Linge', 1, 'Lessive', 'Lessive écologique, vinaigre en adoucissant', 15, ARRAY['Trier blanc, couleurs, foncé', 'Vider les poches', 'Tambour aux ¾', 'Lessive + ½ verre de vinaigre dans le bac adoucissant', '30–40 °C couleurs, 60 °C draps et serviettes', 'Sortir dès la fin']::text[]),
  ('Linge', 2, 'Détacher', 'Savon de Marseille, percarbonate', 5, ARRAY['Agir vite', 'Frotter au savon ou tremper avec 1 c. à soupe de percarbonate', 'Rincer', 'Laver. Pas de sèche-linge avant que la tache soit partie']::text[]),
  ('Linge', 3, 'Séchage', NULL, 10, ARRAY['Secouer chaque pièce', 'Étendre avec de l''espace', 'Aérer. Sèche-linge : nettoyer le filtre à chaque cycle']::text[]),
  ('Linge', 4, 'Draps', NULL, 15, ARRAY['Retirer les draps', 'Aérer le matelas 30 min', 'Poser les draps propres', 'Laver à 60 °C']::text[]),
  ('Linge', 5, 'Rangement', NULL, 15, ARRAY['Plier sans attendre', 'Ranger par personne', 'Mettre de côté le trop petit ou abîmé']::text[]),
  ('Repassage', 1, 'Chemise', NULL, 5, ARRAY['Col, dessous puis dessus', 'Poignets', 'Manches', 'Dos', 'Devant, un côté après l''autre', 'Cintre, bouton du haut fermé']::text[]),
  ('Repassage', 2, 'Pantalon', NULL, 4, ARRAY['Poches', 'Ceinture', 'Une jambe à plat, à l''envers puis à l''endroit', 'Pli, à la même place', 'Cintre']::text[]),
  ('Repassage', 3, 'Robe, jupe', NULL, 5, ARRAY['Haut ou taille', 'Jupe en tournant', 'Cintre']::text[]),
  ('Repassage', 4, 'Nappe, drap', NULL, 8, ARRAY['Plier en deux', 'Repasser par grandes zones', 'Plier selon l''habitude', 'Ranger']::text[]),
  ('Repassage', 5, 'T-shirt, polo', NULL, 2, ARRAY['À l''envers', 'Pas de vapeur sur les imprimés', 'Plier']::text[]),
  ('Sorties de poubelles', 1, 'Pas à pas du soir de collecte', NULL, NULL, ARRAY['Vérifier le jour dans le tableau ci-dessus', 'Vider les poubelles de la maison dans les bacs : cuisine, salle de bains, toilettes, chambres, bureau', 'Remettre un sac propre dans chaque poubelle. Une cuillère de bicarbonate au fond de la poubelle de cuisine limite les odeurs', 'Fermer les sacs sans trop les remplir (ils doivent rester légers)', 'Sortir les bacs sur le trottoir, poignées vers la rue, sans gêner le passage', 'Le lendemain, une fois vidés, les rentrer']::text[]),
  ('Sorties de poubelles', 2, 'Entretien des bacs (une fois par mois)', NULL, NULL, ARRAY['Rincer à l''eau chaude au jet ou à l''arrosoir', 'Saupoudrer de bicarbonate, puis pulvériser du vinaigre blanc', 'Frotter avec une brosse', 'Rincer et laisser sécher couvercle ouvert']::text[])
  ) AS v(task, position, name, product, minutes, steps)
  JOIN chore_tasks t ON t.name = v.task;
UPDATE chore_tasks SET is_active = true;
INSERT INTO chore_golden_rules (position, title, body) VALUES
  (1, 'Aspirer avant de laver', 'on retire d''abord la poussière, on lave ensuite.'),
  (2, 'Du haut vers le bas', 'poussière sur les meubles avant le sol.'),
  (3, 'Du plus propre au plus sale', 'on finit toujours par les toilettes.'),
  (4, 'Laisser agir 5 à 10 minutes', 'le produit travaille à notre place, on frotte moins.'),
  (5, 'Un chiffon par zone', 'on ne passe jamais le chiffon des toilettes ailleurs.');
INSERT INTO chore_materials (position, name, detail) VALUES
  (1, 'Chiffon bleu', 'Chiffon microfibre pour la cuisine'),
  (2, 'Chiffon jaune', 'Chiffon microfibre pour la salle de bains'),
  (3, 'Chiffon rouge', 'Chiffon microfibre pour les toilettes uniquement'),
  (4, 'Chiffon vert', 'Chiffon microfibre pour les meubles et la poussière'),
  (5, 'Pulvérisateurs', '2 pulvérisateurs vides étiquetés : « multi-usage » et « vitres »'),
  (6, 'Éponge à gratter', NULL),
  (7, 'Brosse WC', NULL),
  (8, 'Raclette pour la douche', NULL),
  (9, 'Aspirateur', NULL),
  (10, 'Balai', NULL),
  (11, 'Serpillière', NULL),
  (12, 'Seau', NULL);
INSERT INTO chore_products (position, name, used_for, avoid_on, is_optional) VALUES
  (1, 'Vinaigre blanc ménager (14°)', 'Détartrer, dégraisser, faire briller les vitres', 'Marbre, granit, pierre naturelle, parquet huilé ou ciré', false),
  (2, 'Bicarbonate de soude', 'Frotter doucement, désodoriser, dégraisser', 'Surfaces très fragiles (alu, plaques vitrocéramiques si on frotte fort)', false),
  (3, 'Savon noir liquide', 'Sols, plans de travail, dégraissage général', 'Rien de particulier, bien rincer sur surfaces vernies', false),
  (4, 'Savon de Marseille (cube ou liquide)', 'Lessive, détachage, vaisselle', 'Laine et soie (utiliser un savon doux spécifique)', false),
  (5, 'Acide citrique (poudre)', 'Détartrer robinets, bouilloire, douche, fer à repasser', 'Marbre, pierre naturelle, joints anciens', false),
  (6, 'Alcool ménager 70°', 'Désinfecter poignées, interrupteurs, télécommandes, miroirs', 'Surfaces vernies, plastique fragile, près d''une flamme', false),
  (7, 'Cristaux de soude', 'Gros nettoyage, canalisations, sols très sales', NULL, true),
  (8, 'Percarbonate de sodium', 'Blanchit le linge, détache', NULL, true);
INSERT INTO chore_recipes (position, name, dosage, used_for) VALUES
  (1, 'Multi-usage', '250 mL de vinaigre blanc + 250 mL d''eau', 'Cuisine, salle de bains, vitres, miroirs'),
  (2, 'Savon noir en spray', '1 c. à soupe de savon noir dans 500 mL d''eau tiède', 'Plans de travail, tables, meubles'),
  (3, 'Détartrant', '2 c. à soupe d''acide citrique dans 500 mL d''eau chaude', 'Robinets, douche, bouilloire, fer à repasser'),
  (4, 'Pâte à récurer', '3 c. à soupe de bicarbonate + 1 c. à soupe d''eau', 'Évier, baignoire, plaques de gaz, fonds de casseroles'),
  (5, 'Désinfectant', 'Alcool ménager 70°, pur', 'Poignées, interrupteurs, lunette des toilettes');
INSERT INTO chore_fabric_settings (task_id, position, fabric, iron_points, max_temperature_c, advice)
SELECT t.id, v.position, v.fabric, v.points, v.temperature, v.advice
  FROM (VALUES
  (1, 'Soie, synthétique, viscose', 1, 110, 'Sans vapeur, à l''envers'),
  (2, 'Laine, mélange polyester', 2, 150, 'Chiffon fin entre le fer et le tissu'),
  (3, 'Coton', 3, 200, 'Vapeur, linge légèrement humide'),
  (4, 'Lin', 3, 200, 'Vapeur forte, repasser encore humide')
  ) AS v(position, fabric, points, temperature, advice)
  JOIN chore_tasks t ON t.name = 'Repassage';
INSERT INTO chore_task_notes (task_id, kind, position, title, body)
SELECT t.id, v.kind::chore_note_kind, v.position, v.title, v.body
  FROM (VALUES
  ('Repassage', 'intro', 1, NULL, 'On ne repasse que ce qui en a besoin : chemises, pantalons de ville, nappes. Serviettes, T-shirts, sous-vêtements et draps de bain n''ont pas besoin de fer s''ils sont secoués et pliés en sortant du sèche-linge.'),
  ('Repassage', 'before_start', 1, NULL, 'Remplir le réservoir d''eau (eau déminéralisée si l''eau du robinet est calcaire). Ne pas y mettre de vinaigre ni de parfum.'),
  ('Repassage', 'before_start', 2, NULL, 'Installer la planche, le fer à portée de main, un cintre libre et un spray d''eau.'),
  ('Repassage', 'before_start', 3, NULL, 'Trier le linge par tissu, du plus fragile au plus résistant.'),
  ('Repassage', 'before_start', 4, NULL, 'Allumer le fer et attendre le voyant : il chauffe 2 à 3 min.'),
  ('Repassage', 'other', 1, NULL, 'Ordre de la séance : le fragile d''abord, le lin et le coton à la fin, quand le fer est le plus chaud.'),
  ('Sorties de poubelles', 'intro', 1, NULL, 'La sortie des bacs se fait la veille au soir, ou le matin avant l''heure de collecte indiquée par la commune.'),
  ('Sorties de poubelles', 'other', 1, NULL, 'Les consignes de tri changent selon les communes : en cas de doute sur un emballage, vérifier le guide du tri de la commune.'),
  ('Sorties de poubelles', 'other', 2, 'Autres déchets', 'Encombrants (meubles, électroménager) : déchetterie ou collecte sur rendez-vous, selon la commune.'),
  ('Sorties de poubelles', 'other', 3, 'Autres déchets', 'Piles, ampoules, produits ménagers vides, médicaments périmés : pas dans les bacs, les rapporter en magasin, en pharmacie ou à la déchetterie.'),
  ('Sorties de poubelles', 'other', 4, 'Autres déchets', 'Vieux textile : points de collecte, même abîmé, s''il est propre et sec.')
  ) AS v(task, kind, position, title, body)
  JOIN chore_tasks t ON t.name = v.task;
INSERT INTO chore_bins (task_id, position, name, contents, collection_hint, task_title)
SELECT t.id, v.position, v.name, v.contents, v.hint, v.title
  FROM (VALUES
  (1, 'Ordures ménagères', 'Tout ce qui ne se trie pas : restes non compostables, couches, balayures', NULL, 'Sortir le bac des ordures ménagères'),
  (2, 'Emballages et papiers (bac jaune)', 'Emballages en plastique, métal, carton ; papiers. Vides, pas besoin de les laver', NULL, 'Sortir le bac jaune'),
  (3, 'Verre', 'Bouteilles, bocaux, sans bouchon ni couvercle', 'colonne à verre ou bac', 'Sortir le verre'),
  (4, 'Biodéchets (compost ou bac dédié)', 'Épluchures, marc de café, restes de repas, selon la commune', NULL, 'Sortir les biodéchets')
  ) AS v(position, name, contents, hint, title)
  JOIN chore_tasks t ON t.name = 'Sorties de poubelles';
INSERT INTO chore_never_do (position, body) VALUES
  (1, 'Ne jamais mélanger de la javel avec du vinaigre, de l''ammoniaque ou un produit pour toilettes : cela dégage un gaz toxique. Ce guide n''utilise pas de javel.'),
  (2, 'Ne pas mélanger vinaigre et savon noir dans le même seau : ils s''annulent.'),
  (3, 'Pas de vinaigre ni d''acide citrique sur marbre, granit ou pierre naturelle : ils les attaquent.'),
  (4, 'Alcool : loin de toute flamme et de la plaque de cuisson allumée, pièce aérée.'),
  (5, 'Toujours aérer pendant et après le ménage. Porter des gants si la peau est sensible.');
INSERT INTO chore_never_do_tasks (never_do_id, task_id)
SELECT n.id, t.id
  FROM (VALUES
  (1, 'Cuisine'),
  (1, 'Salle de bains'),
  (1, 'Toilettes'),
  (1, 'Sols'),
  (1, 'Chambres et pièces de vie'),
  (2, 'Cuisine'),
  (2, 'Sols'),
  (3, 'Cuisine'),
  (3, 'Salle de bains'),
  (3, 'Toilettes'),
  (3, 'Sols'),
  (4, 'Cuisine'),
  (4, 'Toilettes'),
  (4, 'Chambres et pièces de vie'),
  (5, 'Cuisine'),
  (5, 'Salle de bains'),
  (5, 'Toilettes'),
  (5, 'Sols'),
  (5, 'Chambres et pièces de vie')
  ) AS v(position, task)
  JOIN chore_never_do n ON n.position = v.position
  JOIN chore_tasks t ON t.name = v.task;
INSERT INTO chore_troubleshooting (position, problem, solution, is_closing) VALUES
  (1, 'Calcaire épais sur un robinet', 'Entourer d''un chiffon imbibé de vinaigre chaud 30 min, puis frotter et rincer', false),
  (2, 'Mauvaise odeur de l''évier', 'Verser 3 c. à soupe de bicarbonate, puis 1 verre de vinaigre chaud ; attendre 15 min, puis rincer à l''eau chaude', false),
  (3, 'Évier ou douche qui s''écoule lentement', 'Retirer les cheveux et débris, puis même mélange bicarbonate et vinaigre. Eau chaude (pas bouillante) si les tuyaux sont en PVC', false),
  (4, 'Odeur dans le réfrigérateur', 'Poser un petit bol de bicarbonate ouvert au fond', false),
  (5, 'Traces sur les vitres', 'Repasser avec un chiffon microfibre sec, jamais en plein soleil', false),
  (6, 'Moisissure qui revient', 'Vinaigre pur sur les joints 30 min, brosser, puis aérer la salle de bains après chaque douche', false),
  (7, 'Brillance sur un tissu foncé', 'Repasser à l''envers, ou passer un chiffon humide entre le fer et le tissu', false),
  (8, 'Pli marqué qui reste', 'Vaporiser un peu d''eau, repasser à nouveau', false),
  (9, 'Fer qui crache de l''eau blanche', 'Vider le réservoir et suivre la notice pour le détartrer', false),
  (10, 'Fer encrassé', 'Le passer sur un chiffon humide quand il est tiède, sans abrasif', false),
  (11, 'À la fin', 'Débrancher, vider le réservoir, laisser refroidir avant de ranger', false),
  (12, 'Problème que ce guide ne couvre pas', 'Arrêter, ne rien mélanger, et prévenir la personne qui s''en occupe habituellement', true);
INSERT INTO chore_task_materials (task_id, material_id)
SELECT t.id, x.id
  FROM (VALUES
  ('Chiffon bleu', 'Cuisine'),
  ('Chiffon jaune', 'Salle de bains'),
  ('Chiffon rouge', 'Toilettes'),
  ('Chiffon vert', 'Chambres et pièces de vie'),
  ('Pulvérisateurs', 'Cuisine'),
  ('Pulvérisateurs', 'Salle de bains'),
  ('Pulvérisateurs', 'Toilettes'),
  ('Pulvérisateurs', 'Chambres et pièces de vie'),
  ('Éponge à gratter', 'Cuisine'),
  ('Éponge à gratter', 'Salle de bains'),
  ('Brosse WC', 'Toilettes'),
  ('Raclette pour la douche', 'Salle de bains'),
  ('Aspirateur', 'Sols'),
  ('Aspirateur', 'Chambres et pièces de vie'),
  ('Balai', 'Sols'),
  ('Serpillière', 'Sols'),
  ('Seau', 'Sols')
  ) AS v(item, task)
  JOIN chore_materials x ON x.name = v.item
  JOIN chore_tasks t ON t.name = v.task;
INSERT INTO chore_task_products (task_id, product_id)
SELECT t.id, x.id
  FROM (VALUES
  ('Vinaigre blanc ménager (14°)', 'Cuisine'),
  ('Vinaigre blanc ménager (14°)', 'Salle de bains'),
  ('Vinaigre blanc ménager (14°)', 'Toilettes'),
  ('Vinaigre blanc ménager (14°)', 'Linge'),
  ('Vinaigre blanc ménager (14°)', 'Sorties de poubelles'),
  ('Bicarbonate de soude', 'Cuisine'),
  ('Bicarbonate de soude', 'Salle de bains'),
  ('Bicarbonate de soude', 'Chambres et pièces de vie'),
  ('Bicarbonate de soude', 'Sorties de poubelles'),
  ('Savon noir liquide', 'Cuisine'),
  ('Savon noir liquide', 'Sols'),
  ('Savon de Marseille (cube ou liquide)', 'Linge'),
  ('Acide citrique (poudre)', 'Toilettes'),
  ('Alcool ménager 70°', 'Toilettes'),
  ('Alcool ménager 70°', 'Chambres et pièces de vie'),
  ('Cristaux de soude', 'Sols'),
  ('Percarbonate de sodium', 'Linge')
  ) AS v(item, task)
  JOIN chore_products x ON x.name = v.item
  JOIN chore_tasks t ON t.name = v.task;
INSERT INTO chore_task_recipes (task_id, recipe_id)
SELECT t.id, x.id
  FROM (VALUES
  ('Multi-usage', 'Cuisine'),
  ('Multi-usage', 'Salle de bains'),
  ('Multi-usage', 'Chambres et pièces de vie'),
  ('Savon noir en spray', 'Cuisine'),
  ('Savon noir en spray', 'Chambres et pièces de vie'),
  ('Détartrant', 'Cuisine'),
  ('Détartrant', 'Salle de bains'),
  ('Détartrant', 'Repassage'),
  ('Pâte à récurer', 'Cuisine'),
  ('Pâte à récurer', 'Salle de bains'),
  ('Désinfectant', 'Toilettes'),
  ('Désinfectant', 'Chambres et pièces de vie')
  ) AS v(item, task)
  JOIN chore_recipes x ON x.name = v.item
  JOIN chore_tasks t ON t.name = v.task;
INSERT INTO chore_troubleshooting_tasks (troubleshooting_id, task_id)
SELECT x.id, t.id
  FROM (VALUES
  (1, 'Cuisine'),
  (1, 'Salle de bains'),
  (2, 'Cuisine'),
  (3, 'Cuisine'),
  (3, 'Salle de bains'),
  (4, 'Cuisine'),
  (5, 'Chambres et pièces de vie'),
  (6, 'Salle de bains'),
  (7, 'Repassage'),
  (8, 'Repassage'),
  (9, 'Repassage'),
  (10, 'Repassage'),
  (11, 'Repassage')
  ) AS v(position, task)
  JOIN chore_troubleshooting x ON x.position = v.position AND NOT x.is_closing
  JOIN chore_tasks t ON t.name = v.task;

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON FUNCTION chore_steps_valid(text[]) IS $$Vrai si la liste d'étapes d'un geste a de 1 à 30 étapes, aucune vide ni de plus de 500 caractères. [US-182 RF2, US-183 RF2]$$;
COMMENT ON FUNCTION chore_day_before(smallint) IS $$Jour de la veille d'un jour de collecte (ISO, 1 = lundi) : le dimanche (7) pour un lundi. [US-181 RF4, BA-3]$$;
COMMENT ON TABLE chore_tasks IS $$Catalogue commun des tâches ménagères guidées (Cuisine, Salle de bains, Toilettes, Sols, Chambres et pièces de vie, Linge, Repassage, Sorties de poubelles au premier chargement), géré par la console : nom, ordre, jours par défaut, temps proposé, active ou masquée. Jamais supprimée (une série de foyer la cite) : masquer la retire du choix des foyers sans casser leurs séries. Aucune donnée de foyer. [US-181 RF1 à RF3, US-183 RF1, RF2, RF2bis, RF4, TM-01, TM-02, TM-08]$$;
COMMENT ON COLUMN chore_tasks.name IS $$Nom de la tâche, unique (casse et espaces ignorés) ; sert de titre aux tâches du foyer, lu dans le catalogue (le titre d'une série ménagère n'est pas stocké). [US-181 RF2, US-183 RF2]$$;
COMMENT ON COLUMN chore_tasks.position IS $$Ordre d'affichage dans la carte des réglages et dans la console, à partir de 1. [US-183 RF2]$$;
COMMENT ON COLUMN chore_tasks.schedule_mode IS $$weekdays : le foyer coche au moins un jour (obligatoire, TM-05). day_before_collection : la tâche apparaît la veille du jour de collecte de chaque bac du foyer (Sorties de poubelles), sans jour propre. [US-181 RF3, RF4, BA-3]$$;
COMMENT ON COLUMN chore_tasks.default_days IS $$Jours par défaut proposés au foyer (1 = lundi … 7 = dimanche, sans doublon, au moins un) ; vide pour une tâche à collecte. [US-181 RF3, US-183 RF2bis]$$;
COMMENT ON COLUMN chore_tasks.suggested_minutes IS $$Temps de réalisation proposé, en minutes (« environ 35 min »), pour un logement moyen. [US-181 RF2, RF3]$$;
COMMENT ON COLUMN chore_tasks.is_active IS $$Vrai = proposée aux foyers. Ne peut être vraie qu'avec au moins un geste (« Ajoutez au moins un geste »). Masquer ne casse aucune série. [US-183 RF2bis, RF4, TM-08]$$;
COMMENT ON TABLE chore_gestures IS $$Gestes d'une tâche ménagère, dans l'ordre du guide : nom, produit, durée et étapes ordonnées (« Plan de travail, table : spray savon noir, 5 min, 4 étapes »). Contenu commun, modifiable en console ; ajouter, retirer, réordonner. Une tâche active garde au moins un geste. [US-182 RF1, RF2, US-183 RF2, TM-06]$$;
COMMENT ON COLUMN chore_gestures.task_id IS $$Tâche du catalogue à laquelle appartient le geste (le geste « Repassage » n'existe que dans la tâche Repassage, TM-06). [US-182 RF1]$$;
COMMENT ON COLUMN chore_gestures.position IS $$Ordre du geste dans la tâche, à partir de 1 (à égalité, l'ordre de création). [US-182 RF1, US-183 RF2]$$;
COMMENT ON COLUMN chore_gestures.name IS $$Nom du geste (« Évier, robinet »). [US-182 RF2]$$;
COMMENT ON COLUMN chore_gestures.product IS $$Produit du geste (« Bicarbonate + vinaigre ») ; vide quand le guide dit « Aucun » ou n'en nomme pas. [US-182 RF2]$$;
COMMENT ON COLUMN chore_gestures.minutes IS $$Durée du geste en minutes ; vide quand le guide n'en donne pas (gestes de la tâche Sorties de poubelles). [US-182 RF2]$$;
COMMENT ON COLUMN chore_gestures.steps IS $$Étapes ordonnées du pas à pas, une par élément, sans leur numéro (« Pulvériser », « Attendre 2 min »). De 1 à 30 étapes. [US-182 RF2, US-183 RF2]$$;
COMMENT ON TABLE chore_golden_rules IS $$Règles d'or du guide (« Aspirer avant de laver », « Du haut vers le bas »…), communes à toutes les tâches, affichées dans « Avant de commencer ». [US-182 RF3, US-183 RF3]$$;
COMMENT ON COLUMN chore_golden_rules.position IS $$Ordre d'affichage, à partir de 1. [US-182 RF3]$$;
COMMENT ON COLUMN chore_golden_rules.title IS $$Intitulé en gras de la règle (« Un chiffon par zone »). [US-182 RF3]$$;
COMMENT ON COLUMN chore_golden_rules.body IS $$Explication qui suit l'intitulé. [US-182 RF3]$$;
COMMENT ON TABLE chore_materials IS $$Matériel du guide, un élément par ligne (un chiffon microfibre par couleur, pulvérisateurs, éponge à gratter, brosse WC, raclette, aspirateur, balai, serpillière, seau). Chaque élément est rattaché aux tâches qui l'utilisent (chore_task_materials) : « Pour cette tâche : Chiffon bleu ». [US-182 RF3, US-183 RF3]$$;
COMMENT ON COLUMN chore_materials.position IS $$Ordre d'affichage, à partir de 1. [US-182 RF3]$$;
COMMENT ON COLUMN chore_materials.name IS $$Nom de l'élément (« Chiffon bleu », « Brosse WC »). [US-182 RF3]$$;
COMMENT ON COLUMN chore_materials.detail IS $$Précision facultative (« Chiffon microfibre pour la cuisine »), 500 caractères au plus. [US-182 RF3]$$;
COMMENT ON TABLE chore_products IS $$Produits du guide (6 produits de base et 2 facultatifs) : nom, « sert à », « à ne pas utiliser sur ». Contenu commun affiché dans « Avant de commencer ». [US-182 RF3, US-183 RF3]$$;
COMMENT ON COLUMN chore_products.position IS $$Ordre d'affichage, à partir de 1. [US-182 RF3]$$;
COMMENT ON COLUMN chore_products.name IS $$Nom du produit (« Vinaigre blanc ménager (14°) »). [US-182 RF3]$$;
COMMENT ON COLUMN chore_products.used_for IS $$« Sert à » : usages du produit. [US-182 RF3]$$;
COMMENT ON COLUMN chore_products.avoid_on IS $$« À ne pas utiliser sur » : surfaces à éviter ; vide quand le guide n'en donne pas. [US-182 RF3]$$;
COMMENT ON COLUMN chore_products.is_optional IS $$Produit facultatif (« Optionnel, pour le linge et les cas difficiles »). [US-182 RF3]$$;
COMMENT ON TABLE chore_recipes IS $$Recettes et dosages du guide (Multi-usage, Savon noir en spray, Détartrant, Pâte à récurer, Désinfectant) : nom, dosage, usage. Contenu commun affiché dans « Avant de commencer ». [US-182 RF3, US-183 RF3]$$;
COMMENT ON COLUMN chore_recipes.position IS $$Ordre d'affichage, à partir de 1. [US-182 RF3]$$;
COMMENT ON COLUMN chore_recipes.name IS $$Nom de la recette. [US-182 RF3]$$;
COMMENT ON COLUMN chore_recipes.dosage IS $$Dosage (« 250 mL de vinaigre blanc + 250 mL d'eau »). [US-182 RF3]$$;
COMMENT ON COLUMN chore_recipes.used_for IS $$« Pour » : surfaces ou usages de la recette. [US-182 RF3]$$;
COMMENT ON TABLE chore_never_do IS $$Consignes « À ne jamais faire » du guide (ne jamais mélanger de la javel avec du vinaigre…), toujours visibles et jamais repliées. Chacune s'applique à une ou plusieurs tâches (chore_never_do_tasks) ; Linge et Repassage n'en ont pas (TM-07), répartition modifiable en console. [US-182 RF4, US-183 RF3, TM-07]$$;
COMMENT ON COLUMN chore_never_do.position IS $$Ordre d'affichage, à partir de 1. [US-182 RF4]$$;
COMMENT ON COLUMN chore_never_do.body IS $$Texte de la consigne de sécurité. [US-182 RF4]$$;
COMMENT ON TABLE chore_never_do_tasks IS $$Tâches auxquelles s'applique chaque consigne « À ne jamais faire » (choix « S'applique à » de la console). [US-183 RF3]$$;
COMMENT ON TABLE chore_troubleshooting IS $$Dépannage rapide du guide (« Si ça ne se passe pas bien ») : problème et solution, rattachés à une ou plusieurs tâches (chore_troubleshooting_tasks). La dernière ligne (« Problème que ce guide ne couvre pas : arrêter, ne rien mélanger, et prévenir la personne qui s'en occupe habituellement ») est fixe et s'affiche en dernier sous le dépannage de toute tâche qui en a. [US-182 RF5, US-183 RF3]$$;
COMMENT ON COLUMN chore_troubleshooting.position IS $$Ordre d'affichage, à partir de 1 ; la ligne fixe vient toujours en dernier. [US-182 RF5]$$;
COMMENT ON COLUMN chore_troubleshooting.problem IS $$Problème (« Calcaire épais sur un robinet »). [US-182 RF5]$$;
COMMENT ON COLUMN chore_troubleshooting.solution IS $$Solution. [US-182 RF5]$$;
COMMENT ON COLUMN chore_troubleshooting.is_closing IS $$Vrai pour l'unique dernière ligne fixe du dépannage : la base refuse de la modifier, de la supprimer, d'en créer une seconde ou de la rattacher à une tâche. [US-182 RF5]$$;
COMMENT ON TABLE chore_troubleshooting_tasks IS $$Tâches auxquelles s'applique chaque ligne du dépannage (choix « S'applique à » de la console). [US-183 RF3]$$;
COMMENT ON TABLE chore_task_materials IS $$Matériel de chaque tâche (la couleur du chiffon à utiliser, les outils), affiché dans « Avant de commencer » de la tâche. Premier rattachement tiré des gestes du guide ; modifiable en console. [US-182 RF3, US-183 RF3]$$;
COMMENT ON TABLE chore_task_products IS $$Produits de chaque tâche, avec « Sert à » et « À ne pas utiliser sur », affichés dans « Avant de commencer » de la tâche. Premier rattachement tiré des produits cités par les gestes du guide ; modifiable en console. [US-182 RF3, US-183 RF3]$$;
COMMENT ON TABLE chore_task_recipes IS $$Recettes et dosages de chaque tâche, affichés dans « Avant de commencer » de la tâche. Premier rattachement tiré de la colonne « Pour » des recettes du guide ; modifiable en console. [US-182 RF3, US-183 RF3]$$;
COMMENT ON TABLE chore_fabric_settings IS $$Réglages par tissu du Repassage (soie, laine, coton, lin) : points sur le fer, température maximale, conseil. Contenu propre à la tâche, modifiable en console. [US-182 RF6, US-183 RF3]$$;
COMMENT ON COLUMN chore_fabric_settings.task_id IS $$Tâche du catalogue (Repassage). [US-182 RF6]$$;
COMMENT ON COLUMN chore_fabric_settings.position IS $$Ordre d'affichage, à partir de 1. [US-182 RF6]$$;
COMMENT ON COLUMN chore_fabric_settings.fabric IS $$Tissu ou famille de tissus (« Soie, synthétique, viscose »). [US-182 RF6]$$;
COMMENT ON COLUMN chore_fabric_settings.iron_points IS $$Points de réglage sur le fer, de 1 à 3. [US-182 RF6]$$;
COMMENT ON COLUMN chore_fabric_settings.max_temperature_c IS $$Température maximale du fer, en degrés Celsius. [US-182 RF6]$$;
COMMENT ON COLUMN chore_fabric_settings.advice IS $$Conseil du tissu (« Sans vapeur, à l'envers »). [US-182 RF6]$$;
COMMENT ON TABLE chore_task_notes IS $$Notes propres à une tâche : introduction, préparation (« Avant de commencer » du Repassage, 4 étapes), autres notes (ordre de la séance, consignes de tri et autres déchets des Sorties de poubelles). Contenu modifiable en console. [US-182 RF6, US-183 RF3]$$;
COMMENT ON COLUMN chore_task_notes.task_id IS $$Tâche du catalogue concernée. [US-182 RF6]$$;
COMMENT ON COLUMN chore_task_notes.kind IS $$intro : avant les gestes ; before_start : préparation de la tâche, une ligne par étape ; other : autres notes. [US-182 RF6]$$;
COMMENT ON COLUMN chore_task_notes.position IS $$Ordre dans la nature de note, à partir de 1. [US-182 RF6]$$;
COMMENT ON COLUMN chore_task_notes.title IS $$Intitulé de regroupement facultatif (« Autres déchets »). [US-182 RF6]$$;
COMMENT ON COLUMN chore_task_notes.body IS $$Texte de la note. [US-182 RF6]$$;
COMMENT ON TABLE chore_bins IS $$Bacs de la tâche Sorties de poubelles (ordures ménagères, emballages et papiers, verre, biodéchets) avec ce qu'on y met. Le foyer règle le jour de collecte de chacun (chore_household_bins), jamais d'adresse. Contenu commun, modifiable en console. [US-181 RF4, US-182 RF6, US-183 RF3]$$;
COMMENT ON COLUMN chore_bins.task_id IS $$Tâche du catalogue à collecte (schedule_mode day_before_collection). [US-181 RF4]$$;
COMMENT ON COLUMN chore_bins.position IS $$Ordre d'affichage, à partir de 1. [US-181 RF4]$$;
COMMENT ON COLUMN chore_bins.name IS $$Nom du bac (« Emballages et papiers (bac jaune) »). [US-181 RF4]$$;
COMMENT ON COLUMN chore_bins.contents IS $$« Ce qu'on y met ». [US-182 RF6]$$;
COMMENT ON COLUMN chore_bins.collection_hint IS $$Indication sur le jour de collecte (« colonne à verre ou bac »), facultative. [US-181 RF4]$$;
COMMENT ON COLUMN chore_bins.task_title IS $$Titre de la tâche du foyer pour ce bac (« Sortir le bac jaune »), lu dans le catalogue à l'affichage. [US-181 RF4]$$;
COMMENT ON TABLE chore_household_tasks IS $$Réglage d'un foyer pour une tâche ménagère du catalogue : activée ou non (toutes désactivées au départ, aucune ligne tant que le foyer n'y a pas touché), jours, personne facultative, série liée. Modifiable par les deux parents, lu par les invités secondaires (sécurité par ligne). Une tâche masquée dans le catalogue garde sa ligne et sa série ; le foyer en est informé (« Cette tâche n'est plus proposée »). [US-181 RF1 à RF7, US-183 RF4, BA-1, TM-04, TM-05]$$;
COMMENT ON COLUMN chore_household_tasks.is_enabled IS $$Tâche activée : sa série existe. Ne s'active qu'avec au moins un jour (ou un bac collecté pour Sorties de poubelles) et si la tâche est active au catalogue ; la désactiver arrête la série (les occurrences passées restent). [US-181 RF3, RF6, TM-05]$$;
COMMENT ON COLUMN chore_household_tasks.weekdays IS $$Jours du foyer pour cette tâche (1 = lundi … 7 = dimanche, rangés, sans doublon, au moins un) ; vides pour Sorties de poubelles. Un changement s'applique à la série dès le lendemain. [US-181 RF3, RF6, TM-05]$$;
COMMENT ON COLUMN chore_household_tasks.member_id IS $$Personne à qui la tâche est confiée, facultative : membre du foyer, enfants compris ; jamais la fiche « autre » masquée du profil d'un enfant. Remis à vide quand le membre est retiré ou effacé. [US-181 RF5, TM-04, TM-05]$$;
COMMENT ON COLUMN chore_household_tasks.chore_series_id IS $$Série de tâches récurrentes liée (source household_chore) ; posée par la base à la création de la série, remise à vide quand elle se termine. [US-181 RF6]$$;
COMMENT ON TABLE chore_household_bins IS $$Jour de collecte de chaque bac d'un foyer (Sorties de poubelles), ou « Pas de collecte ». La tâche « Sortir le bac… » est datée de la veille. Une série par bac collecté. Aucune adresse (D47). Modifiable par les deux parents, lu par les invités secondaires. [US-181 RF4, BA-3]$$;
COMMENT ON COLUMN chore_household_bins.bin_id IS $$Bac du catalogue. [US-181 RF4]$$;
COMMENT ON COLUMN chore_household_bins.task_id IS $$Tâche du bac (Sorties de poubelles) : la ligne dépend de la tâche activée par le foyer, supprimée avec elle. [US-181 RF4]$$;
COMMENT ON COLUMN chore_household_bins.due_time IS $$Heure de la tâche « Sortir le bac… » de la veille de la collecte, réglable par le foyer, 19 h par défaut ; la série du bac la reprend. [US-181 RF4, TM-10]$$;
COMMENT ON COLUMN chore_household_bins.collection_day IS $$Jour de collecte du bac (1 = lundi … 7 = dimanche) ; vide = « Pas de collecte ». La série tombe la veille (chore_day_before). [US-181 RF4, BA-3]$$;
COMMENT ON COLUMN chore_household_bins.chore_series_id IS $$Série de tâches récurrentes du bac (source household_chore) ; posée à sa création, vidée à sa fin. [US-181 RF6]$$;
COMMENT ON COLUMN family_task_series.chore_task_id IS $$Tâche ménagère du catalogue (source household_chore) : une série active par tâche activée du foyer. Le titre et le pas à pas se lisent dans le catalogue ; le titre de la série est vide. [US-181 RF6, US-182 RF1, D75]$$;
COMMENT ON COLUMN family_task_series.chore_bin_id IS $$Bac de la tâche Sorties de poubelles (une série active par bac collecté) ; la série tombe la veille du jour de collecte. [US-181 RF4, D75]$$;
COMMENT ON FUNCTION chore_tasks_before_write() IS $$Une tâche ménagère ne devient active qu'avec au moins un geste (une nouvelle tâche est donc masquée tant qu'elle n'a pas de geste et n'est pas rendue active). [US-183 RF2bis, TM-08]$$;
COMMENT ON FUNCTION chore_tasks_no_delete() IS $$Refuse la suppression d'une tâche ménagère du catalogue : elle se masque, pour ne pas casser les séries des foyers. [US-183 RF4]$$;
COMMENT ON FUNCTION chore_gesture_keep_one() IS $$Refuse de retirer (ou de déplacer vers une autre tâche) le dernier geste d'une tâche active. [US-183 RF2, RF2bis]$$;
COMMENT ON FUNCTION chore_bin_before_write() IS $$Un bac se rattache à une tâche dont les jours viennent de la collecte (schedule_mode day_before_collection). [US-181 RF4]$$;
COMMENT ON FUNCTION chore_troubleshooting_guard() IS $$La dernière ligne fixe du dépannage ne se modifie ni ne se supprime, et aucune autre ligne ne le devient. [US-182 RF5]$$;
COMMENT ON FUNCTION chore_troubleshooting_link_guard() IS $$Refuse de rattacher la ligne fixe du dépannage à une tâche : elle s'affiche en dernier sous le dépannage de toute tâche qui en a. [US-182 RF5]$$;
COMMENT ON FUNCTION chore_household_task_before_write() IS $$Réglage d'un foyer : au moins un jour (rangés) pour une tâche à jours, aucun pour une tâche à collecte ; on n'active pas une tâche masquée au catalogue (celles déjà activées gardent leur réglage). [US-181 RF3, TM-05, US-183 RF4]$$;
COMMENT ON FUNCTION chore_household_collection_check() IS $$Contrôle différé : une tâche à collecte activée (Sorties de poubelles) a au moins un bac avec un jour de collecte, comme une autre tâche a au moins un jour. [US-181 RF4, TM-05]$$;
COMMENT ON FUNCTION family_task_series_chore_sync() IS $$Aligne une série ménagère sur le réglage du foyer à chaque écriture : jours du foyer (ou veille du jour de collecte du bac, à l'heure réglée) et personne choisie ; refuse une série dont la tâche (ou le bac) n'est pas activée dans le foyer. Sans effet sur une série terminée. [US-181 RF3, RF4, RF5, RF6]$$;
COMMENT ON FUNCTION family_task_series_chore_link() IS $$Pose le lien « série liée » du réglage du foyer (tâche ou bac) à la création d'une série ménagère et le vide quand elle se termine. [US-181 RF6]$$;
COMMENT ON FUNCTION chore_resync_series(uuid) IS $$Remet une série ménagère en accord avec le réglage du foyer, dès le lendemain : la série prend les jours et la personne du réglage (trigger), les occurrences à venir des jours retirés sont supprimées, la personne et l'heure des occurrences à venir sont mises à jour, la date de création des occurrences est ramenée à aujourd'hui pour que le planificateur crée les jours ajoutés. Les occurrences faites ou passées restent. [US-181 RF6]$$;
COMMENT ON FUNCTION chore_end_series(uuid) IS $$Termine une série de tâche ménagère (désactivation de la tâche, « Pas de collecte » d'un bac) : les occurrences à faire à partir d'aujourd'hui sont annulées (motif « série terminée »), les passées restent. Même effet que end_family_task_series, sans profil acteur. [US-181 RF6]$$;
COMMENT ON FUNCTION chore_household_task_changed() IS $$Changement du réglage d'une tâche du foyer : désactivée = ses séries (tâche et bacs) se terminent, les occurrences à venir à faire sont annulées et les passées restent ; sinon les séries (tâche et bacs) suivent les nouveaux jours et la nouvelle personne dès le lendemain. [US-181 RF6]$$;
COMMENT ON FUNCTION chore_household_bin_changed() IS $$Changement du jour de collecte ou de l'heure d'un bac : « Pas de collecte » termine sa série ; un nouveau jour la déplace à la veille et une nouvelle heure s'applique, dès le lendemain. [US-181 RF4, RF6]$$;
COMMENT ON FUNCTION chore_member_released() IS $$Un membre retiré ou effacé n'est plus la personne d'une tâche ménagère : la tâche redevient « Personne » (les séries suivent par chore_household_task_changed). [US-181 RF5, US-93]$$;
