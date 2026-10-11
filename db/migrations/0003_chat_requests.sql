-- =====================================================================
-- Demandes envoyées dans le tchat (US-38, US-70). Une demande est comptée une seule fois dans le
-- plafond quotidien, même si elle est renvoyée après une erreur ou un délai sans réponse (RT2).
-- Table technique : aucune copie du texte, l'historique reste chez Digitorn. Purgée après 24 h.
-- =====================================================================
CREATE TABLE chat_requests (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  request_id    uuid NOT NULL,
  agent_id      bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- Jour (fuseau de l'appareil) sur lequel la demande a été comptée
  counted_date  date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX idx_chat_requests_agent_id ON chat_requests (agent_id);
CREATE INDEX idx_chat_requests_created_at ON chat_requests (created_at);
COMMENT ON TABLE chat_requests IS $$Demandes déjà comptées dans le plafond quotidien : un renvoi (même identifiant) n'est pas recompté. Purgée après 24 h. [US-38 RT2, US-70 RF6]$$;
