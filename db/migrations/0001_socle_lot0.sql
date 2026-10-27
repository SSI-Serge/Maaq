-- =====================================================================
-- Socle de la base MAAQ (lot 0 du MVP2), copié TEL QUEL de la session « base de données » :
--   Base de données/Maaq - BD/migrations/lot_0_2_schema.sql (SHA-256 72a25bfb40c9b4877160e5915ab8ef167d3e2abe8442835fd4ffed7ed5828a7c, le 27/10/2026).
-- Le schéma de référence est maaq_schema.sql ; ce fichier n'est jamais modifié à la main.
-- Les écarts propres à l'application sont dans 0002_application.sql. Les lots suivants (2 à 8)
-- sont copiés de la même façon, dans des fichiers numérotés à la suite.
-- =====================================================================
-- MAAQ — lot 0 : Alignement et nettoyage (socle)
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_0_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Extension et domaines
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS citext;
-- ---------------------------------------------------------------------
-- DOMAINES (règles de format réutilisées)
-- ---------------------------------------------------------------------
-- Email normalisé : insensible à la casse, sans espace, forme minimale x@y.z
CREATE DOMAIN email_address AS citext
  CHECK (VALUE ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
-- Téléphone stocké au format international E.164 (+33612345678) ; la normalisation
-- (06… → +336…) est faite par l'application avant insertion.
CREATE DOMAIN phone_e164 AS text
  CHECK (VALUE ~ '^\+[1-9][0-9]{6,14}$');

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- TYPES ÉNUMÉRÉS
-- ---------------------------------------------------------------------
CREATE TYPE user_role              AS ENUM ('admin', 'primary_user', 'guest');
CREATE TYPE guest_rank             AS ENUM ('core', 'secondary');
          -- core = « invité 1 » (D1)
CREATE TYPE user_status            AS ENUM ('pending_activation', 'active', 'grace_period', 'removed');
CREATE TYPE account_status         AS ENUM ('activation_pending', 'active', 'grace_period');
CREATE TYPE grace_origin           AS ENUM ('in_app_request', 'billing_unsubscribe');
CREATE TYPE initial_setup_step     AS ENUM ('step_1_my_info', 'step_2_guest_info', 'completed');
CREATE TYPE activation_link_kind   AS ENUM ('guest_invitation', 'account_activation');
CREATE TYPE delivery_status        AS ENUM ('sending', 'sent', 'failed');
CREATE TYPE code_purpose           AS ENUM ('device_verification', 'access_recovery', 'validation_mailbox', 'password_reset', 'forwarding_sender');
CREATE TYPE code_channel           AS ENUM ('email', 'sms');
CREATE TYPE device_type            AS ENUM ('android', 'iphone', 'desktop', 'other');
CREATE TYPE session_end_reason     AS ENUM ('logout', 'device_revoked', 'guest_removed', 'account_grace_period', 'expired');
CREATE TYPE security_event_type    AS ENUM ('login_locked', 'pattern_locked', 'pattern_recovered', 'device_verified',
                                            'device_revoked', 'login_email_changed', 'password_changed');
CREATE TYPE legal_document_type    AS ENUM ('privacy_policy', 'terms_of_use', 'contract_challenge_consent', 'forwarded_mail_consent');
CREATE TYPE agent_status           AS ENUM ('available', 'blocked');
CREATE TYPE prompt_kind            AS ENUM ('example', 'first_suggestion');
CREATE TYPE requirement_owner      AS ENUM ('primary_user', 'each_profile', 'account');
CREATE TYPE connection_status      AS ENUM ('pending', 'connected', 'refused', 'partial', 'reconnect_required');
CREATE TYPE info_data_type         AS ENUM ('text', 'phone', 'postal_code', 'past_date', 'email');
CREATE TYPE contract_field_type    AS ENUM ('text', 'date', 'amount', 'choice');
CREATE TYPE scan_status            AS ENUM ('pending', 'clean', 'infected');
CREATE TYPE classification_status  AS ENUM ('pending', 'classified', 'failed');
CREATE TYPE consent_action         AS ENUM ('granted', 'withdrawn');
CREATE TYPE consent_trigger        AS ENUM ('user_action', 'contract_details_deleted');
CREATE TYPE logbook_entry_type     AS ENUM ('request', 'action_done', 'action_validated', 'action_refused');
CREATE TYPE anonymization_status   AS ENUM ('none', 'pending', 'done');
CREATE TYPE decision_kind          AS ENUM ('pending', 'validated', 'refused', 'abandoned');
CREATE TYPE execution_status       AS ENUM ('not_started', 'running', 'succeeded', 'failed');
CREATE TYPE report_category        AS ENUM ('incorrect_response', 'wrong_action', 'other');
CREATE TYPE export_status          AS ENUM ('requested', 'preparing', 'ready', 'failed', 'expired');
CREATE TYPE sync_status            AS ENUM ('running', 'succeeded', 'failed');
CREATE TYPE erasure_status         AS ENUM ('pending', 'done', 'failed');
CREATE TYPE chat_erasure_reason    AS ENUM ('logout', 'device_revoked', 'agent_removed');
CREATE TYPE setting_value_type     AS ENUM ('integer', 'email');
CREATE TYPE audit_action           AS ENUM ('account_created', 'account_updated', 'activation_link_resent', 'agent_published', 'agent_blocked', 'agent_reactivated', 'contract_created', 'contract_updated', 'contract_archived', 'contract_field_changed', 'device_revoked_by_admin');
-- Assistant Famille (RDV & tâches)
CREATE TYPE agent_platform         AS ENUM ('digitorn', 'anthropic', 'vertex');
CREATE TYPE member_role            AS ENUM ('parent', 'child', 'other');
CREATE TYPE event_status           AS ENUM ('provisional', 'set_aside', 'confirmed', 'cancelled', 'dismissed');
CREATE TYPE event_source           AS ENUM ('chat_text', 'voice', 'photo', 'android_share', 'forwarded_email', 'whatsapp', 'calendar_sync');
CREATE TYPE event_action           AS ENUM ('created', 'modified', 'confirmed', 'set_aside', 'dismissed', 'cancelled', 'completed_by_email');
CREATE TYPE event_change_reason    AS ENUM ('user_request', 'no_response', 'event_started', 'completed_by_email', 'cancellation_mail', 'report_mail');
CREATE TYPE proposal_kind          AS ENUM ('cancellation', 'reschedule', 'modification');
CREATE TYPE proposal_status        AS ENUM ('pending', 'accepted', 'declined', 'expired');
CREATE TYPE notification_kind      AS ENUM ('reminder_d7', 'reminder_d1', 'reminder_day_of', 'follow_up_24h', 'follow_up_48h');
CREATE TYPE notification_status    AS ENUM ('scheduled', 'sent', 'not_applicable', 'abandoned', 'cancelled');
CREATE TYPE inbound_status         AS ENUM ('received', 'rejected_unauthorized', 'irrelevant', 'processed', 'known_event',
                                            'no_date_found', 'no_matching_event', 'failed', 'verification_mail');
CREATE TYPE mail_classification    AS ENUM ('appointment', 'deadline', 'cancellation', 'report', 'irrelevant');
CREATE TYPE message_sender         AS ENUM ('profile', 'agent');
CREATE TYPE message_kind           AS ENUM ('text', 'voice_transcript', 'image', 'event_proposal');
CREATE TYPE message_delivery_state AS ENUM ('sending', 'sent', 'failed', 'waiting_for_connection');
CREATE TYPE erasure_subject        AS ENUM ('profile', 'family_member');

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
-- Compte MAAQ = un abonnement porté par un utilisateur principal et ses invités.
-- C'est aussi la frontière d'isolation des données (tenant). Stories : US-18, 21, 56, 58, 59, 64.
CREATE TABLE accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status              account_status NOT NULL DEFAULT 'activation_pending',
  -- Nombre d'invités autorisé par le plan ; plan géré hors application (US-21 RT1),
  -- saisi par l'administrateur à la création (US-64 RF2).
  guest_quota         integer NOT NULL CHECK (guest_quota >= 0),
  -- Plafond quotidien de demandes aux agents, par profil du compte : fixé selon le plan à la création, réglable par
  -- l'administrateur (décision du 01/10/2026, O2). Au-delà, l'application refuse la demande avec un message.
  daily_request_limit integer NOT NULL DEFAULT 50 CHECK (daily_request_limit >= 1),
  -- Fuseau de la famille : celui de l'appareil de l'utilisateur principal à sa dernière connexion (AF-2, D35). Recopié de
  -- devices.timezone à chaque connexion du principal : le planificateur des rappels n'a pas à chercher l'appareil.
  family_timezone     text NOT NULL DEFAULT 'Europe/Paris' CHECK (family_timezone ~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$'),
  -- Délai de grâce (désabonnement ou demande de suppression) : voir US-58, US-59
  grace_origin        grace_origin,
  grace_started_at    timestamptz,
  purge_scheduled_at  timestamptz,
  -- Fin d'abonnement : point de départ des 5 ans de conservation des preuves de consentement
  subscription_ended_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Les 3 colonnes de délai de grâce sont toutes renseignées ou toutes vides
  CONSTRAINT ck_accounts_grace_consistent CHECK (
    (status = 'grace_period') = (grace_origin IS NOT NULL AND grace_started_at IS NOT NULL AND purge_scheduled_at IS NOT NULL)
  )
);
-- Profil connectable : administrateur, utilisateur principal ou invité. Un seul modèle pour les
-- 3 rôles car ils partagent connexion, appareils, sessions, sécurité. Stories : US-3, 4, 10, 18-20, 64.
CREATE TABLE users (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE : supprimer le compte efface tous ses profils (US-58 RF4). NULL pour un administrateur.
  account_id              uuid REFERENCES accounts (id) ON DELETE CASCADE,
  role                    user_role NOT NULL,
  -- Rang d'un invité : « core » = invité 1 (noyau du compte avec l'utilisateur principal, D1)
  guest_rank              guest_rank,
  first_name              varchar(100) NOT NULL,
  last_name               varchar(100) NOT NULL,
  email                   email_address NOT NULL,
  phone                   phone_e164,
  -- Empreinte irréversible (argon2/bcrypt) ; NULL tant que le compte n'est pas activé (US-3 RT1)
  password_hash           text,
  status                  user_status NOT NULL DEFAULT 'pending_activation',
  -- Progression de la configuration initiale, utilisateur principal uniquement (US-10 RF1, RF7)
  initial_setup_step      initial_setup_step,
  -- Compteur d'échecs de mot de passe, côté serveur donc non contournable (US-3 RF4, RT2)
  failed_login_count      smallint NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  login_locked_until      timestamptz,
  activated_at            timestamptz,
  -- Suppression : demandée par le profil (délai de grâce) ou invité retiré par l'utilisateur principal
  deletion_requested_at   timestamptz,
  removed_at              timestamptz,
  purge_scheduled_at      timestamptz,
  -- Identifiant du profil chez Digitorn, pour transmission de contexte et suppression (US-10 RT2, US-56 RT1)
  digitorn_user_ref       text UNIQUE,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- Permet aux tables du foyer (membres, adresses autorisées) de garantir qu'un profil appartient au même compte
  UNIQUE (id, account_id),
  CONSTRAINT ck_users_admin_without_account CHECK ((role = 'admin') = (account_id IS NULL)),
  CONSTRAINT ck_users_rank_only_for_guest   CHECK ((role = 'guest') = (guest_rank IS NOT NULL)),
  CONSTRAINT ck_users_setup_only_for_primary CHECK ((role = 'primary_user') = (initial_setup_step IS NOT NULL)),
  CONSTRAINT ck_users_purge_when_leaving    CHECK ((status IN ('grace_period', 'removed')) = (purge_scheduled_at IS NOT NULL)),
  CONSTRAINT ck_users_removed_at            CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
  CONSTRAINT ck_users_email_trimmed         CHECK (email::text = btrim(email::text))
);
-- Lien d'activation à usage unique (invité ou utilisateur principal). Stories : US-4, 5, 18, 64.
CREATE TABLE activation_links (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- CASCADE : un lien n'a pas de sens sans son profil (suppression de l'invité = lien invalidé, US-20 RF7)
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind                activation_link_kind NOT NULL,
  -- Seule l'empreinte du jeton est stockée : une fuite de base ne permet pas d'activer un compte
  token_hash          bytea NOT NULL UNIQUE,
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  revoked_at          timestamptz,
  delivery_status     delivery_status NOT NULL DEFAULT 'sending',
  -- Envoi asynchrone réessayé jusqu'à 3 fois : 1 envoi + 3 reprises (US-18 RF12)
  delivery_attempts   smallint NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 4),
  sms_requested       boolean NOT NULL DEFAULT false,
  sent_at             timestamptz,
  -- SET NULL : on garde le lien même si l'expéditeur est supprimé
  created_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_activation_links_expiry CHECK (expires_at > created_at)
);
-- Appareil reconnu d'un profil + son schéma tactile. Stories : US-6, 7, 8, 51, 53.
CREATE TABLE devices (
  -- L'identifiant est celui conservé sur l'appareil (US-51 RT1) ; un téléphone partagé par 2 profils = 2 lignes
  id                    uuid PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_type           device_type NOT NULL,
  browser               varchar(100),
  first_connected_at    timestamptz NOT NULL DEFAULT now(),
  last_activity_at      timestamptz NOT NULL DEFAULT now(),
  -- Fuseau horaire de l'appareil, mis à jour à chaque connexion (décision du 01/10/2026, O3). Sert aux heures citées
  -- dans les emails du serveur et à la journée du plafond de demandes. Le nom est vérifié par l'application (liste IANA).
  timezone              text NOT NULL DEFAULT 'Europe/Paris' CHECK (timezone ~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$'),
  revoked_at            timestamptz,
  -- SET NULL : on garde la trace de la révocation même si son auteur disparaît
  revoked_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Schéma tactile : propre au profil ET à l'appareil (US-6 RF11), jamais en clair (US-6 RT1)
  pattern_hash          text,
  pattern_set_at        timestamptz,
  pattern_failed_count  smallint NOT NULL DEFAULT 0 CHECK (pattern_failed_count BETWEEN 0 AND 3),
  -- Verrouillage serveur, persistant, levé uniquement par la récupération (US-7 RF3, RT1)
  pattern_locked_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- Session mémorisée sur un appareil : 3 mois maximum (US-6 RT3). Stories : US-3, 6, 9, 20, 53.
CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- CASCADE : révoquer/supprimer l'appareil emporte ses sessions (US-53 RT1)
  device_id        uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  token_hash       bytea NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_reason   session_end_reason,
  CONSTRAINT ck_sessions_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_sessions_revoked CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
-- Codes à usage unique envoyés par email/SMS. Stories : US-8, 15, 51 (et réinitialisation de mot de passe, H5).
CREATE TABLE verification_codes (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose              code_purpose NOT NULL,
  channel              code_channel NOT NULL,
  -- Destinataire figé à l'envoi (email ou numéro) : preuve de ce qui a été utilisé
  target               text NOT NULL,
  -- Jamais en clair (US-8 RT3, US-51 RT2)
  code_hash            bytea NOT NULL,
  expires_at           timestamptz NOT NULL,
  consumed_at          timestamptz,
  -- 5 codes incorrects invalident le code (US-8 RF6, US-51 RF4)
  failed_attempts      smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  invalidated_at       timestamptz,
  -- Appareil en cours de vérification : pas de FK, la ligne devices n'existe qu'après un code correct (US-51 RF3)
  device_identifier    uuid,
  -- Connexion « boîte de validation » à vérifier (US-15 RF4) ; FK ajoutée après création d'agent_connections
  agent_connection_id  bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_verification_codes_device CHECK (purpose <> 'device_verification' OR device_identifier IS NOT NULL),
  CONSTRAINT ck_verification_codes_mailbox CHECK (purpose <> 'validation_mailbox' OR agent_connection_id IS NOT NULL)
);
-- Journal des événements de sécurité. Stories : US-7, 19, 51, 53.
CREATE TABLE security_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- SET NULL : le journal survit à la suppression du profil (pseudonymisé), conservation 3 ans par défaut, durée réglable (H12)
  user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  device_id       uuid REFERENCES devices (id) ON DELETE SET NULL,
  event_type      security_event_type NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  -- Données réellement variables selon le type d'événement (ancien/nouvel email, type d'appareil…)
  details         jsonb
);
-- Versions successives des textes (conservées, US-54 RT2). Contient aussi le texte de consentement au challenge de contrat.
CREATE TABLE legal_document_versions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_type   legal_document_type NOT NULL,
  version_label   varchar(30) NOT NULL,
  content         text NOT NULL,
  published_at    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_type, version_label)
);
CREATE TABLE legal_acceptances (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- RESTRICT : une version acceptée ne peut pas être supprimée (preuve)
  version_id   bigint NOT NULL REFERENCES legal_document_versions (id) ON DELETE RESTRICT,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, version_id)
);
-- Rubriques du catalogue : table plutôt qu'enum car les règles d'accès y sont attachées (US-23, US-30).
CREATE TABLE agent_categories (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                 text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$'),
  label                varchar(60) NOT NULL,
  sort_order            smallint NOT NULL,
  -- true = réservée au noyau (utilisateur principal + invité 1) : rubrique Contrats (D7, US-23 RF11)
  is_core_only         boolean NOT NULL DEFAULT false,
  -- false = les agents de la rubrique vont sur la page Contrats et non sur le dashboard (US-22 RF7)
  shown_on_dashboard   boolean NOT NULL DEFAULT true
);
-- Agent publié dans le catalogue. Un agent n'existe ici qu'une fois « mis à disposition » (US-45).
CREATE TABLE agents (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Plateforme où l'agent est hébergé, choisie à la publication et non modifiable ensuite (US-106 RF1, RF3)
  platform                agent_platform NOT NULL,
  -- Référence NEUTRE de l'agent chez sa plateforme ; les données propres à Digitorn ne sont plus obligatoires (US-106 RT1)
  platform_agent_ref      text NOT NULL,
  name                    varchar(100) NOT NULL,
  -- RESTRICT : une rubrique utilisée ne peut pas disparaître. Un agent n'a qu'une rubrique, non modifiable en V1 (US-45 RF3, RF5)
  category_id             integer NOT NULL REFERENCES agent_categories (id) ON DELETE RESTRICT,
  short_description       varchar(200) NOT NULL,
  full_description        text NOT NULL,
  -- Adresses en copie : l'administrateur précise à la publication si l'agent en demande (0 = non) et combien
  -- au maximum par profil (ex. 10). Décision du 01/10/2026 (point P8, hypothèse H25).
  cc_addresses_max_count  smallint NOT NULL DEFAULT 0 CHECK (cc_addresses_max_count BETWEEN 0 AND 50),
  status                  agent_status NOT NULL DEFAULT 'available',
  maintenance_message     varchar(200),
  blocked_at              timestamptz,
  blocked_by_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  published_at            timestamptz NOT NULL DEFAULT now(),
  published_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_agent_ref),
  -- Blocage : message de maintenance obligatoire (US-46 RF2) ; effacé à la réactivation (US-47 RF3)
  CONSTRAINT ck_agents_blocked_has_message CHECK (
    (status = 'blocked') = (maintenance_message IS NOT NULL AND blocked_at IS NOT NULL AND length(btrim(maintenance_message)) > 0)
  )
);
-- Exemples de demandes (fiche + recherche) et suggestions de première demande (état d'accueil du tchat).
CREATE TABLE agent_sample_prompts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id    bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  kind        prompt_kind NOT NULL,
  content     varchar(500) NOT NULL,
  sort_order smallint NOT NULL DEFAULT 1,
  UNIQUE (agent_id, kind, sort_order)
);
-- Actions de l'agent qui exigent une validation avant exécution (affichées sur la fiche).
CREATE TABLE agent_validated_actions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id    bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  label       varchar(150) NOT NULL,
  sort_order smallint NOT NULL DEFAULT 1,
  UNIQUE (agent_id, label)
);
-- Types de connecteurs : table pour pouvoir en ajouter (Outlook, etc.) sans migration de structure.
CREATE TABLE connector_types (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$'),
  label           varchar(80) NOT NULL,
  -- true = autorisation via la page de consentement Google (US-14) ; false = vérification par code (boîte de validation)
  requires_oauth  boolean NOT NULL
);
-- Connecteurs requis par un agent et responsable de leur configuration (US-29 RT1, US-45 RF10).
CREATE TABLE agent_requirements (
  agent_id           bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  connector_type_id  integer NOT NULL REFERENCES connector_types (id) ON DELETE RESTRICT,
  -- primary_user : configuré par l'utilisateur principal pour cet agent ; each_profile : chaque profil le sien ;
  -- account : connexion unique du compte, indépendante des agents (ex. Drive des contrats, décision du 01/10/2026, P3)
  owner_scope        requirement_owner NOT NULL DEFAULT 'each_profile',
  PRIMARY KEY (agent_id, connector_type_id)
);
-- Informations que l'utilisateur doit fournir pour UN agent, définies librement par l'administrateur à la
-- publication (US-10 RF2, US-45 RF10). Décision du 01/10/2026 (P5) : champs propres à chaque agent, pas de catalogue commun.
CREATE TABLE agent_info_fields (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id     bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  label        varchar(150) NOT NULL,
  -- Détermine le contrôle de format : téléphone FR/international, code postal à 5 chiffres, date de naissance passée… (US-10 RF4)
  data_type    info_data_type NOT NULL,
  is_required  boolean NOT NULL DEFAULT true,
  -- Clé commune (ex. 'telephone') : la valeur saisie pour un champ de même clé et de même type, dans un autre agent,
  -- est proposée pré-remplie (décision du 01/10/2026, N1). NULL = champ jamais partagé.
  shared_key   text CHECK (shared_key ~ '^[a-z0-9_]+$'),
  -- 1 = valeur unique ; plus de 1 = liste (ex. liste de contacts) avec ce nombre maximum d'éléments
  max_items    smallint NOT NULL DEFAULT 1 CHECK (max_items BETWEEN 1 AND 100),
  sort_order   smallint NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- Valeurs saisies par ou pour un profil pour les champs d'un agent. Chiffrées (US-10 RT1).
CREATE TABLE user_agent_info_values (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- CASCADE : un champ supprimé par l'administrateur emporte ses valeurs (elles n'ont plus de sens)
  info_field_id         bigint NOT NULL REFERENCES agent_info_fields (id) ON DELETE CASCADE,
  -- Rang de la valeur dans une liste (1 pour un champ simple), limité par agent_info_fields.max_items (trigger)
  item_position         smallint NOT NULL DEFAULT 1 CHECK (item_position >= 1),
  -- Valeur chiffrée côté application (clé hors base) : donnée personnelle de santé/identité possible
  value_encrypted       bytea NOT NULL,
  -- Auteur : l'utilisateur principal peut renseigner pour ses invités (US-11) ; dernière écriture gagnante (US-12 RF8)
  updated_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, info_field_id, item_position)
);
-- Agents choisis par un profil (son dashboard). Le retrait masque sans supprimer (US-28 RT1).
CREATE TABLE profile_agents (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- RESTRICT : un agent référencé par des dashboards ne se supprime pas (le retrait définitif n'existe pas en V1)
  agent_id              bigint NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- Date d'ajout = ordre d'affichage ; remise à now() lors d'un ré-ajout après retrait
  added_at              timestamptz NOT NULL DEFAULT now(),
  removed_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Un agent une seule fois par profil, même en cas de double envoi (US-26 RT1)
  UNIQUE (user_id, agent_id)
);
-- Connexion d'un profil à un connecteur pour un agent (compte Google, boîte de validation). Aucun mot de passe Google (US-13 RT1).
CREATE TABLE agent_connections (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id            bigint NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  connector_type_id   integer NOT NULL REFERENCES connector_types (id) ON DELETE RESTRICT,
  -- Compte Google réellement autorisé (remplace l'adresse saisie si différente, US-14 RF6) ou adresse de la boîte de validation
  connected_email       email_address NOT NULL,
  status              connection_status NOT NULL DEFAULT 'pending',
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Conservée quand l'agent est retiré du dashboard (US-13 RF10) : une ligne par profil × agent × connecteur
  UNIQUE (user_id, agent_id, connector_type_id)
);
-- Connexion unique au niveau du compte, indépendante des agents : Google Drive de l'utilisateur principal
-- pour les contrats (décision du 01/10/2026, P3). Les agents qui l'exigent (owner_scope = 'account') l'utilisent ;
-- la connexion se fait via l'agent dans MAAQ ou via un widget Digitorn (le statut remonte de Digitorn).
CREATE TABLE account_connections (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- CASCADE : la connexion disparaît avec le compte
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  connector_type_id     integer NOT NULL REFERENCES connector_types (id) ON DELETE RESTRICT,
  connected_email       email_address NOT NULL,
  status                connection_status NOT NULL DEFAULT 'pending',
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  connected_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Une seule connexion par type de connecteur et par compte
  UNIQUE (account_id, connector_type_id)
);
-- Adresses en copie systématique : propres à chaque profil et à chaque agent (D5, US-16, US-17).
CREATE TABLE cc_addresses (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- CASCADE : supprimées avec le compte du profil (US-17 RF8, US-20 RF1)
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id    bigint NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  email       email_address NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, agent_id, email)
);
-- Liste commune des contrats obligatoires, définie par l'administrateur (US-48).
CREATE TABLE contract_definitions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         varchar(120) NOT NULL,
  sort_order  integer NOT NULL,
  -- « Retirer » un contrat = l'archiver : les informations déjà saisies sont conservées (US-48 RF4, RT2)
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- Champs de détail d'un contrat, définis par l'administrateur (US-48 RF10).
CREATE TABLE contract_field_definitions (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_definition_id  bigint NOT NULL REFERENCES contract_definitions (id) ON DELETE RESTRICT,
  label                   varchar(120) NOT NULL,
  field_type              contract_field_type NOT NULL,
  is_required             boolean NOT NULL DEFAULT false,
  sort_order             integer NOT NULL DEFAULT 1,
  archived_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE contract_field_options (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  field_definition_id   bigint NOT NULL REFERENCES contract_field_definitions (id) ON DELETE CASCADE,
  label                 varchar(120) NOT NULL,
  sort_order           integer NOT NULL DEFAULT 1,
  UNIQUE (field_definition_id, label)
);
-- Contrat suivi par un compte : créé à la première saisie ou au premier consentement, sinon « Non renseigné » (US-32 RF6).
CREATE TABLE account_contracts (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- CASCADE : les contrats appartiennent au compte et disparaissent avec lui (US-58 RF4)
  account_id                  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  contract_definition_id      bigint NOT NULL REFERENCES contract_definitions (id) ON DELETE RESTRICT,
  -- Interrupteur de consentement au challenge : désactivé par défaut, partagé par le noyau (US-36 RF1, RF3)
  consent_active              boolean NOT NULL DEFAULT false,
  consent_changed_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  consent_changed_at          timestamptz,
  last_modified_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  last_modified_at            timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, contract_definition_id)
);
CREATE TABLE contract_field_values (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_contract_id    bigint NOT NULL REFERENCES account_contracts (id) ON DELETE CASCADE,
  field_definition_id    bigint NOT NULL REFERENCES contract_field_definitions (id) ON DELETE RESTRICT,
  -- Une seule colonne de valeur renseignée, selon le type du champ (colonnes typées plutôt que du texte libre : contrôles de format en base)
  value_text             varchar(500),
  value_date             date,
  value_amount           numeric(12,2) CHECK (value_amount >= 0),
  value_option_id        bigint REFERENCES contract_field_options (id) ON DELETE RESTRICT,
  updated_by_user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_contract_id, field_definition_id),
  CONSTRAINT ck_contract_field_values_one_value CHECK (num_nonnulls(value_text, value_date, value_amount, value_option_id) = 1)
);
CREATE TABLE contract_documents (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_contract_id      bigint NOT NULL REFERENCES account_contracts (id) ON DELETE CASCADE,
  file_name                varchar(255) NOT NULL,
  mime_type                text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/gif', 'application/pdf')),
  -- La taille maximale n'est plus figée : réglage platform_settings.max_document_size_mb (15 par défaut,
  -- décision du 01/10/2026, H13), contrôlé par trigger ; 1 Mo = 1 048 576 octets
  size_bytes               bigint NOT NULL CHECK (size_bytes > 0),
  added_by_user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  added_at                 timestamptz NOT NULL DEFAULT now(),
  scan_status              scan_status NOT NULL DEFAULT 'pending',
  classification_status    classification_status NOT NULL DEFAULT 'pending',
  classification_attempts  smallint NOT NULL DEFAULT 0 CHECK (classification_attempts >= 0),
  -- Référence du fichier classé dans le Google Drive de l'utilisateur principal par Admin_Classify (US-34 RT1)
  drive_file_ref           text,
  -- Stockage provisoire avant classement ; vidé une fois le fichier dans le Drive
  staging_storage_key      text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
