-- =====================================================================
-- kdo_help : proches, occasions et idées de cadeaux ; canaux de conversation (WhatsApp) ;
-- rappels. Spécification « WhatsApp Channel + Shared Conversation Layer » du 07/10/2026.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Proches à gâter. Données personnelles sur des tiers : supprimées avec le profil (CASCADE), exportées
-- avec ses données, effacement doux 30 jours (« annuler » dans le tchat) puis purge.
-- ---------------------------------------------------------------------
CREATE TABLE gift_people (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name            varchar(100) NOT NULL,
  relationship    varchar(100),
  -- Anniversaire : jour et mois obligatoires ensemble, année facultative (âge inconnu)
  birth_day       smallint CHECK (birth_day BETWEEN 1 AND 31),
  birth_month     smallint CHECK (birth_month BETWEEN 1 AND 12),
  birth_year      smallint CHECK (birth_year BETWEEN 1900 AND 2100),
  budget_amount   numeric(10, 2) CHECK (budget_amount >= 0),
  -- Centres d'intérêt, moments de vie, notes, ce qu'elle n'aime pas, tailles… (texte libre structuré)
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Verrou optimiste : une modification porte le numéro de version lu, sinon elle est refusée
  version         integer NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_gift_people_birthday CHECK ((birth_day IS NULL) = (birth_month IS NULL)),
  CONSTRAINT ck_gift_people_birth_year CHECK (birth_year IS NULL OR birth_day IS NOT NULL)
);
CREATE INDEX idx_gift_people_user ON gift_people (user_id) WHERE deleted_at IS NULL;
COMMENT ON TABLE gift_people IS $$Proches à gâter de kdo_help, propres à un profil. Effacement doux 30 jours puis purge.$$;

-- ---------------------------------------------------------------------
-- Occasions autres que l'anniversaire d'un proche (Noël, fête, anniversaire de mariage…). L'anniversaire
-- d'un proche n'a pas de ligne : il se déduit de gift_people.
-- ---------------------------------------------------------------------
CREATE TABLE gift_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  person_id       uuid REFERENCES gift_people (id) ON DELETE CASCADE,
  kind            varchar(40) NOT NULL,            -- christmas | anniversary | other…
  title           varchar(150) NOT NULL,
  event_day       smallint NOT NULL CHECK (event_day BETWEEN 1 AND 31),
  event_month     smallint NOT NULL CHECK (event_month BETWEEN 1 AND 12),
  -- Année : NULL = chaque année ; renseignée = occasion unique
  event_year      smallint CHECK (event_year BETWEEN 1900 AND 2100),
  budget_amount   numeric(10, 2) CHECK (budget_amount >= 0),
  version         integer NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_gift_events_user ON gift_events (user_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- État d'une occasion précise (clé « person:<id>:<année> » ou « event:<id>:<année> ») : cadeau réglé,
-- rappels reportés. Une ligne n'existe que si l'utilisateur a agi.
-- ---------------------------------------------------------------------
CREATE TABLE gift_occasion_states (
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  occasion_key    text NOT NULL,
  sorted_at       timestamptz,                      -- « c'est réglé » / cadeau acheté
  snoozed_until   date,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, occasion_key)
);

-- ---------------------------------------------------------------------
-- Idées proposées, gardées, achetées ou écartées (mémoire de l'agent et signal d'évaluation).
-- ---------------------------------------------------------------------
CREATE TYPE gift_idea_status AS ENUM ('suggested', 'saved', 'purchased', 'dismissed');
CREATE TABLE gift_ideas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  person_id       uuid REFERENCES gift_people (id) ON DELETE CASCADE,
  occasion_key    text,
  title           varchar(200) NOT NULL,
  why             text NOT NULL DEFAULT '',
  price_min       numeric(10, 2),
  price_max       numeric(10, 2),
  status          gift_idea_status NOT NULL DEFAULT 'suggested',
  suggested_at    timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_gift_ideas_user ON gift_ideas (user_id, suggested_at DESC);

-- ---------------------------------------------------------------------
-- Canaux de conversation. Le fil lui-même reste chez Digitorn (simulé), partagé entre les canaux : ces tables
-- ne gardent ni texte ni contenu, seulement l'identité liée, le consentement et la trace des messages (doublons,
-- état de remise).
-- ---------------------------------------------------------------------
CREATE TYPE channel_kind AS ENUM ('web', 'whatsapp');
CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');

CREATE TABLE channel_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel           channel_kind NOT NULL,
  -- WhatsApp : wa_id, numéro E.164 sans « + »
  external_id       text NOT NULL,
  opt_in            boolean NOT NULL DEFAULT false,
  opt_in_at         timestamptz,
  consent_version   text,
  -- Dernier message reçu : ouvre la fenêtre de 24 h pendant laquelle WhatsApp autorise les messages libres
  last_inbound_at   timestamptz,
  linked_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id),
  UNIQUE (user_id, channel)
);

CREATE TABLE channel_link_codes (
  code          text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel       channel_kind NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES users (id) ON DELETE CASCADE,
  channel         channel_kind NOT NULL,
  external_id     text NOT NULL,                     -- wamid WhatsApp
  direction       message_direction NOT NULL,
  status          text,                              -- sent | delivered | read | failed
  request_id      text,                              -- demande du tchat correspondante
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);

-- ---------------------------------------------------------------------
-- Rappels d'occasions : un seul envoi par (profil, occasion, échéance, canal).
-- ---------------------------------------------------------------------
CREATE TABLE gift_notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  occasion_key    text NOT NULL,
  reminder_point  text NOT NULL,                     -- T-21 | T-7 | T-2
  channel         channel_kind NOT NULL,
  template_name   text,
  status          text NOT NULL,                     -- queued | sent | failed | skipped
  scheduled_for   timestamptz NOT NULL,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, occasion_key, reminder_point, channel)
);

-- ---------------------------------------------------------------------
-- Préférences de rappel du profil. Le fuseau sert aux heures calmes et aux dates relatives quand la demande
-- n'arrive pas d'un appareil connu (WhatsApp) ; il est mis à jour à chaque demande faite depuis l'application.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN timezone text NOT NULL DEFAULT 'Europe/Paris' CHECK (timezone ~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$');
ALTER TABLE users ADD COLUMN quiet_hours_start time NOT NULL DEFAULT '21:00';
ALTER TABLE users ADD COLUMN quiet_hours_end time NOT NULL DEFAULT '08:00';
ALTER TABLE users ADD COLUMN reminder_channel text NOT NULL DEFAULT 'app' CHECK (reminder_channel IN ('app', 'whatsapp', 'both'));
