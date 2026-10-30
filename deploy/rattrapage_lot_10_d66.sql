-- MAAQ — rattrapage additif du lot 10 (décision D66) : contenus du catalogue Devoirs portés par la base.
-- À appliquer UNE SEULE FOIS sur une base où lot_10_2_schema.sql a déjà été appliqué dans sa version c7a4abef… (avant D66).
-- Une base construite avec le lot 10 régénéré (empreinte indiquée dans le message de livraison) n'en a pas besoin : les colonnes y sont déjà.
-- Script additif : trois colonnes facultatives, aucune donnée existante n'est modifiée ni supprimée. Une seule transaction.
-- Après application, le catalogue de la base est identique à celui de maaq_schema.sql (tests/controle_derive.mjs).

ALTER TABLE homework_exercises
  ADD COLUMN statement text CHECK (statement IS NULL OR length(btrim(statement)) BETWEEN 1 AND 2000);
ALTER TABLE homework_activities
  ADD COLUMN steps text CHECK (steps IS NULL OR length(btrim(steps)) BETWEEN 1 AND 4000);
ALTER TABLE homework_activities
  ADD COLUMN materials text CHECK (materials IS NULL OR length(btrim(materials)) BETWEEN 1 AND 1000);

COMMENT ON COLUMN homework_exercises.statement IS $$Énoncé de l'exercice, contenu de référence du manuel porté par la base (D66) : 2 000 caractères au plus, facultatif. Aucune donnée personnelle : table de référence sans lien avec un compte, un profil ou un membre$$;
COMMENT ON COLUMN homework_activities.steps IS $$Étapes de l'activité, contenu de référence porté par la base (D66) : 4 000 caractères au plus, facultatif. Aucune donnée personnelle$$;
COMMENT ON COLUMN homework_activities.materials IS $$Matériel nécessaire à l'activité, contenu de référence porté par la base (D66) : 1 000 caractères au plus, facultatif. Aucune donnée personnelle$$;
