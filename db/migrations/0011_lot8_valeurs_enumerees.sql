-- MAAQ — lot 8 : Trajets et « Sur place » : valeurs ajoutées à des types énumérés existants.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute.
-- À appliquer AVANT lot_8_2_schema.sql.

ALTER TYPE notification_kind ADD VALUE 'travel_first' AFTER 'weekly_digest';
ALTER TYPE notification_kind ADD VALUE 'travel_second' AFTER 'travel_first';
ALTER TYPE notification_kind ADD VALUE 'place_search_ready' AFTER 'auto_confirmed';
ALTER TYPE message_kind ADD VALUE 'place_suggestion' AFTER 'event_proposal';
ALTER TYPE message_kind ADD VALUE 'place_results' AFTER 'place_suggestion';
