-- MAAQ — rattrapage de l'aide Devoirs (D71 à D73), fichier 4/4 : CONTRAINTES de la tâche « Préparer les devoirs » (hebdomadaire, jamais assignée à quelqu'un). À lancer APRÈS la reprise
-- (rattrapage_lot_10_d71_3_reprise.sql) : sans elle, une série ou une occurrence encore assignée ferait échouer l'ajout. Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_task_series_homework_prep' AND conrelid = 'family_task_series'::regclass) THEN
    ALTER TABLE family_task_series
      ADD CONSTRAINT ck_task_series_homework_prep CHECK (source <> 'homework_prep'
        OR (assigned_member_id IS NULL AND event_series_id IS NULL AND repeat_unit = 'week' AND repeat_interval = 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_tasks_homework_prep' AND conrelid = 'family_tasks'::regclass) THEN
    ALTER TABLE family_tasks ADD CONSTRAINT ck_tasks_homework_prep CHECK (source <> 'homework_prep' OR assigned_member_id IS NULL);
  END IF;
END $$;
