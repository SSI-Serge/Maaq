-- MAAQ — rattrapage de l'aide Devoirs (D71 à D73), fichier 3/4 : REPRISE UNIQUE de l'ancienne tâche du dimanche « Préparer les devoirs de la semaine » (source homework_prep) vers la tâche « Préparer les devoirs ».
-- À lancer après rattrapage_lot_10_d71_1_schema.sql et le passage à blanc (rattrapage_lot_10_d71_2_reprise_a_blanc.sql), avant rattrapage_lot_10_d71_4_contraintes.sql. Une seule transaction ; rejouable sans effet.
--  - la série devient hebdomadaire sur les jours de devoirs du foyer (family_settings.homework_days), sans personne assignée ; son HEURE EST GARDÉE ; ses occurrences sont désassignées ;
--  - les occurrences à venir (à faire ou proposées) des jours qui ne sont plus des jours de devoirs sont supprimées ; les passées, faites ou en retard restent ; le planificateur recrée les jours à partir d'aujourd'hui ;
--  - le TITRE n'est pas migré : il est affiché d'après la source ; les tâches « Devoirs — [prénom] » existantes ne sont pas supprimées.
-- Un message (NOTICE) donne le nombre de séries reprises et d'occurrences désassignées et retirées.
DO $$
DECLARE v_series integer; v_assigned integer; v_removed integer;
BEGIN
  UPDATE family_task_series s
     SET assigned_member_id = NULL, repeat_unit = 'week', repeat_interval = 1,
         month_mode = NULL, month_day = NULL, month_nth = NULL, month_weekday = NULL,
         materialized_until = LEAST(s.materialized_until, COALESCE((SELECT (now() AT TIME ZONE a.family_timezone)::date FROM accounts a WHERE a.id = s.account_id), current_date))
   WHERE s.source = 'homework_prep'
     AND (s.assigned_member_id IS NOT NULL OR s.repeat_unit IS DISTINCT FROM 'week' OR s.repeat_interval <> 1 OR s.weekdays IS DISTINCT FROM COALESCE((SELECT st.homework_days FROM family_settings st WHERE st.account_id = s.account_id), ARRAY[1, 2, 4, 5]::smallint[]));
  GET DIAGNOSTICS v_series = ROW_COUNT;
  UPDATE family_tasks SET assigned_member_id = NULL WHERE source = 'homework_prep' AND assigned_member_id IS NOT NULL;
  GET DIAGNOSTICS v_assigned = ROW_COUNT;
  DELETE FROM family_tasks t USING family_task_series s, accounts a
   WHERE t.series_id = s.id AND s.source = 'homework_prep' AND s.ended_at IS NULL AND a.id = s.account_id
     AND t.status IN ('proposed', 'todo') AND t.due_date > (now() AT TIME ZONE a.family_timezone)::date
     AND NOT (date_part('isodow', t.due_date)::smallint = ANY (COALESCE((SELECT st.homework_days FROM family_settings st WHERE st.account_id = s.account_id), ARRAY[1, 2, 4, 5]::smallint[])));
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RAISE NOTICE 'Tâche « Préparer les devoirs » : % série(s) reprise(s), % occurrence(s) désassignée(s), % occurrence(s) à venir retirée(s)', v_series, v_assigned, v_removed;
END $$;
