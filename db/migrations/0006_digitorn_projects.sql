-- =====================================================================
-- Projet Digitorn de chaque agent (décision du 11/10/2026) : un projet Digitorn par agent.
-- La clé secrète et l'adresse de l'application publiée sont propres à chaque projet, donc à chaque agent.
-- Un agent sans clé (démonstration, simulateur) garde le tchat construit par MAAQ.
-- =====================================================================
ALTER TABLE agents
  ADD COLUMN digitorn_api_key_encrypted bytea,
  ADD COLUMN digitorn_app_url text,
  ADD CONSTRAINT ck_agents_digitorn_app_url CHECK (digitorn_app_url IS NULL OR digitorn_app_url ~ '^https://[^\s]+$');

COMMENT ON COLUMN agents.digitorn_api_key_encrypted IS $$Clé secrète (sk_…) du projet Digitorn de cet agent, chiffrée avec la clé de l'application ; jamais affichée ni journalisée. Null = agent sans projet Digitorn réel (simulateur)$$;
COMMENT ON COLUMN agents.digitorn_app_url IS $$Domaine personnalisé de l'application Digitorn publiée, facultatif : transmis au lien de lancement du tchat embarqué. Null = adresse publiée par défaut$$;
