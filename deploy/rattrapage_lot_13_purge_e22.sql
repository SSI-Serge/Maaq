-- MAAQ — rattrapage du lot 13 (décision E-22) : aucun historique des bilans et des mots.
-- À appliquer UNE SEULE FOIS sur une base où lot_13_2_schema.sql a déjà été appliqué dans sa version 6eb48d45… (avant E-22).
-- Une base construite avec le lot 13 régénéré (c254a2b2…, db/migrations/0020_lot13_schema.sql) n'en a pas besoin.
-- Remplace seulement la fonction de purge quotidienne et son commentaire, tels qu'ils figurent dans la version c254a2b2… de lot_13_2_schema.sql.
-- Aucune donnée n'est modifiée ; la prochaine purge supprime les bilans préparés il y a plus de 4 semaines, ouverts ou non. Une seule transaction.

CREATE OR REPLACE FUNCTION purge_expired_emotion_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_weeks integer; v_a bigint; v_b bigint;
BEGIN
  SELECT value_text::integer INTO v_weeks FROM platform_settings WHERE setting_key = 'weekly_digest_retention_weeks';
  v_weeks := COALESCE(v_weeks, 4);
  DELETE FROM weekly_reviews WHERE generated_at < now() - make_interval(weeks => v_weeks);
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM partner_notes WHERE weekly_review_id IS NULL AND created_at < now() - make_interval(weeks => v_weeks);
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
COMMENT ON FUNCTION purge_expired_emotion_data() IS $$Aucun historique : supprime les bilans préparés il y a plus de 4 semaines, ouverts ou non (avec les mots qui leur sont rattachés), et les mots jamais lus écrits il y a plus de 4 semaines. À planifier chaque jour. [US-143 RT1, US-144 RT1, E-22]$$;
