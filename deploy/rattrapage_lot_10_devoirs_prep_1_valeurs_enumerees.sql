-- MAAQ — rattrapage additif du lot 10 (décision D69), fichier 1 sur 2 : nouvelle valeur « homework_prep » du type task_source.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute. À appliquer AVANT
-- rattrapage_lot_10_devoirs_prep_2_schema.sql, une seule fois, sur une base où le lot 10 est déjà appliqué. Une base construite avec le lot 10
-- régénéré (empreintes indiquées dans le message de livraison) n'en a pas besoin.

ALTER TYPE task_source ADD VALUE 'homework_prep' AFTER 'homework';
