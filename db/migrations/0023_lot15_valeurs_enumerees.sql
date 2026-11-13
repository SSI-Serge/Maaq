-- MAAQ — lot 15 : Tâches ménagères guidées : catalogue commun (tâches, gestes, contenus), réglage du foyer, bacs de poubelles, séries de tâches (US-181 à US-183) : valeurs ajoutées à des types énumérés existants.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute.
-- À appliquer AVANT lot_15_2_schema.sql.

ALTER TYPE audit_action ADD VALUE 'chore_catalog_changed' AFTER 'daily_product_changed';
ALTER TYPE task_source ADD VALUE 'household_chore' AFTER 'homework_prep';
