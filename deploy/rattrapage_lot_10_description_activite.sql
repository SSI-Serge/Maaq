-- MAAQ — second rattrapage additif du lot 10 : description des activités du catalogue Devoirs (1 000 caractères au plus).
-- Version à 1 000 caractères. Pour une base qui a déjà reçu la version à 300 caractères de ce script, appliquer plutôt rattrapage_lot_10_description_1000.sql.
-- À appliquer UNE SEULE FOIS sur une base où lot_10_2_schema.sql (version c7a4abef…) puis rattrapage_lot_10_d66.sql ont déjà été appliqués.
-- Une base construite avec le lot 10 régénéré (empreinte indiquée dans le message de livraison) n'en a pas besoin : la colonne y est déjà.
-- Script additif : une colonne facultative, aucune donnée existante n'est modifiée ni supprimée. Une seule transaction.
-- Après application, le catalogue de la base est identique à celui de maaq_schema.sql (tests/controle_derive.mjs).

ALTER TABLE homework_activities
  ADD COLUMN description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000);

COMMENT ON COLUMN homework_activities.description IS $$Description de l'activité : paragraphe d'introduction qui dit ce que fait l'enfant, contenu de référence porté par la base : 1 000 caractères au plus, facultatif. Affichée dans les questions de l'aide et sur l'écran de la semaine. Aucune donnée personnelle$$;