-- Journal des consentements (preuve). Volontairement SANS clé étrangère vers accounts/users :
-- il doit survivre 5 ans à la suppression du compte (US-36 RT1) alors que le compte est effacé à J+30 (US-58).
CREATE TABLE contract_consent_events (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id              uuid NOT NULL,
  actor_user_id           uuid,
  -- Empreinte (HMAC-SHA256, clé hors base) de l'email du consentant : permet d'établir QUI a consenti après la
  -- suppression du compte, sans conserver l'email en clair (décision du 01/10/2026, P2)
  actor_email_hash        bytea NOT NULL,
  contract_definition_id  bigint NOT NULL REFERENCES contract_definitions (id) ON DELETE RESTRICT,
  action_type               consent_action NOT NULL,
  trigger_reason          consent_trigger NOT NULL DEFAULT 'user_action',
  -- Version exacte du texte accepté (nom du partenaire inclus)
  legal_version_id        bigint NOT NULL REFERENCES legal_document_versions (id) ON DELETE RESTRICT,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  -- Renseignée à la fin d'abonnement : fin d'abonnement + 5 ans ; le traitement de purge supprime au-delà
  retain_until            date
);
-- Entrées du carnet, alimentées par synchronisation avec Digitorn toutes les X heures (D4). Conservation : 14 mois glissants par défaut, durée réglable (platform_settings).
-- TABLE PARTITIONNÉE PAR MOIS (occurred_at) : à ~50 demandes par profil et par jour (décision du 01/10/2026, H2),
-- elle atteint plusieurs centaines de millions de lignes sur 14 mois. Les mois expirés sont supprimés en bloc
-- (DROP de partition) au lieu d'un DELETE massif. Contrainte de PostgreSQL : toute clé unique inclut la colonne de partition.
CREATE TABLE logbook_entries (
  id                    bigint GENERATED ALWAYS AS IDENTITY,
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  agent_id              bigint NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- Identifiant de l'entrée chez Digitorn : une demande récupérée plusieurs fois n'apparaît qu'une fois (US-40 RT3).
  -- L'idempotence suppose que occurred_at est stable d'une récupération à l'autre (voir hypothèse H29).
  external_ref          text NOT NULL,
  occurred_at           timestamptz NOT NULL,
  -- SET NULL : invité supprimé → l'entrée reste, sans nom (US-57). Le texte est anonymisé par traitement (anonymization_status)
  requester_user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  entry_type            logbook_entry_type NOT NULL,
  summary               text NOT NULL,
  result                text,
  anonymization_status  anonymization_status NOT NULL DEFAULT 'none',
  synced_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at),
  UNIQUE (account_id, agent_id, external_ref, occurred_at)
) PARTITION BY RANGE (occurred_at);
-- Partition de secours : reçoit les entrées hors des mois préparés (ex. récupération tardive)
CREATE TABLE logbook_entries_default PARTITION OF logbook_entries DEFAULT;
-- Participants d'une demande : sert uniquement à la règle de visibilité D3 pour les invités secondaires.
-- Partitionnée comme le carnet et SANS clé étrangère vers lui : PostgreSQL interdit de supprimer une partition
-- référencée par une clé étrangère. Les deux tables sont purgées ensemble par purge_expired_logbook().
CREATE TABLE logbook_entry_participants (
  entry_id           bigint NOT NULL,
  entry_occurred_at  timestamptz NOT NULL,
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, entry_occurred_at, user_id)
) PARTITION BY RANGE (entry_occurred_at);
CREATE TABLE logbook_entry_participants_default PARTITION OF logbook_entry_participants DEFAULT;
-- Historique des synchronisations : « Dernière mise à jour » du carnet, alertes d'échec.
CREATE TABLE logbook_sync_runs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  status            sync_status NOT NULL DEFAULT 'running',
  entries_imported  integer NOT NULL DEFAULT 0 CHECK (entries_imported >= 0),
  error_message     text
);
-- Décision sur une action proposée par l'agent : garantit « exécutée une seule fois » et « seul le demandeur décide » (US-39).
-- Le contenu des messages/cartes reste chez Digitorn.
CREATE TABLE action_decisions (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id             bigint NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  -- Identifiant de la carte d'action chez Digitorn : clé d'idempotence (US-39 RT1)
  external_action_ref  text NOT NULL,
  -- CASCADE : décision éphémère, la trace durable est dans le carnet
  requester_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  decision             decision_kind NOT NULL DEFAULT 'pending',
  decided_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at           timestamptz,
  execution_status     execution_status NOT NULL DEFAULT 'not_started',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, external_action_ref),
  CONSTRAINT ck_action_decisions_decided_at CHECK ((decision IN ('validated', 'refused')) = (decided_at IS NOT NULL))
);
-- Signalements d'erreurs d'un agent : conservés 14 mois, même après effacement du tchat (US-61).
CREATE TABLE error_reports (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- SET NULL : le signalement survit à la suppression du profil (conservation 14 mois, hypothèse H15)
  reporter_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  reporter_role     user_role NOT NULL,
  agent_id          bigint NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  category          report_category NOT NULL,
  user_comment         varchar(1000),
  -- Référence du message/de la carte signalé chez Digitorn : empêche un second signalement (US-61 RF4)
  message_ref       text NOT NULL,
  -- Copies conservées car l'historique du tchat est effacé (US-61 RF5)
  request_text      text,
  response_text     text NOT NULL,
  reported_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_user_id, agent_id, message_ref)
);
CREATE TABLE data_exports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status               export_status NOT NULL DEFAULT 'requested',
  requested_at         timestamptz NOT NULL DEFAULT now(),
  ready_at             timestamptz,
  -- Lien de téléchargement valable 7 jours (US-55 RF3) ; fichier supprimé à l'expiration (RT2)
  download_expires_at  timestamptz,
  storage_key          text,
  failure_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- Trace non nominative d'une suppression définitive + suivi de la suppression chez Digitorn.
-- SANS FK : le profil n'existe plus ; seul l'identifiant technique reste (US-58 RF7).
CREATE TABLE erasure_traces (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Identifiant technique (non nominatif) du profil ou du membre supprimé
  former_subject_id   uuid NOT NULL,
  subject_kind        erasure_subject NOT NULL DEFAULT 'profile',
  former_account_id   uuid,
  former_role         user_role,
  deleted_at          timestamptz NOT NULL DEFAULT now(),
  -- Conservé le temps que Digitorn confirme la suppression (réessais quotidiens, US-58 RF5), puis vidé
  digitorn_user_ref   text,
  digitorn_status     erasure_status NOT NULL DEFAULT 'pending',
  digitorn_attempts   smallint NOT NULL DEFAULT 0 CHECK (digitorn_attempts >= 0),
  last_attempt_at     timestamptz,
  last_error          text,
  completed_at        timestamptz,
  CONSTRAINT ck_erasure_traces_done CHECK ((digitorn_status = 'done') = (completed_at IS NOT NULL)),
  -- Le rôle n'est renseigné que pour un profil
  CONSTRAINT ck_erasure_traces_role CHECK ((subject_kind = 'profile') = (former_role IS NOT NULL))
);
-- Effacement de l'historique de tchat chez Digitorn, à réessayer jusqu'au succès (US-43 RF8, RT2).
CREATE TABLE chat_erasure_requests (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- NULL = tous les tchats du profil (déconnexion) ; renseigné = un seul agent (retrait du dashboard, US-28 RF6)
  agent_id         bigint REFERENCES agents (id) ON DELETE RESTRICT,
  reason           chat_erasure_reason NOT NULL,
  status           erasure_status NOT NULL DEFAULT 'pending',
  attempts         smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at  timestamptz,
  last_error       text,
  -- Alerte email admin envoyée si l'échec dure plus de 24 h (US-43 RT2)
  alerted_at       timestamptz,
  completed_at     timestamptz,
  requested_at     timestamptz NOT NULL DEFAULT now()
);
-- Compteur de demandes aux agents par profil et par jour : applique le plafond quotidien (décision du 01/10/2026, O2).
-- Une ligne par profil et par jour ; la journée est celle du fuseau de l'appareil au moment de la demande.
CREATE TABLE daily_request_counters (
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  request_date   date NOT NULL,
  request_count  integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, request_date)
);
-- Tables techniques de l'application (reprises des migrations 0002 et 0003, décision du PO du 27/10/2026) : aucune donnée métier durable,
-- rattachées au profil (suppression en cascade avec lui, donc avec son foyer), purgées après 24 h par purge_expired_request_records().
-- Pas de clé composite avec le compte : la clé est propre au profil et l'application n'écrit pas account_id.
-- Clés d'idempotence (comportement commun CC-7) : une action renvoyée avec la même clé (double toucher, « Réessayer » après une coupure)
-- n'est jamais exécutée deux fois ; le serveur renvoie la réponse déjà produite. Seules les réponses réussies sont mémorisées.
CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_path     text NOT NULL,
  response_status  smallint NOT NULL,
  -- Réponse renvoyée au client, chiffrée par l'application (elle peut contenir des données personnelles ; voir le commentaire)
  response_body    bytea,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);
-- Demandes envoyées dans le tchat des agents (US-38, US-70) : une demande n'est comptée qu'une seule fois dans le plafond quotidien, même
-- renvoyée après une erreur ou un délai sans réponse (RT2). Aucune copie du texte : l'historique reste chez la plateforme d'agents.
CREATE TABLE chat_requests (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  request_id    uuid NOT NULL,
  agent_id      bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- Jour (fuseau de l'appareil) sur lequel la demande a été comptée
  counted_date  date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
-- Paramètres modifiables sans nouvelle version (US-65, US-27 RT1, US-62 RT1). Clé/valeur car ce sont des
-- réglages de plateforme peu nombreux, pas des données métier : une colonne par réglage imposerait une migration à chaque ajout.
CREATE TABLE platform_settings (
  setting_key         text PRIMARY KEY CHECK (setting_key ~ '^[a-z_]+$'),
  value_type          setting_value_type NOT NULL,
  value_text          text,
  min_value           integer,
  max_value           integer,
  description         text NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Entier : borné par min/max ; l'évaluation est protégée par CASE (jamais de cast d'un texte non numérique)
  CONSTRAINT ck_platform_settings_integer CHECK (
    value_type <> 'integer' OR value_text IS NULL OR
    CASE WHEN value_text ~ '^[0-9]{1,9}$'
         THEN value_text::integer BETWEEN COALESCE(min_value, 0) AND COALESCE(max_value, 2147483647)
         ELSE false END
  ),
  CONSTRAINT ck_platform_settings_email CHECK (
    value_type <> 'email' OR value_text IS NULL OR value_text ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  )
);
CREATE TABLE platform_setting_changes (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  setting_key          text NOT NULL REFERENCES platform_settings (setting_key) ON DELETE RESTRICT,
  old_value            text,
  new_value            text,
  changed_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  changed_at           timestamptz NOT NULL DEFAULT now()
);
-- Journal d'administration : qui a publié, bloqué, réactivé, modifié quoi (US-45 RT1, 46 RT2, 47 RT1, 48 RT1, 64 RT1).
CREATE TABLE admin_audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  action_type        audit_action NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  -- Détails variables selon l'action (ancien nom d'un contrat, message de blocage…)
  details         jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
