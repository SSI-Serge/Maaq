-- MAAQ — rattrapage additif du lot 10 (décision D70), fichier 2 sur 2 : règle de répétition annuelle et contraintes associées.
-- À appliquer APRÈS rattrapage_lot_10_annuel_1_valeurs_enumerees.sql (valeur « yearly » validée), une seule fois. Une seule transaction.
-- Additif : la fonction series_rule_valid est remplacée par une version qui accepte aussi « yearly » (intervalle 1, aucun jour de la semaine, aucun mode de mois :
-- même jour et même mois, ancre = first_date) ; elle ne change rien pour les valeurs existantes, donc les séries existantes ne changent pas. Deux contraintes sont
-- ajoutées : « sauf vacances scolaires » interdit pour une série annuelle, répétition annuelle interdite pour une tâche récurrente. Les commentaires de deux fonctions
-- sont mis à jour. Aucune donnée n'est modifiée.

CREATE OR REPLACE FUNCTION series_rule_valid(
  p_unit series_repeat_unit, p_interval smallint, p_weekdays smallint[],
  p_month_mode series_month_mode, p_month_day smallint, p_month_nth smallint, p_month_weekday smallint
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(CASE p_unit
    WHEN 'day' THEN p_interval = 1 AND p_weekdays IS NULL AND p_month_mode IS NULL
                    AND p_month_day IS NULL AND p_month_nth IS NULL AND p_month_weekday IS NULL
    WHEN 'week' THEN p_interval IN (1, 2) AND p_weekdays IS NOT NULL
                    AND cardinality(p_weekdays) BETWEEN 1 AND 7
                    AND p_weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
                    AND (SELECT count(DISTINCT w) FROM unnest(p_weekdays) w) = cardinality(p_weekdays)
                    AND p_month_mode IS NULL AND p_month_day IS NULL AND p_month_nth IS NULL AND p_month_weekday IS NULL
    WHEN 'month' THEN p_interval = 1 AND p_weekdays IS NULL AND (
                      (p_month_mode = 'day_of_month' AND p_month_day BETWEEN 1 AND 31
                         AND p_month_nth IS NULL AND p_month_weekday IS NULL)
                   OR (p_month_mode = 'nth_weekday' AND p_month_nth IN (1, 2, 3, 4, -1)
                         AND p_month_weekday BETWEEN 1 AND 7 AND p_month_day IS NULL))
    WHEN 'yearly' THEN p_interval = 1 AND p_weekdays IS NULL AND p_month_mode IS NULL
                    AND p_month_day IS NULL AND p_month_nth IS NULL AND p_month_weekday IS NULL
    ELSE false END, false)
$$;

ALTER TABLE family_event_series
  ADD CONSTRAINT ck_event_series_yearly CHECK (repeat_unit <> 'yearly' OR NOT skip_school_holidays);
ALTER TABLE family_task_series
  ADD CONSTRAINT ck_task_series_unit CHECK (repeat_unit IS DISTINCT FROM 'yearly');

COMMENT ON FUNCTION series_rule_valid(series_repeat_unit, smallint, smallint[], series_month_mode, smallint, smallint, smallint) IS $$Vrai si la règle de répétition est cohérente : chaque jour, chaque semaine (un ou plusieurs jours) ou toutes les deux semaines, chaque mois (même jour du mois, ou n-ième jour de la semaine), ou chaque année (même jour et même mois, pour les RDV seulement). [US-109 RF2, US-110 RF3, D70]$$;
COMMENT ON FUNCTION series_only_d1_reminder(series_repeat_unit, smallint) IS $$Vrai pour une série hebdomadaire ou plus fréquente (rappel J-1 seul) ; faux pour une série toutes les deux semaines, mensuelle ou annuelle (délais du type de RDV). [US-109 RF9, D46, D70]$$;
