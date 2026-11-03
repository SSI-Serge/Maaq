-- MAAQ — lot 13 : Émotions : cœurs, mots libres, bilan de la semaine, envies à deux, couple (US-141 à US-151) : valeurs ajoutées à des types énumérés existants.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute.
-- À appliquer AVANT lot_13_2_schema.sql.

ALTER TYPE notification_kind ADD VALUE 'wish_added' AFTER 'outing_proposal';