-- ---------------------------------------------------------------------
-- Types de RDV : liste de référence, extensible sans code (US-82 RT2, AF-6)
-- ---------------------------------------------------------------------
CREATE TABLE event_types (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$'),
  label       varchar(60) NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 1
);
-- ---------------------------------------------------------------------
-- Conversations de l'agent, conservées par MAAQ pour les agents appelés par API directe (Anthropic, Vertex AI) (D29, D54).
-- Mêmes règles d'effacement que les autres agents : à la déconnexion (US-43) et au bout de 4 jours (US-44).
-- ---------------------------------------------------------------------
CREATE TABLE agent_conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  agent_id              bigint NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  last_message_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, agent_id)
);
CREATE TABLE agent_conversation_messages (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id       uuid NOT NULL REFERENCES agent_conversations (id) ON DELETE CASCADE,
  sender                message_sender NOT NULL,
  kind                  message_kind NOT NULL DEFAULT 'text',
  -- Texte avec les VRAIS prénoms, chiffré. Les alias sont appliqués à l'envoi au modèle et retraduits à la réception (AF-8)
  content               bytea,
  -- Lien « Voir la proposition de RDV » ; clé étrangère ajoutée après la création de family_events
  family_event_id       uuid,
  delivery_state        message_delivery_state NOT NULL DEFAULT 'sent',
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- 4 jours au plus (US-44), sans nouveau réglage (décision du PO)
  expires_at            timestamptz NOT NULL DEFAULT (now() + interval '4 days'),
  CONSTRAINT ck_conversation_messages_content CHECK (kind = 'image' OR content IS NOT NULL)
);
-- Image jointe à un message (photo, capture, partage) : une par message (US-72 RF2).
CREATE TABLE conversation_attachments (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id    bigint NOT NULL UNIQUE REFERENCES agent_conversation_messages (id) ON DELETE CASCADE,
  -- NULL une fois le fichier supprimé du stockage (le fil affiche « Image supprimée »)
  storage_key   text,
  -- HEIC absent : le téléphone convertit la photo en JPEG (décision D37)
  mime_type     text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')),
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  scan_status   scan_status NOT NULL DEFAULT 'pending',
  -- Au plus 30 jours (réglage image_retention_days) ; supprimée plus tôt quand tous les RDV issus sont traités
  expires_at    timestamptz NOT NULL,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_conversation_attachments_deleted CHECK ((deleted_at IS NULL) = (storage_key IS NOT NULL))
);
-- ---------------------------------------------------------------------
-- File de suppression des fichiers du stockage. Sans clé étrangère : alimentée par trigger AVANT toute
-- suppression de ligne, pour qu'une suppression en cascade (compte) ne laisse aucun fichier orphelin.
-- ---------------------------------------------------------------------
CREATE TABLE storage_deletion_queue (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  storage_key   text NOT NULL,
  queued_at     timestamptz NOT NULL DEFAULT now(),
  status        erasure_status NOT NULL DEFAULT 'pending',
  attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    text,
  completed_at  timestamptz,
  CONSTRAINT ck_storage_deletion_queue_done CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
-- ---------------------------------------------------------------------
-- Membres de la famille (US-92, US-93) : donnée du foyer, distincte des profils.
-- ---------------------------------------------------------------------
CREATE TABLE family_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Profil correspondant (NULL pour un membre sans compte). Tout profil de compte a son membre, créé avec lui (US-92 RF1)
  user_id             uuid,
  -- Prénom du membre ; NULL après anonymisation. Pour un membre lié, copie tenue à jour depuis le profil (US-93 RF3)
  first_name          varchar(100),
  -- Mois et année de naissance, facultatifs ; le jour n'est jamais demandé (D54, décision du DPO)
  birth_year          smallint,
  birth_month         smallint,
  -- Rôle servant à nommer l'alias donné au modèle : « Parent 1 », « Enfant 2 »… (D37). Défaut « enfant » à la création
  role                member_role NOT NULL DEFAULT 'child',
  -- Numéro de l'alias PAR RÔLE : attribué une fois, jamais réutilisé (l'historique rejoué au modèle reste cohérent)
  alias_number        smallint NOT NULL,
  color_index         smallint NOT NULL CHECK (color_index >= 0),
  archived_at         timestamptz,
  anonymized_at       timestamptz,
  created_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  -- Le profil lié appartient au même foyer ; si le profil est supprimé, le lien est coupé (et le membre anonymisé)
  CONSTRAINT fk_family_members_user FOREIGN KEY (user_id, account_id)
    REFERENCES users (id, account_id) ON DELETE SET NULL (user_id),
  UNIQUE (account_id, role, alias_number),
  CONSTRAINT ck_family_members_anonymized CHECK ((anonymized_at IS NOT NULL) = (first_name IS NULL)),
  CONSTRAINT ck_family_members_anonymized_archived CHECK (anonymized_at IS NULL OR archived_at IS NOT NULL),
  CONSTRAINT ck_family_members_anonymized_birth CHECK (anonymized_at IS NULL OR (birth_year IS NULL AND birth_month IS NULL)),
  CONSTRAINT ck_family_members_birth CHECK ((birth_year IS NULL) = (birth_month IS NULL)
                                          AND (birth_month IS NULL OR birth_month BETWEEN 1 AND 12)
                                          AND (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100)),
  -- 30 caractères au plus pour un membre déclaré à la main (US-92 RF4) ; un membre lié suit son profil
  CONSTRAINT ck_family_members_name_length CHECK (user_id IS NOT NULL OR first_name IS NULL OR length(first_name) <= 30)
);
-- ---------------------------------------------------------------------
-- Mail de transfert (US-85 à US-91)
-- ---------------------------------------------------------------------
CREATE TABLE forwarding_mailboxes (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Alias aléatoire non devinable : « famille-[code]@[domaine] » (US-85 RF1). Les adresses révoquées restent (historique)
  address               email_address NOT NULL UNIQUE,
  -- NULL tant qu'aucun parent n'a donné son consentement (US-85 RF2)
  activated_at          timestamptz,
  activated_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  revoked_at            timestamptz,
  revoked_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Alimente « Dernier mail reçu » même après la purge des informations de suivi (US-85 RF7)
  last_mail_received_at timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- Preuve du consentement au traitement des mails transférés. Comme contract_consent_events : sans clé étrangère,
-- elle survit à la suppression du compte (conservation à valider par le DPO, H14).
CREATE TABLE forwarding_consent_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        uuid NOT NULL,
  actor_user_id     uuid,
  actor_email_hash  bytea NOT NULL,
  action_type       consent_action NOT NULL,
  legal_version_id  bigint NOT NULL REFERENCES legal_document_versions (id) ON DELETE RESTRICT,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  retain_until      date
);
-- Adresses autorisées à transférer : celles des deux parents au MVP (D33, US-88).
CREATE TABLE forwarding_authorized_senders (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id             uuid NOT NULL,
  email               email_address NOT NULL,
  -- NULL tant que le code à 6 chiffres n'est pas saisi ; les emails de connexion sont créés déjà vérifiés (US-88 RF2, RF4)
  verified_at         timestamptz,
  added_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Une même adresse n'est autorisée qu'une fois par famille (US-88 RT3)
  UNIQUE (account_id, email),
  -- La suppression du profil (invité 1) supprime ses adresses : l'adresse est une donnée personnelle du profil
  CONSTRAINT fk_forwarding_senders_user FOREIGN KEY (user_id, account_id)
    REFERENCES users (id, account_id) ON DELETE CASCADE
);
-- Suivi de chaque mail reçu. Le contenu (corps, pièces jointes) n'est JAMAIS en base : objet chiffré dans le stockage de l'UE.
CREATE TABLE inbound_emails (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  mailbox_id            bigint NOT NULL REFERENCES forwarding_mailboxes (id) ON DELETE CASCADE,
  received_at           timestamptz NOT NULL DEFAULT now(),
  envelope_sender       text,
  -- Parent dont l'adresse autorisée a transféré le mail ; NULL si non autorisé ou si le profil est supprimé
  forwarded_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Empreinte de l'identifiant unique du message : un même mail n'est traité qu'une fois par famille (US-89 RF1, RT1)
  message_id_hash       bytea NOT NULL,
  status                inbound_status NOT NULL DEFAULT 'received',
  classification        mail_classification,
  events_created        smallint NOT NULL DEFAULT 0 CHECK (events_created >= 0),
  -- Traitement retenté 3 fois après un échec (US-87 RF15)
  attempts              smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 4),
  last_error            text,
  scan_status           scan_status NOT NULL DEFAULT 'pending',
  raw_storage_key       text,
  raw_expires_at        timestamptz,
  raw_deleted_at        timestamptz,
  -- Dernière alerte « adresse non autorisée » envoyée aux parents : au plus une par jour et par adresse (US-88 RF12)
  parents_alerted_at    timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, message_id_hash)
);
-- Plafond de mails traités par jour et par famille (50, US-87 RF12) : compteur atomique comme celui des demandes
CREATE TABLE inbound_email_daily_counters (
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  email_date          date NOT NULL,
  mail_count          integer NOT NULL DEFAULT 0 CHECK (mail_count >= 0),
  -- Alerte « plafond atteint » envoyée à l'utilisateur principal, une fois par jour
  over_limit_alerted_at timestamptz,
  PRIMARY KEY (account_id, email_date)
);
-- ---------------------------------------------------------------------
-- Calendrier familial : RDV du FOYER, pas de l'agent (D25, US-78 RT2)
-- ---------------------------------------------------------------------
CREATE TABLE family_events (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_type_id           integer NOT NULL REFERENCES event_types (id) ON DELETE RESTRICT,
  -- Chiffrés. Pour un RDV médical, title est NULL : « RDV médical — [prénom] » est calculé à l'affichage (AF-8, US-93 RF4)
  title                   bytea,
  location                bytea,
  note                    bytea,
  -- UTC ; ends_at toujours renseignée (1 h par défaut, fin de journée pour « toute la journée ») pour détecter les conflits
  starts_at               timestamptz NOT NULL,
  ends_at                 timestamptz NOT NULL,
  end_is_default          boolean NOT NULL DEFAULT false,
  all_day                 boolean NOT NULL DEFAULT false,
  -- « Toute la famille » : aucune ligne dans family_event_members (D27)
  whole_family            boolean NOT NULL DEFAULT false,
  status                  event_status NOT NULL DEFAULT 'provisional',
  status_changed_at       timestamptz NOT NULL DEFAULT now(),
  -- Contrôle de version : une modification fondée sur une version dépassée est refusée (US-76 RT1)
  version                 integer NOT NULL DEFAULT 1,
  source                  event_source NOT NULL,
  -- Demandeur, ou parent qui a transféré le mail (SET NULL à la suppression du profil)
  requested_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  source_at               timestamptz,
  source_message_id       bigint REFERENCES agent_conversation_messages (id) ON DELETE SET NULL,
  source_inbound_email_id uuid REFERENCES inbound_emails (id) ON DELETE SET NULL,
  -- Regroupe les RDV issus d'un même mail pour la confirmation groupée, même après la purge du suivi du mail (US-91 RT2)
  source_group_id         uuid,
  created_via_agent_id    bigint REFERENCES agents (id) ON DELETE RESTRICT,
  confirmed_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  confirmed_at            timestamptz,
  -- Empreinte calculée par l'application (créneau, type, membres) : pas deux RDV actifs identiques (US-89 RT3)
  fingerprint             bytea NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT ck_family_events_period CHECK (ends_at > starts_at),
  -- Un RDV confirmé ou annulé a forcément été confirmé (confirmé → annulé est la seule sortie de « confirmé »)
  CONSTRAINT ck_family_events_confirmed CHECK ((status IN ('confirmed', 'cancelled')) = (confirmed_at IS NOT NULL))
);
-- Les membres concernés par un RDV : un ou plusieurs (D27), toujours des membres, y compris les parents (US-92 RT2).
CREATE TABLE family_event_members (
  event_id    uuid NOT NULL,
  member_id   uuid NOT NULL,
  account_id  uuid NOT NULL,
  PRIMARY KEY (event_id, member_id),
  -- Le RDV et le membre appartiennent au même foyer
  CONSTRAINT fk_family_event_members_event FOREIGN KEY (event_id, account_id)
    REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  -- Sans suppression automatique : un membre n'est jamais supprimé seul (archivé ou anonymisé). Contrôle différé à la fin de
  -- la transaction, pour que la suppression d'un foyer (qui supprime membres et RDV en cascade) puisse aboutir
  CONSTRAINT fk_family_event_members_member FOREIGN KEY (member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED
);
-- Historique des changements de statut et des modifications : qui, quand, pourquoi (US-75 RT4, US-83 RT2).
CREATE TABLE family_event_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     uuid NOT NULL REFERENCES family_events (id) ON DELETE CASCADE,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  -- NULL = changement fait par le système (ex. passage automatique à « ignoré »)
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  action       event_action NOT NULL,
  from_status  event_status,
  to_status    event_status,
  reason       event_change_reason
);
-- Propositions d'annulation, de report ou de modification faites par l'agent : jamais appliquées sans accord (US-90, AF-4).
CREATE TABLE family_event_change_proposals (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_id                uuid NOT NULL REFERENCES family_events (id) ON DELETE CASCADE,
  kind                    proposal_kind NOT NULL,
  new_starts_at           timestamptz,
  new_ends_at             timestamptz,
  -- Autres champs modifiés (JSON chiffré), pour une proposition de modification
  proposed_changes        bytea,
  source_inbound_email_id uuid REFERENCES inbound_emails (id) ON DELETE SET NULL,
  requested_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  status                  proposal_status NOT NULL DEFAULT 'pending',
  decided_by_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_change_proposals_reschedule CHECK (kind <> 'reschedule' OR (new_starts_at IS NOT NULL AND new_ends_at IS NOT NULL)),
  CONSTRAINT ck_change_proposals_decided CHECK ((status IN ('accepted', 'declined')) = (decided_at IS NOT NULL))
);
-- ---------------------------------------------------------------------
-- Rappels, relances, notifications (US-81 à US-84, US-94)
-- ---------------------------------------------------------------------
CREATE TABLE family_reminder_settings (
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_type_id       integer NOT NULL REFERENCES event_types (id) ON DELETE RESTRICT,
  remind_d7           boolean NOT NULL DEFAULT true,
  remind_d1           boolean NOT NULL DEFAULT true,
  remind_day_of       boolean NOT NULL DEFAULT true,
  updated_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, event_type_id)
);
CREATE TABLE scheduled_notifications (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL pour les notifications sans RDV (tâches, point de la semaine) : voir task_id et subject_date (MVP2)
  event_id            uuid NOT NULL REFERENCES family_events (id) ON DELETE CASCADE,
  recipient_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind                notification_kind NOT NULL,
  due_at              timestamptz NOT NULL,
  status              notification_status NOT NULL DEFAULT 'scheduled',
  push_sent_at        timestamptz,
  email_sent_at       timestamptz,
  attempts            smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Abonnement aux notifications d'un appareil (US-94) : lié à l'appareil existant (US-53).
CREATE TABLE push_subscriptions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id           uuid NOT NULL UNIQUE REFERENCES devices (id) ON DELETE CASCADE,
  -- Adresse du service de notification et clés : secrets, chiffrés par l'application
  endpoint_encrypted  bytea NOT NULL,
  endpoint_hash       bytea NOT NULL UNIQUE,
  p256dh_encrypted    bytea NOT NULL,
  auth_encrypted      bytea NOT NULL,
  last_success_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- Trace non nominative de la suppression d'un MEMBRE et suivi de la suppression chez une plateforme d'agents.
-- Facultatif tant que l'engagement écrit d'Anthropic sur la conservation des données n'est pas obtenu (P-37, D54).
CREATE TABLE erasure_trace_targets (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  erasure_trace_id  bigint NOT NULL REFERENCES erasure_traces (id) ON DELETE CASCADE,
  platform          agent_platform NOT NULL,
  external_ref      text,
  status            erasure_status NOT NULL DEFAULT 'pending',
  attempts          smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at   timestamptz,
  last_error        text,
  completed_at      timestamptz,
  CONSTRAINT ck_erasure_trace_targets_done CHECK ((status = 'done') = (completed_at IS NOT NULL))
);

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- On peut maintenant relier les codes de vérification à la connexion concernée
ALTER TABLE verification_codes
  ADD CONSTRAINT fk_verification_codes_agent_connection
  FOREIGN KEY (agent_connection_id) REFERENCES agent_connections (id) ON DELETE CASCADE;
-- Les codes de vérification servent aussi à vérifier une adresse autorisée (US-88 RF4)
ALTER TABLE verification_codes
  ADD COLUMN authorized_sender_id bigint REFERENCES forwarding_authorized_senders (id) ON DELETE CASCADE;
ALTER TABLE verification_codes
  ADD CONSTRAINT ck_verification_codes_forwarding CHECK (purpose <> 'forwarding_sender' OR authorized_sender_id IS NOT NULL);
-- Le lien « Voir la proposition de RDV » d'un message du tchat (clé étrangère ajoutée maintenant que family_events existe)
ALTER TABLE agent_conversation_messages
  ADD CONSTRAINT fk_conversation_messages_event FOREIGN KEY (family_event_id) REFERENCES family_events (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
-- Valeurs automatiques d'un membre : alias par rôle (jamais réutilisé), couleur libre, prénom du profil lié,
-- limite de membres déclarés (US-92 RF6, RF7, D37).
CREATE FUNCTION family_member_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('family_members:' || NEW.account_id::text, 0));
  IF NEW.first_name IS NULL AND NEW.user_id IS NOT NULL THEN
    SELECT first_name INTO NEW.first_name FROM users WHERE id = NEW.user_id;
  END IF;
  IF NEW.alias_number IS NULL THEN
    SELECT COALESCE(max(alias_number), 0) + 1 INTO NEW.alias_number
      FROM family_members WHERE account_id = NEW.account_id AND role = NEW.role;
  END IF;
  IF NEW.color_index IS NULL THEN
    SELECT min(c) INTO NEW.color_index FROM generate_series(0, 99) c
     WHERE NOT EXISTS (SELECT 1 FROM family_members m
                        WHERE m.account_id = NEW.account_id AND m.archived_at IS NULL AND m.color_index = c);
  END IF;
  -- La limite ne vise que les membres déclarés à la main : les profils ont automatiquement leur membre
  IF NEW.user_id IS NULL AND NEW.archived_at IS NULL THEN
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_family_members';
    SELECT count(*) INTO v_count FROM family_members
     WHERE account_id = NEW.account_id AND user_id IS NULL AND archived_at IS NULL;
    IF v_count >= COALESCE(v_max, 12) THEN
      RAISE EXCEPTION 'Nombre maximal de membres atteint (%)', COALESCE(v_max, 12) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Changement de rôle = nouvel alias (l'ancien n'est pas réutilisé) ; lien avec le profil coupé = anonymisation du membre
CREATE FUNCTION family_member_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family_members:' || NEW.account_id::text, 0));
    SELECT COALESCE(max(alias_number), 0) + 1 INTO NEW.alias_number
      FROM family_members WHERE account_id = NEW.account_id AND role = NEW.role;
  END IF;
  -- Profil supprimé (le lien passe à NULL par la clé étrangère) : le membre est anonymisé, quoi qu'il arrive
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL AND NEW.anonymized_at IS NULL THEN
    NEW.first_name := NULL;
    NEW.birth_year := NULL;
    NEW.birth_month := NULL;
    NEW.anonymized_at := now();
    NEW.archived_at := COALESCE(NEW.archived_at, now());
  END IF;
  RETURN NEW;
END $$;
-- Chaque profil du compte (utilisateur principal, invités) devient membre dès sa création (US-92 RF1).
-- Rôle : parent pour l'utilisateur principal et l'invité 1 ; autre pour un invité secondaire (D37).
CREATE FUNCTION create_member_for_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO family_members (account_id, user_id, first_name, role, created_by_user_id)
  VALUES (NEW.account_id, NEW.id, NEW.first_name,
          CASE WHEN NEW.role = 'primary_user' OR NEW.guest_rank = 'core' THEN 'parent'::member_role ELSE 'other'::member_role END,
          NEW.id);
  RETURN NEW;
END $$;
-- Le membre suit son profil : prénom, rang (parent / autre) et retrait de l'invité (US-93 RF3, RF7).
CREATE FUNCTION sync_member_from_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE family_members SET
         first_name = NEW.first_name,
         role = CASE WHEN NEW.role = 'primary_user' OR NEW.guest_rank = 'core' THEN 'parent'::member_role ELSE 'other'::member_role END,
         archived_at = CASE WHEN NEW.status = 'removed' THEN COALESCE(archived_at, now()) ELSE archived_at END
   WHERE user_id = NEW.id AND anonymized_at IS NULL;
  RETURN NEW;
END $$;
-- Transitions de statut d'un RDV (AF-1). Faux si la transition n'est pas permise.
CREATE FUNCTION family_event_transition_allowed(p_from event_status, p_to event_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (
    ('provisional', 'confirmed'), ('provisional', 'set_aside'), ('provisional', 'dismissed'),
    ('set_aside', 'confirmed'), ('set_aside', 'dismissed'),
    ('confirmed', 'cancelled'))
$$;
-- Garde-fou en base : statut, version, « toute la famille ».
CREATE FUNCTION family_event_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT family_event_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Transition de statut interdite : % vers %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
  END IF;
  IF NEW.whole_family AND NOT OLD.whole_family
     AND EXISTS (SELECT 1 FROM family_event_members WHERE event_id = NEW.id) THEN
    RAISE EXCEPTION 'Un RDV « toute la famille » n''a pas de membres désignés' USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
-- Au plus 30 RDV par mail (US-91 RF2), séances de série exceptées
CREATE FUNCTION family_event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  IF NEW.source_inbound_email_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family_events_mail:' || NEW.source_inbound_email_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_events_per_email';
    SELECT count(*) INTO v_count FROM family_events WHERE source_inbound_email_id = NEW.source_inbound_email_id;
    IF v_count >= COALESCE(v_max, 30) THEN
      RAISE EXCEPTION 'Au plus % RDV par mail', COALESCE(v_max, 30) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Un RDV « toute la famille » n'a pas de membres désignés
CREATE FUNCTION family_event_member_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM family_events WHERE id = NEW.event_id AND whole_family) THEN
    RAISE EXCEPTION 'Un RDV « toute la famille » n''a pas de membres désignés' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Adresses autorisées : seulement l'utilisateur principal ou l'invité 1 (D33), 10 par famille (US-88 RF5, RF6)
CREATE FUNCTION forwarding_sender_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer; v_is_parent boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('forwarding_senders:' || NEW.account_id::text, 0));
  SELECT (role = 'primary_user' OR guest_rank = 'core') AND status <> 'removed' INTO v_is_parent
    FROM users WHERE id = NEW.user_id;
  IF NOT COALESCE(v_is_parent, false) THEN
    RAISE EXCEPTION 'Seules les adresses de l''utilisateur principal et de l''invité 1 peuvent transférer des mails' USING ERRCODE = 'check_violation';
  END IF;
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_authorized_forwarding_addresses';
  SELECT count(*) INTO v_count FROM forwarding_authorized_senders WHERE account_id = NEW.account_id;
  IF v_count >= COALESCE(v_max, 10) THEN
    RAISE EXCEPTION 'Nombre maximal d''adresses atteint (%)', COALESCE(v_max, 10) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Image : taille maximale réglable (10 Mo) et échéance par défaut (30 jours)
