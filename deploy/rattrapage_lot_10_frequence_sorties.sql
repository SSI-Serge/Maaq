-- MAAQ — rattrapage additif du lot 10 (décision D67) : la fréquence « une par semaine » des propositions de sorties est retirée.
-- À appliquer UNE SEULE FOIS sur une base où le lot 10 est déjà appliqué (quel que soit le rattrapage de description reçu).
-- Une base construite avec le lot 10 régénéré (empreinte indiquée dans le message de livraison) n'en a pas besoin : la contrainte y est déjà.
-- Une seule transaction. La valeur « weekly » n'est pas retirée du type énuméré : une contrainte la refuse. Toute ligne qui l'aurait est ramenée à « deux par mois ».

UPDATE outing_criteria SET frequency = 'twice_monthly' WHERE frequency = 'weekly';
-- Les contrôles différés de la table (des critères activés ont au moins un thème) se déclenchent à la mise à jour : on les exécute tout de suite,
-- sans quoi PostgreSQL refuse le ALTER TABLE qui suit dans la même transaction (« pending trigger events »).
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE outing_criteria
  ADD CONSTRAINT ck_outing_criteria_frequency CHECK (frequency <> 'weekly');

COMMENT ON COLUMN outing_criteria.frequency IS $$Fréquence des propositions : une par mois (monthly, défaut) ou deux par mois (twice_monthly). La valeur weekly (une par semaine) est retirée par la décision D67 (coût d'une proposition) : elle reste dans le type énuméré mais la contrainte ck_outing_criteria_frequency la refuse$$;
