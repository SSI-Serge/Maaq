-- MAAQ — lot 12 : Vidéo de présentation : écran « Découvrir MAAQ » vu ou passé, remplacement de la vidéo journalisé (US-140) : valeurs ajoutées à des types énumérés existants.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute.
-- À appliquer AVANT lot_12_2_schema.sql.

ALTER TYPE audit_action ADD VALUE 'presentation_updated' AFTER 'contract_review_viewed';
