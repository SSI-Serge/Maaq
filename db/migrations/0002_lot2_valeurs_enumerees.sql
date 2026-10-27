-- Copié TEL QUEL de la session « base de données » : migrations/lot_2_1_valeurs_enumerees.sql (SHA-256 2eed05a29ca0133f…, le 27/10/2026).
-- Lot 2 du MVP2 (US-113). Ne jamais modifier à la main ; chaque fichier est appliqué dans sa propre transaction.
-- MAAQ — lot 2 : US-113 : notification de l'autre parent : valeurs ajoutées à des types énumérés existants.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute.
-- À appliquer AVANT lot_2_2_schema.sql.

ALTER TYPE setting_value_type ADD VALUE 'timestamp' AFTER 'email';
ALTER TYPE notification_kind ADD VALUE 'event_added' AFTER 'follow_up_48h';
ALTER TYPE notification_kind ADD VALUE 'event_to_confirm' AFTER 'event_added';
