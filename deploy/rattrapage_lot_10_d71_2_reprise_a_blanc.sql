-- MAAQ — rattrapage de l'aide Devoirs (D71 à D73), fichier 2/4 : PASSAGE À BLANC de la reprise unique de l'ancienne tâche du dimanche. LECTURE SEULE : aucune écriture, aucune suppression.
-- À lancer après rattrapage_lot_10_d71_1_schema.sql et avant rattrapage_lot_10_d71_3_reprise.sql. Il montre, par série « Préparer les devoirs » (source homework_prep), ce que la reprise ferait, puis une ligne de total.
-- Colonnes : foyer, série, heure (gardée), jours avant et après, série assignée aujourd'hui, occurrences assignées à désassigner, occurrences à venir qui seront retirées (jours qui ne sont plus des jours de devoirs),
-- occurrences passées gardées. Le titre n'est pas migré : l'application l'affiche d'après la source.
WITH base AS (
  SELECT s.id AS series_id, s.account_id, s.due_time, s.weekdays AS jours_avant, COALESCE((SELECT st.homework_days FROM family_settings st WHERE st.account_id = s.account_id), ARRAY[1, 2, 4, 5]::smallint[]) AS jours_apres, s.assigned_member_id IS NOT NULL AS assignee, s.ended_at IS NOT NULL AS terminee,
         COALESCE((SELECT (now() AT TIME ZONE a.family_timezone)::date FROM accounts a WHERE a.id = s.account_id), current_date) AS aujourdhui
    FROM family_task_series s
   WHERE s.source = 'homework_prep'
), detail AS (
  SELECT b.account_id, b.series_id, b.due_time, b.jours_avant, b.jours_apres, b.assignee, b.terminee,
         (SELECT count(*) FROM family_tasks t WHERE t.series_id = b.series_id AND t.assigned_member_id IS NOT NULL)::integer AS a_desassigner,
         CASE WHEN b.terminee THEN 0 ELSE
           (SELECT count(*) FROM family_tasks t WHERE t.series_id = b.series_id AND t.status IN ('proposed', 'todo') AND t.due_date > b.aujourdhui
               AND NOT (date_part('isodow', t.due_date)::smallint = ANY (b.jours_apres)))::integer END AS a_retirer,
         (SELECT count(*) FROM family_tasks t WHERE t.series_id = b.series_id AND t.due_date <= b.aujourdhui)::integer AS passees_gardees
    FROM base b
)
SELECT account_id::text AS foyer, series_id::text AS serie, due_time::text AS heure_gardee, jours_avant::text, jours_apres::text, assignee, terminee, a_desassigner, a_retirer, passees_gardees
  FROM detail
UNION ALL
SELECT 'TOTAL', count(*)::text, NULL, NULL, NULL, bool_or(assignee), bool_or(terminee), COALESCE(sum(a_desassigner), 0)::integer, COALESCE(sum(a_retirer), 0)::integer, COALESCE(sum(passees_gardees), 0)::integer
  FROM detail
ORDER BY 1;
