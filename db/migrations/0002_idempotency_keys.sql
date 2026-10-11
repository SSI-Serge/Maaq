-- =====================================================================
-- Clés d'idempotence (comportement commun CC-7) : une action renvoyée avec la même clé
-- (double toucher, « Réessayer » après une coupure) n'est jamais exécutée deux fois ;
-- le serveur renvoie la réponse déjà produite. Table technique, purgée après 24 h.
-- =====================================================================
CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_path     text NOT NULL,
  response_status  smallint NOT NULL,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);
CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys (created_at);
COMMENT ON TABLE idempotency_keys IS $$Réponses déjà produites pour une clé d'idempotence, conservées 24 h (CC-7).$$;
