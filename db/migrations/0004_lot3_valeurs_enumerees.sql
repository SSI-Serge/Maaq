-- Copié TEL QUEL de la session « base de données » : migrations/lot_3_1_valeurs_enumerees.sql (SHA-256 053bc6805dc315d5…, le 27/10/2026).
-- Lot 3 du MVP2 (enregistrement d'office, AT-8). Ne jamais modifier à la main ; chaque fichier est appliqué dans sa propre transaction.
-- MAAQ — lot 3 : Enregistrement d'office : valeurs ajoutées à des types énumérés existants.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute.
-- À appliquer AVANT lot_3_2_schema.sql.

ALTER TYPE notification_kind ADD VALUE 'auto_confirmed' AFTER 'follow_up_48h';
