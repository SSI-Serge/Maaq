-- =====================================================================
-- Éléments propres à l'application, absents du schéma de référence de la session « base de données ».
-- (Décision du 27/10/2026 : ils vivent dans cette migration, appliquée après le socle.)
-- =====================================================================

-- Rappel « suppression dans 7 jours » : un seul rappel par délai de grâce (US-58 RF3). Remis à vide quand le compte est repris.
ALTER TABLE accounts ADD COLUMN grace_reminder_sent_at timestamptz;
COMMENT ON COLUMN accounts.grace_reminder_sent_at IS $$Date d'envoi du rappel « suppression dans 7 jours » : un seul rappel par délai de grâce (US-58 RF3). Remis à vide quand le compte est repris$$;

-- Projet Digitorn de chaque agent de plateforme « digitorn » (décision du 11/10/2026) : la clé secrète et l'adresse de
-- l'application publiée sont propres à chaque projet. Un agent sans ligne ici (démonstration, simulateur) garde le tchat de MAAQ.
CREATE TABLE agent_digitorn_projects (
  agent_id           bigint PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
  -- NULL pour un agent « visiteur » : seule l'adresse de l'application publiée est connue
  api_key_encrypted  bytea,
  app_url            text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_agent_digitorn_projects_content CHECK (api_key_encrypted IS NOT NULL OR app_url IS NOT NULL),
  CONSTRAINT ck_agent_digitorn_projects_app_url CHECK (app_url IS NULL OR app_url ~ '^https://[^\s]+$')
);
COMMENT ON TABLE agent_digitorn_projects IS $$Clé secrète (sk_…) du projet Digitorn de l'agent, chiffrée avec la clé de l'application (jamais affichée ni journalisée), et domaine personnalisé facultatif de l'application publiée.$$;

-- Texte de consentement au challenge d'un contrat (US-36 RF2, RT1). Le nom du partenaire n'est pas encore connu.
INSERT INTO legal_document_versions (document_type, version_label, content, published_at)
VALUES ('contract_challenge_consent', '1.0',
        'L''entreprise [nom du partenaire], partenaire de MAAQ, pourra utiliser les informations de votre contrat pour le challenger.', now())
ON CONFLICT (document_type, version_label) DO NOTHING;

-- ---------------------------------------------------------------------
-- Assistant Famille (agent appelé par API directe, plateforme « anthropic »)
-- ---------------------------------------------------------------------
-- Ligne de l'agent : les conversations du tchat de MAAQ (agent_conversations) et les RDV créés par l'assistant s'y rattachent.
-- Elle n'apparaît pas dans le catalogue tant que les agents d'autres plateformes n'y sont pas ouverts (US-106).
INSERT INTO agents (platform, platform_agent_ref, name, category_id, short_description, full_description, status)
SELECT 'anthropic', 'assistant-famille', 'Assistant Famille — RDV & tâches', c.id,
       'Rendez-vous et tâches de la famille, par écrit ou à la voix.',
       'Assistant du calendrier familial : crée des rendez-vous provisoires à confirmer, propose des créneaux et rappelle les échéances.',
       'available'
  FROM agent_categories c WHERE c.code = 'perso';

-- Une demande envoyée à l'assistant : relie le message du parent à la réponse, pour qu'un renvoi (« Réessayer », double toucher)
-- rende la réponse déjà donnée au lieu de refaire le travail, et retrouve les RDV créés par la demande.
-- Disparaît avec les messages (4 jours, US-44).
CREATE TABLE assistant_requests (
  conversation_id   uuid NOT NULL REFERENCES agent_conversations (id) ON DELETE CASCADE,
  request_id        uuid NOT NULL,
  user_message_id   bigint NOT NULL REFERENCES agent_conversation_messages (id) ON DELETE CASCADE,
  reply_message_id  bigint REFERENCES agent_conversation_messages (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, request_id)
);
CREATE INDEX idx_assistant_requests_user_message ON assistant_requests (user_message_id);
CREATE INDEX idx_assistant_requests_reply_message ON assistant_requests (reply_message_id);
COMMENT ON TABLE assistant_requests IS $$Demandes faites à l'Assistant Famille : message du parent, réponse de l'assistant ; sert à rendre la même réponse à un renvoi.$$;