CREATE FUNCTION conversation_attachment_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max_mb integer; v_days integer;
BEGIN
  SELECT value_text::integer INTO v_max_mb FROM platform_settings WHERE setting_key = 'max_image_size_mb';
  IF NEW.size_bytes > COALESCE(v_max_mb, 10)::bigint * 1048576 THEN
    RAISE EXCEPTION 'Image trop lourde (maximum % Mo)', COALESCE(v_max_mb, 10) USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.expires_at IS NULL THEN
    SELECT value_text::integer INTO v_days FROM platform_settings WHERE setting_key = 'image_retention_days';
    NEW.expires_at := now() + make_interval(days => COALESCE(v_days, 30));
  END IF;
  RETURN NEW;
END $$;
-- Tout fichier lié à une ligne supprimée est mis en file de suppression, y compris en cascade (compte supprimé)
CREATE FUNCTION enqueue_attachment_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.storage_key IS NOT NULL THEN INSERT INTO storage_deletion_queue (storage_key) VALUES (OLD.storage_key); END IF;
  RETURN OLD;
END $$;
CREATE FUNCTION enqueue_inbound_email_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.raw_storage_key IS NOT NULL THEN INSERT INTO storage_deletion_queue (storage_key) VALUES (OLD.raw_storage_key); END IF;
  RETURN OLD;
