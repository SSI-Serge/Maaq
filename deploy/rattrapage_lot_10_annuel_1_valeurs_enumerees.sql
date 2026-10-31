-- MAAQ — rattrapage additif du lot 10 (décision D70), fichier 1 sur 2 : répétition « chaque année » des RDV récurrents, nouvelle valeur « yearly » du type
-- series_repeat_unit. Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute. À appliquer AVANT
-- rattrapage_lot_10_annuel_2_schema.sql, une seule fois, sur une base où le lot 10 est déjà appliqué. Une base construite avec le lot 10 régénéré
-- (empreintes indiquées dans le message de livraison) n'en a pas besoin.

ALTER TYPE series_repeat_unit ADD VALUE 'yearly' AFTER 'month';
