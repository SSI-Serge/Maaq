-- MAAQ — rattrapage additif du lot 10 (décision D69), fichier 2 sur 2 : une seule série « Préparer les devoirs de la semaine » active par foyer.
-- À appliquer APRÈS rattrapage_lot_10_devoirs_prep_1_valeurs_enumerees.sql (valeur « homework_prep » validée), une seule fois. Une seule transaction.
-- Additif : un index unique partiel ; aucune donnée n'est modifiée. ck_tasks_homework reste inchangée (« homework » exige une semaine de devoirs ;
-- « homework_prep » n'en porte pas). La série reste active quand l'aide est désactivée : le code masque le lien.

-- D69 : « Préparer les devoirs de la semaine », tâche récurrente du dimanche à 18 h créée depuis la carte « Aide Devoirs » (source « homework_prep », sans semaine
-- de devoirs : c'est une série de tâches, pas une tâche liée à une semaine). Une seule série active par foyer. La série reste active quand l'aide est désactivée :
-- le code masque le lien, la base n'a rien à faire. Ses occurrences copient la source de leur série.
CREATE UNIQUE INDEX ux_task_series_homework_prep ON family_task_series (account_id) WHERE source = 'homework_prep' AND ended_at IS NULL;