END $$;
-- Changement de statut atomique, avec contrôle de version et historique (US-75 RT2, RT4 ; US-77 ; US-80).
-- Retourne false si le RDV a déjà été traité ou modifié entre-temps (« Confirmé par … » est alors affiché).
-- MVP2 : un RDV annulé ou ignoré retire ses tâches proposées et à faire (US-95 RF7) ; p_scope = portée pour une séance de série.
CREATE FUNCTION change_family_event_status(
  p_event_id uuid, p_to event_status, p_user_id uuid,
  p_expected_version integer DEFAULT NULL, p_reason event_change_reason DEFAULT 'user_request'
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_event family_events%ROWTYPE;
BEGIN
  SELECT * INTO v_event FROM family_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_expected_version IS NOT NULL AND v_event.version <> p_expected_version THEN RETURN false; END IF;
  IF NOT family_event_transition_allowed(v_event.status, p_to) THEN RETURN false; END IF;
  IF p_to = 'confirmed' THEN
    IF v_event.starts_at <= now() THEN
      RAISE EXCEPTION 'Ce rendez-vous est déjà passé' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT v_event.whole_family AND NOT EXISTS (SELECT 1 FROM family_event_members WHERE event_id = p_event_id) THEN
      RAISE EXCEPTION 'Précisez le membre concerné avant de confirmer' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE family_events
     SET status = p_to,
         confirmed_by_user_id = CASE WHEN p_to = 'confirmed' THEN p_user_id ELSE confirmed_by_user_id END,
         confirmed_at = CASE WHEN p_to = 'confirmed' THEN now() ELSE confirmed_at END
   WHERE id = p_event_id;
  INSERT INTO family_event_history (event_id, user_id, action, from_status, to_status, reason)
  VALUES (p_event_id, p_user_id,
          CASE p_to WHEN 'confirmed' THEN 'confirmed' WHEN 'set_aside' THEN 'set_aside'
                    WHEN 'dismissed' THEN 'dismissed' ELSE 'cancelled' END::event_action,
          v_event.status, p_to, p_reason);
  RETURN true;
END $$;
-- Confirmation groupée : tous les RDV choisis sont confirmés, ou aucun (US-91 RF11, RT1)
CREATE FUNCTION confirm_family_events_group(p_event_ids uuid[], p_user_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_n integer := 0;
BEGIN
  FOREACH v_id IN ARRAY p_event_ids LOOP
    IF NOT change_family_event_status(v_id, 'confirmed', p_user_id) THEN
      RAISE EXCEPTION 'Le rendez-vous % ne peut pas être confirmé', v_id USING ERRCODE = 'check_violation';
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
-- Conflits (US-74 RF2 à RF4) : créneaux qui se chevauchent avec au moins un membre commun ; « toute la famille »
-- est en conflit avec tout. Seuls les RDV confirmés et provisoires comptent. Aucune contrainte d'exclusion :
-- l'utilisateur peut confirmer malgré un conflit.
CREATE FUNCTION find_family_event_conflicts(
  p_account_id uuid, p_member_ids uuid[], p_whole_family boolean,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_event uuid DEFAULT NULL
) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
  SELECT e.id FROM family_events e
   WHERE e.account_id = p_account_id
     AND e.status IN ('provisional', 'confirmed')
     AND (p_exclude_event IS NULL OR e.id <> p_exclude_event)
     AND e.starts_at < p_ends_at AND e.ends_at > p_starts_at
     AND (p_whole_family OR e.whole_family
          OR EXISTS (SELECT 1 FROM family_event_members m WHERE m.event_id = e.id AND m.member_id = ANY (p_member_ids)))
$$;
-- RDV visibles par un profil (D26) : parents = tous ; invité secondaire = RDV dont il est un membre concerné,
-- RDV « toute la famille » et RDV issus de ses propres demandes. Les RDV annulés et ignorés ne s'affichent pas.
CREATE FUNCTION family_events_visible_to(p_viewer uuid) RETURNS SETOF family_events
LANGUAGE sql STABLE AS $$
  SELECT e.*
    FROM family_events e
    JOIN users v ON v.id = p_viewer AND v.account_id = e.account_id
   WHERE e.status IN ('provisional', 'set_aside', 'confirmed')
     AND ( v.role = 'primary_user' OR v.guest_rank = 'core'
        OR e.whole_family
        OR e.requested_by_user_id = v.id
        OR EXISTS (SELECT 1 FROM family_event_members m JOIN family_members fm ON fm.id = m.member_id
                    WHERE m.event_id = e.id AND fm.user_id = v.id) )
$$;
-- Droit de confirmer, modifier, ignorer ou annuler : parents = tous les RDV ; invité secondaire = ses propres demandes (D26)
CREATE FUNCTION can_manage_family_event(p_user_id uuid, p_event_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM family_events e JOIN users u ON u.id = p_user_id AND u.account_id = e.account_id
     WHERE e.id = p_event_id
       AND (u.role = 'primary_user' OR u.guest_rank = 'core' OR e.requested_by_user_id = u.id))
$$;
-- Onglet « Famille » du carnet de bord : VUE sur l'historique des RDV, les propositions et le suivi des mails
-- (décision du PO : rien n'est écrit dans logbook_entries ; ces lignes disparaissent avec les RDV et le suivi purgés).
CREATE VIEW v_family_logbook AS
SELECT h.event_id AS family_event_id, NULL::uuid AS inbound_email_id, e.account_id, h.occurred_at,
       h.user_id AS actor_user_id,
       CASE h.action WHEN 'confirmed' THEN 'event_confirmed' WHEN 'set_aside' THEN 'event_set_aside'
                     WHEN 'dismissed' THEN 'event_dismissed' WHEN 'modified' THEN 'event_modified'
                     ELSE 'event_cancelled' END AS entry_kind
  FROM family_event_history h JOIN family_events e ON e.id = h.event_id
 WHERE h.action IN ('confirmed', 'set_aside', 'dismissed', 'modified', 'cancelled')
   AND (h.user_id IS NOT NULL OR h.action IN ('modified', 'cancelled'))
UNION ALL
SELECT p.event_id, p.source_inbound_email_id, p.account_id, p.decided_at, p.decided_by_user_id,
       CASE p.status WHEN 'accepted' THEN 'proposal_accepted' ELSE 'proposal_declined' END
  FROM family_event_change_proposals p WHERE p.status IN ('accepted', 'declined')
UNION ALL
SELECT NULL::uuid, i.id, i.account_id, i.received_at, i.forwarded_by_user_id,
       CASE i.status WHEN 'processed' THEN 'mail_received' WHEN 'irrelevant' THEN 'mail_not_retained'
                     WHEN 'no_date_found' THEN 'mail_no_date' WHEN 'known_event' THEN 'mail_known_event'
                     ELSE 'mail_no_matching_event' END
  FROM inbound_emails i
 WHERE i.status IN ('processed', 'irrelevant', 'no_date_found', 'known_event', 'no_matching_event');
-- Carnet « Famille » visible par un profil : parents = tout le foyer ; invité secondaire = ses actions et les RDV qu'il voit
CREATE FUNCTION family_logbook_visible_to(p_viewer uuid) RETURNS SETOF v_family_logbook
LANGUAGE sql STABLE AS $$
  SELECT l.*
    FROM v_family_logbook l
    JOIN users v ON v.id = p_viewer AND v.account_id = l.account_id
   WHERE v.role = 'primary_user' OR v.guest_rank = 'core'
      OR l.actor_user_id = v.id
      OR l.family_event_id IN (SELECT id FROM family_events_visible_to(p_viewer))
$$;
-- Plafond de mails traités par jour et par famille. accepted = false au-delà de la limite ;
-- alert_due = true la première fois de la journée (l'utilisateur principal est alors prévenu, US-87 RF12).
CREATE FUNCTION register_inbound_email(p_account_id uuid, p_email_date date)
RETURNS TABLE (accepted boolean, alert_due boolean) LANGUAGE plpgsql AS $$
DECLARE v_limit integer; v_count integer; v_alert boolean;
BEGIN
  SELECT value_text::integer INTO v_limit FROM platform_settings WHERE setting_key = 'max_inbound_emails_per_day';
  INSERT INTO inbound_email_daily_counters AS c (account_id, email_date, mail_count)
       VALUES (p_account_id, p_email_date, 1)
  ON CONFLICT (account_id, email_date) DO UPDATE SET mail_count = c.mail_count + 1
        WHERE c.mail_count < COALESCE(v_limit, 50)
  RETURNING c.mail_count INTO v_count;
  IF v_count IS NOT NULL THEN
    RETURN QUERY SELECT true, false;
    RETURN;
  END IF;
  UPDATE inbound_email_daily_counters SET over_limit_alerted_at = now()
   WHERE account_id = p_account_id AND email_date = p_email_date AND over_limit_alerted_at IS NULL
  RETURNING true INTO v_alert;
  RETURN QUERY SELECT false, COALESCE(v_alert, false);
END $$;
-- Supprime du stockage les images et les contenus bruts de mails dont plus aucun RDV ne dépend.
CREATE FUNCTION delete_orphan_sources(p_message_ids bigint[], p_email_ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  WITH old AS (
    SELECT a.id, a.storage_key FROM conversation_attachments a
     WHERE a.message_id = ANY (p_message_ids) AND a.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM family_events e WHERE e.source_message_id = a.message_id)),
  q AS (INSERT INTO storage_deletion_queue (storage_key) SELECT storage_key FROM old)
  UPDATE conversation_attachments a SET deleted_at = now(), storage_key = NULL FROM old WHERE a.id = old.id;
  WITH old AS (
    SELECT i.id, i.raw_storage_key FROM inbound_emails i
     WHERE i.id = ANY (p_email_ids) AND i.raw_storage_key IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM family_events e WHERE e.source_inbound_email_id = i.id)),
  q AS (INSERT INTO storage_deletion_queue (storage_key) SELECT raw_storage_key FROM old)
  UPDATE inbound_emails i SET raw_storage_key = NULL, raw_deleted_at = now() FROM old WHERE i.id = old.id;
END $$;
-- Effacement d'un membre : prénom et naissance vidés, RDV qui ne concernent que lui supprimés, images et mails
-- devenus inutiles supprimés (D34, US-93 RF13, RT2, RT3). Dans les RDV partagés, il reste affiché « Ancien membre ».
-- Limite connue : le remplacement du prénom dans le texte libre (titre, lieu, note, chiffrés) est fait par l'application,
-- au mieux (risque accepté par le PO, à mentionner dans l'AIPD). Retourne le nombre de RDV supprimés.
-- Appelée par « Effacer définitivement » (p_write_trace = true) et par la purge d'un invité (false : la trace du profil existe).
CREATE FUNCTION anonymize_family_member(p_member_id uuid, p_write_trace boolean DEFAULT true) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v_account uuid; v_msg bigint[]; v_mail uuid[]; v_n bigint;
BEGIN
  SELECT account_id INTO v_account FROM family_members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  WITH del AS (
    DELETE FROM family_events e
     WHERE e.account_id = v_account AND NOT e.whole_family
       AND EXISTS (SELECT 1 FROM family_event_members x WHERE x.event_id = e.id AND x.member_id = p_member_id)
       AND NOT EXISTS (SELECT 1 FROM family_event_members y WHERE y.event_id = e.id AND y.member_id <> p_member_id)
    RETURNING e.source_message_id, e.source_inbound_email_id)
  SELECT COALESCE(array_agg(DISTINCT source_message_id) FILTER (WHERE source_message_id IS NOT NULL), '{}'),
         COALESCE(array_agg(DISTINCT source_inbound_email_id) FILTER (WHERE source_inbound_email_id IS NOT NULL), '{}'),
         count(*)
    INTO v_msg, v_mail, v_n FROM del;
  PERFORM delete_orphan_sources(v_msg, v_mail);
  UPDATE family_members
     SET first_name = NULL, birth_year = NULL, birth_month = NULL, user_id = NULL,
         anonymized_at = COALESCE(anonymized_at, now()), archived_at = COALESCE(archived_at, now())
   WHERE id = p_member_id;
  IF p_write_trace THEN
    INSERT INTO erasure_traces (former_subject_id, former_account_id, subject_kind, digitorn_status, completed_at)
    VALUES (p_member_id, v_account, 'family_member', 'done', now());
  END IF;
  RETURN v_n;
END $$;
-- Purge des RDV : annulés ou ignorés après 30 jours, passés après 24 mois (réglages). Supprime aussi les images et mails bruts orphelins.
CREATE FUNCTION purge_expired_family_events() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_closed integer; v_past integer; v_msg bigint[]; v_mail uuid[]; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_closed FROM platform_settings WHERE setting_key = 'family_event_closed_retention_days';
  SELECT value_text::integer INTO v_past FROM platform_settings WHERE setting_key = 'family_event_past_retention_months';
  WITH del AS (
    DELETE FROM family_events
     WHERE (status IN ('cancelled', 'dismissed') AND status_changed_at < now() - make_interval(days => COALESCE(v_closed, 30)))
        OR ends_at < now() - make_interval(months => COALESCE(v_past, 24))
    RETURNING source_message_id, source_inbound_email_id)
  SELECT COALESCE(array_agg(DISTINCT source_message_id) FILTER (WHERE source_message_id IS NOT NULL), '{}'),
         COALESCE(array_agg(DISTINCT source_inbound_email_id) FILTER (WHERE source_inbound_email_id IS NOT NULL), '{}'),
         count(*)
    INTO v_msg, v_mail, v_n FROM del;
  PERFORM delete_orphan_sources(v_msg, v_mail);
  RETURN v_n;
END $$;
-- Images : supprimées à l'échéance (30 jours) ou plus tôt, quand des RDV en sont issus et qu'aucun n'attend plus de décision
CREATE FUNCTION purge_expired_attachments() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  WITH old AS (
    SELECT a.id, a.storage_key FROM conversation_attachments a
     WHERE a.deleted_at IS NULL
       AND ( a.expires_at <= now()
          OR ( EXISTS (SELECT 1 FROM family_events e WHERE e.source_message_id = a.message_id)
               AND NOT EXISTS (SELECT 1 FROM family_events e WHERE e.source_message_id = a.message_id
                                  AND e.status IN ('provisional', 'set_aside')) ) )),
  q AS (INSERT INTO storage_deletion_queue (storage_key) SELECT storage_key FROM old)
  UPDATE conversation_attachments a SET deleted_at = now(), storage_key = NULL FROM old WHERE a.id = old.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- Mails : contenu brut supprimé à l'échéance (30 jours), ou dès qu'il est inutile (mail sans RDV, ou RDV tous traités) ;
-- informations de suivi supprimées après 90 jours (30 jours pour un expéditeur non autorisé).
CREATE FUNCTION purge_expired_inbound_emails() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_meta integer; v_rejected integer; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_meta FROM platform_settings WHERE setting_key = 'inbound_email_metadata_retention_days';
  SELECT value_text::integer INTO v_rejected FROM platform_settings WHERE setting_key = 'rejected_email_metadata_retention_days';
  WITH old AS (
    SELECT i.id, i.raw_storage_key FROM inbound_emails i
     WHERE i.raw_storage_key IS NOT NULL
       AND ( i.raw_expires_at <= now()
          OR i.status IN ('irrelevant', 'no_date_found', 'known_event', 'no_matching_event', 'verification_mail')
          OR ( i.status = 'processed'
               AND EXISTS (SELECT 1 FROM family_events e WHERE e.source_inbound_email_id = i.id)
               AND NOT EXISTS (SELECT 1 FROM family_events e WHERE e.source_inbound_email_id = i.id
                                  AND e.status IN ('provisional', 'set_aside')) ) )),
  q AS (INSERT INTO storage_deletion_queue (storage_key) SELECT raw_storage_key FROM old)
  UPDATE inbound_emails i SET raw_storage_key = NULL, raw_deleted_at = now() FROM old WHERE i.id = old.id;
  DELETE FROM inbound_emails
   WHERE (status <> 'rejected_unauthorized' AND received_at < now() - make_interval(days => COALESCE(v_meta, 90)))
      OR (status = 'rejected_unauthorized' AND received_at < now() - make_interval(days => COALESCE(v_rejected, 30)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- Messages du tchat conservés par MAAQ : supprimés au bout de 4 jours (US-44). Les images suivent en cascade.
CREATE FUNCTION purge_expired_conversation_messages() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM agent_conversation_messages WHERE expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- Effacement des conversations d'un profil : à la déconnexion, à la révocation d'un appareil (tous les agents)
-- ou au retrait d'un agent (cet agent seulement). Retourne le nombre de messages supprimés. [US-9, 28, 43, 53]
CREATE FUNCTION erase_agent_conversations(p_user_id uuid, p_agent_id bigint DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM agent_conversation_messages m
   USING agent_conversations c
   WHERE m.conversation_id = c.id AND c.user_id = p_user_id AND (p_agent_id IS NULL OR c.agent_id = p_agent_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- Compteurs journaliers (demandes, mails) : conservés 7 jours
CREATE FUNCTION purge_old_daily_counters() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_a bigint; v_b bigint;
BEGIN
  DELETE FROM daily_request_counters WHERE request_date < current_date - 7;
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM inbound_email_daily_counters WHERE email_date < current_date - 7;
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
-- Clés d'idempotence et demandes du tchat : conservées 24 h (comme l'application le faisait par DELETE direct)
CREATE FUNCTION purge_expired_request_records() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_a bigint; v_b bigint;
BEGIN
  DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM chat_requests WHERE created_at < now() - interval '24 hours';
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
-- Âge d'un membre en mois civils à partir du mois et de l'année de naissance (le jour n'est jamais saisi, D54). Convention :
-- différence des mois civils entre la date donnée et le mois de naissance. NULL si la naissance n'est pas connue.
CREATE FUNCTION family_member_age_months(p_birth_year smallint, p_birth_month smallint, p_on date DEFAULT current_date)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_birth_year IS NULL OR p_birth_month IS NULL THEN NULL
              ELSE (EXTRACT(year FROM p_on)::integer * 12 + EXTRACT(month FROM p_on)::integer) - (p_birth_year * 12 + p_birth_month) END
$$;
-- Journal d'administration : conservé 5 ans (décision du PO du 26/10/2026)
CREATE FUNCTION purge_admin_audit_log() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'admin_audit_retention_months';
  DELETE FROM admin_audit_log WHERE occurred_at < now() - make_interval(months => COALESCE(v_months, 60));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- Fiche « membre » de chaque profil (US-92 RF1, US-20, US-113 RT6) : créée avec le profil par un trigger, archivée au retrait de l'invité et
-- anonymisée à sa suppression. Rattrapage des profils qui n'en ont pas (invités antérieurs au trigger) ; idempotent. Retourne le nombre de fiches créées.
CREATE FUNCTION backfill_family_members() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_u record; v_n integer := 0;
BEGIN
  FOR v_u IN SELECT u.id, u.account_id, u.first_name, u.role, u.guest_rank, u.status FROM users u
              WHERE u.role <> 'admin' AND u.account_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM family_members m WHERE m.user_id = u.id)
              ORDER BY u.created_at LOOP
    INSERT INTO family_members (account_id, user_id, first_name, role, created_by_user_id, archived_at)
    VALUES (v_u.account_id, v_u.id, v_u.first_name,
            CASE WHEN v_u.role = 'primary_user' OR v_u.guest_rank = 'core' THEN 'parent'::member_role ELSE 'other'::member_role END,
            v_u.id, CASE WHEN v_u.status = 'removed' THEN now() END);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
-- Mise à jour automatique de updated_at (audit)
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
-- Quota d'invités vérifié côté serveur à l'ajout, même si l'écran affichait une place (US-18 RT1).
-- Le verrou sur le compte sérialise deux ajouts simultanés. Les invités retirés ou en délai de grâce libèrent
-- leur place (US-20 RF2 ; décision du 01/10/2026, P13).
CREATE FUNCTION enforce_guest_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_quota integer; v_used integer;
BEGIN
  IF NEW.role <> 'guest' THEN RETURN NEW; END IF;
  SELECT guest_quota INTO v_quota FROM accounts WHERE id = NEW.account_id FOR UPDATE;
  SELECT count(*) INTO v_used FROM users
   WHERE account_id = NEW.account_id AND role = 'guest' AND status IN ('pending_activation', 'active');
  IF v_used >= v_quota THEN
    RAISE EXCEPTION 'Quota d''invités atteint pour le compte %', NEW.account_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Règles d'ajout d'un agent au dashboard : limite par rubrique (US-26 RT2, US-27) et rubrique Contrats
-- réservée au noyau (D7, US-23 RF11). S'applique à l'ajout et au ré-ajout après retrait.
CREATE FUNCTION enforce_profile_agent_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_role user_role; v_rank guest_rank; v_category_id integer; v_core_only boolean; v_max integer; v_count integer;
BEGIN
  IF NEW.removed_at IS NOT NULL THEN RETURN NEW; END IF;                       -- retrait : rien à contrôler
  IF TG_OP = 'UPDATE' AND OLD.removed_at IS NULL THEN RETURN NEW; END IF;      -- agent déjà actif : pas un (ré)ajout
  SELECT role, guest_rank INTO v_role, v_rank FROM users WHERE id = NEW.user_id;
  SELECT c.id, c.is_core_only INTO v_category_id, v_core_only
    FROM agents a JOIN agent_categories c ON c.id = a.category_id WHERE a.id = NEW.agent_id;
  IF v_role = 'admin' THEN
    RAISE EXCEPTION 'Un administrateur n''a pas de dashboard' USING ERRCODE = 'check_violation';
  END IF;
  IF v_core_only AND v_role = 'guest' AND v_rank = 'secondary' THEN
    RAISE EXCEPTION 'Rubrique réservée au noyau du compte' USING ERRCODE = 'check_violation';
  END IF;
  -- Verrou par profil et rubrique : deux ajouts simultanés (2 appareils, double toucher) ne dépassent pas la limite
  PERFORM pg_advisory_xact_lock(hashtextextended('profile_agents:' || NEW.user_id::text || ':' || v_category_id::text, 0));
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_agents_per_category';
  SELECT count(*) INTO v_count
    FROM profile_agents pa JOIN agents a ON a.id = pa.agent_id
   WHERE pa.user_id = NEW.user_id AND a.category_id = v_category_id AND pa.removed_at IS NULL
     AND pa.id IS DISTINCT FROM NEW.id;
  IF v_count >= COALESCE(v_max, 10) THEN
    RAISE EXCEPTION 'Limite de % agents atteinte dans cette rubrique', COALESCE(v_max, 10) USING ERRCODE = 'check_violation';
  END IF;
  -- Ré-ajout après retrait : l'agent repasse en fin de liste (ordre d'ajout, US-22 RF3)
  IF TG_OP = 'UPDATE' THEN NEW.added_at := now(); END IF;
  RETURN NEW;
END $$;
-- Limite d'adresses en copie par profil et par agent (US-16 RF4) : fixée par l'administrateur à la publication
-- de l'agent (agents.cc_addresses_max_count, 10 en pratique). 0 = l'agent n'accepte pas d'adresses en copie.
CREATE FUNCTION enforce_cc_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_count integer; v_max smallint;
BEGIN
  SELECT cc_addresses_max_count INTO v_max FROM agents WHERE id = NEW.agent_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('cc_addresses:' || NEW.user_id::text || ':' || NEW.agent_id::text, 0));
  SELECT count(*) INTO v_count FROM cc_addresses WHERE user_id = NEW.user_id AND agent_id = NEW.agent_id;
  IF v_count >= COALESCE(v_max, 0) THEN
    RAISE EXCEPTION 'Limite d''adresses en copie atteinte pour cet agent (maximum %)', COALESCE(v_max, 0) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Une valeur de liste ne dépasse pas le nombre d'éléments prévu par le champ de l'agent (agent_info_fields.max_items)
CREATE FUNCTION enforce_info_value_position() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max smallint;
BEGIN
  SELECT max_items INTO v_max FROM agent_info_fields WHERE id = NEW.info_field_id;
  IF NEW.item_position > v_max THEN
    RAISE EXCEPTION 'Ce champ accepte au plus % élément(s)', v_max USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Nombre maximal de documents par contrat (20 par défaut, US-34 RF5) et taille maximale (15 Mo par défaut, US-34 RF2, RT3),
-- tous deux réglables dans platform_settings
CREATE FUNCTION enforce_contract_document_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_count integer; v_max_mb integer; v_max_docs integer;
BEGIN
  SELECT value_text::integer INTO v_max_mb FROM platform_settings WHERE setting_key = 'max_document_size_mb';
  SELECT value_text::integer INTO v_max_docs FROM platform_settings WHERE setting_key = 'max_documents_per_contract';
  IF NEW.size_bytes > COALESCE(v_max_mb, 15)::bigint * 1048576 THEN
    RAISE EXCEPTION 'Document trop volumineux (maximum % Mo)', COALESCE(v_max_mb, 15) USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('contract_documents:' || NEW.account_contract_id::text, 0));
  SELECT count(*) INTO v_count FROM contract_documents WHERE account_contract_id = NEW.account_contract_id;
  IF v_count >= COALESCE(v_max_docs, 20) THEN
    RAISE EXCEPTION 'Limite de % documents atteinte pour ce contrat', COALESCE(v_max_docs, 20) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
-- Éléments de configuration manquants par profil et agent (qui doit faire quoi) — base des statuts
-- « Prêt / À configurer » du dashboard, de la page Contrats et de l'écran informatif de l'invité (US-22, 29, 31).
CREATE VIEW v_profile_agent_missing_items AS
-- Connecteurs requis non connectés : par le profil, par l'utilisateur principal, ou connexion unique du compte
SELECT pa.user_id, pa.agent_id, 'connector'::text AS item_kind, ct.code AS item_code,
       CASE ar.owner_scope WHEN 'each_profile' THEN 'profile' ELSE 'primary_user' END AS responsible
  FROM profile_agents pa
  JOIN users u ON u.id = pa.user_id
  JOIN agent_requirements ar ON ar.agent_id = pa.agent_id
  JOIN connector_types ct ON ct.id = ar.connector_type_id
 WHERE pa.removed_at IS NULL
   AND CASE ar.owner_scope
         WHEN 'account' THEN NOT EXISTS (
           SELECT 1 FROM account_connections c
            WHERE c.account_id = u.account_id AND c.connector_type_id = ar.connector_type_id AND c.status = 'connected')
         ELSE NOT EXISTS (
           SELECT 1 FROM agent_connections ac
            WHERE ac.agent_id = pa.agent_id AND ac.connector_type_id = ar.connector_type_id AND ac.status = 'connected'
              AND ac.user_id = CASE ar.owner_scope
                    WHEN 'primary_user' THEN (SELECT p.id FROM users p WHERE p.account_id = u.account_id AND p.role = 'primary_user')
                    ELSE pa.user_id END)
       END
UNION ALL
-- Informations obligatoires de l'agent non renseignées (au moins un élément pour un champ liste)
SELECT pa.user_id, pa.agent_id, 'info'::text, f.label, 'profile'
  FROM profile_agents pa
  JOIN agent_info_fields f ON f.agent_id = pa.agent_id AND f.is_required
 WHERE pa.removed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM user_agent_info_values v WHERE v.user_id = pa.user_id AND v.info_field_id = f.id);
-- Dashboard / page Contrats : agents d'un profil avec statut calculé (US-22 RT1)
CREATE VIEW v_dashboard_agents AS
SELECT pa.user_id, a.id AS agent_id, a.name, a.short_description, c.code AS category_code, pa.added_at,
       CASE WHEN a.status = 'blocked' THEN 'blocked'
            WHEN EXISTS (SELECT 1 FROM v_profile_agent_missing_items m WHERE m.user_id = pa.user_id AND m.agent_id = pa.agent_id)
                 THEN 'to_configure'
            ELSE 'ready' END AS display_status
  FROM profile_agents pa
  JOIN agents a ON a.id = pa.agent_id
  JOIN agent_categories c ON c.id = a.category_id
 WHERE pa.removed_at IS NULL;
-- Valeurs déjà saisies pour un autre agent et proposées pré-remplies (décision du 01/10/2026, N1) : même profil, même
-- clé commune et même type de donnée. La valeur la plus récemment modifiée est retenue. L'utilisateur confirme la
-- copie : c'est alors une nouvelle ligne de user_agent_info_values, indépendante de la source.
CREATE VIEW v_info_prefill_suggestions AS
SELECT DISTINCT ON (pa.user_id, f.id, v.item_position)
       pa.user_id, f.id AS info_field_id, src.id AS source_field_id, v.item_position, v.value_encrypted
  FROM profile_agents pa
  JOIN agent_info_fields f ON f.agent_id = pa.agent_id AND f.shared_key IS NOT NULL
  JOIN agent_info_fields src ON src.shared_key = f.shared_key AND src.id <> f.id AND src.data_type = f.data_type
  JOIN user_agent_info_values v ON v.user_id = pa.user_id AND v.info_field_id = src.id AND v.item_position <= f.max_items
 WHERE pa.removed_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM user_agent_info_values t
                    WHERE t.user_id = pa.user_id AND t.info_field_id = f.id AND t.item_position = v.item_position)
 ORDER BY pa.user_id, f.id, v.item_position, v.updated_at DESC;
-- Comptes et invités jamais activés à supprimer : le dernier lien d'activation (ou, à défaut, la création) date de plus de
-- unactivated_purge_days jours (30 par défaut, décision du 01/10/2026, N8). Pour un utilisateur principal, le traitement
-- supprime le compte entier (cascade) ; pour un invité, seulement son profil.
CREATE VIEW v_never_activated_purge_candidates AS
SELECT u.id AS user_id, u.account_id, u.role,
       COALESCE(l.last_link_at, u.created_at) AS last_activity_at
  FROM users u
  LEFT JOIN LATERAL (SELECT max(al.created_at) AS last_link_at FROM activation_links al WHERE al.user_id = u.id) l ON true
 WHERE u.status = 'pending_activation'
   AND COALESCE(l.last_link_at, u.created_at) <
       now() - make_interval(days => (SELECT value_text::integer FROM platform_settings WHERE setting_key = 'unactivated_purge_days'));
-- Quota d'invités : « N invités sur M — M−N places disponibles » (US-21)
CREATE VIEW v_account_guest_quota AS
SELECT a.id AS account_id, a.guest_quota,
       count(u.id) AS guests_used,
       greatest(a.guest_quota - count(u.id), 0) AS places_left
  FROM accounts a
  LEFT JOIN users u ON u.account_id = a.id AND u.role = 'guest' AND u.status IN ('pending_activation', 'active')
 GROUP BY a.id, a.guest_quota;
-- Statut affiché d'un invité sur l'écran de gestion des invités (US-4 RF10, US-5 RF1, US-18 RF12).
-- « Invitation expirée » se déduit du lien (30 min) : pas de statut stocké qui deviendrait faux avec le temps.
CREATE VIEW v_guest_display_status AS
SELECT u.id AS user_id, u.account_id, u.guest_rank,
       CASE
         WHEN u.status = 'active' THEN 'active'
         WHEN u.status = 'pending_activation' AND l.id IS NULL THEN 'invitation_sent'
         WHEN u.status = 'pending_activation' AND l.delivery_status = 'sending' THEN 'sending'
         WHEN u.status = 'pending_activation' AND l.delivery_status = 'failed' THEN 'send_failed'
         WHEN u.status = 'pending_activation' AND l.expires_at < now() THEN 'invitation_expired'
         WHEN u.status = 'pending_activation' THEN 'invitation_sent'
         ELSE u.status::text
       END AS display_status,
       l.sent_at AS last_invitation_sent_at
  FROM users u
  LEFT JOIN LATERAL (
    SELECT al.* FROM activation_links al
     WHERE al.user_id = u.id AND al.kind = 'guest_invitation'
     ORDER BY al.created_at DESC LIMIT 1) l ON true
 WHERE u.role = 'guest' AND u.status <> 'removed';
-- Carnet de bord visible par un profil (règle D3) :
--  * utilisateur principal et invité 1 (noyau) → toutes les entrées du compte ;
--  * invité secondaire → ses propres entrées + celles où il est participant.
-- Les entrées en cours d'anonymisation sont masquées (US-57 RF7).
CREATE FUNCTION logbook_visible_entries(p_viewer uuid) RETURNS SETOF logbook_entries
LANGUAGE sql STABLE AS $$
  SELECT e.*
    FROM logbook_entries e
    JOIN users v ON v.id = p_viewer AND v.account_id = e.account_id
   WHERE e.anonymization_status <> 'pending'
     AND ( v.role = 'primary_user'
        OR v.guest_rank = 'core'
        OR e.requester_user_id = v.id
        OR EXISTS (SELECT 1 FROM logbook_entry_participants p
                    WHERE p.entry_id = e.id AND p.entry_occurred_at = e.occurred_at AND p.user_id = v.id) )
$$;
-- Prépare les partitions mensuelles du carnet (mois courant + N mois à venir) ; à appeler chaque mois.
CREATE FUNCTION ensure_logbook_partitions(p_months_ahead integer DEFAULT 3) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_base timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
  v_from text; v_to text; v_suffix text;
BEGIN
  FOR i IN 0..p_months_ahead LOOP
    v_suffix := to_char(v_base + make_interval(months => i), 'YYYY_MM');
    v_from := to_char(v_base + make_interval(months => i), 'YYYY-MM-DD') || ' 00:00:00+00';
    v_to   := to_char(v_base + make_interval(months => i + 1), 'YYYY-MM-DD') || ' 00:00:00+00';
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF logbook_entries FOR VALUES FROM (%L) TO (%L)',
                   'logbook_entries_' || v_suffix, v_from, v_to);
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF logbook_entry_participants FOR VALUES FROM (%L) TO (%L)',
                   'logbook_entry_participants_' || v_suffix, v_from, v_to);
  END LOOP;
END $$;
-- Purge des entrées du carnet au-delà de la durée de rétention réglable, 14 mois par défaut (US-40 RF6, RT6) : supprime en bloc les mois entièrement
-- expirés, puis efface les lignes expirées du mois frontière. Retourne le nombre de lignes supprimées hors DROP.
CREATE FUNCTION purge_expired_logbook(p_retention interval DEFAULT NULL) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  -- Sans argument : durée lue dans platform_settings.logbook_retention_months (14 mois par défaut)
  v_cutoff timestamptz := now() - COALESCE(p_retention, make_interval(months =>
    (SELECT value_text::integer FROM platform_settings WHERE setting_key = 'logbook_retention_months')));
  r record; v_month_end timestamptz; v_n bigint; v_total bigint := 0;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'logbook_entries' AND c.relname ~ '^logbook_entries_[0-9]{4}_[0-9]{2}$'
  LOOP
    v_month_end := ((to_date(substr(r.relname, 17), 'YYYY_MM') + interval '1 month')::timestamp) AT TIME ZONE 'UTC';
    IF v_month_end <= v_cutoff THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', 'logbook_entry_participants_' || substr(r.relname, 17));
      EXECUTE format('DROP TABLE %I', r.relname);
    END IF;
  END LOOP;
  DELETE FROM logbook_entry_participants WHERE entry_occurred_at < v_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM logbook_entries WHERE occurred_at < v_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RETURN v_total;
