-- MAAQ — lot 10 : Sous-agents Sorties et Devoirs (US-114 à US-121) : valeurs ajoutées à des types énumérés existants.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute.
-- À appliquer AVANT lot_10_2_schema.sql.

ALTER TYPE event_source ADD VALUE 'outing' AFTER 'calendar_sync';
ALTER TYPE notification_kind ADD VALUE 'outing_proposal' AFTER 'event_to_confirm';
ALTER TYPE task_source ADD VALUE 'homework' AFTER 'anticipation';
