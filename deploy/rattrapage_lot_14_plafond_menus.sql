-- MAAQ — rattrapage additif du lot 14 (plafond de menus complets par foyer et par jour, décision CR-44 / US-156 RF12ter), À APPLIQUER JUSTE APRÈS rattrapage_lot_14_menu_libre.sql
-- (b4ca9553…, qui n'est pas modifié), pour une base qui a déjà reçu lot_14_2_schema.sql (5298e454…) et les six rattrapages du lot 14 précédents, dans cet ordre. Une base neuve applique le
-- lot_14_2_schema.sql régénéré (nouvelle empreinte) et n'a pas besoin de ce fichier. Une seule transaction, idempotent. Aucune ligne existante touchée, aucune valeur d'énumération.
--  1. Table meal_menu_daily_counters (compte, jour, nombre de menus), sécurité par ligne du couple, effacée avec le compte.
--  2. Fonction register_meal_menu(compte, jour, plafond) : incrémente le compteur si le plafond n'est pas atteint (vrai), sinon ne compte rien (faux) ; atomique ; plafond vide = réglage de la console.
--  3. Réglage de la console meal_menu_daily_cap (entier de 1 à 100, 10 par défaut), ajouté s'il n'existe pas.
--  4. purge_expired_grocery_data() REMPLACÉE (même signature) : elle supprime aussi les compteurs de plus de 7 jours.

CREATE TABLE IF NOT EXISTS meal_menu_daily_counters (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  menu_date   date NOT NULL,
  menu_count  smallint NOT NULL DEFAULT 0 CHECK (menu_count >= 0),
  PRIMARY KEY (account_id, menu_date)
);
ALTER TABLE meal_menu_daily_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meal_menu_daily_counters_couple ON meal_menu_daily_counters;
CREATE POLICY meal_menu_daily_counters_couple ON meal_menu_daily_counters
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));

CREATE OR REPLACE FUNCTION register_meal_menu(p_account uuid, p_day date, p_cap integer DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql AS $$
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

INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('meal_menu_daily_cap',               'integer', '10',    1,  100,      $$Nombre maximum de menus complets composés par un foyer et par jour, corrections comprises ; au-delà, l'agent invite à reprendre le lendemain (US-156 RF12ter, CR-44)$$)
ON CONFLICT (setting_key) DO NOTHING;

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
  RETURN v_total;
END $$;

COMMENT ON TABLE meal_menu_daily_counters IS $$Nombre de menus complets composés par un foyer un jour donné, pour le plafond quotidien (réglage de la console meal_menu_daily_cap, 10 par défaut) : chaque menu proposé et chaque correction compte comme un menu. Aucune donnée personnelle hors le compte ; incrémenté seulement par register_meal_menu() ; purgé après 7 jours (purge_expired_grocery_data) ; effacé avec le compte. [US-156 RF12ter, CR-44]$$;
COMMENT ON COLUMN meal_menu_daily_counters.menu_date IS $$Jour du décompte, calculé par l'application dans le fuseau du foyer [CR-44]$$;
COMMENT ON COLUMN meal_menu_daily_counters.menu_count IS $$Menus complets déjà acceptés ce jour-là ; borné par le plafond, jamais au-dessus [CR-44]$$;
COMMENT ON FUNCTION register_meal_menu(uuid, date, integer) IS $$Compte un menu complet d'un foyer pour un jour et applique le plafond quotidien : true = accepté (le compteur est incrémenté), false = plafond atteint (rien n'est compté). Le plafond est le paramètre ou, s'il est vide, le réglage de la console meal_menu_daily_cap (10 par défaut). Atomique : deux demandes simultanées ne dépassent jamais le plafond. [US-156 RF12ter, CR-44]$$;
COMMENT ON FUNCTION purge_expired_grocery_data() IS $$Supprime les menus validés de plus de 12 mois, les tickets (avec leurs lignes) antérieurs à l'année en cours moins deux, les produits achetés de la liste de plus de 3 mois (et les listes validées devenues vides), les entrées du journal des produits à référencer de plus de 12 mois, les preuves de consentement arrivées à échéance, les lignes de la base commune des prix de plus de 12 mois (réglage de la fenêtre grocery_check_window_months ; le catalogue n'est pas concerné) et les compteurs du plafond quotidien de menus de plus de 7 jours. Les durées sont des réglages de la console (à confirmer par le DPO, CR-26). À planifier chaque jour. [CR-23, CR-35, CR-44]$$;
