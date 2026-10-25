-- =====================================================================
-- Assistant Famille — rendez-vous et tâches (étape 1 du pilote) : membres du foyer, calendrier familial, propositions de
-- changement faites par l'assistant, conversations avec l'assistant.
-- Le compte MAAQ est la famille : toutes les tables portent account_id et disparaissent avec le compte (US-58 RF4).
-- Décisions du PO : D31 (minimisation), D32 (statuts), D35 (types, durées), D37 (alias).
-- =====================================================================

CREATE TYPE family_member_role   AS ENUM ('parent', 'child');
-- Six types de rendez-vous (D35)
CREATE TYPE family_event_type    AS ENUM ('school', 'medical', 'work', 'family', 'personal', 'admin');
-- D32 : provisoire, confirmé, annulé, écarté (reste visible en gris et barré jusqu'à la relance suivante), ignoré
CREATE TYPE family_event_status  AS ENUM ('provisional', 'confirmed', 'canceled', 'set_aside', 'ignored');
CREATE TYPE family_event_source  AS ENUM ('typed', 'dictation', 'capture', 'mail');
CREATE TYPE family_proposal_kind   AS ENUM ('modification', 'cancellation');
CREATE TYPE family_proposal_status AS ENUM ('pending', 'applied', 'refused');
CREATE TYPE assistant_message_role AS ENUM ('user', 'assistant');

-- Personnes du foyer : les parents (profils connectables) et les enfants (sans compte).
CREATE TABLE family_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Profil connectable correspondant, pour un parent. Un profil supprimé ne supprime pas la personne du calendrier (D34).
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  first_name   varchar(100) NOT NULL CHECK (btrim(first_name) <> ''),
  role         family_member_role NOT NULL,
  birth_date   date,
  -- Numéro de l'alias donné au modèle (« Parent 1 », « Enfant 2 »…), propre au compte et au rôle (D37)
  alias_index  integer NOT NULL CHECK (alias_index >= 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, role, alias_index)
);
CREATE UNIQUE INDEX uq_family_members_user ON family_members (account_id, user_id) WHERE user_id IS NOT NULL;
COMMENT ON TABLE family_members IS $$Personnes du foyer (parents et enfants) pour le calendrier familial et l'Assistant Famille. Les enfants n'ont pas de compte. [D31, D34, D37]$$;
COMMENT ON COLUMN family_members.alias_index IS $$Numéro de l'alias « Parent N » / « Enfant N » donné au modèle à la place du prénom ; attribué à la création du membre, propre au compte et au rôle$$;

-- Calendrier familial : la référence est dans MAAQ, l'assistant n'écrit que des rendez-vous provisoires.
CREATE TABLE family_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  title               varchar(200) NOT NULL CHECK (btrim(title) <> ''),
  event_type          family_event_type NOT NULL,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  all_day             boolean NOT NULL DEFAULT false,
  place               text,
  notes               text,
  -- Texte libre pour les répétitions (« hebdomadaire, le mercredi ») : pas de série d'événements à ce stade
  recurrence          text,
  status              family_event_status NOT NULL DEFAULT 'provisional',
  source              family_event_source NOT NULL,
  -- Identifie la demande qui a créé le rendez-vous : une même demande traitée deux fois ne crée rien de plus
  source_ref          text,
  created_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_family_events_range CHECK (ends_at >= starts_at)
);
CREATE INDEX idx_family_events_account_start ON family_events (account_id, starts_at);
CREATE UNIQUE INDEX uq_family_events_source_ref ON family_events (account_id, source_ref) WHERE source_ref IS NOT NULL;
COMMENT ON TABLE family_events IS $$Calendrier familial. Le calendrier de référence est ici ; l'assistant crée des rendez-vous provisoires, un parent les confirme. [D31, D32, D35]$$;
COMMENT ON COLUMN family_events.source_ref IS $$Identifiant de la demande (et rang dans la demande) qui a créé le rendez-vous : rend la création idempotente$$;
COMMENT ON COLUMN family_events.starts_at IS $$Début en UTC ; l'assistant raisonne en heure locale du foyer (fuseau de l'appareil de l'utilisateur principal, D35)$$;

CREATE TABLE family_event_members (
  event_id   uuid NOT NULL REFERENCES family_events (id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES family_members (id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, member_id)
);
CREATE INDEX idx_family_event_members_member ON family_event_members (member_id);
COMMENT ON TABLE family_event_members IS $$Personnes concernées par un rendez-vous. Supprimer un membre le retire de ses rendez-vous ; l'anonymisation des rendez-vous partagés (D34) est traitée à la suppression.$$;

-- Modifications et annulations proposées par l'assistant : rien n'est appliqué sans la validation d'un parent.
CREATE TABLE family_event_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_id           uuid NOT NULL REFERENCES family_events (id) ON DELETE CASCADE,
  kind               family_proposal_kind NOT NULL,
  changes            jsonb,
  reason             text,
  status             family_proposal_status NOT NULL DEFAULT 'pending',
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  decided_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX idx_family_event_proposals_event ON family_event_proposals (event_id);
CREATE INDEX idx_family_event_proposals_pending ON family_event_proposals (account_id) WHERE status = 'pending';
COMMENT ON TABLE family_event_proposals IS $$Modifications et annulations proposées par l'assistant, en attente de la validation d'un parent. Rien n'est appliqué avant.$$;

-- Conversations avec l'assistant (une par parent). Le contenu est chiffré comme les informations personnelles des agents.
CREATE TABLE assistant_conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
COMMENT ON TABLE assistant_conversations IS $$Fil de discussion d'un parent avec l'Assistant Famille.$$;

CREATE TABLE assistant_messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    uuid NOT NULL REFERENCES assistant_conversations (id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  role               assistant_message_role NOT NULL,
  source             family_event_source NOT NULL DEFAULT 'typed',
  -- Identifiant de la demande choisi par l'écran : un renvoi rend la réponse déjà donnée sans rien refaire
  request_id         uuid NOT NULL,
  content_encrypted  bytea NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, request_id, role)
);
CREATE INDEX idx_assistant_messages_conversation ON assistant_messages (conversation_id, created_at);
COMMENT ON TABLE assistant_messages IS $$Messages échangés avec l'Assistant Famille. Contenu chiffré (AES-256-GCM, clé de l'application) ; jamais journalisé en clair.$$;