END $$;
-- Enregistre une demande d'un profil et applique le plafond quotidien de son compte. Retourne true si la demande est
-- acceptée (compteur incrémenté), false si le plafond est atteint (l'application affiche le message). L'incrément est
-- atomique : deux demandes simultanées ne dépassent pas le plafond. Une relance après erreur ne doit pas être comptée
-- deux fois : l'application n'appelle la fonction qu'une fois par demande (US-38 RT2, CC-7).
CREATE FUNCTION register_agent_request(p_user_id uuid, p_request_date date) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_limit integer; v_count integer;
BEGIN
  SELECT a.daily_request_limit INTO v_limit
    FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = p_user_id;
  IF v_limit IS NULL THEN RETURN false; END IF;                       -- administrateur ou profil inconnu : pas de demande
  INSERT INTO daily_request_counters AS c (user_id, request_date, request_count)
       VALUES (p_user_id, p_request_date, 1)
  ON CONFLICT (user_id, request_date) DO UPDATE SET request_count = c.request_count + 1
        WHERE c.request_count < v_limit
  RETURNING c.request_count INTO v_count;
  RETURN v_count IS NOT NULL;
END $$;
-- Purge des signalements au-delà de la durée de rétention réglable (14 mois par défaut, US-61 RT2)
CREATE FUNCTION purge_expired_error_reports() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM error_reports
   WHERE reported_at < now() - make_interval(months =>
         (SELECT value_text::integer FROM platform_settings WHERE setting_key = 'error_report_retention_months'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
-- Purge du journal de sécurité au-delà de la durée de rétention réglable (36 mois par défaut)
CREATE FUNCTION purge_expired_security_events() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM security_events
   WHERE occurred_at < now() - make_interval(months =>
         (SELECT value_text::integer FROM platform_settings WHERE setting_key = 'security_event_retention_months'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
CREATE INDEX idx_accounts_purge_scheduled_at ON accounts (purge_scheduled_at) WHERE purge_scheduled_at IS NOT NULL;
-- Un email = un seul compte actif (US-18 RF3). Un invité retiré libère son email (hypothèse H7).
CREATE UNIQUE INDEX ux_users_email_not_removed ON users (email) WHERE status <> 'removed';
-- Un seul utilisateur principal par compte
CREATE UNIQUE INDEX ux_users_one_primary_per_account ON users (account_id) WHERE role = 'primary_user';
-- Un seul invité 1 par compte tant qu'il n'est pas retiré (D6 : pas de promotion automatique)
CREATE UNIQUE INDEX ux_users_one_core_guest_per_account ON users (account_id) WHERE guest_rank = 'core' AND status <> 'removed';
CREATE INDEX idx_users_account_id ON users (account_id, role);
CREATE INDEX idx_users_purge_scheduled_at ON users (purge_scheduled_at) WHERE purge_scheduled_at IS NOT NULL;
-- Un seul lien valide à la fois par profil (US-5 RT1) ; le renvoi révoque l'ancien dans la même transaction
CREATE UNIQUE INDEX ux_activation_links_one_valid ON activation_links (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
-- Limite de 3 renvois par heure (US-5 RT2) : comptage des envois récents d'un profil
CREATE INDEX idx_activation_links_user_id ON activation_links (user_id, created_at DESC);
CREATE INDEX idx_activation_links_created_by_user_id ON activation_links (created_by_user_id);
CREATE INDEX idx_devices_user_id ON devices (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_devices_revoked_by_user_id ON devices (revoked_by_user_id);
CREATE INDEX idx_sessions_user_id ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_device_id ON sessions (device_id);
-- Délais de renvoi (60 s) et plafonds horaires (5 / h) : lecture des derniers envois d'un profil
CREATE INDEX idx_verification_codes_user_id ON verification_codes (user_id, purpose, created_at DESC);
CREATE INDEX idx_verification_codes_agent_connection_id ON verification_codes (agent_connection_id) WHERE agent_connection_id IS NOT NULL;
CREATE INDEX idx_security_events_user_id ON security_events (user_id, occurred_at DESC);
CREATE INDEX idx_security_events_actor_user_id ON security_events (actor_user_id);
CREATE INDEX idx_security_events_device_id ON security_events (device_id);
CREATE INDEX idx_security_events_type ON security_events (event_type, occurred_at DESC);
CREATE INDEX idx_legal_document_versions_current ON legal_document_versions (document_type, published_at DESC);
CREATE INDEX idx_legal_acceptances_version_id ON legal_acceptances (version_id);
CREATE INDEX idx_agents_category_id ON agents (category_id, name);
CREATE INDEX idx_agents_blocked_by_user_id ON agents (blocked_by_user_id);
CREATE INDEX idx_agents_published_by_user_id ON agents (published_by_user_id);
CREATE INDEX idx_agent_requirements_connector_type_id ON agent_requirements (connector_type_id);
CREATE UNIQUE INDEX ux_agent_info_fields_label ON agent_info_fields (agent_id, lower(label));
CREATE INDEX idx_agent_info_fields_shared_key ON agent_info_fields (shared_key) WHERE shared_key IS NOT NULL;
CREATE INDEX idx_user_agent_info_values_info_field_id ON user_agent_info_values (info_field_id);
CREATE INDEX idx_user_agent_info_values_updated_by_user_id ON user_agent_info_values (updated_by_user_id);
CREATE INDEX idx_profile_agents_agent_id ON profile_agents (agent_id);
CREATE INDEX idx_profile_agents_active ON profile_agents (user_id, added_at) WHERE removed_at IS NULL;
CREATE INDEX idx_agent_connections_agent_id ON agent_connections (agent_id);
CREATE INDEX idx_agent_connections_connector_type_id ON agent_connections (connector_type_id);
-- Proposition de réutiliser une adresse déjà connectée (US-13 RF7)
CREATE INDEX idx_agent_connections_connected_email ON agent_connections (user_id, connected_email);
CREATE INDEX idx_account_connections_connector_type_id ON account_connections (connector_type_id);
CREATE INDEX idx_account_connections_connected_by_user_id ON account_connections (connected_by_user_id);
CREATE INDEX idx_cc_addresses_agent_id ON cc_addresses (agent_id);
-- Nom unique dans la liste, sans tenir compte des majuscules (US-48 RF2)
CREATE UNIQUE INDEX ux_contract_definitions_name ON contract_definitions (lower(name)) WHERE archived_at IS NULL;
CREATE INDEX idx_contract_definitions_sort_order ON contract_definitions (sort_order) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX ux_contract_field_definitions_label ON contract_field_definitions (contract_definition_id, lower(label)) WHERE archived_at IS NULL;
CREATE INDEX idx_account_contracts_contract_definition_id ON account_contracts (contract_definition_id);
CREATE INDEX idx_account_contracts_consent_changed_by ON account_contracts (consent_changed_by_user_id);
CREATE INDEX idx_account_contracts_last_modified_by ON account_contracts (last_modified_by_user_id);
CREATE INDEX idx_contract_field_values_field_definition_id ON contract_field_values (field_definition_id);
CREATE INDEX idx_contract_field_values_value_option_id ON contract_field_values (value_option_id);
CREATE INDEX idx_contract_field_values_updated_by ON contract_field_values (updated_by_user_id);
CREATE INDEX idx_contract_documents_account_contract_id ON contract_documents (account_contract_id);
CREATE INDEX idx_contract_documents_added_by_user_id ON contract_documents (added_by_user_id);
CREATE INDEX idx_contract_documents_to_classify ON contract_documents (classification_status) WHERE classification_status <> 'classified';
CREATE INDEX idx_contract_consent_events_account ON contract_consent_events (account_id, contract_definition_id, occurred_at DESC);
CREATE INDEX idx_contract_consent_events_contract_definition_id ON contract_consent_events (contract_definition_id);
CREATE INDEX idx_contract_consent_events_legal_version_id ON contract_consent_events (legal_version_id);
CREATE INDEX idx_contract_consent_events_retain_until ON contract_consent_events (retain_until) WHERE retain_until IS NOT NULL;
-- Les index déclarés sur la table partitionnée sont créés automatiquement sur chaque partition
CREATE INDEX idx_logbook_entries_listing ON logbook_entries (account_id, agent_id, occurred_at DESC);
CREATE INDEX idx_logbook_entries_agent_id ON logbook_entries (agent_id);
CREATE INDEX idx_logbook_entries_requester_user_id ON logbook_entries (requester_user_id);
CREATE INDEX idx_logbook_entry_participants_user_id ON logbook_entry_participants (user_id);
CREATE INDEX idx_logbook_sync_runs_status ON logbook_sync_runs (status, finished_at DESC);
CREATE INDEX idx_action_decisions_requester_user_id ON action_decisions (requester_user_id);
CREATE INDEX idx_action_decisions_decided_by_user_id ON action_decisions (decided_by_user_id);
CREATE INDEX idx_error_reports_agent_id ON error_reports (agent_id);
-- Purge des signalements de plus de 14 mois (US-61 RT2)
CREATE INDEX idx_error_reports_reported_at ON error_reports (reported_at);
-- Une seule demande en cours par profil (US-55 RF5)
CREATE UNIQUE INDEX ux_data_exports_one_in_progress ON data_exports (user_id) WHERE status IN ('requested', 'preparing');
CREATE INDEX idx_data_exports_user_id ON data_exports (user_id);
CREATE INDEX idx_data_exports_expiry ON data_exports (download_expires_at) WHERE status = 'ready';
CREATE INDEX idx_erasure_traces_pending ON erasure_traces (digitorn_status) WHERE digitorn_status <> 'done';
CREATE INDEX idx_chat_erasure_requests_pending ON chat_erasure_requests (status, requested_at) WHERE status <> 'done';
CREATE INDEX idx_chat_erasure_requests_user_id ON chat_erasure_requests (user_id);
CREATE INDEX idx_chat_erasure_requests_agent_id ON chat_erasure_requests (agent_id);
CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys (created_at);
CREATE INDEX idx_chat_requests_agent_id ON chat_requests (agent_id);
CREATE INDEX idx_chat_requests_created_at ON chat_requests (created_at);
CREATE INDEX idx_platform_settings_updated_by_user_id ON platform_settings (updated_by_user_id);
CREATE INDEX idx_platform_setting_changes_key ON platform_setting_changes (setting_key, changed_at DESC);
CREATE INDEX idx_platform_setting_changes_changed_by ON platform_setting_changes (changed_by_user_id);
CREATE INDEX idx_admin_audit_log_admin_user_id ON admin_audit_log (admin_user_id);
CREATE INDEX idx_admin_audit_log_entity ON admin_audit_log (entity_type, entity_id);
CREATE INDEX idx_admin_audit_log_occurred_at ON admin_audit_log (occurred_at DESC);
CREATE INDEX idx_agent_conversations_account_id ON agent_conversations (account_id);
CREATE INDEX idx_agent_conversations_agent_id ON agent_conversations (agent_id);
CREATE INDEX idx_conversation_messages_conversation ON agent_conversation_messages (conversation_id, created_at);
CREATE INDEX idx_conversation_messages_expires_at ON agent_conversation_messages (expires_at);
CREATE INDEX idx_conversation_attachments_expiry ON conversation_attachments (expires_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_storage_deletion_queue_pending ON storage_deletion_queue (queued_at) WHERE status <> 'done';
-- Un profil = au plus un membre (US-92 RT1)
CREATE UNIQUE INDEX ux_family_members_one_per_user ON family_members (user_id) WHERE user_id IS NOT NULL;
-- Prénom unique parmi les membres déclarés actifs (US-92 RF5) ; le contrôle contre les prénoms des profils se fait à l'application
CREATE UNIQUE INDEX ux_family_members_declared_name ON family_members (account_id, lower(first_name)) WHERE user_id IS NULL AND archived_at IS NULL;
-- Couleur distincte parmi les membres actifs ; une couleur libérée est réattribuable (US-93 RF9)
CREATE UNIQUE INDEX ux_family_members_active_color ON family_members (account_id, color_index) WHERE archived_at IS NULL;
CREATE INDEX idx_family_members_created_by_user_id ON family_members (created_by_user_id);
-- Une seule adresse active par famille (D33) ; la régénérer révoque l'ancienne
CREATE UNIQUE INDEX ux_forwarding_mailboxes_one_active ON forwarding_mailboxes (account_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_forwarding_mailboxes_account_id ON forwarding_mailboxes (account_id);
CREATE INDEX idx_forwarding_mailboxes_activated_by ON forwarding_mailboxes (activated_by_user_id);
CREATE INDEX idx_forwarding_mailboxes_revoked_by ON forwarding_mailboxes (revoked_by_user_id);
CREATE INDEX idx_forwarding_consent_events_account ON forwarding_consent_events (account_id, occurred_at DESC);
CREATE INDEX idx_forwarding_consent_events_legal_version_id ON forwarding_consent_events (legal_version_id);
CREATE INDEX idx_forwarding_consent_events_retain_until ON forwarding_consent_events (retain_until) WHERE retain_until IS NOT NULL;
CREATE INDEX idx_forwarding_authorized_senders_user_id ON forwarding_authorized_senders (user_id);
CREATE INDEX idx_forwarding_authorized_senders_added_by ON forwarding_authorized_senders (added_by_user_id);
CREATE INDEX idx_verification_codes_authorized_sender_id ON verification_codes (authorized_sender_id) WHERE authorized_sender_id IS NOT NULL;
CREATE INDEX idx_inbound_emails_account ON inbound_emails (account_id, received_at DESC);
CREATE INDEX idx_inbound_emails_mailbox_id ON inbound_emails (mailbox_id);
CREATE INDEX idx_inbound_emails_forwarded_by ON inbound_emails (forwarded_by_user_id);
CREATE INDEX idx_inbound_emails_raw ON inbound_emails (raw_expires_at) WHERE raw_storage_key IS NOT NULL;
CREATE INDEX idx_inbound_emails_received_at ON inbound_emails (received_at);
CREATE UNIQUE INDEX ux_family_events_active_fingerprint ON family_events (account_id, fingerprint)
  WHERE status IN ('provisional', 'set_aside', 'confirmed');
CREATE INDEX idx_family_events_calendar ON family_events (account_id, starts_at, ends_at)
  WHERE status IN ('provisional', 'set_aside', 'confirmed');
CREATE INDEX idx_family_events_closed ON family_events (status_changed_at) WHERE status IN ('cancelled', 'dismissed');
CREATE INDEX idx_family_events_past ON family_events (ends_at);
CREATE INDEX idx_family_events_event_type_id ON family_events (event_type_id);
CREATE INDEX idx_family_events_requested_by ON family_events (requested_by_user_id);
CREATE INDEX idx_family_events_confirmed_by ON family_events (confirmed_by_user_id);
CREATE INDEX idx_family_events_source_message_id ON family_events (source_message_id);
CREATE INDEX idx_family_events_source_email_id ON family_events (source_inbound_email_id);
CREATE INDEX idx_family_events_source_group ON family_events (source_group_id) WHERE source_group_id IS NOT NULL;
CREATE INDEX idx_family_events_created_via_agent_id ON family_events (created_via_agent_id);
CREATE INDEX idx_family_event_members_member ON family_event_members (member_id, event_id);
CREATE INDEX idx_family_event_members_account_id ON family_event_members (account_id);
CREATE INDEX idx_family_event_history_event ON family_event_history (event_id, occurred_at);
CREATE INDEX idx_family_event_history_user_id ON family_event_history (user_id);
-- Une seule proposition en attente par RDV : dès qu'un profil la traite, elle disparaît pour les autres (US-90 RF8)
CREATE UNIQUE INDEX ux_change_proposals_one_pending ON family_event_change_proposals (event_id) WHERE status = 'pending';
CREATE INDEX idx_change_proposals_account_id ON family_event_change_proposals (account_id);
CREATE INDEX idx_change_proposals_email_id ON family_event_change_proposals (source_inbound_email_id);
CREATE INDEX idx_change_proposals_requested_by ON family_event_change_proposals (requested_by_user_id);
CREATE INDEX idx_change_proposals_decided_by ON family_event_change_proposals (decided_by_user_id);
CREATE INDEX idx_family_reminder_settings_event_type_id ON family_reminder_settings (event_type_id);
CREATE INDEX idx_family_reminder_settings_updated_by ON family_reminder_settings (updated_by_user_id);
-- Clés d'unicité contre l'envoi en double (US-81 RT2) : voir ux_scheduled_notifications_* (section MVP2)
CREATE INDEX idx_scheduled_notifications_due ON scheduled_notifications (due_at) WHERE status = 'scheduled';
CREATE INDEX idx_scheduled_notifications_recipient_user_id ON scheduled_notifications (recipient_user_id);
CREATE INDEX idx_erasure_trace_targets_trace ON erasure_trace_targets (erasure_trace_id);
CREATE INDEX idx_erasure_trace_targets_pending ON erasure_trace_targets (status) WHERE status <> 'done';
CREATE INDEX idx_conversation_messages_family_event_id ON agent_conversation_messages (family_event_id) WHERE family_event_id IS NOT NULL;
-- Un double passage du planificateur n'envoie jamais deux fois (US-81 RT2, US-97 RT1)
CREATE UNIQUE INDEX ux_scheduled_notifications_event ON scheduled_notifications (event_id, kind, recipient_user_id, due_at)
  WHERE event_id IS NOT NULL;
CREATE INDEX idx_scheduled_notifications_no_event ON scheduled_notifications (due_at) WHERE event_id IS NULL AND status <> 'scheduled';

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_family_members_before_insert BEFORE INSERT ON family_members
  FOR EACH ROW EXECUTE FUNCTION family_member_before_insert();
CREATE TRIGGER trg_family_members_before_update BEFORE UPDATE ON family_members
  FOR EACH ROW EXECUTE FUNCTION family_member_before_update();
CREATE TRIGGER trg_users_create_member AFTER INSERT ON users
  FOR EACH ROW WHEN (NEW.role <> 'admin') EXECUTE FUNCTION create_member_for_user();
CREATE TRIGGER trg_users_sync_member AFTER UPDATE OF first_name, guest_rank, status ON users
  FOR EACH ROW WHEN (OLD.first_name IS DISTINCT FROM NEW.first_name
                  OR OLD.guest_rank IS DISTINCT FROM NEW.guest_rank
                  OR OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION sync_member_from_user();
CREATE TRIGGER trg_family_events_before_update BEFORE UPDATE ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_before_update();
CREATE TRIGGER trg_family_events_before_insert BEFORE INSERT ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_before_insert();
CREATE TRIGGER trg_family_event_members_before_insert BEFORE INSERT ON family_event_members
  FOR EACH ROW EXECUTE FUNCTION family_event_member_before_insert();
CREATE TRIGGER trg_forwarding_senders_before_insert BEFORE INSERT ON forwarding_authorized_senders
  FOR EACH ROW EXECUTE FUNCTION forwarding_sender_before_insert();
CREATE TRIGGER trg_conversation_attachments_before_insert BEFORE INSERT ON conversation_attachments
  FOR EACH ROW EXECUTE FUNCTION conversation_attachment_before_insert();
CREATE TRIGGER trg_conversation_attachments_enqueue BEFORE DELETE ON conversation_attachments
  FOR EACH ROW EXECUTE FUNCTION enqueue_attachment_file();
CREATE TRIGGER trg_inbound_emails_enqueue BEFORE DELETE ON inbound_emails
  FOR EACH ROW EXECUTE FUNCTION enqueue_inbound_email_file();
CREATE TRIGGER trg_users_guest_quota BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION enforce_guest_quota();
CREATE TRIGGER trg_profile_agents_rules BEFORE INSERT OR UPDATE ON profile_agents
  FOR EACH ROW EXECUTE FUNCTION enforce_profile_agent_rules();
CREATE TRIGGER trg_cc_addresses_limit BEFORE INSERT ON cc_addresses FOR EACH ROW EXECUTE FUNCTION enforce_cc_limit();
CREATE TRIGGER trg_user_agent_info_values_position BEFORE INSERT OR UPDATE OF item_position, info_field_id ON user_agent_info_values
  FOR EACH ROW EXECUTE FUNCTION enforce_info_value_position();
CREATE TRIGGER trg_contract_documents_limit BEFORE INSERT ON contract_documents
  FOR EACH ROW EXECUTE FUNCTION enforce_contract_document_limit();
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
      AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'trg_' || c.table_name || '_updated_at')
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', r.table_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Données de référence
-- ---------------------------------------------------------------------
INSERT INTO agent_categories (code, label, sort_order, is_core_only, shown_on_dashboard) VALUES
  ('pro', 'Pro', 1, false, true),
  ('perso', 'Perso', 2, false, true),
  ('contracts', 'Agents des Contrats', 3, true, false);
INSERT INTO connector_types (code, label, requires_oauth) VALUES
  ('google_drive', 'Google Drive', true),
  ('google_calendar', 'Google Agenda', true),
  ('validation_mailbox', 'Boîte mail de validation', false);
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('logbook_sync_interval_hours', 'integer', '5',  1, 24,   $$Fréquence de synchronisation du carnet avec Digitorn, en heures (US-40 RT2, US-65)$$),
  ('guest_data_retention_days',   'integer', '30', 1, NULL, $$Délai avant suppression des données d'un invité retiré, en jours (US-20 RT2, US-65)$$),
  ('alert_email',                 'email',   NULL, NULL, NULL, $$Adresse qui reçoit les alertes (échecs de synchronisation, d'effacement, de suppression) — à renseigner au déploiement$$),
  ('support_email',               'email',   NULL, NULL, NULL, $$Boîte mail du support (US-62 RT1) — à renseigner au déploiement$$),
  ('max_agents_per_category',     'integer', '10', 1, NULL, $$Nombre maximum d'agents par profil et par rubrique (US-27 RT1)$$),
  ('max_document_size_mb',        'integer', '15', 1, NULL, $$Taille maximale d'un document de contrat, en Mo (US-34 RF2) : amenée à augmenter à l'usage$$),
  ('max_documents_per_contract',  'integer', '20', 1, NULL, $$Nombre maximum de documents par contrat (US-34 RF5), réglable (décision du 01/10/2026)$$),
  ('logbook_retention_months',    'integer', '14', 1, NULL, $$Durée de conservation du carnet de bord, en mois (US-40 RF6), réglable (décision du 01/10/2026)$$),
  ('unactivated_purge_days',      'integer', '30', 1, NULL, $$Délai avant suppression d'un compte ou d'un invité jamais activé, en jours depuis le dernier lien envoyé$$),
  ('error_report_retention_months',    'integer', '14', 1, NULL, $$Durée de conservation des signalements d'erreur, en mois (US-61 RT2), réglable (décision du 01/10/2026)$$),
  ('security_event_retention_months',  'integer', '36', 1, NULL, $$Durée de conservation du journal de sécurité, en mois (3 ans), réglable (décision du 01/10/2026)$$);
INSERT INTO event_types (code, label, sort_order) VALUES
  ('school', 'École', 1), ('medical', 'Médical', 2), ('professional', 'Professionnel', 3),
  ('family', 'Familial', 4), ('personal', 'Personnel', 5), ('administrative', 'Administratif', 6);
-- Réglages de l'Assistant Famille (US-65) : limites et durées de conservation (D35)
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('max_inbound_emails_per_day',              'integer', '50', 1, NULL, $$Mails transférés traités par jour et par famille (US-87 RF12)$$),
  ('max_events_per_email',                    'integer', '30', 1, NULL, $$RDV créés au plus par mail (US-91 RF2)$$),
  ('max_image_size_mb',                       'integer', '10', 1, NULL, $$Taille maximale d'une image jointe, en Mo (US-72 RF4)$$),
  ('max_family_members',                      'integer', '12', 1, NULL, $$Membres actifs déclarés au plus par famille (US-92 RF7)$$),
  ('max_authorized_forwarding_addresses',     'integer', '10', 1, NULL, $$Adresses autorisées à transférer au plus par famille (US-88 RF6)$$),
  ('image_retention_days',                    'integer', '30', 1, NULL, $$Conservation maximale d'une image jointe, en jours (US-72 RF8)$$),
  ('inbound_email_raw_retention_days',        'integer', '30', 1, NULL, $$Conservation maximale du contenu brut d'un mail transféré, en jours (US-87 RF13)$$),
  ('inbound_email_metadata_retention_days',   'integer', '90', 1, NULL, $$Conservation des informations de suivi d'un mail accepté, en jours (US-87 RT4)$$),
  ('rejected_email_metadata_retention_days',  'integer', '30', 1, NULL, $$Conservation des informations de suivi d'un mail d'expéditeur non autorisé, en jours (US-88 RT2)$$),
  ('family_event_closed_retention_days',      'integer', '30', 1, NULL, $$Conservation d'un RDV annulé ou ignoré, en jours (US-77 RT1, US-80 RT2)$$),
  ('family_event_past_retention_months',      'integer', '24', 1, NULL, $$Conservation d'un RDV passé, en mois (décision du 24/10/2026)$$);
-- Réglages du MVP2 (US-65)
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('admin_audit_retention_months',         'integer', '60', 1, NULL, $$Conservation du journal d'administration, en mois (5 ans, décision du PO du 26/10/2026)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON TABLE accounts IS $$Compte MAAQ (abonnement) : un utilisateur principal + ses invités. Frontière d'isolation des données. [US-18, 21, 56, 58, 59, 64]$$;
COMMENT ON COLUMN accounts.status IS $$activation_pending = créé par l'admin, lien d'activation non utilisé ; grace_period = accès suspendu en attente de suppression$$;
COMMENT ON COLUMN accounts.guest_quota IS $$Nombre maximum d'invités du plan. Une réduction du plan n'expulse personne (US-21 RF6) : seuls les ajouts sont bloqués$$;
COMMENT ON COLUMN accounts.daily_request_limit IS $$Nombre maximum de demandes aux agents par jour et par profil du compte (50 par défaut), fixé selon le plan et réglable par l'administrateur ; voir register_agent_request()$$;
COMMENT ON COLUMN accounts.family_timezone IS $$Fuseau IANA de la famille (appareil de l'utilisateur principal à sa dernière connexion), utilisé pour les heures des RDV, rappels et relances$$;
COMMENT ON COLUMN accounts.grace_origin IS $$in_app_request = bouton Désabonnement (annulable immédiatement) ; billing_unsubscribe = outil de facturation (reprise = nouvel abonnement hors app) — US-59 RF2/RF3$$;
COMMENT ON COLUMN accounts.purge_scheduled_at IS $$Date de suppression définitive (début du délai de grâce + 30 jours). Lue par le traitement quotidien (US-56 RT2)$$;
COMMENT ON COLUMN accounts.subscription_ended_at IS $$Date de fin d'abonnement ; sert à calculer la fin de conservation du journal des consentements (5 ans, US-36 RT1)$$;
COMMENT ON TABLE users IS $$Profil connectable : administrateur, utilisateur principal ou invité (3 rôles, un seul modèle). [US-3, 4, 10, 11, 18, 19, 20, 64]$$;
COMMENT ON COLUMN users.account_id IS $$Compte d'appartenance ; NULL pour les administrateurs (hors compte client)$$;
COMMENT ON COLUMN users.guest_rank IS $$core = invité 1 (premier invité ajouté, ou désigné par l'utilisateur principal) ; secondary = invités 2 à n (D1, D6)$$;
COMMENT ON COLUMN users.email IS $$Email de connexion, unique et insensible à la casse. Pour un invité actif, sa modification change aussi l'email de connexion (US-19 RF4)$$;
COMMENT ON COLUMN users.phone IS $$Téléphone mobile pour SMS (invitation, code de vérification). Distinct du téléphone saisi pour les agents (US-19 RF5)$$;
COMMENT ON COLUMN users.status IS $$pending_activation = invitation/activation en attente ; active ; grace_period = suppression demandée par le profil ; removed = invité retiré, données purgées après X jours$$;
COMMENT ON COLUMN users.initial_setup_step IS $$Étape de la configuration initiale (utilisateur principal) pour reprendre là où il s'est arrêté ; NULL pour invités et admins$$;
COMMENT ON COLUMN users.login_locked_until IS $$Fin du blocage de 15 min après 5 échecs consécutifs de mot de passe (US-3 RF4)$$;
COMMENT ON COLUMN users.purge_scheduled_at IS $$Date de suppression définitive des données du profil : délai de grâce de 30 jours (auto-suppression, durée unique décidée le 01/10/2026) ou X jours après retrait (US-20 RT2, paramètre de la console)$$;
COMMENT ON COLUMN users.digitorn_user_ref IS $$Identifiant de ce profil chez Digitorn, facultatif (inutile pour un agent appelé par API directe, hypothèse H11)$$;
COMMENT ON TABLE activation_links IS $$Liens d'activation valables 30 min, à usage unique (invitation d'un invité, activation d'un utilisateur principal). [US-4, 5, 18, 64]$$;
COMMENT ON COLUMN activation_links.token_hash IS $$Empreinte SHA-256 du jeton envoyé par email/SMS ; le jeton lui-même n'est jamais conservé$$;
COMMENT ON COLUMN activation_links.expires_at IS $$Envoi + 30 minutes. Le statut « Invitation expirée » de l'écran invités se déduit de cette date$$;
COMMENT ON COLUMN activation_links.delivery_status IS $$sending = Envoi en cours ; sent = Invitation envoyée ; failed = Échec d'envoi (US-18 RF7, RF12)$$;
COMMENT ON COLUMN activation_links.sms_requested IS $$true si un numéro était renseigné : l'invitation part aussi par SMS$$;
COMMENT ON TABLE devices IS $$Appareil vérifié d'un profil (type, navigateur) avec son schéma tactile et son verrouillage. [US-6, 7, 8, 51, 53]$$;
COMMENT ON COLUMN devices.id IS $$Identifiant propre à MAAQ, généré à la vérification d'identité et conservé sur l'appareil$$;
COMMENT ON COLUMN devices.timezone IS $$Fuseau horaire IANA de l'appareil (ex. Europe/Paris), mis à jour à chaque connexion ; défaut Europe/Paris$$;
COMMENT ON COLUMN devices.revoked_at IS $$Appareil révoqué : il disparaît de la liste et doit repasser par la vérification d'identité (US-53 RF3)$$;
COMMENT ON COLUMN devices.pattern_hash IS $$Empreinte du schéma 3×3 (min. 4 points). NULL pour l'administrateur (pas de schéma) ou tant que non créé$$;
COMMENT ON COLUMN devices.pattern_failed_count IS $$Échecs consécutifs ; 3 = verrouillage. Remis à 0 après un schéma correct ou une récupération (US-6 RF8)$$;
COMMENT ON COLUMN devices.pattern_locked_at IS $$Non NULL = accès par schéma verrouillé sur cet appareil ; le mot de passe reste utilisable (US-7 RF4)$$;
COMMENT ON TABLE sessions IS $$Sessions ouvertes ; invalidées côté serveur à la déconnexion, révocation, retrait d'invité ou délai de grâce. [US-3, 6, 9, 20, 53]$$;
COMMENT ON COLUMN sessions.token_hash IS $$Empreinte du jeton de session : une session copiée ne vaut plus rien une fois invalidée (US-9 RT1)$$;
COMMENT ON TABLE verification_codes IS $$Codes à 6 chiffres à usage unique (vérification d'appareil, récupération d'accès, boîte de validation). [US-8, 15, 51]$$;
COMMENT ON COLUMN verification_codes.purpose IS $$device_verification (10 min) ; access_recovery (30 min) ; validation_mailbox (vérification de la boîte, US-15) ; password_reset = hypothèse H5 (US-3 renvoie vers un parcours non décrit)$$;
COMMENT ON COLUMN verification_codes.device_identifier IS $$Identifiant d'appareil proposé par le client, devient devices.id après un code correct$$;
COMMENT ON TABLE security_events IS $$Journal des événements de sécurité (verrouillages, changement d'email, appareils vérifiés/révoqués), conservé 3 ans par défaut (durée réglable). [US-7 RT2, 19 RT1, 53 RT2]$$;
COMMENT ON COLUMN security_events.event_type IS $$Type d'événement : verrouillage du schéma ou du mot de passe, récupération, appareil vérifié ou révoqué, changement d'email ou de mot de passe$$;
COMMENT ON COLUMN security_events.actor_user_id IS $$Auteur de l'action quand il diffère du profil concerné (ex. utilisateur principal révoquant l'appareil d'un invité)$$;
COMMENT ON TABLE legal_document_versions IS $$Versions de la politique de confidentialité, des CGU et du texte de consentement au challenge de contrat. [US-36, 54]$$;
COMMENT ON COLUMN legal_document_versions.content IS $$Texte intégral de la version (le nom du partenaire du consentement y figure : à fournir, US-36 RF2)$$;
COMMENT ON COLUMN legal_document_versions.published_at IS $$Date d'entrée en vigueur ; la version courante est la plus récente déjà publiée$$;
COMMENT ON TABLE legal_acceptances IS $$Acceptation par un profil d'une version de la politique ou des CGU (profil, date/heure, version). [US-4, 54, 64]$$;
COMMENT ON TABLE agent_categories IS $$Rubriques du catalogue (Pro, Perso, Agents des Contrats) et leurs règles d'accès. [US-22, 23, 30, 45]$$;
COMMENT ON TABLE agents IS $$Agent IA publié dans le catalogue, avec sa fiche et son état Disponible/Bloqué (blocage géré par MAAQ seul). [US-23, 24, 42, 45, 46, 47]$$;
COMMENT ON COLUMN agents.platform IS $$digitorn = tchat de Digitorn intégré à MAAQ ; anthropic = API Anthropic directe, vertex = Claude sur Vertex AI en UE : tchat de MAAQ, conversations conservées par MAAQ (US-106 RF5, D29, D54)$$;
COMMENT ON COLUMN agents.platform_agent_ref IS $$Identifiant de l'agent chez sa plateforme, choisi parmi ceux hébergés et non encore publiés (US-45 RF2, US-106 RF2)$$;
COMMENT ON COLUMN agents.status IS $$available = utilisable ; blocked = maintenance, MAAQ refuse toute nouvelle demande vers cet agent (US-42 RT1)$$;
COMMENT ON COLUMN agents.cc_addresses_max_count IS $$Nombre maximum d'adresses en copie par profil que cet agent accepte, fixé par l'administrateur à la publication ; 0 = l'agent n'a pas de section « Adresses en copie » (US-16 RF1, RF4)$$;
COMMENT ON COLUMN agents.maintenance_message IS $$Message affiché dans la bannière de blocage, 200 caractères max, obligatoire au blocage$$;
COMMENT ON TABLE agent_sample_prompts IS $$Exemples de demandes (fiche agent, recherche) et suggestions de première demande (tchat vide). [US-24, 25, 41, 45]$$;
COMMENT ON COLUMN agent_sample_prompts.kind IS $$example = exemple affiché sur la fiche et indexé par la recherche ; first_suggestion = bouton de l'état d'accueil du tchat (3 par agent)$$;
COMMENT ON TABLE agent_validated_actions IS $$Types d'actions soumises à validation, déclarés à la mise à disposition de l'agent. [US-24 RF1, 39 RF6, 45]$$;
COMMENT ON TABLE connector_types IS $$Types de connecteurs d'un agent : Google Drive, Google Agenda, boîte de validation. [US-13, 14, 15, 45]$$;
COMMENT ON TABLE agent_requirements IS $$Connecteurs requis par agent et responsable de leur configuration. Base du statut « À configurer ». [US-13, 15, 29, 45]$$;
COMMENT ON COLUMN agent_requirements.owner_scope IS $$primary_user = seule l'utilisateur principal configure pour cet agent (l'invité voit « à configurer par X », US-29 RF3) ; each_profile = chaque profil connecte ses comptes ; account = connexion unique du compte (table account_connections), partagée par les agents qui l'exigent$$;
COMMENT ON TABLE agent_info_fields IS $$Champs d'information propres à un agent (formulaire « Informations nécessaires à [agent] »), définis par l'administrateur à la publication. [US-10, 45]$$;
COMMENT ON COLUMN agent_info_fields.shared_key IS $$Clé commune permettant de proposer une valeur déjà saisie pour un autre agent (même clé, même type de donnée) : voir v_info_prefill_suggestions$$;
COMMENT ON COLUMN agent_info_fields.max_items IS $$1 = valeur unique ; supérieur à 1 = liste de valeurs (ex. contacts) limitée à ce nombre$$;
COMMENT ON TABLE user_agent_info_values IS $$Informations personnelles d'un profil pour un agent (valeurs chiffrées), une ligne par champ et par élément de liste. [US-10, 11, 12]$$;
COMMENT ON COLUMN user_agent_info_values.updated_by_user_id IS $$Profil ayant fait la dernière modification (traçabilité, US-12 RT1)$$;
COMMENT ON TABLE profile_agents IS $$Dashboard : agents ajoutés par chaque profil. Retiré = masqué, configuration et carnet conservés. [US-22, 26, 27, 28, 31]$$;
COMMENT ON COLUMN profile_agents.removed_at IS $$Date de retrait ; NULL = agent visible sur le dashboard/page Contrats. Ne compte plus dans la limite de 10$$;
COMMENT ON TABLE agent_connections IS $$Connecteurs configurés par un profil pour un agent (compte Google Drive/Agenda, boîte de validation) et leur statut. [US-13, 14, 15, 29]$$;
COMMENT ON COLUMN agent_connections.status IS $$pending = autorisation (ou code de vérification) en attente ; connected = utilisable ; refused/partial = consentement Google refusé/incomplet ; reconnect_required = autorisation expirée ou révoquée (US-13 RT3). Absence de ligne = « Non configuré »$$;
COMMENT ON TABLE account_connections IS $$Connexion partagée du compte à un connecteur (Google Drive de l'utilisateur principal pour les contrats), indépendante des agents. [US-32 RF11, 34 RT1, 13]$$;
COMMENT ON COLUMN account_connections.status IS $$Mêmes valeurs que agent_connections.status. Le bandeau « Drive non connecté » des contrats se déduit de status différent de connected$$;
COMMENT ON TABLE cc_addresses IS $$Adresses ajoutées en copie des événements d'agenda demandés par un profil (maximum fixé par agent, agents.cc_addresses_max_count). Les participants automatiques (D2) ne sont pas stockés : ils se déduisent du rang. [US-16, 17]$$;
COMMENT ON COLUMN cc_addresses.user_id IS $$Profil propriétaire : la liste de l'utilisateur principal ne s'applique qu'à SES événements (D5)$$;
COMMENT ON TABLE contract_definitions IS $$Contrats obligatoires proposés dans « Mes contrats » (Assurance Auto, Mutuelle…), communs à tous les clients. [US-32, 48]$$;
COMMENT ON COLUMN contract_definitions.archived_at IS $$Contrat retiré de la liste par l'administrateur ; les données clients restent en base (hypothèse H8)$$;
COMMENT ON TABLE contract_field_definitions IS $$Champs de détail proposés pour chaque contrat (assureur, échéance, cotisation…) avec type et caractère obligatoire. [US-33, 48]$$;
COMMENT ON COLUMN contract_field_definitions.field_type IS $$text, date, amount (montant positif) ou choice (liste de choix, voir contract_field_options)$$;
COMMENT ON TABLE contract_field_options IS $$Valeurs possibles d'un champ de type « liste de choix ». [US-48 RF10]$$;
COMMENT ON TABLE account_contracts IS $$État d'un contrat pour un compte (accessible au noyau seulement) : dernière modification et consentement au challenge. [US-32, 33, 35, 36]$$;
COMMENT ON COLUMN account_contracts.consent_active IS $$État courant du consentement (la preuve est dans contract_consent_events). Remis à false par la suppression complète du contrat (US-35 RF5)$$;
COMMENT ON TABLE contract_field_values IS $$Valeurs saisies pour un contrat d'un compte. Un champ vidé = ligne supprimée. [US-33, 35]$$;
COMMENT ON COLUMN contract_field_values.value_amount IS $$Montant en euros (devise unique supposée, H9), jamais négatif$$;
COMMENT ON TABLE contract_documents IS $$Lien entre un contrat et un document scanné (le fichier vit dans le Drive de l'utilisateur principal). Retirer = supprimer la ligne seulement. [US-34, 35]$$;
COMMENT ON COLUMN contract_documents.scan_status IS $$Analyse antivirus obligatoire avant disponibilité (US-34 RT2)$$;
COMMENT ON COLUMN contract_documents.classification_status IS $$pending = « Classement en cours » ; classified = « Document disponible » ; failed = « Classement impossible » après 3 essais auto (US-34 RF13, RF14)$$;
COMMENT ON TABLE contract_consent_events IS $$Journal append-only des consentements au challenge (qui, quand, quelle version du texte). Conservé 5 ans après la fin d'abonnement, d'où l'absence de FK vers le compte. [US-36 RT1]$$;
COMMENT ON COLUMN contract_consent_events.account_id IS $$Identifiant du compte, SANS FK : référence conservée après suppression du compte (point à valider DPO, H14)$$;
COMMENT ON COLUMN contract_consent_events.actor_email_hash IS $$Empreinte HMAC-SHA256 de l'email du consentant (clé hors base) : preuve nominative après suppression du compte sans conserver l'email$$;
COMMENT ON TABLE logbook_entries IS $$Carnet de bord : demandes et actions des agents pour un compte, en lecture seule, conservées 14 mois par défaut (durée réglable). Table partitionnée par mois. [US-38, 39, 40, 50, 57]$$;
COMMENT ON COLUMN logbook_entries.external_ref IS $$Identifiant Digitorn de l'entrée, garantit l'idempotence de la synchronisation$$;
COMMENT ON COLUMN logbook_entries.requester_user_id IS $$Demandeur ; NULL après suppression définitive de l'invité (affiché « Invité supprimé »)$$;
COMMENT ON COLUMN logbook_entries.anonymization_status IS $$pending = entrées masquées pendant l'anonymisation du texte (US-57 RF7) ; done = nom et données personnelles retirés (irréversible)$$;
COMMENT ON TABLE logbook_entry_participants IS $$Participants d'une demande du noyau : un invité secondaire ne voit que les demandes où il figure (D3). Partitionnée comme le carnet. [US-40 RT5]$$;
COMMENT ON COLUMN logbook_entry_participants.entry_occurred_at IS $$Date de l'entrée du carnet (clé de partition, avec entry_id)$$;
COMMENT ON TABLE logbook_sync_runs IS $$Exécutions de la synchronisation du carnet avec Digitorn ; la dernière réussie alimente « Dernière mise à jour ». [US-40 RF5, RT2, RT4]$$;
COMMENT ON TABLE action_decisions IS $$Décision (validée/refusée/abandonnée) sur une action proposée par un agent, avec état d'exécution ; sert l'idempotence. [US-39]$$;
COMMENT ON COLUMN action_decisions.decision IS $$pending = carte en attente ; abandoned = déconnexion ou expiration de l'historique sans décision (US-39 RF8)$$;
COMMENT ON TABLE error_reports IS $$Registre des signalements de réponses ou actions erronées d'un agent, conservés 14 mois par défaut (durée réglable). [US-61]$$;
COMMENT ON COLUMN error_reports.response_text IS $$Copie de la réponse signalée (peut contenir des données personnelles : à chiffrer, voir plan de sécurité)$$;
COMMENT ON TABLE data_exports IS $$Demandes d'export des données d'un profil (droit d'accès/portabilité), préparées en arrière-plan. [US-55]$$;
COMMENT ON TABLE erasure_traces IS $$Preuve minimale et non nominative d'une suppression définitive de profil ou de membre (date, identifiant technique) + suivi côté Digitorn. [US-20, 56, 57, 58, 93]$$;
COMMENT ON TABLE chat_erasure_requests IS $$File des effacements d'historique de tchat demandés à Digitorn (déconnexion, révocation d'appareil, retrait d'agent), avec réessais. [US-9, 28, 43, 53]$$;
COMMENT ON TABLE daily_request_counters IS $$Nombre de demandes envoyées aux agents par un profil un jour donné, pour appliquer le plafond quotidien du compte. Purgé après quelques jours. [US-38]$$;
COMMENT ON COLUMN daily_request_counters.request_count IS $$Nombre de demandes déjà acceptées ce jour-là ; borné par accounts.daily_request_limit via register_agent_request()$$;
COMMENT ON COLUMN daily_request_counters.request_date IS $$Jour calendaire dans le fuseau de l'appareil au moment de la demande (hypothèse H35)$$;
COMMENT ON TABLE idempotency_keys IS $$Réponses déjà produites pour une clé d'idempotence, conservées 24 h (CC-7). Table technique, purgée par purge_expired_request_records().$$;
COMMENT ON COLUMN idempotency_keys.response_body IS $$Copie de la réponse renvoyée au client, chiffrée par l'application (bytea ; décision du PO du 27/10/2026). Selon l'action, la réponse peut contenir des données personnelles : adresses en copie d'un agent, détail d'un contrat et de ses champs, nom de fichier d'un document. Limite : 24 h, puis suppression ; supprimée aussi avec le profil. Seules les réponses réussies sont enregistrées. NULL pour une réponse sans corps (204)$$;
COMMENT ON TABLE chat_requests IS $$Demandes déjà comptées dans le plafond quotidien : un renvoi (même identifiant) n'est pas recompté. Aucun texte, aucun contenu : un identifiant de demande, l'agent et le jour. Purgée après 24 h. [US-38 RT2, US-70 RF6]$$;
COMMENT ON TABLE platform_settings IS $$Réglages de la plateforme modifiables depuis la console admin (fréquence de synchro, délais, emails, limites). [US-27, 62, 65]$$;
COMMENT ON TABLE platform_setting_changes IS $$Historique des modifications de paramètres : ancien/nouveau, administrateur, date. [US-65 RF4]$$;
COMMENT ON TABLE admin_audit_log IS $$Journal d'administration : actions de l'administrateur sur agents, contrats et comptes. [US-45, 46, 47, 48, 64]$$;
COMMENT ON TABLE event_types IS $$Types de RDV de l'Assistant Famille (six au MVP) ; déterminent les délais de rappel. [US-75, 82, AF-6]$$;
COMMENT ON TABLE agent_conversations IS $$Conversation d'un profil avec un agent dont MAAQ conserve le tchat (agents appelés par API directe : Anthropic, Vertex AI). Les agents Digitorn gardent leur historique chez Digitorn. [US-37, 43, 44, D29]$$;
COMMENT ON TABLE agent_conversation_messages IS $$Messages d'une conversation conservée par MAAQ. Supprimés à la déconnexion, au retrait de l'agent et au bout de 4 jours. [US-38, 43, 44, 71, 72]$$;
COMMENT ON COLUMN agent_conversation_messages.content IS $$Contenu chiffré avec les vrais prénoms (texte, ou transcription d'une dictée : l'enregistrement audio n'est jamais conservé, US-71 RT2)$$;
COMMENT ON COLUMN agent_conversation_messages.delivery_state IS $$État d'envoi du message : sending, sent, failed, waiting_for_connection (US-38 RF2, RF14)$$;
COMMENT ON TABLE conversation_attachments IS $$Image jointe à un message du tchat de l'Assistant Famille (le fichier est dans un stockage chiffré de l'UE). [US-72, 73]$$;
COMMENT ON COLUMN conversation_attachments.storage_key IS $$Chemin de l'objet dans le stockage chiffré ; NULL après suppression. Les suppressions passent par storage_deletion_queue$$;
COMMENT ON TABLE storage_deletion_queue IS $$Fichiers (images, mails bruts) à supprimer du stockage, avec réessais. Évite les fichiers orphelins après une suppression en cascade. [US-56, 58, 72, 87, 93]$$;
COMMENT ON TABLE family_members IS $$Membres de la famille concernés par les RDV (enfants sans compte, parents, invités). Retirer = archiver ; effacer = anonymiser. [US-92, 93]$$;
COMMENT ON COLUMN family_members.user_id IS $$Profil lié, NULL pour un membre sans compte. Coupé à la suppression du profil, ce qui déclenche l'anonymisation du membre$$;
COMMENT ON COLUMN family_members.role IS $$parent (utilisateur principal, invité 1) ; child ; other (invité secondaire par défaut). Un changement de rôle attribue un nouvel alias$$;
COMMENT ON COLUMN family_members.alias_number IS $$Numéro d'alias par compte et par rôle, jamais réutilisé, même après archivage ou anonymisation$$;
COMMENT ON COLUMN family_members.birth_year IS $$Année de naissance, facultative, avec le mois (jamais le jour, D54). Les âges sont transmis au modèle par tranche, calculés sans stockage supplémentaire (D37, family_member_age_months). Donnée d'un mineur : incluse dans l'export (US-92 RT4)$$;
COMMENT ON COLUMN family_members.birth_month IS $$Mois de naissance (1 à 12), facultatif, renseigné avec l'année ; le jour n'existe pas en base (D54)$$;
COMMENT ON COLUMN family_members.anonymized_at IS $$Date d'effacement des données du membre (prénom et naissance vidés) ; il reste affiché « Ancien membre » dans les RDV partagés (US-93 RF13)$$;
COMMENT ON TABLE forwarding_mailboxes IS $$Adresse de transfert de la famille, conservée séparément du compte pour pouvoir être régénérée sans perdre l'historique. [US-85]$$;
COMMENT ON TABLE forwarding_consent_events IS $$Journal append-only des consentements au traitement des mails transférés (auteur, date, version du texte). Survit au compte, comme les consentements aux contrats. [US-85 RF2, RT3]$$;
COMMENT ON TABLE forwarding_authorized_senders IS $$Adresses autorisées à transférer des mails vers l'adresse de la famille (utilisateur principal et invité 1 seulement au MVP, 10 par famille). [US-88]$$;
COMMENT ON COLUMN verification_codes.authorized_sender_id IS $$Adresse autorisée en cours de vérification (usage forwarding_sender, code valable 15 minutes)$$;
COMMENT ON TABLE inbound_emails IS $$Informations de suivi de chaque mail transféré (date, expéditeur, statut). Contenu brut dans le stockage chiffré, supprimé au plus tard 30 jours après réception. [US-85 à US-91]$$;
COMMENT ON COLUMN inbound_emails.status IS $$received ; rejected_unauthorized (jamais de contenu conservé, suivi 30 jours) ; irrelevant ; processed ; known_event (RDV déjà connu) ; no_date_found ; no_matching_event (annulation sans RDV correspondant) ; failed ; verification_mail (mail de vérification d'une messagerie)$$;
COMMENT ON COLUMN inbound_emails.raw_storage_key IS $$Objet chiffré contenant le mail et ses pièces jointes ; NULL après suppression (raw_deleted_at). Supprimé via storage_deletion_queue$$;
COMMENT ON TABLE inbound_email_daily_counters IS $$Nombre de mails transférés traités par famille et par jour, pour appliquer la limite de 50. Purgé après quelques jours. [US-87 RF12]$$;
COMMENT ON TABLE family_events IS $$RDV du foyer (calendrier familial), ressource partagée dont l'agent n'est pas propriétaire. Statuts : provisoire, écarté, confirmé, annulé, ignoré. [US-74 à US-80, 87 à 91, D25, AF-1]$$;
COMMENT ON COLUMN family_events.title IS $$Titre chiffré. NULL pour un RDV médical : le titre générique « RDV médical — [prénom] » est calculé, jamais stocké$$;
COMMENT ON COLUMN family_events.status IS $$provisional = proposé par l'agent (gris) ; set_aside = écarté (reste visible et confirmable jusqu'à la relance suivante) ; confirmed ; cancelled ; dismissed (retiré du calendrier). Transitions : provisional → confirmed/set_aside/dismissed ; set_aside → confirmed/dismissed ; confirmed → cancelled$$;
COMMENT ON COLUMN family_events.version IS $$Incrémentée à chaque modification ; l'application ne met à jour que si la version lue est encore la bonne (US-76 RT1)$$;
COMMENT ON COLUMN family_events.fingerprint IS $$Empreinte du RDV (créneau, type, membres) calculée par l'application ; unique parmi les RDV actifs d'un foyer. Pour une séance de série, l'application y inclut series_id : une séance identique à un RDV déjà saisi devient un conflit signalé, pas une erreur$$;
COMMENT ON COLUMN family_events.confirmed_by_user_id IS $$Profil qui a confirmé le RDV ; vide si la confirmation est automatique (auto_confirmed) ou si le profil a été supprimé$$;
COMMENT ON TABLE family_event_members IS $$Membres concernés par un RDV (un ou plusieurs). « Toute la famille » = indicateur whole_family du RDV, sans ligne ici. [US-76, 92, D27]$$;
COMMENT ON TABLE family_event_history IS $$Historique d'un RDV : statut avant/après, auteur (vide pour le système), date, motif. Alimente le détail du RDV et l'onglet « Famille » du carnet. [US-75, 77, 79, 80, 83]$$;
COMMENT ON TABLE family_event_change_proposals IS $$Proposition d'annulation, de report ou de modification d'un RDV existant (suite à un mail ou à une demande à l'agent), en attente de décision d'un parent. [US-80 RT3, US-90]$$;
COMMENT ON TABLE family_reminder_settings IS $$Délais de rappel par famille et par type de RDV. Seules les modifications sont stockées : l'absence de ligne = les trois rappels actifs. [US-82]$$;
COMMENT ON TABLE scheduled_notifications IS $$Rappels (J-7, J-1, jour J), relances (24 h, 48 h) et notifications de trajet programmés par RDV et destinataire ; rappels de tâches et point de la semaine sans RDV. Supprimés avec le RDV ; sans RDV, 30 jours après l'échéance. [US-79, 81, 83, 97, 98, 107]$$;
COMMENT ON COLUMN scheduled_notifications.status IS $$scheduled ; sent ; not_applicable (échéance déjà passée à la confirmation) ; abandoned (non parti avant le début du RDV) ; cancelled (RDV annulé ou date changée)$$;
COMMENT ON TABLE push_subscriptions IS $$Abonnement aux notifications d'un appareil. Supprimé à la déconnexion, à la révocation de l'appareil (qui n'est que marqué révoqué) et quand il n'est plus valide. [US-9, 53, 81 RT4, 94]$$;
COMMENT ON TABLE erasure_trace_targets IS $$Suppression des données d'une trace chez une plateforme d'agents (Digitorn, Anthropic, Vertex AI), avec réessais. À utiliser si un fournisseur conserve des données sans effacement possible à la demande (P-37). [US-56, 58, 106]$$;
COMMENT ON FUNCTION family_event_transition_allowed(event_status, event_status) IS $$Transitions permises de statut d'un RDV : provisoire → confirmé/écarté/ignoré ; écarté → confirmé/ignoré ; confirmé → annulé. [AF-1, D32]$$;
COMMENT ON FUNCTION change_family_event_status(uuid, event_status, uuid, integer, event_change_reason) IS $$Change le statut d'un RDV de façon atomique (transition permise, version attendue), écrit l'historique, passe les tâches proposées à « à faire » à la confirmation et retire les tâches proposées ou à faire d'un RDV annulé ou ignoré (un RDV écarté garde ses tâches proposées). Auteur NULL et motif no_response = confirmation d'office. false = déjà traité ou modifié. [US-75, 77, 80, 83, 95 RF7, 109, D48, D49]$$;
COMMENT ON FUNCTION confirm_family_events_group(uuid[], uuid) IS $$Confirme plusieurs RDV d'un même mail en une seule transaction : tout ou rien. [US-91]$$;
COMMENT ON FUNCTION find_family_event_conflicts(uuid, uuid[], boolean, timestamptz, timestamptz, uuid) IS $$RDV en conflit avec un créneau donné (même membre ou toute la famille, statuts confirmé et provisoire). [US-74]$$;
COMMENT ON FUNCTION family_events_visible_to(uuid) IS $$RDV visibles par un profil selon son rang (décision D26). [US-78, 79]$$;
COMMENT ON FUNCTION can_manage_family_event(uuid, uuid) IS $$Vrai si le profil peut confirmer, modifier, ignorer ou annuler ce RDV (parents : tous ; invité secondaire : ses demandes). [US-75, 80, D26]$$;
COMMENT ON VIEW v_family_logbook IS $$Entrées de l'onglet « Famille » du carnet : confirmations, abandons, modifications, annulations, propositions traitées, mails reçus. Produite à partir de l'historique des RDV (une ligne par série pour un changement de série ; « RDV ajouté automatiquement » pour une confirmation d'office) et du suivi des mails. [US-40, 75, 77, 80, 87, 89, 90, 109, D49]$$;
COMMENT ON FUNCTION family_logbook_visible_to(uuid) IS $$Onglet « Famille » du carnet visible par un profil selon son rang (décision D26). [US-40]$$;
COMMENT ON FUNCTION register_inbound_email(uuid, date) IS $$Compte un mail transféré et applique la limite quotidienne de la famille ; indique s'il faut alerter l'utilisateur principal. [US-87 RF12]$$;
COMMENT ON FUNCTION delete_orphan_sources(bigint[], uuid[]) IS $$Met en file de suppression les images et mails bruts qui ne sont plus liés à aucun RDV. [US-72 RF8, US-87 RF13, US-93 RT3]$$;
COMMENT ON FUNCTION anonymize_family_member(uuid, boolean) IS $$Efface un membre (anonymisation) et supprime ses RDV exclusifs et leurs fichiers, ses questions d'anticipation ; ses tâches à faire deviennent non assignées ; trace non nominative. [US-57, 93, 96 RF8, D34]$$;
COMMENT ON FUNCTION purge_expired_family_events() IS $$Supprime les RDV annulés ou ignorés (30 jours) et passés (24 mois), avec leurs notifications, historique et tâches liées, puis les séries terminées ou annulées sans séance. À planifier chaque jour. [US-77 RT1, US-80 RT2, US-109, D35]$$;
COMMENT ON FUNCTION purge_expired_attachments() IS $$Supprime les images à l'échéance ou dès que tous les RDV qui en sont issus sont traités. À planifier chaque jour. [US-72 RF8]$$;
COMMENT ON FUNCTION purge_expired_inbound_emails() IS $$Supprime le contenu brut des mails devenu inutile ou échu, puis les informations de suivi après 90 jours (30 pour les non autorisés). À planifier chaque jour. [US-87 RF13, RT4, US-88 RT2]$$;
COMMENT ON FUNCTION purge_expired_conversation_messages() IS $$Supprime les messages conservés depuis plus de 4 jours (images en cascade). À planifier au moins chaque heure. [US-44]$$;
COMMENT ON FUNCTION erase_agent_conversations(uuid, bigint) IS $$Supprime les messages des conversations d'un profil (tous les agents, ou un seul). Pour les agents Digitorn, l'effacement reste demandé à Digitorn (chat_erasure_requests). [US-9, 28, 43, 53]$$;
COMMENT ON FUNCTION purge_old_daily_counters() IS $$Supprime les compteurs journaliers de demandes et de mails de plus de 7 jours. À planifier chaque jour. [US-38, 70, 87]$$;
COMMENT ON FUNCTION purge_expired_request_records() IS $$Supprime les clés d'idempotence et les demandes du tchat de plus de 24 h. À planifier chaque heure. [CC-7, US-38 RT2]$$;
COMMENT ON FUNCTION family_member_age_months(smallint, smallint, date) IS $$Âge d'un membre en mois civils (différence des mois, sans jour) à une date ; NULL si le mois ou l'année de naissance manque. Sert aux conditions d'âge du catalogue (US-102) et aux tranches d'âge transmises au modèle. [US-92, US-102, D54]$$;
COMMENT ON FUNCTION purge_admin_audit_log() IS $$Supprime les entrées du journal d'administration de plus de 5 ans (réglable). À planifier chaque jour. [US-45, US-64]$$;
COMMENT ON FUNCTION backfill_family_members() IS $$Crée la fiche « membre » des profils qui n'en ont pas (invités existants) ; une fiche archivée pour un invité retiré. Idempotent. [US-92 RF1, US-20, US-113 RT6]$$;
COMMENT ON VIEW v_profile_agent_missing_items IS $$Éléments manquants (connecteur ou information) et responsable (profil ou utilisateur principal) par agent du dashboard. [US-29 RT1]$$;
COMMENT ON VIEW v_dashboard_agents IS $$Agents actifs d'un profil avec statut Prêt / À configurer / Bloqué. [US-22, 29, 31, 42]$$;
COMMENT ON VIEW v_info_prefill_suggestions IS $$Valeurs déjà saisies pour un autre agent (même clé commune et même type) proposées pré-remplies pour un champ encore vide. [US-10 RF12]$$;
COMMENT ON VIEW v_never_activated_purge_candidates IS $$Profils jamais activés dont le dernier lien a plus de 30 jours (réglable) : à purger (compte entier pour un utilisateur principal). [US-58, décision N8]$$;
COMMENT ON VIEW v_account_guest_quota IS $$Quota d'invités par compte : invités comptés (en attente, expirés, échec d'envoi, actifs ; pas les invités retirés ni en délai de grâce), places restantes. [US-21]$$;
COMMENT ON VIEW v_guest_display_status IS $$Statut affiché des invités : Envoi en cours, Invitation envoyée, Invitation expirée, Échec d'envoi, Actif. [US-4, 5, 18, 21]$$;
COMMENT ON FUNCTION logbook_visible_entries(uuid) IS $$Entrées du carnet visibles par un profil selon son rang (décision D3). [US-40, 50]$$;
COMMENT ON FUNCTION ensure_logbook_partitions(integer) IS $$Crée les partitions mensuelles du carnet et de ses participants (mois courant + N à venir). À planifier chaque mois. [US-40]$$;
COMMENT ON FUNCTION purge_expired_logbook(interval) IS $$Supprime les entrées du carnet au-delà de la durée de rétention (réglage logbook_retention_months, 14 mois par défaut) : partitions entières puis lignes du mois frontière. À planifier chaque jour. [US-40 RF6, RT6]$$;
COMMENT ON FUNCTION register_agent_request(uuid, date) IS $$Compte une demande d'un profil et applique le plafond quotidien du compte : true = acceptée, false = plafond atteint. [US-38]$$;
COMMENT ON FUNCTION purge_expired_error_reports() IS $$Supprime les signalements plus anciens que error_report_retention_months (14 mois par défaut). À planifier chaque jour. [US-61 RT2]$$;
COMMENT ON FUNCTION purge_expired_security_events() IS $$Supprime les événements de sécurité plus anciens que security_event_retention_months (36 mois par défaut). À planifier chaque mois. [US-7, 19, 53]$$;

-- ---------------------------------------------------------------------
-- Initialisation
-- ---------------------------------------------------------------------
-- Partitions initiales du carnet : mois courant + 3 mois à venir
SELECT ensure_logbook_partitions(3);
