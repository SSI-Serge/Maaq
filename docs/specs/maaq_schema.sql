-- =====================================================================
-- MAAQ — Schéma de base de données (PostgreSQL 15+)
-- Source : MAAQ_US_Detaillees_BA.md (US-1 à US-65, décisions D1–D11)
-- Généré le 2026-10-01 — voir MAAQ_BDD_Conception.md pour le guide de relecture
--
-- CONVENTIONS
--  * Identifiants en anglais (snake_case, tables au pluriel), commentaires en français.
--  * Clés primaires : UUID pour ce qui est exposé ou sensible (comptes, profils, appareils,
--    sessions, exports : non énumérables) ; bigint identity pour tout le reste (plus compact).
--  * Dates en timestamptz (UTC en base, conversion à l'affichage). Montants en numeric.
--  * Chaque clé étrangère a un ON DELETE explicite. ON UPDATE n'est pas précisé : les clés
--    primaires ne sont jamais modifiées (comportement par défaut NO ACTION = refus).
--  * Toute clé étrangère est indexée (index nommés idx_<table>_<colonne>).
--  * Les statuts sont des types ENUM : ajout d'une valeur = ALTER TYPE ... ADD VALUE.
--  * Chiffrement : les informations personnelles saisies pour les agents sont chiffrées par
--    l'application AVANT insertion (colonne bytea). Le reste repose sur le chiffrement du
--    disque / de la base du prestataire UE.
--
-- Ordre d'exécution : extensions → types → comptes/profils → sécurité → catalogue →
-- configuration → contrats → carnet → conformité → paramètres → fonctions/vues/triggers.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;   -- emails insensibles à la casse (unicité normalisée)

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
-- TYPES ÉNUMÉRÉS
-- ---------------------------------------------------------------------
CREATE TYPE user_role              AS ENUM ('admin', 'primary_user', 'guest');
CREATE TYPE guest_rank             AS ENUM ('core', 'secondary');          -- core = « invité 1 » (D1)
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
CREATE TYPE legal_document_type    AS ENUM ('privacy_policy', 'terms_of_use', 'contract_challenge_consent', 'forwarded_mail_consent', 'contract_analysis_consent', 'grocery_price_sharing_consent');
CREATE TYPE agent_status           AS ENUM ('available', 'blocked', 'retired');
CREATE TYPE prompt_kind            AS ENUM ('example', 'first_suggestion');
CREATE TYPE requirement_owner      AS ENUM ('primary_user', 'each_profile', 'account');
CREATE TYPE connection_status      AS ENUM ('pending', 'connected', 'refused', 'partial', 'reconnect_required');
CREATE TYPE info_data_type         AS ENUM ('text', 'phone', 'postal_code', 'past_date', 'email');
CREATE TYPE contract_field_type    AS ENUM ('text', 'date', 'amount', 'choice');
CREATE TYPE scan_status            AS ENUM ('pending', 'clean', 'infected');
CREATE TYPE classification_status  AS ENUM ('pending', 'classified', 'failed');
CREATE TYPE consent_action         AS ENUM ('granted', 'withdrawn');
CREATE TYPE consent_trigger        AS ENUM ('user_action', 'contract_details_deleted', 'contract_deleted');
CREATE TYPE logbook_entry_type     AS ENUM ('request', 'action_done', 'action_validated', 'action_refused');
CREATE TYPE anonymization_status   AS ENUM ('none', 'pending', 'done');
CREATE TYPE decision_kind          AS ENUM ('pending', 'validated', 'refused', 'abandoned');
CREATE TYPE execution_status       AS ENUM ('not_started', 'running', 'succeeded', 'failed');
CREATE TYPE report_category        AS ENUM ('incorrect_response', 'wrong_action', 'other');
CREATE TYPE export_status          AS ENUM ('requested', 'preparing', 'ready', 'failed', 'expired');
CREATE TYPE sync_status            AS ENUM ('running', 'succeeded', 'failed');
CREATE TYPE erasure_status         AS ENUM ('pending', 'done', 'failed');
CREATE TYPE chat_erasure_reason    AS ENUM ('logout', 'device_revoked', 'agent_removed');
CREATE TYPE setting_value_type     AS ENUM ('integer', 'email', 'timestamp', 'free_text');
CREATE TYPE audit_action           AS ENUM ('account_created', 'account_updated', 'activation_link_resent', 'agent_published', 'agent_blocked',
                                            'agent_reactivated', 'contract_created', 'contract_updated', 'contract_archived',
                                            'contract_field_changed', 'device_revoked_by_admin', 'catalog_loaded', 'contract_document_field_changed', 'contract_analysis_decided',
                                            'contract_review_viewed', 'presentation_updated', 'agent_retired', 'agent_restored',
                                            'meal_catalog_changed', 'meal_planning_changed', 'grocery_catalog_changed', 'grocery_price_moderated');

-- Assistant Famille (RDV & tâches)
CREATE TYPE agent_platform         AS ENUM ('digitorn', 'anthropic', 'vertex');
CREATE TYPE member_role            AS ENUM ('parent', 'child', 'other');
CREATE TYPE event_status           AS ENUM ('provisional', 'set_aside', 'confirmed', 'cancelled', 'dismissed');
CREATE TYPE event_source           AS ENUM ('chat_text', 'voice', 'photo', 'android_share', 'forwarded_email', 'whatsapp', 'calendar_sync', 'outing');
CREATE TYPE event_action           AS ENUM ('created', 'modified', 'confirmed', 'set_aside', 'dismissed', 'cancelled', 'completed_by_email');
CREATE TYPE event_change_reason    AS ENUM ('user_request', 'no_response', 'event_started', 'completed_by_email', 'cancellation_mail', 'report_mail');
CREATE TYPE proposal_kind          AS ENUM ('cancellation', 'reschedule', 'modification');
CREATE TYPE proposal_status        AS ENUM ('pending', 'accepted', 'declined', 'expired');
CREATE TYPE notification_kind      AS ENUM ('reminder_d7', 'reminder_d1', 'reminder_day_of', 'follow_up_24h', 'follow_up_48h',
                                            'task_daily', 'task_due_1h', 'task_assigned', 'weekly_digest', 'travel_first', 'travel_second',
                                            'auto_confirmed', 'place_search_ready', 'event_added', 'event_to_confirm', 'outing_proposal', 'wish_added');
CREATE TYPE notification_status    AS ENUM ('scheduled', 'sent', 'not_applicable', 'abandoned', 'cancelled');
CREATE TYPE inbound_status         AS ENUM ('received', 'rejected_unauthorized', 'irrelevant', 'processed', 'known_event',
                                            'no_date_found', 'no_matching_event', 'failed', 'verification_mail');
CREATE TYPE mail_classification    AS ENUM ('appointment', 'deadline', 'cancellation', 'report', 'irrelevant');
CREATE TYPE message_sender         AS ENUM ('profile', 'agent');
CREATE TYPE message_kind           AS ENUM ('text', 'voice_transcript', 'image', 'event_proposal', 'place_suggestion', 'place_results');
CREATE TYPE message_delivery_state AS ENUM ('sending', 'sent', 'failed', 'waiting_for_connection');
CREATE TYPE erasure_subject        AS ENUM ('profile', 'family_member');

-- MVP2 « Calendrier intelligent » : séries, tâches, anticipation, point hebdomadaire, trajets
CREATE TYPE series_repeat_unit    AS ENUM ('day', 'week', 'month', 'yearly');
CREATE TYPE series_month_mode     AS ENUM ('day_of_month', 'nth_weekday');
CREATE TYPE series_end_kind       AS ENUM ('date', 'count', 'never');
CREATE TYPE change_scope          AS ENUM ('this', 'following', 'all');
CREATE TYPE task_status           AS ENUM ('proposed', 'todo', 'done', 'cancelled');
CREATE TYPE task_cancel_reason    AS ENUM ('user', 'event_cancelled', 'series_ended', 'expired');
CREATE TYPE task_source           AS ENUM ('user', 'agent', 'anticipation', 'homework', 'homework_prep');
CREATE TYPE question_origin       AS ENUM ('catalog', 'history');
CREATE TYPE question_status       AS ENUM ('pending', 'snoozed', 'settled', 'task_created', 'dismissed', 'expired');
CREATE TYPE question_answer       AS ENUM ('done_or_planned', 'todo', 'remind_later');
CREATE TYPE digest_summary_status AS ENUM ('pending', 'generated', 'failed');
CREATE TYPE travel_origin         AS ENUM ('previous_event', 'last_position', 'live_screen', 'none');
CREATE TYPE travel_status         AS ENUM ('pending', 'first_done', 'second_done', 'skipped', 'failed');
CREATE TYPE location_consent_cause AS ENUM ('user_action', 'device_revoked', 'device_deleted');
CREATE TYPE place_search_origin   AS ENUM ('button', 'chat', 'suggestion');
CREATE TYPE place_search_status   AS ENUM ('queued', 'running', 'done', 'no_result', 'failed', 'obsolete');
CREATE TYPE place_suggestion_answer AS ENUM ('pending', 'accepted', 'declined');
CREATE TYPE notification_channel  AS ENUM ('push', 'none');

-- Sous-agents Sorties et Devoirs (lot 10, US-114 à US-121)
CREATE TYPE outing_category       AS ENUM ('self', 'couple', 'kids', 'teens');
CREATE TYPE outing_mood           AS ENUM ('calm', 'playful', 'both');
CREATE TYPE outing_frequency      AS ENUM ('monthly', 'twice_monthly', 'weekly');
CREATE TYPE outing_day_pref       AS ENUM ('weekend', 'weekday_evenings', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');
CREATE TYPE outing_proposal_status AS ENUM ('ready', 'dismissed', 'added');
CREATE TYPE outing_idea_section   AS ENUM ('in_budget', 'novelty');
CREATE TYPE outing_idea_status    AS ENUM ('proposed', 'dismissed', 'added');
CREATE TYPE homework_level        AS ENUM ('cp', 'ce1', 'ce2', 'cm1', 'cm2');
CREATE TYPE homework_activity_category AS ENUM ('nature', 'philosophy', 'stem', 'art', 'imagination', 'games_projects');

-- Contrats V2 (lot 11, US-122 à US-138)
CREATE TYPE contract_channel      AS ENUM ('analysis', 'challenge');
CREATE TYPE contract_document_kind AS ENUM ('pdf', 'photos');
CREATE TYPE contract_masking_status AS ENUM ('pending', 'masking', 'to_verify', 'verified', 'uncertain', 'unreadable');
CREATE TYPE contract_mask_type    AS ENUM ('person', 'address', 'email', 'phone', 'contract_number', 'bank_account', 'vehicle', 'social_security',
                                           'employer', 'account_identifier', 'manual', 'other');
CREATE TYPE contract_analysis_status AS ENUM ('running', 'awaiting_admin', 'completed', 'failed', 'cancelled');
CREATE TYPE contract_review_decision AS ENUM ('continue', 'stop');

-- Courses et repas (lot 14, US-152 à US-175)
CREATE TYPE meal_tag_kind         AS ENUM ('diet', 'meat', 'allergen');
CREATE TYPE meal_entry_kind       AS ENUM ('pleasure', 'dinner', 'express');
CREATE TYPE grocery_item_state    AS ENUM ('preparing', 'validated', 'added_after_validation', 'bought');
CREATE TYPE grocery_unreferenced_kind   AS ENUM ('unknown', 'no_reference');
CREATE TYPE grocery_unreferenced_source AS ENUM ('list', 'menu', 'ticket');
CREATE TYPE grocery_unreferenced_state  AS ENUM ('to_reference', 'referenced', 'rejected');
CREATE TYPE grocery_reference_status    AS ENUM ('compliant', 'to_check', 'none_found', 'not_applicable');

-- =====================================================================
-- 1. COMPTES ET PROFILS
-- =====================================================================

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
  -- Rappel « suppression dans 7 jours » : un seul par délai de grâce (US-58 RF3) ; remis à vide par trigger quand le compte est repris
  grace_reminder_sent_at timestamptz,
  -- Fin d'abonnement : point de départ des 5 ans de conservation des preuves de consentement
  subscription_ended_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Les 3 colonnes de délai de grâce sont toutes renseignées ou toutes vides
  CONSTRAINT ck_accounts_grace_consistent CHECK (
    (status = 'grace_period') = (grace_origin IS NOT NULL AND grace_started_at IS NOT NULL AND purge_scheduled_at IS NOT NULL)
  ),
  -- Le rappel de suppression n'existe que pendant un délai de grâce
  CONSTRAINT ck_accounts_grace_reminder CHECK (grace_reminder_sent_at IS NULL OR status = 'grace_period')
);
CREATE INDEX idx_accounts_purge_scheduled_at ON accounts (purge_scheduled_at) WHERE purge_scheduled_at IS NOT NULL;
COMMENT ON TABLE accounts IS $$Compte MAAQ (abonnement) : un utilisateur principal + ses invités. Frontière d'isolation des données. [US-18, 21, 56, 58, 59, 64]$$;
COMMENT ON COLUMN accounts.status IS $$activation_pending = créé par l'admin, lien d'activation non utilisé ; grace_period = accès suspendu en attente de suppression$$;
COMMENT ON COLUMN accounts.guest_quota IS $$Nombre maximum d'invités du plan. Une réduction du plan n'expulse personne (US-21 RF6) : seuls les ajouts sont bloqués$$;
COMMENT ON COLUMN accounts.daily_request_limit IS $$Nombre maximum de demandes aux agents par jour et par profil du compte (50 par défaut), fixé selon le plan et réglable par l'administrateur ; voir register_agent_request()$$;
COMMENT ON COLUMN accounts.family_timezone IS $$Fuseau IANA de la famille (appareil de l'utilisateur principal à sa dernière connexion), utilisé pour les heures des RDV, rappels et relances$$;
COMMENT ON COLUMN accounts.grace_origin IS $$in_app_request = bouton Désabonnement (annulable immédiatement) ; billing_unsubscribe = outil de facturation (reprise = nouvel abonnement hors app) — US-59 RF2/RF3$$;
COMMENT ON COLUMN accounts.purge_scheduled_at IS $$Date de suppression définitive (début du délai de grâce + 30 jours). Lue par le traitement quotidien (US-56 RT2)$$;
COMMENT ON COLUMN accounts.grace_reminder_sent_at IS $$Date d'envoi du rappel « suppression dans 7 jours » : un seul rappel par délai de grâce (US-58 RF3). Remis à vide par trigger quand le compte est repris ; ne peut être renseignée que pendant un délai de grâce$$;
COMMENT ON COLUMN accounts.subscription_ended_at IS $$Date de fin d'abonnement ; sert à calculer la fin de conservation du journal des consentements (5 ans, US-36 RT1)$$;

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
  -- Écran « Découvrir MAAQ » (vidéo de présentation) vu ou passé : une seule date par profil, aucune autre statistique de lecture (US-140 RF4, RT3)
  presentation_seen_at    timestamptz,
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
-- Un email = un seul compte actif (US-18 RF3). Un invité retiré libère son email (hypothèse H7).
CREATE UNIQUE INDEX ux_users_email_not_removed ON users (email) WHERE status <> 'removed';
-- Un seul utilisateur principal par compte
CREATE UNIQUE INDEX ux_users_one_primary_per_account ON users (account_id) WHERE role = 'primary_user';
-- Un seul invité 1 par compte tant qu'il n'est pas retiré (D6 : pas de promotion automatique)
CREATE UNIQUE INDEX ux_users_one_core_guest_per_account ON users (account_id) WHERE guest_rank = 'core' AND status <> 'removed';
CREATE INDEX idx_users_account_id ON users (account_id, role);
CREATE INDEX idx_users_purge_scheduled_at ON users (purge_scheduled_at) WHERE purge_scheduled_at IS NOT NULL;
COMMENT ON TABLE users IS $$Profil connectable : administrateur, utilisateur principal ou invité (3 rôles, un seul modèle). [US-3, 4, 10, 11, 18, 19, 20, 64]$$;
COMMENT ON COLUMN users.account_id IS $$Compte d'appartenance ; NULL pour les administrateurs (hors compte client)$$;
COMMENT ON COLUMN users.guest_rank IS $$core = invité 1 (premier invité ajouté, ou désigné par l'utilisateur principal) ; secondary = invités 2 à n (D1, D6)$$;
COMMENT ON COLUMN users.email IS $$Email de connexion, unique et insensible à la casse. Pour un invité actif, sa modification change aussi l'email de connexion (US-19 RF4)$$;
COMMENT ON COLUMN users.phone IS $$Téléphone mobile pour SMS (invitation, code de vérification). Distinct du téléphone saisi pour les agents (US-19 RF5)$$;
COMMENT ON COLUMN users.status IS $$pending_activation = invitation/activation en attente ; active ; grace_period = suppression demandée par le profil ; removed = invité retiré, données purgées après X jours$$;
COMMENT ON COLUMN users.initial_setup_step IS $$Étape de la configuration initiale (utilisateur principal) pour reprendre là où il s'est arrêté ; NULL pour invités et admins$$;
COMMENT ON COLUMN users.presentation_seen_at IS $$Date à laquelle le profil a vu ou passé l'écran « Découvrir MAAQ » (vidéo de présentation) : l'écran n'est plus proposé ensuite ; vide tant qu'il n'a pas été vu. Seule donnée de lecture conservée (aucune durée, aucun compteur). Entre dans l'export des données du profil et disparaît avec lui. [US-140 RF4, RT3]$$;
COMMENT ON COLUMN users.login_locked_until IS $$Fin du blocage de 15 min après 5 échecs consécutifs de mot de passe (US-3 RF4)$$;
COMMENT ON COLUMN users.purge_scheduled_at IS $$Date de suppression définitive des données du profil : délai de grâce de 30 jours (auto-suppression, durée unique décidée le 01/10/2026) ou X jours après retrait (US-20 RT2, paramètre de la console)$$;
COMMENT ON COLUMN users.digitorn_user_ref IS $$Identifiant de ce profil chez Digitorn, facultatif (inutile pour un agent appelé par API directe, hypothèse H11)$$;

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
-- Un seul lien valide à la fois par profil (US-5 RT1) ; le renvoi révoque l'ancien dans la même transaction
CREATE UNIQUE INDEX ux_activation_links_one_valid ON activation_links (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
-- Limite de 3 renvois par heure (US-5 RT2) : comptage des envois récents d'un profil
CREATE INDEX idx_activation_links_user_id ON activation_links (user_id, created_at DESC);
CREATE INDEX idx_activation_links_created_by_user_id ON activation_links (created_by_user_id);
COMMENT ON TABLE activation_links IS $$Liens d'activation valables 30 min, à usage unique (invitation d'un invité, activation d'un utilisateur principal). [US-4, 5, 18, 64]$$;
COMMENT ON COLUMN activation_links.token_hash IS $$Empreinte SHA-256 du jeton envoyé par email/SMS ; le jeton lui-même n'est jamais conservé$$;
COMMENT ON COLUMN activation_links.expires_at IS $$Envoi + 30 minutes. Le statut « Invitation expirée » de l'écran invités se déduit de cette date$$;
COMMENT ON COLUMN activation_links.delivery_status IS $$sending = Envoi en cours ; sent = Invitation envoyée ; failed = Échec d'envoi (US-18 RF7, RF12)$$;
COMMENT ON COLUMN activation_links.sms_requested IS $$true si un numéro était renseigné : l'invitation part aussi par SMS$$;

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
CREATE INDEX idx_devices_user_id ON devices (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_devices_revoked_by_user_id ON devices (revoked_by_user_id);
COMMENT ON TABLE devices IS $$Appareil vérifié d'un profil (type, navigateur) avec son schéma tactile et son verrouillage. [US-6, 7, 8, 51, 53]$$;
COMMENT ON COLUMN devices.id IS $$Identifiant propre à MAAQ, généré à la vérification d'identité et conservé sur l'appareil$$;
COMMENT ON COLUMN devices.timezone IS $$Fuseau horaire IANA de l'appareil (ex. Europe/Paris), mis à jour à chaque connexion ; défaut Europe/Paris$$;
COMMENT ON COLUMN devices.revoked_at IS $$Appareil révoqué : il disparaît de la liste et doit repasser par la vérification d'identité (US-53 RF3)$$;
COMMENT ON COLUMN devices.pattern_hash IS $$Empreinte du schéma 3×3 (min. 4 points). NULL pour l'administrateur (pas de schéma) ou tant que non créé$$;
COMMENT ON COLUMN devices.pattern_failed_count IS $$Échecs consécutifs ; 3 = verrouillage. Remis à 0 après un schéma correct ou une récupération (US-6 RF8)$$;
COMMENT ON COLUMN devices.pattern_locked_at IS $$Non NULL = accès par schéma verrouillé sur cet appareil ; le mot de passe reste utilisable (US-7 RF4)$$;

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
CREATE INDEX idx_sessions_user_id ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_device_id ON sessions (device_id);
COMMENT ON TABLE sessions IS $$Sessions ouvertes ; invalidées côté serveur à la déconnexion, révocation, retrait d'invité ou délai de grâce. [US-3, 6, 9, 20, 53]$$;
COMMENT ON COLUMN sessions.token_hash IS $$Empreinte du jeton de session : une session copiée ne vaut plus rien une fois invalidée (US-9 RT1)$$;

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
-- Délais de renvoi (60 s) et plafonds horaires (5 / h) : lecture des derniers envois d'un profil
CREATE INDEX idx_verification_codes_user_id ON verification_codes (user_id, purpose, created_at DESC);
CREATE INDEX idx_verification_codes_agent_connection_id ON verification_codes (agent_connection_id) WHERE agent_connection_id IS NOT NULL;
COMMENT ON TABLE verification_codes IS $$Codes à 6 chiffres à usage unique (vérification d'appareil, récupération d'accès, boîte de validation). [US-8, 15, 51]$$;
COMMENT ON COLUMN verification_codes.purpose IS $$device_verification (10 min) ; access_recovery (30 min) ; validation_mailbox (vérification de la boîte, US-15) ; password_reset = hypothèse H5 (US-3 renvoie vers un parcours non décrit)$$;
COMMENT ON COLUMN verification_codes.device_identifier IS $$Identifiant d'appareil proposé par le client, devient devices.id après un code correct$$;

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
CREATE INDEX idx_security_events_user_id ON security_events (user_id, occurred_at DESC);
CREATE INDEX idx_security_events_actor_user_id ON security_events (actor_user_id);
CREATE INDEX idx_security_events_device_id ON security_events (device_id);
CREATE INDEX idx_security_events_type ON security_events (event_type, occurred_at DESC);
COMMENT ON TABLE security_events IS $$Journal des événements de sécurité (verrouillages, changement d'email, appareils vérifiés/révoqués), conservé 3 ans par défaut (durée réglable). [US-7 RT2, 19 RT1, 53 RT2]$$;
COMMENT ON COLUMN security_events.event_type IS $$Type d'événement : verrouillage du schéma ou du mot de passe, récupération, appareil vérifié ou révoqué, changement d'email ou de mot de passe$$;
COMMENT ON COLUMN security_events.actor_user_id IS $$Auteur de l'action quand il diffère du profil concerné (ex. utilisateur principal révoquant l'appareil d'un invité)$$;

-- =====================================================================
-- 2. CONFORMITÉ : TEXTES JURIDIQUES ET ACCEPTATIONS
-- =====================================================================

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
CREATE INDEX idx_legal_document_versions_current ON legal_document_versions (document_type, published_at DESC);
COMMENT ON TABLE legal_document_versions IS $$Versions de la politique de confidentialité, des CGU et du texte de consentement au challenge de contrat. [US-36, 54]$$;
COMMENT ON COLUMN legal_document_versions.content IS $$Texte intégral de la version (le nom du partenaire du consentement y figure : à fournir, US-36 RF2)$$;
COMMENT ON COLUMN legal_document_versions.published_at IS $$Date d'entrée en vigueur ; la version courante est la plus récente déjà publiée$$;
-- Texte de consentement au challenge d'un contrat, version 1.0 (US-36 RF2, RT1) : le nom du partenaire n'est pas encore connu
INSERT INTO legal_document_versions (document_type, version_label, content, published_at) VALUES
  ('contract_challenge_consent', '1.0', 'L''entreprise [nom du partenaire], partenaire de MAAQ, pourra utiliser les informations de votre contrat pour le challenger.', now());

CREATE TABLE legal_acceptances (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- RESTRICT : une version acceptée ne peut pas être supprimée (preuve)
  version_id   bigint NOT NULL REFERENCES legal_document_versions (id) ON DELETE RESTRICT,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, version_id)
);
CREATE INDEX idx_legal_acceptances_version_id ON legal_acceptances (version_id);
COMMENT ON TABLE legal_acceptances IS $$Acceptation par un profil d'une version de la politique ou des CGU (profil, date/heure, version). [US-4, 54, 64]$$;

-- =====================================================================
-- 3. CATALOGUE D'AGENTS (administration)
-- =====================================================================

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
COMMENT ON TABLE agent_categories IS $$Rubriques du catalogue (Pro, Perso, Agents des Contrats) et leurs règles d'accès. [US-22, 23, 30, 45]$$;
INSERT INTO agent_categories (code, label, sort_order, is_core_only, shown_on_dashboard) VALUES
  ('pro', 'Pro', 1, false, true),
  ('perso', 'Perso', 2, false, true),
  ('contracts', 'Agents des Contrats', 3, true, false);

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
  -- Retiré du catalogue (réversible, CR-34) : date et administrateur ; la contrainte ck_agents_retired est posée avec le lot 14
  retired_at              timestamptz,
  retired_by_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Présent dans le catalogue (rubriques Pro et Perso) : faux pour un agent à tuile fixe comme l'Assistant Famille (lot 14, décision du PO du 07/11/2026) ; la plateforme ne sert plus de critère de liste
  listed_in_catalog       boolean NOT NULL DEFAULT true,
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
CREATE INDEX idx_agents_category_id ON agents (category_id, name);
CREATE INDEX idx_agents_blocked_by_user_id ON agents (blocked_by_user_id);
CREATE INDEX idx_agents_retired_by_user_id ON agents (retired_by_user_id);
CREATE INDEX idx_agents_published_by_user_id ON agents (published_by_user_id);
COMMENT ON TABLE agents IS $$Agent IA publié dans le catalogue, avec sa fiche et son état Disponible/Bloqué (blocage géré par MAAQ seul). [US-23, 24, 42, 45, 46, 47]$$;
COMMENT ON COLUMN agents.platform IS $$digitorn = tchat de Digitorn intégré à MAAQ ; anthropic = API Anthropic directe, vertex = Claude sur Vertex AI en UE : tchat de MAAQ, conversations conservées par MAAQ (US-106 RF5, D29, D54)$$;
COMMENT ON COLUMN agents.platform_agent_ref IS $$Identifiant de l'agent chez sa plateforme, choisi parmi ceux hébergés et non encore publiés (US-45 RF2, US-106 RF2)$$;
COMMENT ON COLUMN agents.status IS $$available = utilisable ; blocked = maintenance, MAAQ refuse toute nouvelle demande vers cet agent (US-42 RT1) ; retired = retiré du catalogue et des tableaux de bord, réversible (CR-34)$$;
COMMENT ON COLUMN agents.listed_in_catalog IS $$Vrai = l'agent est proposé dans le catalogue (rubriques Pro et Perso) ; faux = agent à tuile fixe, jamais listé (Assistant Famille). Remplace le filtre sur la plateforme, qui ne distingue pas un agent natif à tuile fixe d'un agent natif du catalogue (Courses et repas). Vrai par défaut. [US-22, 23, 106, décision du PO du 07/11/2026]$$;
COMMENT ON COLUMN agents.retired_at IS $$Date du retrait de l'agent du catalogue ; renseignée si et seulement si le statut est « retired ». Un agent retiré est invisible du catalogue et des tableaux de bord, et se rétablit sans perte. [CR-34]$$;
COMMENT ON COLUMN agents.cc_addresses_max_count IS $$Nombre maximum d'adresses en copie par profil que cet agent accepte, fixé par l'administrateur à la publication ; 0 = l'agent n'a pas de section « Adresses en copie » (US-16 RF1, RF4)$$;
COMMENT ON COLUMN agents.maintenance_message IS $$Message affiché dans la bannière de blocage, 200 caractères max, obligatoire au blocage$$;

-- Projet Digitorn d'un agent de plateforme « digitorn » (reprise de l'application, décision du PO du 27/10/2026). Table dédiée plutôt que
-- des colonnes de agents : la clé secrète ne concerne qu'une plateforme, et agents est lue partout (catalogue, tableau de bord, vues) ;
-- un secret isolé ne sort jamais par un SELECT * ni par une vue. Un agent sans ligne ici (démonstration, simulateur) garde le tchat de MAAQ.
CREATE TABLE agent_digitorn_projects (
  agent_id           bigint PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
  -- NULL pour un agent « visiteur » : seule l'adresse de l'application publiée est connue. Chiffrée par l'application.
  api_key_encrypted  bytea,
  app_url            text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_agent_digitorn_projects_content CHECK (api_key_encrypted IS NOT NULL OR app_url IS NOT NULL),
  CONSTRAINT ck_agent_digitorn_projects_app_url CHECK (app_url IS NULL OR app_url ~ '^https://[^\s]+$')
);
COMMENT ON TABLE agent_digitorn_projects IS $$Clé secrète (sk_…) du projet Digitorn de l'agent, chiffrée avec la clé de l'application (jamais affichée ni journalisée), et domaine personnalisé facultatif de l'application publiée. Aucune donnée personnelle. [US-45, 106]$$;
COMMENT ON COLUMN agent_digitorn_projects.api_key_encrypted IS $$Clé secrète du projet, chiffrée par l'application ; jamais en clair en base, jamais renvoyée au navigateur$$;

-- Assistant Famille : agent appelé par API directe (plateforme « anthropic »). Les conversations du tchat de MAAQ (agent_conversations) et les RDV
-- créés par l'assistant s'y rattachent, donc la ligne est une donnée de référence du socle. Elle n'apparaît dans le catalogue d'aucun profil tant
-- qu'elle n'est pas ajoutée à un profil (US-106).
INSERT INTO agents (platform, platform_agent_ref, name, category_id, short_description, full_description, status) VALUES
  ('anthropic', 'assistant-famille', 'Assistant Famille — RDV & tâches', (SELECT id FROM agent_categories WHERE code = 'perso'),
   'Rendez-vous et tâches de la famille, par écrit ou à la voix.',
   'Assistant du calendrier familial : crée des rendez-vous provisoires à confirmer, propose des créneaux et rappelle les échéances.', 'available');

-- Exemples de demandes (fiche + recherche) et suggestions de première demande (état d'accueil du tchat).
CREATE TABLE agent_sample_prompts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id    bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  kind        prompt_kind NOT NULL,
  content     varchar(500) NOT NULL,
  sort_order smallint NOT NULL DEFAULT 1,
  UNIQUE (agent_id, kind, sort_order)
);
COMMENT ON TABLE agent_sample_prompts IS $$Exemples de demandes (fiche agent, recherche) et suggestions de première demande (tchat vide). [US-24, 25, 41, 45]$$;
COMMENT ON COLUMN agent_sample_prompts.kind IS $$example = exemple affiché sur la fiche et indexé par la recherche ; first_suggestion = bouton de l'état d'accueil du tchat (3 par agent)$$;

-- Actions de l'agent qui exigent une validation avant exécution (affichées sur la fiche).
CREATE TABLE agent_validated_actions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id    bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  label       varchar(150) NOT NULL,
  sort_order smallint NOT NULL DEFAULT 1,
  UNIQUE (agent_id, label)
);
COMMENT ON TABLE agent_validated_actions IS $$Types d'actions soumises à validation, déclarés à la mise à disposition de l'agent. [US-24 RF1, 39 RF6, 45]$$;

-- Types de connecteurs : table pour pouvoir en ajouter (Outlook, etc.) sans migration de structure.
CREATE TABLE connector_types (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$'),
  label           varchar(80) NOT NULL,
  -- true = autorisation via la page de consentement Google (US-14) ; false = vérification par code (boîte de validation)
  requires_oauth  boolean NOT NULL
);
COMMENT ON TABLE connector_types IS $$Types de connecteurs d'un agent : Google Drive, Google Agenda, boîte de validation. [US-13, 14, 15, 45]$$;
INSERT INTO connector_types (code, label, requires_oauth) VALUES
  ('google_drive', 'Google Drive', true),
  ('google_calendar', 'Google Agenda', true),
  ('validation_mailbox', 'Boîte mail de validation', false);

-- Connecteurs requis par un agent et responsable de leur configuration (US-29 RT1, US-45 RF10).
CREATE TABLE agent_requirements (
  agent_id           bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  connector_type_id  integer NOT NULL REFERENCES connector_types (id) ON DELETE RESTRICT,
  -- primary_user : configuré par l'utilisateur principal pour cet agent ; each_profile : chaque profil le sien ;
  -- account : connexion unique du compte, indépendante des agents (ex. Drive des contrats, décision du 01/10/2026, P3)
  owner_scope        requirement_owner NOT NULL DEFAULT 'each_profile',
  PRIMARY KEY (agent_id, connector_type_id)
);
CREATE INDEX idx_agent_requirements_connector_type_id ON agent_requirements (connector_type_id);
COMMENT ON TABLE agent_requirements IS $$Connecteurs requis par agent et responsable de leur configuration. Base du statut « À configurer ». [US-13, 15, 29, 45]$$;
COMMENT ON COLUMN agent_requirements.owner_scope IS $$primary_user = seule l'utilisateur principal configure pour cet agent (l'invité voit « à configurer par X », US-29 RF3) ; each_profile = chaque profil connecte ses comptes ; account = connexion unique du compte (table account_connections), partagée par les agents qui l'exigent$$;

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
CREATE UNIQUE INDEX ux_agent_info_fields_label ON agent_info_fields (agent_id, lower(label));
CREATE INDEX idx_agent_info_fields_shared_key ON agent_info_fields (shared_key) WHERE shared_key IS NOT NULL;
COMMENT ON TABLE agent_info_fields IS $$Champs d'information propres à un agent (formulaire « Informations nécessaires à [agent] »), définis par l'administrateur à la publication. [US-10, 45]$$;
COMMENT ON COLUMN agent_info_fields.shared_key IS $$Clé commune permettant de proposer une valeur déjà saisie pour un autre agent (même clé, même type de donnée) : voir v_info_prefill_suggestions$$;
COMMENT ON COLUMN agent_info_fields.max_items IS $$1 = valeur unique ; supérieur à 1 = liste de valeurs (ex. contacts) limitée à ce nombre$$;

-- =====================================================================
-- 4. CONFIGURATION DES PROFILS : INFOS, DASHBOARD, CONNECTEURS, COPIES
-- =====================================================================

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
CREATE INDEX idx_user_agent_info_values_info_field_id ON user_agent_info_values (info_field_id);
CREATE INDEX idx_user_agent_info_values_updated_by_user_id ON user_agent_info_values (updated_by_user_id);
COMMENT ON TABLE user_agent_info_values IS $$Informations personnelles d'un profil pour un agent (valeurs chiffrées), une ligne par champ et par élément de liste. [US-10, 11, 12]$$;
COMMENT ON COLUMN user_agent_info_values.updated_by_user_id IS $$Profil ayant fait la dernière modification (traçabilité, US-12 RT1)$$;

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
CREATE INDEX idx_profile_agents_agent_id ON profile_agents (agent_id);
CREATE INDEX idx_profile_agents_active ON profile_agents (user_id, added_at) WHERE removed_at IS NULL;
COMMENT ON TABLE profile_agents IS $$Dashboard : agents ajoutés par chaque profil. Retiré = masqué, configuration et carnet conservés. [US-22, 26, 27, 28, 31]$$;
COMMENT ON COLUMN profile_agents.removed_at IS $$Date de retrait ; NULL = agent visible sur le dashboard/page Contrats. Ne compte plus dans la limite de 10$$;

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
CREATE INDEX idx_agent_connections_agent_id ON agent_connections (agent_id);
CREATE INDEX idx_agent_connections_connector_type_id ON agent_connections (connector_type_id);
-- Proposition de réutiliser une adresse déjà connectée (US-13 RF7)
CREATE INDEX idx_agent_connections_connected_email ON agent_connections (user_id, connected_email);
COMMENT ON TABLE agent_connections IS $$Connecteurs configurés par un profil pour un agent (compte Google Drive/Agenda, boîte de validation) et leur statut. [US-13, 14, 15, 29]$$;
COMMENT ON COLUMN agent_connections.status IS $$pending = autorisation (ou code de vérification) en attente ; connected = utilisable ; refused/partial = consentement Google refusé/incomplet ; reconnect_required = autorisation expirée ou révoquée (US-13 RT3). Absence de ligne = « Non configuré »$$;

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
CREATE INDEX idx_account_connections_connector_type_id ON account_connections (connector_type_id);
CREATE INDEX idx_account_connections_connected_by_user_id ON account_connections (connected_by_user_id);
COMMENT ON TABLE account_connections IS $$Connexion partagée du compte à un connecteur (Google Drive de l'utilisateur principal pour les contrats), indépendante des agents. [US-32 RF11, 34 RT1, 13]$$;
COMMENT ON COLUMN account_connections.status IS $$Mêmes valeurs que agent_connections.status. Le bandeau « Drive non connecté » des contrats se déduit de status différent de connected$$;

-- On peut maintenant relier les codes de vérification à la connexion concernée
ALTER TABLE verification_codes
  ADD CONSTRAINT fk_verification_codes_agent_connection
  FOREIGN KEY (agent_connection_id) REFERENCES agent_connections (id) ON DELETE CASCADE;

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
CREATE INDEX idx_cc_addresses_agent_id ON cc_addresses (agent_id);
COMMENT ON TABLE cc_addresses IS $$Adresses ajoutées en copie des événements d'agenda demandés par un profil (maximum fixé par agent, agents.cc_addresses_max_count). Les participants automatiques (D2) ne sont pas stockés : ils se déduisent du rang. [US-16, 17]$$;
COMMENT ON COLUMN cc_addresses.user_id IS $$Profil propriétaire : la liste de l'utilisateur principal ne s'applique qu'à SES événements (D5)$$;

-- =====================================================================
-- 5. CONTRATS
-- =====================================================================

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
-- Nom unique dans la liste, sans tenir compte des majuscules (US-48 RF2)
CREATE UNIQUE INDEX ux_contract_definitions_name ON contract_definitions (lower(name)) WHERE archived_at IS NULL;
CREATE INDEX idx_contract_definitions_sort_order ON contract_definitions (sort_order) WHERE archived_at IS NULL;
COMMENT ON TABLE contract_definitions IS $$Catégories de contrats proposées dans « Mes contrats » (Assurance Auto, Mutuelle…), communes à tous les clients : ex-« contrats obligatoires ». Chaque catégorie a, pour chaque famille, un contrat de base et des contrats complémentaires, ses champs de documents (contract_document_fields) et ses champs de détail (contract_field_definitions). [US-32, 48, 122, 124]$$;
COMMENT ON COLUMN contract_definitions.archived_at IS $$Contrat retiré de la liste par l'administrateur ; les données clients restent en base (hypothèse H8)$$;

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
CREATE UNIQUE INDEX ux_contract_field_definitions_label ON contract_field_definitions (contract_definition_id, lower(label)) WHERE archived_at IS NULL;
COMMENT ON TABLE contract_field_definitions IS $$Champs de détail proposés pour chaque contrat (assureur, échéance, cotisation…) avec type et caractère obligatoire. [US-33, 48]$$;
COMMENT ON COLUMN contract_field_definitions.field_type IS $$text, date, amount (montant positif) ou choice (liste de choix, voir contract_field_options)$$;

CREATE TABLE contract_field_options (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  field_definition_id   bigint NOT NULL REFERENCES contract_field_definitions (id) ON DELETE CASCADE,
  label                 varchar(120) NOT NULL,
  sort_order           integer NOT NULL DEFAULT 1,
  UNIQUE (field_definition_id, label)
);
COMMENT ON TABLE contract_field_options IS $$Valeurs possibles d'un champ de type « liste de choix ». [US-48 RF10]$$;

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
CREATE INDEX idx_account_contracts_contract_definition_id ON account_contracts (contract_definition_id);
CREATE INDEX idx_account_contracts_consent_changed_by ON account_contracts (consent_changed_by_user_id);
CREATE INDEX idx_account_contracts_last_modified_by ON account_contracts (last_modified_by_user_id);
COMMENT ON TABLE account_contracts IS $$Contrat d'une famille (accessible au noyau seulement) : de base (un par catégorie, créé d'office, non supprimable) ou complémentaire (supprimable), nom libre, interrupteurs d'analyse (analysis_*) et de challenge (consent_*), dernière modification. [US-32, 33, 35, 36, 124, 125, 127, 128, 133]$$;
COMMENT ON COLUMN account_contracts.consent_active IS $$Interrupteur « challenge » du contrat : désactivé par défaut, partagé par le noyau, impossible à activer tant que le courtier n'est pas désigné (C-10). La preuve est dans contract_consent_events (canal challenge). Remis à false par la suppression complète des informations du contrat (US-35 RF5). [US-128]$$;

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
CREATE INDEX idx_contract_field_values_field_definition_id ON contract_field_values (field_definition_id);
CREATE INDEX idx_contract_field_values_value_option_id ON contract_field_values (value_option_id);
CREATE INDEX idx_contract_field_values_updated_by ON contract_field_values (updated_by_user_id);
COMMENT ON TABLE contract_field_values IS $$Valeurs saisies pour un contrat d'un compte. Un champ vidé = ligne supprimée. [US-33, 35]$$;
COMMENT ON COLUMN contract_field_values.value_amount IS $$Montant en euros (devise unique supposée, H9), jamais négatif$$;

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
CREATE INDEX idx_contract_documents_account_contract_id ON contract_documents (account_contract_id);
CREATE INDEX idx_contract_documents_added_by_user_id ON contract_documents (added_by_user_id);
CREATE INDEX idx_contract_documents_to_classify ON contract_documents (classification_status) WHERE classification_status <> 'classified';
COMMENT ON TABLE contract_documents IS $$OBSOLÈTE depuis les contrats V2 (C-01, C-04) : ancien dépôt libre de documents classés dans le Drive de l'utilisateur principal (US-34), remplacé par contract_field_documents ; vidée à la mise en service, conservée vide en attendant sa suppression. [US-34, 35]$$;
COMMENT ON COLUMN contract_documents.scan_status IS $$Analyse antivirus obligatoire avant disponibilité (US-34 RT2)$$;
COMMENT ON COLUMN contract_documents.classification_status IS $$pending = « Classement en cours » ; classified = « Document disponible » ; failed = « Classement impossible » après 3 essais auto (US-34 RF13, RF14)$$;

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
CREATE INDEX idx_contract_consent_events_account ON contract_consent_events (account_id, contract_definition_id, occurred_at DESC);
CREATE INDEX idx_contract_consent_events_contract_definition_id ON contract_consent_events (contract_definition_id);
CREATE INDEX idx_contract_consent_events_legal_version_id ON contract_consent_events (legal_version_id);
CREATE INDEX idx_contract_consent_events_retain_until ON contract_consent_events (retain_until) WHERE retain_until IS NOT NULL;
COMMENT ON TABLE contract_consent_events IS $$Journal append-only des consentements à l'analyse IA et au challenge, par contrat (qui, quand, quelle version du texte). Conservé 5 ans après la fin d'abonnement, d'où l'absence de FK vers le compte. [US-36 RT1]$$;
COMMENT ON COLUMN contract_consent_events.account_id IS $$Identifiant du compte, SANS FK : référence conservée après suppression du compte (point à valider DPO, H14)$$;
COMMENT ON COLUMN contract_consent_events.actor_email_hash IS $$Empreinte HMAC-SHA256 de l'email du consentant (clé hors base) : preuve nominative après suppression du compte sans conserver l'email$$;

-- =====================================================================
-- 6. CARNET DE BORD ET VALIDATION D'ACTIONS
-- =====================================================================

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
-- Les index déclarés sur la table partitionnée sont créés automatiquement sur chaque partition
CREATE INDEX idx_logbook_entries_listing ON logbook_entries (account_id, agent_id, occurred_at DESC);
CREATE INDEX idx_logbook_entries_agent_id ON logbook_entries (agent_id);
CREATE INDEX idx_logbook_entries_requester_user_id ON logbook_entries (requester_user_id);
COMMENT ON TABLE logbook_entries IS $$Carnet de bord : demandes et actions des agents pour un compte, en lecture seule, conservées 14 mois par défaut (durée réglable). Table partitionnée par mois. [US-38, 39, 40, 50, 57]$$;
COMMENT ON COLUMN logbook_entries.external_ref IS $$Identifiant Digitorn de l'entrée, garantit l'idempotence de la synchronisation$$;
COMMENT ON COLUMN logbook_entries.requester_user_id IS $$Demandeur ; NULL après suppression définitive de l'invité (affiché « Invité supprimé »)$$;
COMMENT ON COLUMN logbook_entries.anonymization_status IS $$pending = entrées masquées pendant l'anonymisation du texte (US-57 RF7) ; done = nom et données personnelles retirés (irréversible)$$;

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
CREATE INDEX idx_logbook_entry_participants_user_id ON logbook_entry_participants (user_id);
COMMENT ON TABLE logbook_entry_participants IS $$Participants d'une demande du noyau : un invité secondaire ne voit que les demandes où il figure (D3). Partitionnée comme le carnet. [US-40 RT5]$$;
COMMENT ON COLUMN logbook_entry_participants.entry_occurred_at IS $$Date de l'entrée du carnet (clé de partition, avec entry_id)$$;

-- Historique des synchronisations : « Dernière mise à jour » du carnet, alertes d'échec.
CREATE TABLE logbook_sync_runs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  status            sync_status NOT NULL DEFAULT 'running',
  entries_imported  integer NOT NULL DEFAULT 0 CHECK (entries_imported >= 0),
  error_message     text
);
CREATE INDEX idx_logbook_sync_runs_status ON logbook_sync_runs (status, finished_at DESC);
COMMENT ON TABLE logbook_sync_runs IS $$Exécutions de la synchronisation du carnet avec Digitorn ; la dernière réussie alimente « Dernière mise à jour ». [US-40 RF5, RT2, RT4]$$;

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
CREATE INDEX idx_action_decisions_requester_user_id ON action_decisions (requester_user_id);
CREATE INDEX idx_action_decisions_decided_by_user_id ON action_decisions (decided_by_user_id);
COMMENT ON TABLE action_decisions IS $$Décision (validée/refusée/abandonnée) sur une action proposée par un agent, avec état d'exécution ; sert l'idempotence. [US-39]$$;
COMMENT ON COLUMN action_decisions.decision IS $$pending = carte en attente ; abandoned = déconnexion ou expiration de l'historique sans décision (US-39 RF8)$$;

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
CREATE INDEX idx_error_reports_agent_id ON error_reports (agent_id);
-- Purge des signalements de plus de 14 mois (US-61 RT2)
CREATE INDEX idx_error_reports_reported_at ON error_reports (reported_at);
COMMENT ON TABLE error_reports IS $$Registre des signalements de réponses ou actions erronées d'un agent, conservés 14 mois par défaut (durée réglable). [US-61]$$;
COMMENT ON COLUMN error_reports.response_text IS $$Copie de la réponse signalée (peut contenir des données personnelles : à chiffrer, voir plan de sécurité)$$;

-- =====================================================================
-- 7. TRAITEMENTS RGPD : EXPORT, EFFACEMENT
-- =====================================================================

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
-- Une seule demande en cours par profil (US-55 RF5)
CREATE UNIQUE INDEX ux_data_exports_one_in_progress ON data_exports (user_id) WHERE status IN ('requested', 'preparing');
CREATE INDEX idx_data_exports_user_id ON data_exports (user_id);
CREATE INDEX idx_data_exports_expiry ON data_exports (download_expires_at) WHERE status = 'ready';
COMMENT ON TABLE data_exports IS $$Demandes d'export des données d'un profil (droit d'accès/portabilité), préparées en arrière-plan. [US-55]$$;

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
CREATE INDEX idx_erasure_traces_pending ON erasure_traces (digitorn_status) WHERE digitorn_status <> 'done';
COMMENT ON TABLE erasure_traces IS $$Preuve minimale et non nominative d'une suppression définitive de profil ou de membre (date, identifiant technique) + suivi côté Digitorn. [US-20, 56, 57, 58, 93]$$;

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
CREATE INDEX idx_chat_erasure_requests_pending ON chat_erasure_requests (status, requested_at) WHERE status <> 'done';
CREATE INDEX idx_chat_erasure_requests_user_id ON chat_erasure_requests (user_id);
CREATE INDEX idx_chat_erasure_requests_agent_id ON chat_erasure_requests (agent_id);
COMMENT ON TABLE chat_erasure_requests IS $$File des effacements d'historique de tchat demandés à Digitorn (déconnexion, révocation d'appareil, retrait d'agent), avec réessais. [US-9, 28, 43, 53]$$;

-- Compteur de demandes aux agents par profil et par jour : applique le plafond quotidien (décision du 01/10/2026, O2).
-- Une ligne par profil et par jour ; la journée est celle du fuseau de la famille (accounts.family_timezone) au moment de la demande (H35 remplacée).
CREATE TABLE daily_request_counters (
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  request_date   date NOT NULL,
  request_count  integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, request_date)
);
COMMENT ON TABLE daily_request_counters IS $$Nombre de demandes envoyées aux agents par un profil un jour donné, pour appliquer le plafond quotidien du compte. Purgé après quelques jours. [US-38]$$;
COMMENT ON COLUMN daily_request_counters.request_count IS $$Nombre de demandes déjà acceptées ce jour-là ; borné par accounts.daily_request_limit via register_agent_request()$$;
COMMENT ON COLUMN daily_request_counters.request_date IS $$Jour calendaire dans le fuseau de la famille (accounts.family_timezone) au moment de la demande, pour le tchat des agents comme pour l'assistant (hypothèse H35 remplacée, US-70 RF5)$$;

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
CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys (created_at);
COMMENT ON TABLE idempotency_keys IS $$Réponses déjà produites pour une clé d'idempotence, conservées 24 h (CC-7). Table technique, purgée par purge_expired_request_records().$$;
COMMENT ON COLUMN idempotency_keys.response_body IS $$Copie de la réponse renvoyée au client, chiffrée par l'application (bytea ; décision du PO du 27/10/2026). Selon l'action, la réponse peut contenir des données personnelles : adresses en copie d'un agent, détail d'un contrat et de ses champs, nom de fichier d'un document. Limite : 24 h, puis suppression ; supprimée aussi avec le profil. Seules les réponses réussies sont enregistrées. NULL pour une réponse sans corps (204)$$;

-- Demandes envoyées dans le tchat des agents (US-38, US-70) : une demande n'est comptée qu'une seule fois dans le plafond quotidien, même
-- renvoyée après une erreur ou un délai sans réponse (RT2). Aucune copie du texte : l'historique reste chez la plateforme d'agents.
CREATE TABLE chat_requests (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  request_id    uuid NOT NULL,
  agent_id      bigint NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- Jour (fuseau de la famille, accounts.family_timezone) sur lequel la demande a été comptée
  counted_date  date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX idx_chat_requests_agent_id ON chat_requests (agent_id);
CREATE INDEX idx_chat_requests_created_at ON chat_requests (created_at);
COMMENT ON TABLE chat_requests IS $$Demandes déjà comptées dans le plafond quotidien : un renvoi (même identifiant) n'est pas recompté. Aucun texte, aucun contenu : un identifiant de demande, l'agent et le jour. Purgée après 24 h. [US-38 RT2, US-70 RF6]$$;
COMMENT ON COLUMN chat_requests.counted_date IS $$Jour calendaire dans le fuseau de la famille (accounts.family_timezone) sur lequel la demande a été comptée (hypothèse H35 remplacée, US-70 RF5)$$;

-- =====================================================================
-- 8. ADMINISTRATION : PARAMÈTRES ET JOURNAL
-- =====================================================================

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
  ),
  -- Horodatage ISO 8601 avec fuseau (ex. 2026-11-02T08:00:00+01:00)
  CONSTRAINT ck_platform_settings_timestamp CHECK (
    value_type <> 'timestamp' OR value_text IS NULL OR value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
  )
);
CREATE INDEX idx_platform_settings_updated_by_user_id ON platform_settings (updated_by_user_id);
COMMENT ON TABLE platform_settings IS $$Réglages de la plateforme modifiables depuis la console admin (fréquence de synchro, délais, emails, limites). [US-27, 62, 65]$$;
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

CREATE TABLE platform_setting_changes (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  setting_key          text NOT NULL REFERENCES platform_settings (setting_key) ON DELETE RESTRICT,
  old_value            text,
  new_value            text,
  changed_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  changed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_setting_changes_key ON platform_setting_changes (setting_key, changed_at DESC);
CREATE INDEX idx_platform_setting_changes_changed_by ON platform_setting_changes (changed_by_user_id);
COMMENT ON TABLE platform_setting_changes IS $$Historique des modifications de paramètres : ancien/nouveau, administrateur, date. [US-65 RF4]$$;

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
CREATE INDEX idx_admin_audit_log_admin_user_id ON admin_audit_log (admin_user_id);
CREATE INDEX idx_admin_audit_log_entity ON admin_audit_log (entity_type, entity_id);
CREATE INDEX idx_admin_audit_log_occurred_at ON admin_audit_log (occurred_at DESC);
COMMENT ON TABLE admin_audit_log IS $$Journal d'administration : actions de l'administrateur sur agents, contrats et comptes. [US-45, 46, 47, 48, 64]$$;

-- =====================================================================
-- 8 bis. ASSISTANT FAMILLE (RDV & TÂCHES) — MVP
-- Sources : MAAQ_US_Detaillees_BA_Assistant_Famille.md (US-71 à US-94, US-106 ; D25 à D38)
-- Principes : le calendrier, les membres, le mail de transfert et les conversations sont des
-- données du FOYER (account_id, ON DELETE CASCADE). Les textes pouvant révéler de la santé
-- (titre, lieu, note) sont chiffrés par l'application (bytea). Les liens entre tables du même
-- foyer passent par des clés composites (id, account_id) : impossible de relier deux foyers.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Types de RDV : liste de référence, extensible sans code (US-82 RT2, AF-6)
-- ---------------------------------------------------------------------
CREATE TABLE event_types (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+$'),
  label       varchar(60) NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 1
);
COMMENT ON TABLE event_types IS $$Types de RDV de l'Assistant Famille (six au MVP) ; déterminent les délais de rappel. [US-75, 82, AF-6]$$;
INSERT INTO event_types (code, label, sort_order) VALUES
  ('school', 'École', 1), ('medical', 'Médical', 2), ('professional', 'Professionnel', 3),
  ('family', 'Familial', 4), ('personal', 'Personnel', 5), ('administrative', 'Administratif', 6);

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
CREATE INDEX idx_agent_conversations_account_id ON agent_conversations (account_id);
CREATE INDEX idx_agent_conversations_agent_id ON agent_conversations (agent_id);
COMMENT ON TABLE agent_conversations IS $$Conversation d'un profil avec un agent dont MAAQ conserve le tchat (agents appelés par API directe : Anthropic, Vertex AI). Les agents Digitorn gardent leur historique chez Digitorn. [US-37, 43, 44, D29]$$;

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
  CONSTRAINT ck_conversation_messages_content CHECK (kind IN ('image', 'place_suggestion', 'place_results') OR content IS NOT NULL),
  -- Cible des clés composites de assistant_requests : une demande ne relie que des messages de sa propre conversation
  CONSTRAINT uq_conversation_messages_conversation_id UNIQUE (conversation_id, id)
);
CREATE INDEX idx_conversation_messages_conversation ON agent_conversation_messages (conversation_id, created_at);
CREATE INDEX idx_conversation_messages_expires_at ON agent_conversation_messages (expires_at);
COMMENT ON TABLE agent_conversation_messages IS $$Messages d'une conversation conservée par MAAQ. Supprimés à la déconnexion, au retrait de l'agent et au bout de 4 jours. [US-38, 43, 44, 71, 72]$$;
COMMENT ON COLUMN agent_conversation_messages.content IS $$Contenu chiffré avec les vrais prénoms (texte, ou transcription d'une dictée : l'enregistrement audio n'est jamais conservé, US-71 RT2)$$;
COMMENT ON COLUMN agent_conversation_messages.delivery_state IS $$État d'envoi du message : sending, sent, failed, waiting_for_connection (US-38 RF2, RF14)$$;

-- Une demande envoyée à l'Assistant Famille (reprise de l'application, décision du PO du 27/10/2026) : relie le message du parent à la réponse,
-- pour qu'un renvoi (« Réessayer », double toucher) rende la réponse déjà donnée au lieu de refaire le travail, et retrouve les RDV créés.
-- Aucun texte : des identifiants seulement. Rattachée au compte par la conversation (suppression du foyer en cascade) ; disparaît avec les
-- messages (4 jours, US-44) : pas de purge propre. Pas de colonne account_id : l'application ne l'écrit pas et la conversation la porte déjà.
CREATE TABLE assistant_requests (
  conversation_id   uuid NOT NULL REFERENCES agent_conversations (id) ON DELETE CASCADE,
  request_id        uuid NOT NULL,
  user_message_id   bigint NOT NULL,
  reply_message_id  bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, request_id),
  -- Les deux messages appartiennent à la conversation de la demande ; la demande part avec le message du parent, la réponse supprimée la laisse vide
  CONSTRAINT fk_assistant_requests_user_message FOREIGN KEY (conversation_id, user_message_id)
    REFERENCES agent_conversation_messages (conversation_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_assistant_requests_reply_message FOREIGN KEY (conversation_id, reply_message_id)
    REFERENCES agent_conversation_messages (conversation_id, id) ON DELETE SET NULL (reply_message_id)
);
CREATE INDEX idx_assistant_requests_user_message ON assistant_requests (user_message_id);
CREATE INDEX idx_assistant_requests_reply_message ON assistant_requests (reply_message_id);
COMMENT ON TABLE assistant_requests IS $$Demandes faites à l'Assistant Famille : message du parent, réponse de l'assistant ; sert à rendre la même réponse à un renvoi et à retrouver les RDV créés par la demande. Aucun texte. Disparaît avec les messages (4 jours). [US-38, 44, 71, 95]$$;

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
CREATE INDEX idx_conversation_attachments_expiry ON conversation_attachments (expires_at) WHERE deleted_at IS NULL;
COMMENT ON TABLE conversation_attachments IS $$Image jointe à un message du tchat de l'Assistant Famille (le fichier est dans un stockage chiffré de l'UE). [US-72, 73]$$;
COMMENT ON COLUMN conversation_attachments.storage_key IS $$Chemin de l'objet dans le stockage chiffré ; NULL après suppression. Les suppressions passent par storage_deletion_queue$$;

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
CREATE INDEX idx_storage_deletion_queue_pending ON storage_deletion_queue (queued_at) WHERE status <> 'done';
COMMENT ON TABLE storage_deletion_queue IS $$Fichiers (images, mails bruts) à supprimer du stockage, avec réessais. Évite les fichiers orphelins après une suppression en cascade. [US-56, 58, 72, 87, 93]$$;

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
-- Un profil = au plus un membre (US-92 RT1)
CREATE UNIQUE INDEX ux_family_members_one_per_user ON family_members (user_id) WHERE user_id IS NOT NULL;
-- Prénom unique parmi les membres déclarés actifs (US-92 RF5) ; le contrôle contre les prénoms des profils se fait à l'application
CREATE UNIQUE INDEX ux_family_members_declared_name ON family_members (account_id, lower(first_name)) WHERE user_id IS NULL AND archived_at IS NULL;
-- Couleur distincte parmi les membres actifs ; une couleur libérée est réattribuable (US-93 RF9)
CREATE UNIQUE INDEX ux_family_members_active_color ON family_members (account_id, color_index) WHERE archived_at IS NULL;
CREATE INDEX idx_family_members_created_by_user_id ON family_members (created_by_user_id);
COMMENT ON TABLE family_members IS $$Membres de la famille concernés par les RDV (enfants sans compte, parents, invités). Retirer = archiver ; effacer = anonymiser. [US-92, 93]$$;
COMMENT ON COLUMN family_members.user_id IS $$Profil lié, NULL pour un membre sans compte. Coupé à la suppression du profil, ce qui déclenche l'anonymisation du membre$$;
COMMENT ON COLUMN family_members.role IS $$parent (utilisateur principal, invité 1) ; child ; other (invité secondaire par défaut). Un changement de rôle attribue un nouvel alias$$;
COMMENT ON COLUMN family_members.alias_number IS $$Numéro d'alias par compte et par rôle, jamais réutilisé, même après archivage ou anonymisation$$;
COMMENT ON COLUMN family_members.birth_year IS $$Année de naissance, facultative, avec le mois (jamais le jour, D54). Les âges sont transmis au modèle par tranche, calculés sans stockage supplémentaire (D37, family_member_age_months). Donnée d'un mineur : incluse dans l'export (US-92 RT4)$$;
COMMENT ON COLUMN family_members.birth_month IS $$Mois de naissance (1 à 12), facultatif, renseigné avec l'année ; le jour n'existe pas en base (D54)$$;
COMMENT ON COLUMN family_members.anonymized_at IS $$Date d'effacement des données du membre (prénom et naissance vidés) ; il reste affiché « Ancien membre » dans les RDV partagés (US-93 RF13)$$;

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
-- Une seule adresse active par famille (D33) ; la régénérer révoque l'ancienne
CREATE UNIQUE INDEX ux_forwarding_mailboxes_one_active ON forwarding_mailboxes (account_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_forwarding_mailboxes_account_id ON forwarding_mailboxes (account_id);
CREATE INDEX idx_forwarding_mailboxes_activated_by ON forwarding_mailboxes (activated_by_user_id);
CREATE INDEX idx_forwarding_mailboxes_revoked_by ON forwarding_mailboxes (revoked_by_user_id);
COMMENT ON TABLE forwarding_mailboxes IS $$Adresse de transfert de la famille, conservée séparément du compte pour pouvoir être régénérée sans perdre l'historique. [US-85]$$;

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
CREATE INDEX idx_forwarding_consent_events_account ON forwarding_consent_events (account_id, occurred_at DESC);
CREATE INDEX idx_forwarding_consent_events_legal_version_id ON forwarding_consent_events (legal_version_id);
CREATE INDEX idx_forwarding_consent_events_retain_until ON forwarding_consent_events (retain_until) WHERE retain_until IS NOT NULL;
COMMENT ON TABLE forwarding_consent_events IS $$Journal append-only des consentements au traitement des mails transférés (auteur, date, version du texte). Survit au compte, comme les consentements aux contrats. [US-85 RF2, RT3]$$;

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
CREATE INDEX idx_forwarding_authorized_senders_user_id ON forwarding_authorized_senders (user_id);
CREATE INDEX idx_forwarding_authorized_senders_added_by ON forwarding_authorized_senders (added_by_user_id);
COMMENT ON TABLE forwarding_authorized_senders IS $$Adresses autorisées à transférer des mails vers l'adresse de la famille (utilisateur principal et invité 1 seulement au MVP, 10 par famille). [US-88]$$;

-- Les codes de vérification servent aussi à vérifier une adresse autorisée (US-88 RF4)
ALTER TABLE verification_codes
  ADD COLUMN authorized_sender_id bigint REFERENCES forwarding_authorized_senders (id) ON DELETE CASCADE;
ALTER TABLE verification_codes
  ADD CONSTRAINT ck_verification_codes_forwarding CHECK (purpose <> 'forwarding_sender' OR authorized_sender_id IS NOT NULL);
CREATE INDEX idx_verification_codes_authorized_sender_id ON verification_codes (authorized_sender_id) WHERE authorized_sender_id IS NOT NULL;
COMMENT ON COLUMN verification_codes.authorized_sender_id IS $$Adresse autorisée en cours de vérification (usage forwarding_sender, code valable 15 minutes)$$;

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
CREATE INDEX idx_inbound_emails_account ON inbound_emails (account_id, received_at DESC);
CREATE INDEX idx_inbound_emails_mailbox_id ON inbound_emails (mailbox_id);
CREATE INDEX idx_inbound_emails_forwarded_by ON inbound_emails (forwarded_by_user_id);
CREATE INDEX idx_inbound_emails_raw ON inbound_emails (raw_expires_at) WHERE raw_storage_key IS NOT NULL;
CREATE INDEX idx_inbound_emails_received_at ON inbound_emails (received_at);
COMMENT ON TABLE inbound_emails IS $$Informations de suivi de chaque mail transféré (date, expéditeur, statut). Contenu brut dans le stockage chiffré, supprimé au plus tard 30 jours après réception. [US-85 à US-91]$$;
COMMENT ON COLUMN inbound_emails.status IS $$received ; rejected_unauthorized (jamais de contenu conservé, suivi 30 jours) ; irrelevant ; processed ; known_event (RDV déjà connu) ; no_date_found ; no_matching_event (annulation sans RDV correspondant) ; failed ; verification_mail (mail de vérification d'une messagerie)$$;
COMMENT ON COLUMN inbound_emails.raw_storage_key IS $$Objet chiffré contenant le mail et ses pièces jointes ; NULL après suppression (raw_deleted_at). Supprimé via storage_deletion_queue$$;

-- Plafond de mails traités par jour et par famille (50, US-87 RF12) : compteur atomique comme celui des demandes
CREATE TABLE inbound_email_daily_counters (
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  email_date          date NOT NULL,
  mail_count          integer NOT NULL DEFAULT 0 CHECK (mail_count >= 0),
  -- Alerte « plafond atteint » envoyée à l'utilisateur principal, une fois par jour
  over_limit_alerted_at timestamptz,
  PRIMARY KEY (account_id, email_date)
);
COMMENT ON TABLE inbound_email_daily_counters IS $$Nombre de mails transférés traités par famille et par jour, pour appliquer la limite de 50. Purgé après quelques jours. [US-87 RF12]$$;

-- ---------------------------------------------------------------------
-- MVP2 — Séries de RDV (US-109, D43). La règle est ici ; les séances sont des lignes de family_events créées à
-- l'avance sur 6 mois glissants par le planificateur (clé d'idempotence : series_id + occurrence_date).
-- ---------------------------------------------------------------------

-- Règle de répétition valide, partagée par les séries de RDV et de tâches (US-109 RF2, US-110 RF3)
CREATE FUNCTION series_rule_valid(
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
COMMENT ON FUNCTION series_rule_valid(series_repeat_unit, smallint, smallint[], series_month_mode, smallint, smallint, smallint) IS $$Vrai si la règle de répétition est cohérente : chaque jour, chaque semaine (un ou plusieurs jours) ou toutes les deux semaines, chaque mois (même jour du mois, ou n-ième jour de la semaine), ou chaque année (même jour et même mois, pour les RDV seulement). [US-109 RF2, US-110 RF3, D70]$$;

-- Hebdomadaire ou plus fréquent : seul le rappel J-1 est envoyé pour chaque séance. Toutes les deux semaines et chaque mois
-- suivent les délais de rappel du type de RDV (décision du PO du 26/10/2026, D46).
CREATE FUNCTION series_only_d1_reminder(p_unit series_repeat_unit, p_interval smallint) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_unit IN ('day', 'week') AND p_interval = 1
$$;
COMMENT ON FUNCTION series_only_d1_reminder(series_repeat_unit, smallint) IS $$Vrai pour une série hebdomadaire ou plus fréquente (rappel J-1 seul) ; faux pour une série toutes les deux semaines, mensuelle ou annuelle (délais du type de RDV). [US-109 RF9, D46, D70]$$;

CREATE TABLE family_event_series (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_type_id           integer NOT NULL REFERENCES event_types (id) ON DELETE RESTRICT,
  -- Modèle des séances. Chiffrés ; titre NULL pour un RDV médical (comme family_events)
  title                   bytea,
  location                bytea,
  -- Coordonnées du lieu (latitude, longitude), chiffrées. Jamais pour un RDV médical ; jamais une adresse de domicile (D47)
  location_point          bytea,
  note                    bytea,
  -- Heure locale de début (dans series_timezone) et durée : un changement d'heure ne décale pas l'heure locale (US-109 RT4)
  start_time              time NOT NULL,
  duration_minutes        integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 1 AND 1440),
  all_day                 boolean NOT NULL DEFAULT false,
  whole_family            boolean NOT NULL DEFAULT false,
  series_timezone         text NOT NULL DEFAULT 'Europe/Paris' CHECK (series_timezone ~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$'),
  -- Première date de la règle (ancre de « toutes les deux semaines »)
  first_date              date NOT NULL,
  repeat_unit             series_repeat_unit NOT NULL,
  repeat_interval         smallint NOT NULL DEFAULT 1,
  -- Jours de la semaine, ISO : 1 = lundi … 7 = dimanche
  weekdays                smallint[],
  month_mode              series_month_mode,
  month_day               smallint,
  -- 1 à 4 = premier à quatrième, -1 = dernier ; month_weekday : ISO 1 à 7
  month_nth               smallint,
  month_weekday           smallint,
  end_kind                series_end_kind NOT NULL DEFAULT 'never',
  until_date              date,
  -- Nombre de séances réellement tenues, hors vacances sautées (D47)
  occurrence_count        integer CHECK (occurrence_count > 0),
  skip_school_holidays    boolean NOT NULL DEFAULT false,
  status                  event_status NOT NULL DEFAULT 'provisional',
  status_changed_at       timestamptz NOT NULL DEFAULT now(),
  -- Dernière date pour laquelle les séances ont été créées : le planificateur ne complète que vers l'avant
  materialized_until      date,
  -- Renseignée quand la règle n'a plus de séance à venir ou que la série est annulée : la série n'est plus « active »
  ended_at                timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  source                  event_source NOT NULL,
  requested_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  source_at               timestamptz,
  source_message_id       bigint REFERENCES agent_conversation_messages (id) ON DELETE SET NULL,
  source_inbound_email_id uuid REFERENCES inbound_emails (id) ON DELETE SET NULL,
  created_via_agent_id    bigint REFERENCES agents (id) ON DELETE RESTRICT,
  confirmed_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  confirmed_at            timestamptz,
  -- « Cette séance et les suivantes » : la série est scindée, la nouvelle garde un lien vers l'ancienne
  split_from_series_id    uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_event_series_split FOREIGN KEY (split_from_series_id, account_id)
    REFERENCES family_event_series (id, account_id) ON DELETE SET NULL (split_from_series_id),
  CONSTRAINT ck_event_series_unit CHECK (repeat_unit <> 'day'),
  CONSTRAINT ck_event_series_rule CHECK (series_rule_valid(repeat_unit, repeat_interval, weekdays, month_mode, month_day, month_nth, month_weekday)),
  CONSTRAINT ck_event_series_end CHECK (
    (end_kind = 'date') = (until_date IS NOT NULL) AND (end_kind = 'count') = (occurrence_count IS NOT NULL)
    AND (until_date IS NULL OR until_date >= first_date)),
  CONSTRAINT ck_event_series_status CHECK (status IN ('provisional', 'confirmed', 'cancelled', 'dismissed')),
  CONSTRAINT ck_event_series_confirmed CHECK ((status IN ('confirmed', 'cancelled')) = (confirmed_at IS NOT NULL)),
  CONSTRAINT ck_event_series_location_point CHECK (location_point IS NULL OR location IS NOT NULL)
);
CREATE INDEX idx_event_series_account_id ON family_event_series (account_id);
CREATE INDEX idx_event_series_planning ON family_event_series (materialized_until) WHERE status IN ('provisional', 'confirmed') AND ended_at IS NULL;
CREATE INDEX idx_event_series_cleanup ON family_event_series (status_changed_at) WHERE ended_at IS NOT NULL OR status IN ('cancelled', 'dismissed');
CREATE INDEX idx_event_series_event_type_id ON family_event_series (event_type_id);
CREATE INDEX idx_event_series_requested_by ON family_event_series (requested_by_user_id);
CREATE INDEX idx_event_series_confirmed_by ON family_event_series (confirmed_by_user_id);
CREATE INDEX idx_event_series_source_message_id ON family_event_series (source_message_id);
CREATE INDEX idx_event_series_source_email_id ON family_event_series (source_inbound_email_id);
CREATE INDEX idx_event_series_created_via_agent_id ON family_event_series (created_via_agent_id);
CREATE INDEX idx_event_series_split_from ON family_event_series (split_from_series_id);
COMMENT ON TABLE family_event_series IS $$Série de RDV récurrents : la règle de répétition, le modèle des séances et l'état de confirmation (tout ou rien). Les séances sont des lignes de family_events. [US-109, D43]$$;
COMMENT ON COLUMN family_event_series.location_point IS $$Coordonnées chiffrées du lieu (proposées par l'API Adresse), supprimées avec la série. NULL pour un RDV médical (pas de suivi de trajet). Jamais une adresse de domicile (D47)$$;
COMMENT ON COLUMN family_event_series.start_time IS $$Heure locale de début, dans le fuseau de la série : un changement d'heure ne décale pas l'heure locale d'une séance$$;
COMMENT ON COLUMN family_event_series.first_date IS $$Première date de la règle (ancre de « toutes les deux semaines »)$$;
COMMENT ON COLUMN family_event_series.weekdays IS $$Jours de la semaine (ISO, 1 = lundi à 7 = dimanche) d'une série hebdomadaire$$;
COMMENT ON COLUMN family_event_series.month_nth IS $$Série mensuelle « n-ième jour de la semaine » : 1 à 4, ou -1 pour le dernier$$;
COMMENT ON COLUMN family_event_series.occurrence_count IS $$Fin « après N séances » : compte les séances réellement tenues, hors vacances sautées (D47)$$;
COMMENT ON COLUMN family_event_series.status IS $$provisional, confirmed, cancelled ou dismissed. La confirmation est atomique (confirm_family_series) : toutes les séances à venir sont confirmées, ou aucune$$;
COMMENT ON COLUMN family_event_series.materialized_until IS $$Dernière date pour laquelle les séances sont créées (6 mois glissants) ; le planificateur ne complète que vers l'avant, sans recréer une séance déjà purgée$$;
COMMENT ON COLUMN family_event_series.ended_at IS $$Série terminée ou annulée : elle ne compte plus parmi les 30 séries actives et sera supprimée quand il ne lui restera plus de séance$$;
COMMENT ON COLUMN family_event_series.split_from_series_id IS $$Série d'origine quand « Cette séance et les suivantes » a scindé la série$$;

-- Membres concernés par la série ; les séances les recopient à leur création (comme family_event_members)
CREATE TABLE family_event_series_members (
  series_id   uuid NOT NULL,
  member_id   uuid NOT NULL,
  account_id  uuid NOT NULL,
  PRIMARY KEY (series_id, member_id),
  CONSTRAINT fk_series_members_series FOREIGN KEY (series_id, account_id)
    REFERENCES family_event_series (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_series_members_member FOREIGN KEY (member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_series_members_member ON family_event_series_members (member_id, series_id);
CREATE INDEX idx_series_members_account_id ON family_event_series_members (account_id);
COMMENT ON TABLE family_event_series_members IS $$Membres concernés par une série de RDV (un ou plusieurs). « Toute la famille » = indicateur whole_family de la série. [US-109, D27]$$;

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
  -- MVP2 : séance d'une série (US-109). La série supprimée, la séance reste un RDV ordinaire (SET NULL)
  series_id               uuid,
  -- Date locale d'origine de la séance dans la série : clé stable, même si la séance est déplacée
  occurrence_date         date,
  -- Séance modifiée seule, qui reste rattachée à la série (mention « Modifiée », US-109 RF8)
  is_modified             boolean NOT NULL DEFAULT false,
  -- Coordonnées chiffrées du lieu (latitude, longitude), supprimées avec le RDV. Jamais pour un RDV médical ; jamais une adresse de domicile (D47)
  location_point          bytea,
  -- D49 : échéance d'enregistrement automatique (NULL = jamais), tenue par trigger ; confirmé d'office au nom de « MAAQ (sans réponse) »
  auto_confirm_at         timestamptz,
  auto_confirmed          boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_family_events_series FOREIGN KEY (series_id, account_id)
    REFERENCES family_event_series (id, account_id) ON DELETE SET NULL (series_id),
  CONSTRAINT ck_family_events_series CHECK (series_id IS NULL OR occurrence_date IS NOT NULL),
  CONSTRAINT ck_family_events_location_point CHECK (location_point IS NULL OR location IS NOT NULL),
  -- Une confirmation d'office n'a pas de profil confirmeur ; elle ne peut exister que pour un RDV confirmé (puis éventuellement annulé)
  CONSTRAINT ck_family_events_auto_confirmed CHECK (NOT auto_confirmed OR (confirmed_by_user_id IS NULL AND status IN ('confirmed', 'cancelled'))),
  CONSTRAINT ck_family_events_period CHECK (ends_at > starts_at),
  -- Un RDV confirmé ou annulé a forcément été confirmé (confirmé → annulé est la seule sortie de « confirmé »)
  CONSTRAINT ck_family_events_confirmed CHECK ((status IN ('confirmed', 'cancelled')) = (confirmed_at IS NOT NULL))
);
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
-- Clé d'idempotence du planificateur : une seule séance par date d'origine et par série
CREATE UNIQUE INDEX ux_family_events_series_occurrence ON family_events (series_id, occurrence_date) WHERE series_id IS NOT NULL;
-- RDV provisoires à enregistrer d'office (planificateur de 5 minutes)
CREATE INDEX idx_family_events_auto_confirm ON family_events (auto_confirm_at) WHERE status = 'provisional' AND auto_confirm_at IS NOT NULL;
COMMENT ON TABLE family_events IS $$RDV du foyer (calendrier familial), ressource partagée dont l'agent n'est pas propriétaire. Statuts : provisoire, écarté, confirmé, annulé, ignoré. [US-74 à US-80, 87 à 91, D25, AF-1]$$;
COMMENT ON COLUMN family_events.title IS $$Titre chiffré. NULL pour un RDV médical : le titre générique « RDV médical — [prénom] » est calculé, jamais stocké$$;
COMMENT ON COLUMN family_events.status IS $$provisional = proposé par l'agent (gris) ; set_aside = écarté (reste visible et confirmable jusqu'à la relance suivante) ; confirmed ; cancelled ; dismissed (retiré du calendrier). Transitions : provisional → confirmed/set_aside/dismissed ; set_aside → confirmed/dismissed ; confirmed → cancelled$$;
COMMENT ON COLUMN family_events.version IS $$Incrémentée à chaque modification ; l'application ne met à jour que si la version lue est encore la bonne (US-76 RT1)$$;
COMMENT ON COLUMN family_events.fingerprint IS $$Empreinte du RDV (créneau, type, membres) calculée par l'application ; unique parmi les RDV actifs d'un foyer. Pour une séance de série, l'application y inclut series_id : une séance identique à un RDV déjà saisi devient un conflit signalé, pas une erreur$$;
COMMENT ON COLUMN family_events.series_id IS $$Série dont ce RDV est une séance (US-109). Série supprimée : la séance devient un RDV ordinaire$$;
COMMENT ON COLUMN family_events.occurrence_date IS $$Date locale d'origine de la séance dans la série (clé stable, même après un déplacement)$$;
COMMENT ON COLUMN family_events.is_modified IS $$Séance modifiée seule : elle reste rattachée à la série avec la mention « Modifiée » et n'est plus touchée par « Toute la série » (D47)$$;
COMMENT ON COLUMN family_events.auto_confirm_at IS $$Échéance d'enregistrement sans réponse : le plus petit de (proposition + 72 h) et (début - 2 h). NULL = jamais : RDV non provisoire, source hors tchat, séance de série, ou proposé moins de 2 h avant son début. Le délai court depuis la proposition même si le RDV est modifié$$;
COMMENT ON COLUMN family_events.auto_confirmed IS $$Confirmé d'office, au nom de « MAAQ (sans réponse) » : confirmed_by_user_id est alors vide, et l'historique porte le motif no_response. À distinguer d'une confirmation dont l'auteur a été supprimé$$;
COMMENT ON COLUMN family_events.confirmed_by_user_id IS $$Profil qui a confirmé le RDV ; vide si la confirmation est automatique (auto_confirmed) ou si le profil a été supprimé$$;
COMMENT ON COLUMN family_events.location_point IS $$Coordonnées chiffrées du lieu, supprimées avec le RDV. NULL pour un RDV médical (pas de suivi de trajet). Jamais une adresse de domicile (D47)$$;

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
CREATE INDEX idx_family_event_members_member ON family_event_members (member_id, event_id);
CREATE INDEX idx_family_event_members_account_id ON family_event_members (account_id);
COMMENT ON TABLE family_event_members IS $$Membres concernés par un RDV (un ou plusieurs). « Toute la famille » = indicateur whole_family du RDV, sans ligne ici. [US-76, 92, D27]$$;

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
  reason       event_change_reason,
  -- MVP2 : série concernée et portée du changement ; l'onglet « Famille » regroupe en une ligne les changements d'une même série
  series_id    uuid REFERENCES family_event_series (id) ON DELETE SET NULL,
  scope        change_scope
);
CREATE INDEX idx_family_event_history_event ON family_event_history (event_id, occurred_at);
CREATE INDEX idx_family_event_history_series ON family_event_history (series_id) WHERE series_id IS NOT NULL;
CREATE INDEX idx_family_event_history_user_id ON family_event_history (user_id);
COMMENT ON TABLE family_event_history IS $$Historique d'un RDV : statut avant/après, auteur (vide pour le système), date, motif. Alimente le détail du RDV et l'onglet « Famille » du carnet. [US-75, 77, 79, 80, 83]$$;

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
-- Une seule proposition en attente par RDV : dès qu'un profil la traite, elle disparaît pour les autres (US-90 RF8)
CREATE UNIQUE INDEX ux_change_proposals_one_pending ON family_event_change_proposals (event_id) WHERE status = 'pending';
CREATE INDEX idx_change_proposals_account_id ON family_event_change_proposals (account_id);
CREATE INDEX idx_change_proposals_email_id ON family_event_change_proposals (source_inbound_email_id);
CREATE INDEX idx_change_proposals_requested_by ON family_event_change_proposals (requested_by_user_id);
CREATE INDEX idx_change_proposals_decided_by ON family_event_change_proposals (decided_by_user_id);
COMMENT ON TABLE family_event_change_proposals IS $$Proposition d'annulation, de report ou de modification d'un RDV existant (suite à un mail ou à une demande à l'agent), en attente de décision d'un parent. [US-80 RT3, US-90]$$;

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
CREATE INDEX idx_family_reminder_settings_event_type_id ON family_reminder_settings (event_type_id);
CREATE INDEX idx_family_reminder_settings_updated_by ON family_reminder_settings (updated_by_user_id);
COMMENT ON TABLE family_reminder_settings IS $$Délais de rappel par famille et par type de RDV. Seules les modifications sont stockées : l'absence de ligne = les trois rappels actifs. [US-82]$$;

CREATE TABLE scheduled_notifications (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL pour les notifications sans RDV (tâches, point de la semaine) : voir task_id et subject_date (MVP2)
  event_id            uuid REFERENCES family_events (id) ON DELETE CASCADE,
  recipient_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind                notification_kind NOT NULL,
  due_at              timestamptz NOT NULL,
  -- Jour local d'une notification agrégée (rappel quotidien des tâches, point de la semaine : lundi de la semaine couverte)
  subject_date        date,
  -- Échéance d'envoi : au-delà, la notification est abandonnée (rappel de tâches : avant midi, US-97 RF9) ; NULL = début du RDV
  deadline_at         timestamptz,
  status              notification_status NOT NULL DEFAULT 'scheduled',
  push_sent_at        timestamptz,
  email_sent_at       timestamptz,
  attempts            smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Clés d'unicité contre l'envoi en double (US-81 RT2) : voir ux_scheduled_notifications_* (section MVP2)
CREATE INDEX idx_scheduled_notifications_due ON scheduled_notifications (due_at) WHERE status = 'scheduled';
CREATE INDEX idx_scheduled_notifications_recipient_user_id ON scheduled_notifications (recipient_user_id);
COMMENT ON TABLE scheduled_notifications IS $$Rappels (J-7, J-1, jour J), relances (24 h, 48 h) et notifications de trajet programmés par RDV et destinataire ; rappels de tâches, point de la semaine et annonce d'une proposition de sorties sans RDV. Supprimés avec le RDV ; sans RDV, 30 jours après l'échéance. [US-79, 81, 83, 97, 98, 107, 115]$$;
COMMENT ON COLUMN scheduled_notifications.status IS $$scheduled ; sent ; not_applicable (échéance déjà passée à la confirmation) ; abandoned (non parti avant le début du RDV) ; cancelled (RDV annulé ou date changée)$$;

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
COMMENT ON TABLE push_subscriptions IS $$Abonnement aux notifications d'un appareil. Supprimé à la déconnexion, à la révocation de l'appareil (qui n'est que marqué révoqué) et quand il n'est plus valide. [US-9, 53, 81 RT4, 94]$$;

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
CREATE INDEX idx_erasure_trace_targets_trace ON erasure_trace_targets (erasure_trace_id);
CREATE INDEX idx_erasure_trace_targets_pending ON erasure_trace_targets (status) WHERE status <> 'done';
COMMENT ON TABLE erasure_trace_targets IS $$Suppression des données d'une trace chez une plateforme d'agents (Digitorn, Anthropic, Vertex AI), avec réessais. À utiliser si un fournisseur conserve des données sans effacement possible à la demande (P-37). [US-56, 58, 106]$$;

-- Le lien « Voir la proposition de RDV » d'un message du tchat (clé étrangère ajoutée maintenant que family_events existe)
ALTER TABLE agent_conversation_messages
  ADD CONSTRAINT fk_conversation_messages_event FOREIGN KEY (family_event_id) REFERENCES family_events (id) ON DELETE SET NULL;
CREATE INDEX idx_conversation_messages_family_event_id ON agent_conversation_messages (family_event_id) WHERE family_event_id IS NOT NULL;

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


-- =====================================================================
-- 8 ter. ASSISTANT FAMILLE — MVP2 « CALENDRIER INTELLIGENT »
-- Sources : MAAQ_US_Detaillees_BA_Assistant_Famille_MVP2.md (US-95 à 98, 102, 107 à 110 ; D40 à D47, AT-1 à AT-7)
-- et MAAQ_BDD_Proposition_MVP2.md (validée par le PO le 26/10/2026).
-- Même principes que le MVP : données du FOYER (account_id, ON DELETE CASCADE), liens du même foyer par clés composites,
-- textes sensibles chiffrés par l'application. AUCUNE adresse de domicile n'est stockée (D47).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Réglages : famille (zone scolaire, catalogue d'anticipation) et profil (rappels de tâches, point hebdomadaire)
-- ---------------------------------------------------------------------
CREATE TABLE family_settings (
  account_id            uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  -- Zone scolaire (A, B ou C) pour « Sauf vacances scolaires » ; NULL = non réglée, l'option n'est pas proposée (US-109 RF4)
  school_zone           char(1) CHECK (school_zone IN ('A', 'B', 'C')),
  -- Interrupteur du catalogue d'anticipation et des suggestions de l'historique (US-102 RF9, US-108 RF8)
  anticipation_enabled  boolean NOT NULL DEFAULT true,
  updated_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_family_settings_updated_by ON family_settings (updated_by_user_id);
COMMENT ON TABLE family_settings IS $$Réglages de l'Assistant Famille communs à la famille : zone scolaire, catalogue d'anticipation actif ou non, aide Devoirs. Absence de ligne = valeurs par défaut. [US-102 RF9, US-108 RF8, US-109 RF4, US-118 RF1]$$;

CREATE TABLE user_assistant_settings (
  user_id                      uuid PRIMARY KEY,
  account_id                   uuid NOT NULL,
  task_daily_reminder_enabled  boolean NOT NULL DEFAULT true,
  weekly_digest_enabled        boolean NOT NULL DEFAULT true,
  -- « Être prévenu des RDV ajoutés par l'autre parent » (parent) ou « qui me concernent » (invité secondaire) ; actif par défaut (US-113 RF14, D58)
  notify_events_added          boolean NOT NULL DEFAULT true,
  -- Jour du point de la semaine (ISO, 7 = dimanche) et heure locale (minutes multiples de 5 : planificateur toutes les 5 minutes)
  weekly_digest_weekday        smallint NOT NULL DEFAULT 7 CHECK (weekly_digest_weekday BETWEEN 1 AND 7),
  weekly_digest_time           time NOT NULL DEFAULT '19:00'
                                 CHECK (date_part('minute', weekly_digest_time)::integer % 5 = 0 AND date_part('second', weekly_digest_time) = 0),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_user_assistant_settings_user FOREIGN KEY (user_id, account_id)
    REFERENCES users (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_user_assistant_settings_account_id ON user_assistant_settings (account_id);
COMMENT ON TABLE user_assistant_settings IS $$Réglages personnels d'un profil, une colonne par réglage : prévenu des RDV ajoutés (US-113), rappel quotidien des tâches, point de la semaine. Créée à la première modification ; absence de ligne = valeurs par défaut. [US-97 RF8, US-98 RF7]$$;

-- Vacances scolaires par zone, chargées chaque année depuis la source officielle (US-109 RT3)
CREATE TABLE school_holiday_periods (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zone         char(1) NOT NULL CHECK (zone IN ('A', 'B', 'C')),
  school_year  varchar(9) NOT NULL CHECK (school_year ~ '^[0-9]{4}-[0-9]{4}$'),
  label        varchar(80) NOT NULL,
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  UNIQUE (zone, starts_on),
  CONSTRAINT ck_school_holiday_period CHECK (ends_on >= starts_on)
);
COMMENT ON TABLE school_holiday_periods IS $$Périodes de vacances scolaires par zone (A, B, C), chargées chaque année depuis la source officielle ; les années de plus de 2 ans sont purgées. [US-109 RF4, RT3]$$;

-- ---------------------------------------------------------------------
-- Anticipation : catalogue, situation de la famille, questions à trois choix (US-102, US-108, AT-6, AT-7)
-- ---------------------------------------------------------------------
-- Questions du court questionnaire de situation (5 au plus) : une table, pour ajouter la 5e sans migration
CREATE TABLE family_situation_questions (
  situation_key  text PRIMARY KEY CHECK (situation_key ~ '^[a-z_]+$'),
  label          varchar(150) NOT NULL,
  sort_order     smallint NOT NULL DEFAULT 1
);
COMMENT ON TABLE family_situation_questions IS $$Questions du questionnaire de situation de la famille (véhicule, logement, animal, scolarité ; 5 au plus), tenues par l'équipe produit. [US-102 RF2]$$;
INSERT INTO family_situation_questions (situation_key, label, sort_order) VALUES
  ('vehicle',          'Avez-vous un véhicule ?', 1),
  ('home_owner',       'Êtes-vous propriétaire de votre logement ?', 2),
  ('pet',              'Avez-vous un animal ?', 3),
  ('children_schooled','Vos enfants sont-ils scolarisés ?', 4);

CREATE TABLE family_situation_answers (
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  situation_key       text NOT NULL REFERENCES family_situation_questions (situation_key) ON DELETE CASCADE,
  answer              boolean NOT NULL,
  answered_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  answered_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, situation_key)
);
CREATE INDEX idx_situation_answers_answered_by ON family_situation_answers (answered_by_user_id);
CREATE INDEX idx_situation_answers_key ON family_situation_answers (situation_key);
COMMENT ON TABLE family_situation_answers IS $$Réponses de la famille au questionnaire de situation. Absence de ligne = sans réponse : seules les échéances sans condition de situation sont proposées. [US-102 RF2]$$;

-- Chaque chargement du catalogue appliqué depuis la console d'administration (US-111 RF11, D50)
CREATE TABLE anticipation_catalog_loads (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  loaded_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  loaded_at            timestamptz NOT NULL DEFAULT now(),
  file_name            varchar(200) NOT NULL,
  rows_total           integer NOT NULL CHECK (rows_total >= 0),
  rows_created         integer NOT NULL DEFAULT 0 CHECK (rows_created >= 0),
  rows_updated         integer NOT NULL DEFAULT 0 CHECK (rows_updated >= 0),
  rows_disabled        integer NOT NULL DEFAULT 0 CHECK (rows_disabled >= 0),
  rows_unchanged       integer NOT NULL DEFAULT 0 CHECK (rows_unchanged >= 0)
);
CREATE INDEX idx_catalog_loads_loaded_by ON anticipation_catalog_loads (loaded_by_user_id);
CREATE INDEX idx_catalog_loads_loaded_at ON anticipation_catalog_loads (loaded_at);
COMMENT ON TABLE anticipation_catalog_loads IS $$Historique des chargements du catalogue d'anticipation depuis la console (fichier Excel) : administrateur, date, fichier, nombres de créations, modifications, désactivations. Le chargement s'applique en entier ou pas du tout. [US-111 RF11, D50]$$;

-- Catalogue d'échéances types, géré depuis la console d'administration par chargement d'un fichier Excel (US-111, D50)
CREATE TABLE anticipation_catalog_items (
  id                         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                       text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  -- Peut contenir {membre}, remplacé à l'affichage par le prénom du membre concerné
  label                      varchar(200) NOT NULL,
  category                   varchar(40) NOT NULL,
  is_medical                 boolean NOT NULL DEFAULT false,
  active                     boolean NOT NULL DEFAULT true,
  -- Question posée pour un membre précis (âge, rôle) ou pour la famille
  per_member                 boolean NOT NULL DEFAULT false,
  -- Période concernée (peut chevaucher le 31/12, par exemple novembre à février)
  period_start_month         smallint NOT NULL CHECK (period_start_month BETWEEN 1 AND 12),
  period_start_day           smallint NOT NULL DEFAULT 1 CHECK (period_start_day BETWEEN 1 AND 31),
  period_end_month           smallint NOT NULL CHECK (period_end_month BETWEEN 1 AND 12),
  period_end_day             smallint NOT NULL DEFAULT 28 CHECK (period_end_day BETWEEN 1 AND 31),
  lead_days                  smallint NOT NULL DEFAULT 21 CHECK (lead_days >= 0),
  every_n_years              smallint NOT NULL DEFAULT 1 CHECK (every_n_years BETWEEN 1 AND 10),
  -- Conditions (toutes à remplir) : rôle et âge du membre, situation de la famille
  target_role                member_role,
  min_age_months             smallint CHECK (min_age_months >= 0),
  max_age_months             smallint CHECK (max_age_months >= 0),
  situation_key              text REFERENCES family_situation_questions (situation_key) ON DELETE RESTRICT,
  situation_required_value   boolean,
  -- Contenu médical validé par une source officielle puis relu avant publication (US-102 RT4)
  source_reference           text,
  reviewed_at                timestamptz,
  -- Référent santé (médecin ou pharmacien conseil) qui a validé le contenu médical avant le chargement (D54)
  reviewed_by                varchar(100),
  -- Numéro de version : monte à chaque modification de contenu (l'ancienne ligne est archivée) ; dernier chargement concerné
  version                    integer NOT NULL DEFAULT 1,
  last_load_id               bigint REFERENCES anticipation_catalog_loads (id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_catalog_age CHECK (min_age_months IS NULL OR max_age_months IS NULL OR min_age_months <= max_age_months),
  CONSTRAINT ck_catalog_per_member CHECK (per_member OR (target_role IS NULL AND min_age_months IS NULL AND max_age_months IS NULL)),
  CONSTRAINT ck_catalog_situation CHECK ((situation_key IS NULL) = (situation_required_value IS NULL)),
  CONSTRAINT ck_catalog_medical_reviewed CHECK (NOT (is_medical AND active) OR (reviewed_at IS NOT NULL AND source_reference IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE INDEX idx_catalog_items_situation_key ON anticipation_catalog_items (situation_key);
CREATE INDEX idx_catalog_items_last_load ON anticipation_catalog_items (last_load_id);
COMMENT ON TABLE anticipation_catalog_items IS $$Catalogue d'anticipation : échéances types (impôts, rentrée, contrôle technique, suivis médicaux selon l'âge…) avec période, délai, fréquence et conditions. Données de référence. [US-102 RF1, RT1, RT4]$$;
COMMENT ON COLUMN anticipation_catalog_items.every_n_years IS $$Fréquence : 1 = chaque année, 2 = tous les 2 ans… Une échéance réglée (« Oui ») revient la période suivante après ce délai$$;
COMMENT ON COLUMN anticipation_catalog_items.is_medical IS $$Question médicale générique (âge et catalogue seulement, jamais l'historique des RDV, D44). Un contenu médical actif exige une source et une relecture$$;

-- Versions précédentes d'une échéance du catalogue : copie de l'ancienne ligne à chaque modification de contenu, gardée 12 mois (D54)
CREATE TABLE anticipation_catalog_item_history (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id                   integer NOT NULL REFERENCES anticipation_catalog_items (id) ON DELETE CASCADE,
  version                   integer NOT NULL,
  replaced_at               timestamptz NOT NULL DEFAULT now(),
  -- Chargement qui a produit cette version, et chargement qui l'a remplacée
  produced_by_load_id       bigint REFERENCES anticipation_catalog_loads (id) ON DELETE SET NULL,
  replaced_by_load_id       bigint REFERENCES anticipation_catalog_loads (id) ON DELETE SET NULL,
  code                      text NOT NULL,
  label                     varchar(200) NOT NULL,
  category                  varchar(40) NOT NULL,
  is_medical                boolean NOT NULL,
  active                    boolean NOT NULL,
  per_member                boolean NOT NULL,
  period_start_month        smallint NOT NULL,
  period_start_day          smallint NOT NULL,
  period_end_month          smallint NOT NULL,
  period_end_day            smallint NOT NULL,
  lead_days                 smallint NOT NULL,
  every_n_years             smallint NOT NULL,
  target_role               member_role,
  min_age_months            smallint,
  max_age_months            smallint,
  situation_key             text,
  situation_required_value  boolean,
  source_reference          text,
  reviewed_at               timestamptz,
  reviewed_by               varchar(100),
  UNIQUE (item_id, version)
);
CREATE INDEX idx_catalog_item_history_replaced_at ON anticipation_catalog_item_history (replaced_at);
CREATE INDEX idx_catalog_item_history_produced_by ON anticipation_catalog_item_history (produced_by_load_id);
CREATE INDEX idx_catalog_item_history_replaced_by ON anticipation_catalog_item_history (replaced_by_load_id);
COMMENT ON TABLE anticipation_catalog_item_history IS $$Versions précédentes des échéances du catalogue (contenu complet, avec le chargement qui les a produites et celui qui les a remplacées), gardées 12 mois. [US-111, D54]$$;

-- La carte : un état par échéance (catalogue) ou par RDV qui revient (historique)
CREATE TABLE anticipation_questions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  origin             question_origin NOT NULL,
  catalog_item_id    integer REFERENCES anticipation_catalog_items (id) ON DELETE RESTRICT,
  member_id          uuid,
  -- Période concernée ; period_end = date limite, échéance de la tâche créée par « Non, à faire » (US-102 RF6)
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  -- Suggestion tirée de l'historique (US-108) : date anniversaire, RDV d'ancrage, identité stable et titre figé (chiffré)
  anchor_date        date,
  anchor_event_id    uuid REFERENCES family_events (id) ON DELETE SET NULL,
  suggestion_key     bytea,
  -- Question du catalogue : libellé du catalogue au moment où elle est posée, avec le repère {membre} (jamais le prénom) ;
  -- recopié par trigger. Suggestion de l'historique : aucun texte, le titre vient du RDV d'origine (D54)
  label_template     varchar(200),
  status             question_status NOT NULL DEFAULT 'pending',
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  remind_at          date,
  -- Lundi de la semaine où la carte a été présentée (au plus 5 par semaine et par famille, AT-7)
  presented_week     date CHECK (presented_week IS NULL OR date_part('isodow', presented_week) = 1),
  times_presented    smallint NOT NULL DEFAULT 0 CHECK (times_presented >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_questions_member FOREIGN KEY (member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_questions_period CHECK (period_end >= period_start),
  CONSTRAINT ck_questions_origin CHECK (
    (origin = 'catalog' AND catalog_item_id IS NOT NULL AND suggestion_key IS NULL AND anchor_date IS NULL AND label_template IS NOT NULL)
    OR (origin = 'history' AND catalog_item_id IS NULL AND suggestion_key IS NOT NULL AND anchor_date IS NOT NULL AND label_template IS NULL)),
  CONSTRAINT ck_questions_snoozed CHECK ((status = 'snoozed') = (remind_at IS NOT NULL)),
  CONSTRAINT ck_questions_remind CHECK (remind_at IS NULL OR remind_at <= period_end)
);
-- Une question par échéance, membre et période (membre NULL = question de famille) ; une par RDV qui revient et par date anniversaire
CREATE UNIQUE INDEX ux_questions_catalog ON anticipation_questions (account_id, catalog_item_id, member_id, period_start) NULLS NOT DISTINCT
  WHERE origin = 'catalog';
CREATE UNIQUE INDEX ux_questions_history ON anticipation_questions (account_id, suggestion_key, anchor_date) WHERE origin = 'history';
CREATE INDEX idx_questions_open ON anticipation_questions (account_id, period_end) WHERE status IN ('pending', 'snoozed');
CREATE INDEX idx_questions_week ON anticipation_questions (account_id, presented_week);
CREATE INDEX idx_questions_period_end ON anticipation_questions (period_end);
CREATE INDEX idx_questions_catalog_item_id ON anticipation_questions (catalog_item_id);
CREATE INDEX idx_questions_member ON anticipation_questions (member_id);
CREATE INDEX idx_questions_anchor_event_id ON anticipation_questions (anchor_event_id);
COMMENT ON TABLE anticipation_questions IS $$Question à trois choix (« Oui, c'est fait ou prévu » / « Non, à faire » / « Me le rappeler dans… ») issue du catalogue ou de l'historique non médical. Réservée aux parents ; la réponse d'un parent vaut pour la famille. [US-102, US-108, AT-6, AT-7]$$;
COMMENT ON COLUMN anticipation_questions.suggestion_key IS $$Suggestion de l'historique : empreinte (HMAC) du titre normalisé et du type, avec le foyer. Identité stable d'un RDV qui revient, même quand le RDV d'origine est purgé$$;
COMMENT ON COLUMN anticipation_questions.label_template IS $$Libellé du catalogue au moment où la question est posée, avec le repère {membre} remplacé à l'affichage : la question garde son ancien libellé sans jamais contenir de prénom. Vide pour une suggestion de l'historique, dont le texte est recomposé à partir du RDV d'origine (D54)$$;
COMMENT ON COLUMN anticipation_questions.presented_week IS $$Lundi de la semaine de présentation : au plus 5 questions par semaine et par famille, catalogue et historique confondus (AT-7). Une question sans réponse peut être présentée à nouveau$$;
COMMENT ON COLUMN anticipation_questions.status IS $$pending ; snoozed (« Me le rappeler », reposée à remind_at) ; settled (« Oui ») ; task_created (« Non » : une tâche existe) ; dismissed (« Ne plus me le proposer ») ; expired (période terminée sans réponse)$$;

-- « Ne plus me le proposer » (US-108 RF7) : l'empreinte suffit à ne plus poser la question ; le titre chiffré sert l'export
CREATE TABLE anticipation_opt_outs (
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  suggestion_key      bytea NOT NULL,
  created_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, suggestion_key)
);
CREATE INDEX idx_opt_outs_created_by ON anticipation_opt_outs (created_by_user_id);
COMMENT ON TABLE anticipation_opt_outs IS $$RDV pour lesquels un parent ne veut plus de suggestion (« Ne plus me le proposer »), repérés par une empreinte sans titre ni prénom. Conservés jusqu'à la suppression du foyer. [US-108 RF7, D54]$$;

-- ---------------------------------------------------------------------
-- Tâches (US-110, US-95, US-96) : une tâche seule, liée à un RDV, ou l'occurrence d'une tâche récurrente
-- ---------------------------------------------------------------------
CREATE TABLE family_task_series (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  title                bytea NOT NULL,
  note                 bytea,
  assigned_member_id   uuid,
  due_time             time,
  -- Deux modes exclusifs : règle propre (les poubelles chaque mardi) ou « une tâche par séance » d'une série de RDV (US-95 RF9)
  event_series_id      uuid,
  days_before_event    smallint CHECK (days_before_event >= 0),
  first_date           date,
  repeat_unit          series_repeat_unit,
  repeat_interval      smallint NOT NULL DEFAULT 1,
  weekdays             smallint[],
  month_mode           series_month_mode,
  month_day            smallint,
  month_nth            smallint,
  month_weekday        smallint,
  end_kind             series_end_kind NOT NULL DEFAULT 'never',
  until_date           date,
  occurrence_count     integer CHECK (occurrence_count > 0),
  -- Dernière date pour laquelle les occurrences sont créées (8 semaines glissantes)
  materialized_until   date,
  ended_at             timestamptz,
  -- Modèle proposé avec une série de RDV provisoire (D48) : sans occurrence tant que la série n'est pas confirmée
  proposed             boolean NOT NULL DEFAULT false,
  created_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  source               task_source NOT NULL DEFAULT 'user',
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT ck_task_series_proposed CHECK (NOT proposed OR event_series_id IS NOT NULL),
  CONSTRAINT fk_task_series_member FOREIGN KEY (assigned_member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_task_series_event_series FOREIGN KEY (event_series_id, account_id)
    REFERENCES family_event_series (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_task_series_mode CHECK (
    (event_series_id IS NOT NULL AND days_before_event IS NOT NULL AND first_date IS NULL AND repeat_unit IS NULL
       AND repeat_interval = 1 AND weekdays IS NULL AND month_mode IS NULL AND month_day IS NULL AND month_nth IS NULL
       AND month_weekday IS NULL AND end_kind = 'never' AND until_date IS NULL AND occurrence_count IS NULL)
    OR (event_series_id IS NULL AND days_before_event IS NULL AND first_date IS NOT NULL AND repeat_unit IS NOT NULL
       AND series_rule_valid(repeat_unit, repeat_interval, weekdays, month_mode, month_day, month_nth, month_weekday))),
  CONSTRAINT ck_task_series_end CHECK (
    (end_kind = 'date') = (until_date IS NOT NULL) AND (end_kind = 'count') = (occurrence_count IS NOT NULL)
    AND (until_date IS NULL OR first_date IS NULL OR until_date >= first_date))
);
CREATE INDEX idx_task_series_account_active ON family_task_series (account_id) WHERE ended_at IS NULL;
CREATE INDEX idx_task_series_planning ON family_task_series (materialized_until) WHERE ended_at IS NULL AND event_series_id IS NULL;
CREATE INDEX idx_task_series_event_series ON family_task_series (event_series_id);
CREATE INDEX idx_task_series_member ON family_task_series (assigned_member_id);
CREATE INDEX idx_task_series_created_by ON family_task_series (created_by_user_id);
COMMENT ON TABLE family_task_series IS $$Tâche récurrente (règle propre, au plus 50 actives par famille) ou tâche qui s'applique à chaque séance d'une série de RDV (comptée dans les 10 tâches de la série). Les occurrences sont des lignes de family_tasks, créées 8 semaines à l'avance. [US-110, US-95 RF9, D41]$$;
COMMENT ON COLUMN family_task_series.event_series_id IS $$Mode « suit une série de RDV » : une occurrence par séance, échéance = date de la séance moins days_before_event. NULL = règle propre$$;
COMMENT ON COLUMN family_task_series.proposed IS $$Modèle de tâche proposé avec une série de RDV provisoire : confirm_family_series le passe à faux, le planificateur l'ignore tant qu'il est proposé, l'abandon de la série le supprime (D48)$$;
COMMENT ON COLUMN family_task_series.ended_at IS $$Série terminée ou annulée : plus d'occurrence créée, comptée hors des 50 tâches récurrentes actives$$;

CREATE TABLE family_tasks (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  series_id                  uuid,
  -- Date d'origine de l'occurrence dans la série : clé d'idempotence du planificateur
  occurrence_date            date,
  event_id                   uuid,
  -- Chiffrés. Pour un RDV médical, titre générique sans spécialité ni motif (AT-4)
  title                      bytea NOT NULL,
  note                       bytea,
  status                     task_status NOT NULL DEFAULT 'todo',
  -- Échéance : date locale (fuseau de la famille) et heure facultative (« avant 8 h 15 »)
  due_date                   date NOT NULL,
  due_time                   time,
  -- Tâche relative à un RDV : écart conservé quand le RDV est déplacé (US-95 RF6)
  days_before_event          smallint CHECK (days_before_event >= 0),
  -- Toujours un membre, jamais un profil (US-96 RT1) ; NULL = personne, suivie par les deux parents (AT-3)
  assigned_member_id         uuid,
  done_by_member_id          uuid,
  done_at                    timestamptz,
  status_changed_at          timestamptz NOT NULL DEFAULT now(),
  status_changed_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  cancel_reason              task_cancel_reason,
  created_by_user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  source                     task_source NOT NULL DEFAULT 'user',
  -- Question à trois choix à l'origine de la tâche (« Non, à faire ») : une seule tâche par question
  origin_question_id         uuid REFERENCES anticipation_questions (id) ON DELETE SET NULL,
  -- Lot 10 : semaine de devoirs à l'origine de la tâche « Devoirs — [prénom] (N éléments) » (source « homework », US-119 RF4) ;
  -- le lien vers homework_weeks est ajouté avec cette table, plus bas
  homework_week_id           uuid,
  version                    integer NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_tasks_series FOREIGN KEY (series_id, account_id)
    REFERENCES family_task_series (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_tasks_event FOREIGN KEY (event_id, account_id)
    REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_tasks_assigned FOREIGN KEY (assigned_member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_tasks_done_by FOREIGN KEY (done_by_member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_tasks_done CHECK ((status = 'done') = (done_at IS NOT NULL) AND (status = 'done') = (done_by_member_id IS NOT NULL)),
  CONSTRAINT ck_tasks_cancelled CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CONSTRAINT ck_tasks_proposed CHECK (status <> 'proposed' OR event_id IS NOT NULL),
  CONSTRAINT ck_tasks_offset CHECK (days_before_event IS NULL OR event_id IS NOT NULL),
  CONSTRAINT ck_tasks_occurrence CHECK (series_id IS NULL OR occurrence_date IS NOT NULL)
);
CREATE UNIQUE INDEX ux_tasks_series_occurrence ON family_tasks (series_id, occurrence_date) WHERE series_id IS NOT NULL;
CREATE UNIQUE INDEX ux_tasks_origin_question ON family_tasks (origin_question_id) WHERE origin_question_id IS NOT NULL;
CREATE INDEX idx_tasks_due ON family_tasks (account_id, due_date) WHERE status = 'todo';
CREATE INDEX idx_tasks_closed ON family_tasks (status_changed_at) WHERE status IN ('done', 'cancelled');
CREATE INDEX idx_tasks_event ON family_tasks (event_id);
CREATE INDEX idx_tasks_assigned ON family_tasks (assigned_member_id);
CREATE INDEX idx_tasks_done_by ON family_tasks (done_by_member_id);
CREATE INDEX idx_tasks_status_changed_by ON family_tasks (status_changed_by_user_id);
CREATE INDEX idx_tasks_created_by ON family_tasks (created_by_user_id);
COMMENT ON TABLE family_tasks IS $$Tâche de la famille : préparatoire (liée à un RDV), seule, ou occurrence d'une tâche récurrente. Statuts : proposée, à faire, faite, annulée ; « En retard » est un affichage calculé (v_family_tasks). [US-95, US-96, US-110, AT-1 à AT-5]$$;
COMMENT ON COLUMN family_tasks.status IS $$proposed = suggérée par l'agent, visible dans « À préparer » ; todo ; done (avec auteur et date) ; cancelled (motif obligatoire). « En retard » n'est pas un statut$$;
COMMENT ON COLUMN family_tasks.title IS $$Titre chiffré. Titre générique pour une tâche liée à un RDV médical (AT-4) ; transmis à l'agent uniquement sous forme de référence (D39)$$;
COMMENT ON COLUMN family_tasks.days_before_event IS $$Échéance relative au RDV : nombre de jours avant. L'écart est conservé quand le RDV est déplacé (US-95 RF6)$$;
COMMENT ON COLUMN family_tasks.done_by_member_id IS $$Membre qui a coché la tâche (« Faite par [prénom] ») : le membre survit à la suppression d'un profil, avec son alias$$;
COMMENT ON COLUMN family_tasks.cancel_reason IS $$user ; event_cancelled (RDV annulé ou ignoré) ; series_ended ; expired (jamais faite, annulée automatiquement 45 jours après l'échéance)$$;
COMMENT ON COLUMN family_tasks.origin_question_id IS $$Question d'anticipation qui a créé la tâche (réponse « Non, à faire ») : unique, pas de double création (CC-7)$$;

CREATE TABLE anticipation_answers (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id          uuid NOT NULL REFERENCES anticipation_questions (id) ON DELETE CASCADE,
  answer               question_answer NOT NULL,
  remind_months        smallint CHECK (remind_months IN (1, 3, 6)),
  answered_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  answered_at          timestamptz NOT NULL DEFAULT now(),
  created_task_id      uuid REFERENCES family_tasks (id) ON DELETE SET NULL,
  CONSTRAINT ck_answers_remind CHECK ((answer = 'remind_later') = (remind_months IS NOT NULL))
);
CREATE INDEX idx_answers_question ON anticipation_answers (question_id, answered_at);
CREATE INDEX idx_answers_answered_by ON anticipation_answers (answered_by_user_id);
CREATE INDEX idx_answers_created_task ON anticipation_answers (created_task_id);
COMMENT ON TABLE anticipation_answers IS $$Journal des réponses aux questions à trois choix : réponse, auteur, date, tâche créée. Conservé 24 mois après la période, avec la question. [US-102 RT3, US-108, AT-6]$$;

-- ---------------------------------------------------------------------
-- Point de la semaine (US-98) : le résumé de l'agent, une fois par famille ; les listes sont calculées en direct
-- ---------------------------------------------------------------------
CREATE TABLE weekly_digests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Lundi de la semaine couverte
  week_start       date NOT NULL CHECK (date_part('isodow', week_start) = 1),
  summary_status   digest_summary_status NOT NULL DEFAULT 'pending',
  -- Résumé chiffré, rédigé avec des références (jamais de titre, lieu ni prénom) remplacées à l'affichage ; réservé aux parents
  agent_summary    bytea,
  generated_at     timestamptz,
  events_count     integer CHECK (events_count >= 0),
  tasks_count      integer CHECK (tasks_count >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, week_start),
  CONSTRAINT ck_weekly_digests_generated CHECK ((summary_status = 'generated') = (agent_summary IS NOT NULL AND generated_at IS NOT NULL))
);
CREATE INDEX idx_weekly_digests_week ON weekly_digests (week_start);
COMMENT ON TABLE weekly_digests IS $$Résumé de l'agent du point hebdomadaire, une fois par famille et par semaine, conservé 4 semaines. Les listes (RDV, tâches, points d'attention) sont calculées en direct selon la visibilité du profil ; l'invité secondaire n'a pas le résumé de l'agent. [US-98]$$;

-- ---------------------------------------------------------------------
-- Trajets (US-107, D42, D46, D47). Jamais d'adresse de domicile. La seule position conservée est la dernière position
-- connue d'un appareil : chiffrée, 3 heures au plus, jamais visible des autres profils.
-- ---------------------------------------------------------------------
CREATE TABLE device_location_consents (
  device_id       uuid PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  withdrawn_at    timestamptz,
  notice_version  varchar(20) NOT NULL,
  purpose         text NOT NULL DEFAULT 'travel_time' CHECK (purpose ~ '^[a-z_]+$'),
  CONSTRAINT ck_location_consents_withdrawn CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);
COMMENT ON TABLE device_location_consents IS $$Consentement à la lecture de la position, par appareil, avec sa date et sa version d'information ; retirable à tout moment. Chaque changement est inscrit dans device_location_consent_events. [US-107 RF11, RT5]$$;

-- Journal des consentements à la position (D54, décision du DPO) : preuve de l'accord et du retrait, par appareil. Sans clé
-- étrangère : la preuve survit à l'appareil et au profil (comme forwarding_consent_events). Alimenté par trigger.
CREATE TABLE device_location_consent_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  action          consent_action NOT NULL,
  cause           location_consent_cause NOT NULL DEFAULT 'user_action',
  notice_version  varchar(20) NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  retain_until    date NOT NULL
);
CREATE INDEX idx_location_consent_events_device ON device_location_consent_events (device_id, occurred_at);
CREATE INDEX idx_location_consent_events_user ON device_location_consent_events (user_id);
CREATE INDEX idx_location_consent_events_retain_until ON device_location_consent_events (retain_until);
COMMENT ON TABLE device_location_consent_events IS $$Journal des consentements à la position : appareil, profil (identifiant seul), accord ou retrait, version du texte, date. Sans clé étrangère, conservé 5 ans après l'événement (réglable). [US-107 RF11, RT5, D54]$$;
COMMENT ON COLUMN device_location_consent_events.cause IS $$user_action = choix de l'utilisateur ; device_revoked = appareil révoqué ; device_deleted = appareil ou profil supprimé$$;

CREATE TABLE device_last_positions (
  device_id           uuid PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  -- Latitude et longitude, chiffrées par l'application
  position_encrypted  bytea NOT NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  -- Au plus 3 heures après la lecture, et jamais au-delà de la fin du RDV suivi : vérifié par la base (D47, US-107 RF12)
  expires_at          timestamptz NOT NULL,
  CONSTRAINT ck_last_positions_expiry CHECK (expires_at > captured_at AND expires_at <= captured_at + interval '3 hours')
);
CREATE INDEX idx_last_positions_expiry ON device_last_positions (expires_at);
COMMENT ON TABLE device_last_positions IS $$Dernière position connue d'un appareil (une ligne, remplacée à chaque lecture), chiffrée, conservée 3 heures au plus et jamais au-delà de la fin du RDV suivi. Jamais affichée aux autres profils. [US-107 RF5, RF12, D46, D47]$$;
COMMENT ON COLUMN device_last_positions.expires_at IS $$Fin de conservation : au plus captured_at + 3 heures (contrôle en base), ramenée à la fin du RDV suivi par l'application. La purge tourne toutes les 5 minutes et la lecture ignore les lignes échues$$;

-- « Suivre mon trajet » : propre à chaque profil, par RDV ou par série (D47)
CREATE TABLE travel_tracking (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  event_id    uuid,
  series_id   uuid,
  -- false sur une séance : écarte cette séance d'un suivi de série
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_travel_tracking_user FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_travel_tracking_event FOREIGN KEY (event_id, account_id) REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_travel_tracking_series FOREIGN KEY (series_id, account_id) REFERENCES family_event_series (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_travel_tracking_target CHECK (num_nonnulls(event_id, series_id) = 1)
);
CREATE UNIQUE INDEX ux_travel_tracking_event ON travel_tracking (user_id, event_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX ux_travel_tracking_series ON travel_tracking (user_id, series_id) WHERE series_id IS NOT NULL;
CREATE INDEX idx_travel_tracking_event ON travel_tracking (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_travel_tracking_series ON travel_tracking (series_id) WHERE series_id IS NOT NULL;
CREATE INDEX idx_travel_tracking_account_id ON travel_tracking (account_id);
COMMENT ON TABLE travel_tracking IS $$Suivi du trajet activé par un profil pour un RDV ou une série qui le concerne. Seuls les profils qui l'ont activé sont notifiés. Jamais pour un RDV médical, ni sans lieu. [US-107 RF4, D47]$$;

-- Estimation d'un profil pour un RDV : heure de départ conseillée et durée, conservées jusqu'à la fin du RDV (RF12)
CREATE TABLE event_travel_advice (
  event_id                uuid NOT NULL,
  user_id                 uuid NOT NULL,
  account_id              uuid NOT NULL,
  status                  travel_status NOT NULL DEFAULT 'pending',
  -- D'où part l'estimation : lieu du RDV précédent, dernière position connue, écran de suivi ouvert, ou rien
  origin_kind             travel_origin NOT NULL DEFAULT 'none',
  origin_event_id         uuid REFERENCES family_events (id) ON DELETE SET NULL,
  first_computed_at       timestamptz,
  first_duration_minutes  integer CHECK (first_duration_minutes > 0),
  advised_departure_at    timestamptz,
  second_computed_at      timestamptz,
  second_duration_minutes integer CHECK (second_duration_minutes > 0),
  -- Durée sans trafic estimée à l'activation du suivi, depuis la position du téléphone si elle est autorisée (US-107 RF5, D52) ;
  -- affichée sous le lieu, propre à chaque profil (D55). Vide tant qu'aucune estimation n'est possible
  estimated_duration_minutes integer CHECK (estimated_duration_minutes > 0),
  estimated_at            timestamptz,
  notified_first_at       timestamptz,
  notified_second_at      timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CONSTRAINT fk_travel_advice_event FOREIGN KEY (event_id, account_id) REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_travel_advice_user FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_travel_advice_first CHECK ((first_computed_at IS NULL) = (first_duration_minutes IS NULL)),
  CONSTRAINT ck_travel_advice_second CHECK ((second_computed_at IS NULL) = (second_duration_minutes IS NULL)),
  CONSTRAINT ck_travel_advice_estimated CHECK ((estimated_at IS NULL) = (estimated_duration_minutes IS NULL))
);
CREATE INDEX idx_travel_advice_user ON event_travel_advice (user_id);
CREATE INDEX idx_travel_advice_account_id ON event_travel_advice (account_id);
CREATE INDEX idx_travel_advice_origin_event ON event_travel_advice (origin_event_id);
COMMENT ON TABLE event_travel_advice IS $$Estimation de trajet d'un profil pour un RDV : base de départ, durées, heure de départ conseillée, notifications envoyées. Aucune position. Supprimée à la fin du RDV. [US-107 RF5 à RF8, RF12]$$;

-- ---------------------------------------------------------------------
-- « Sur place » : où se garer et où manger près d'un RDV (US-112, D52, D55). Une ligne par recherche : elle sert de travail à
-- exécuter, d'état et de résultat. Aucun point médian, aucune coordonnée arrondie, aucun texte de requête, aucun avis n'est
-- stocké. La liste des adresses est un seul bloc chiffré : elle est dérivée de l'adresse du RDV, donc aussi sensible qu'elle.
-- ---------------------------------------------------------------------
CREATE TABLE event_place_searches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_id              uuid NOT NULL,
  requested_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Rang de la recherche pour ce RDV (jamais réutilisé, même après un échec)
  seq                   integer NOT NULL CHECK (seq >= 1),
  origin                place_search_origin NOT NULL,
  status                place_search_status NOT NULL DEFAULT 'queued',
  queued_at             timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  attempts              smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- timeout, service_unavailable ou error ; obligatoire pour un échec
  failure_reason        varchar(40),
  -- Date de vérification : « Informations trouvées sur internet le [date] »
  checked_on            date,
  -- Adresses trouvées, chiffrées : pour chacune, catégorie (parking, petite faim, grande faim), nom, type, ville, distance à pied,
  -- source. Le lien « Voir les avis » est recalculé à l'affichage (nom et ville) ; aucune note ni avis n'est stocké
  result_payload        bytea,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  UNIQUE (event_id, seq),
  CONSTRAINT fk_place_searches_event FOREIGN KEY (event_id, account_id)
    REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_place_searches_payload CHECK ((status = 'done') = (result_payload IS NOT NULL)),
  CONSTRAINT ck_place_searches_failure CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT ck_place_searches_checked CHECK ((status IN ('done', 'no_result')) = (checked_on IS NOT NULL))
);
CREATE INDEX idx_place_searches_pending ON event_place_searches (status, queued_at) WHERE status IN ('queued', 'running');
CREATE INDEX idx_place_searches_account_id ON event_place_searches (account_id);
CREATE INDEX idx_place_searches_requested_by ON event_place_searches (requested_by_user_id);
COMMENT ON TABLE event_place_searches IS $$Recherche « Sur place » d'un RDV (où se garer, où manger) : travail à exécuter, état (en attente, en cours, terminée, aucune information, échec, obsolète) et résultat chiffré. Au plus 3 recherches non échouées par RDV ; supprimée à la fin du RDV. [US-112 RF8, RF9, RT4, RT5, D52]$$;
COMMENT ON COLUMN event_place_searches.status IS $$queued = demandée, pas encore prise ; running = en cours ; done = résultat disponible ; no_result = aucune information fiable ; failed = échec (n'est pas comptée dans les 3 par RDV) ; obsolete = l'adresse du RDV a changé, résultat effacé mais recherche comptée$$;
COMMENT ON COLUMN event_place_searches.result_payload IS $$Adresses trouvées (1 ou 2 parkings, 2 « petite faim », 2 « grande faim » : nom, type, ville, distance à pied, source), JSON chiffré par l'application. Aucun avis ni note ; aucune coordonnée$$;
COMMENT ON COLUMN event_place_searches.seq IS $$Rang de la recherche pour le RDV, attribué par trigger et jamais réutilisé$$;

-- Suggestion automatique de la recherche : une seule fois par RDV (la clé est le RDV), « Non, merci » est mémorisé (US-112 RF3)
CREATE TABLE event_place_suggestions (
  event_id               uuid PRIMARY KEY,
  account_id             uuid NOT NULL,
  suggested_to_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  suggested_at           timestamptz NOT NULL DEFAULT now(),
  answer                 place_suggestion_answer NOT NULL DEFAULT 'pending',
  answered_at            timestamptz,
  -- Recherche lancée par la réponse « Oui »
  search_id              uuid REFERENCES event_place_searches (id) ON DELETE SET NULL,
  CONSTRAINT fk_place_suggestions_event FOREIGN KEY (event_id, account_id)
    REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_place_suggestions_answered CHECK ((answer = 'pending') = (answered_at IS NULL))
);
CREATE INDEX idx_place_suggestions_account_id ON event_place_suggestions (account_id);
CREATE INDEX idx_place_suggestions_user ON event_place_suggestions (suggested_to_user_id);
CREATE INDEX idx_place_suggestions_search ON event_place_suggestions (search_id);
COMMENT ON TABLE event_place_suggestions IS $$Suggestion automatique de la recherche « Sur place », faite une seule fois par RDV, pour un lieu public identifiable ou en cas de doute, jugé par l'agent à la proposition du RDV, avec la réponse (« Oui », « Non, merci »). Un lieu manifestement privé n'est jamais suggéré ; aucun calcul de distance. [US-112 RF3, D60]$$;

-- Messages du tchat : le message « Sur place » ne porte que le lien vers la recherche (le contenu vient de la ligne de recherche,
-- gardée jusqu'à la fin du RDV, alors que les messages sont supprimés à 4 jours)
ALTER TABLE agent_conversation_messages
  ADD COLUMN place_search_id uuid REFERENCES event_place_searches (id) ON DELETE SET NULL;
CREATE INDEX idx_conversation_messages_place_search_id ON agent_conversation_messages (place_search_id) WHERE place_search_id IS NOT NULL;
COMMENT ON COLUMN agent_conversation_messages.place_search_id IS $$Message « Sur place » : recherche dont il présente le résultat (sans copie du contenu)$$;

-- ---------------------------------------------------------------------
-- scheduled_notifications : sujets sans RDV (tâches, jour, semaine) et trajets
-- ---------------------------------------------------------------------
ALTER TABLE scheduled_notifications
  ADD COLUMN task_id uuid REFERENCES family_tasks (id) ON DELETE CASCADE;
-- Envie ajoutée à « Nos envies » (US-149) : la clé étrangère vers couple_wishes est posée avec cette table (lot 13)
ALTER TABLE scheduled_notifications
  ADD COLUMN wish_id uuid;
-- Canal d'une notification « RDV ajouté » ou « RDV à confirmer » (US-113 RT4) : push sur les appareils autorisés, ou « none » quand
-- le destinataire n'en a aucun (la ligne est écrite quand même, pour ne pas réessayer ni renvoyer un arriéré). Jamais par email.
ALTER TABLE scheduled_notifications
  ADD COLUMN channel notification_channel;
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT ck_scheduled_notifications_channel CHECK (
    (kind IN ('event_added', 'event_to_confirm')) = (channel IS NOT NULL)
    AND (channel IS DISTINCT FROM 'none' OR (status = 'not_applicable' AND push_sent_at IS NULL AND email_sent_at IS NULL))
    AND (kind NOT IN ('event_added', 'event_to_confirm') OR email_sent_at IS NULL));
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT ck_scheduled_notifications_subject CHECK (
    CASE WHEN kind = 'wish_added'
           THEN wish_id IS NOT NULL AND event_id IS NULL AND task_id IS NULL AND subject_date IS NULL
         WHEN kind IN ('task_daily', 'weekly_digest', 'outing_proposal')
           THEN subject_date IS NOT NULL AND event_id IS NULL AND task_id IS NULL
         WHEN kind IN ('task_due_1h', 'task_assigned')
           THEN task_id IS NOT NULL AND event_id IS NULL AND subject_date IS NULL
         ELSE event_id IS NOT NULL AND task_id IS NULL AND subject_date IS NULL END);
-- Un double passage du planificateur n'envoie jamais deux fois (US-81 RT2, US-97 RT1)
CREATE UNIQUE INDEX ux_scheduled_notifications_event ON scheduled_notifications (event_id, kind, recipient_user_id, due_at)
  WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX ux_scheduled_notifications_task ON scheduled_notifications (task_id, kind, recipient_user_id, due_at)
  WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX ux_scheduled_notifications_day ON scheduled_notifications (kind, recipient_user_id, subject_date)
  WHERE subject_date IS NOT NULL;
-- Notification de trajet : au plus une par profil et par RDV, ligne mise à jour en place lors d'un nouvel essai (US-107 RT4)
CREATE UNIQUE INDEX ux_scheduled_notifications_travel ON scheduled_notifications (event_id, kind, recipient_user_id)
  WHERE kind IN ('travel_first', 'travel_second');
-- Une seule notification « RDV ajouté » ou « RDV à confirmer » par RDV et par destinataire, tous types confondus : jamais les deux,
-- et aucune confirmation après une notification de RDV provisoire (US-113 RF1, RF4, RT2, RT4)
CREATE UNIQUE INDEX ux_scheduled_notifications_event_notice ON scheduled_notifications (event_id, recipient_user_id)
  WHERE kind IN ('event_added', 'event_to_confirm');
CREATE INDEX idx_scheduled_notifications_task_id ON scheduled_notifications (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_scheduled_notifications_no_event ON scheduled_notifications (due_at) WHERE event_id IS NULL AND status <> 'scheduled';

-- Réglages du MVP2 (US-65)
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('max_tasks_per_event',                  'integer', '10', 1, NULL, $$Tâches préparatoires au plus par RDV, ou par série de RDV (US-95 RF8)$$),
  ('max_recurring_tasks_per_family',       'integer', '50', 1, NULL, $$Tâches récurrentes actives (règle propre) au plus par famille (US-110 RF11)$$),
  ('max_active_event_series_per_family',   'integer', '30', 1, NULL, $$Séries de RDV actives au plus par famille (US-109 RF3)$$),
  ('task_retention_days',                  'integer', '90', 1, NULL, $$Conservation d'une tâche faite ou annulée, en jours (US-110 RT3)$$),
  ('overdue_task_auto_cancel_days',        'integer', '45', 1, NULL, $$Une tâche « À faire » jamais faite est annulée automatiquement ce nombre de jours après son échéance (D47)$$),
  ('overdue_task_reminder_days',           'integer', '7',  1, NULL, $$Une tâche en retard figure dans le rappel quotidien pendant ce nombre de jours (US-97 RF6)$$),
  ('max_questions_per_week',               'integer', '5',  1, NULL, $$Questions de rappel et suggestions présentées au plus par semaine et par famille (AT-7)$$),
  ('weekly_digest_retention_weeks',        'integer', '4',  1, NULL, $$Conservation du point hebdomadaire, en semaines (US-98 RT3)$$),
  ('anticipation_retention_months',        'integer', '24', 1, NULL, $$Conservation des questions et réponses d'anticipation après la fin de leur période, en mois (D47)$$),
  ('event_series_horizon_months',          'integer', '6',  1, NULL, $$Séances d'une série de RDV créées à l'avance, en mois glissants (US-109 RT1)$$),
  ('task_series_horizon_weeks',            'integer', '8',  1, NULL, $$Occurrences d'une tâche récurrente créées à l'avance, en semaines glissantes (US-110 RT2)$$),
  ('travel_gap_alert_minutes',             'integer', '30', 1, NULL, $$Écart en dessous duquel deux RDV d'un même membre déclenchent l'alerte « RDV rapproché », en minutes (US-107 RF1)$$),
  ('notification_retention_days',          'integer', '30', 1, NULL, $$Conservation des notifications sans RDV (tâches, point de la semaine) après leur échéance, en jours$$),
  ('auto_confirm_delay_hours',              'integer', '72', 1, NULL, $$Un RDV provisoire sans réponse est confirmé automatiquement ce nombre d'heures après sa proposition (AT-8, D49)$$),
  ('auto_confirm_min_lead_hours',           'integer', '2',  1, NULL, $$Le RDV est confirmé au plus tard ce nombre d'heures avant son début ; un RDV proposé moins de ce délai avant son début n'est jamais confirmé automatiquement (AT-8)$$),
  ('auto_confirm_grace_minutes',            'integer', '60', 1, NULL, $$Tolérance après l'échéance d'enregistrement automatique, en minutes : au-delà, le RDV reste à confirmer jusqu'à son début (D51)$$),
  ('location_consent_proof_retention_months', 'integer', '60', 1, NULL, $$Conservation du journal des consentements à la position après l'événement, en mois (D54, décision du DPO)$$),
  ('catalog_version_retention_months',     'integer', '12', 1, NULL, $$Conservation des versions précédentes du catalogue d'anticipation, en mois (D54)$$),
  ('catalog_load_retention_months',        'integer', '60', 1, NULL, $$Conservation de l'historique des chargements du catalogue d'anticipation, en mois (5 ans, comme le journal d'administration, décision du PO du 26/10/2026)$$),
  ('admin_audit_retention_months',         'integer', '60', 1, NULL, $$Conservation du journal d'administration, en mois (5 ans, décision du PO du 26/10/2026)$$),
  ('max_place_searches_per_event',         'integer', '3',  1, NULL, $$Recherches « Sur place » au plus par RDV, hors recherches en échec (US-112 RF9)$$),
  ('place_search_timeout_seconds',         'integer', '120', 1, NULL, $$Une recherche « Sur place » en cours depuis plus longtemps échoue (US-112 RF11)$$),
  ('place_search_queue_grace_seconds',     'integer', '30', 1, NULL, $$Délai après lequel le planificateur prend une recherche « Sur place » restée en attente (filet de sécurité, US-112 RT5)$$),
  ('place_search_max_walk_minutes',        'integer', '15', 1, NULL, $$Distance à pied maximale des adresses « Sur place », en minutes (US-112 RF6, décision du PM)$$),
  ('event_notice_delay_minutes',           'integer', '10', 1, NULL, $$Délai après la proposition d'un RDV pour la notification de l'autre parent : confirmé dans ce délai = « ajouté », sinon « à confirmer » (US-113 RF2, RF3, D57)$$),
  ('event_notice_activation_at',           'timestamp', NULL, NULL, NULL, $$Garde-fou de mise en service de la notification de l'autre parent : seuls les RDV proposés après cette date sont notifiés ; vide = notification désactivée (US-113 RT5)$$);

-- ---------------------------------------------------------------------
-- Fonctions et triggers de l'Assistant Famille
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
CREATE TRIGGER trg_family_members_before_insert BEFORE INSERT ON family_members
  FOR EACH ROW EXECUTE FUNCTION family_member_before_insert();

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
CREATE TRIGGER trg_family_members_before_update BEFORE UPDATE ON family_members
  FOR EACH ROW EXECUTE FUNCTION family_member_before_update();

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
CREATE TRIGGER trg_users_create_member AFTER INSERT ON users
  FOR EACH ROW WHEN (NEW.role <> 'admin') EXECUTE FUNCTION create_member_for_user();

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
CREATE TRIGGER trg_users_sync_member AFTER UPDATE OF first_name, guest_rank, status ON users
  FOR EACH ROW WHEN (OLD.first_name IS DISTINCT FROM NEW.first_name
                  OR OLD.guest_rank IS DISTINCT FROM NEW.guest_rank
                  OR OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION sync_member_from_user();

-- Transitions de statut d'un RDV (AF-1). Faux si la transition n'est pas permise.
CREATE FUNCTION family_event_transition_allowed(p_from event_status, p_to event_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (
    ('provisional', 'confirmed'), ('provisional', 'set_aside'), ('provisional', 'dismissed'),
    ('set_aside', 'confirmed'), ('set_aside', 'dismissed'),
    ('confirmed', 'cancelled'))
$$;
COMMENT ON FUNCTION family_event_transition_allowed(event_status, event_status) IS $$Transitions permises de statut d'un RDV : provisoire → confirmé/écarté/ignoré ; écarté → confirmé/ignoré ; confirmé → annulé. [AF-1, D32]$$;

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
CREATE TRIGGER trg_family_events_before_update BEFORE UPDATE ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_before_update();

-- Au plus 30 RDV par mail (US-91 RF2), séances de série exceptées
CREATE FUNCTION family_event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  -- Les séances d'une série n'entrent pas dans ce plafond : une série compte pour un RDV (US-109)
  IF NEW.source_inbound_email_id IS NOT NULL AND NEW.series_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family_events_mail:' || NEW.source_inbound_email_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_events_per_email';
    SELECT count(*) INTO v_count FROM family_events WHERE source_inbound_email_id = NEW.source_inbound_email_id AND series_id IS NULL;
    IF v_count >= COALESCE(v_max, 30) THEN
      RAISE EXCEPTION 'Au plus % RDV par mail', COALESCE(v_max, 30) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_events_before_insert BEFORE INSERT ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_before_insert();

-- Un RDV « toute la famille » n'a pas de membres désignés
CREATE FUNCTION family_event_member_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM family_events WHERE id = NEW.event_id AND whole_family) THEN
    RAISE EXCEPTION 'Un RDV « toute la famille » n''a pas de membres désignés' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_event_members_before_insert BEFORE INSERT ON family_event_members
  FOR EACH ROW EXECUTE FUNCTION family_event_member_before_insert();

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
CREATE TRIGGER trg_forwarding_senders_before_insert BEFORE INSERT ON forwarding_authorized_senders
  FOR EACH ROW EXECUTE FUNCTION forwarding_sender_before_insert();

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
CREATE TRIGGER trg_conversation_attachments_before_insert BEFORE INSERT ON conversation_attachments
  FOR EACH ROW EXECUTE FUNCTION conversation_attachment_before_insert();

-- Tout fichier lié à une ligne supprimée est mis en file de suppression, y compris en cascade (compte supprimé)
CREATE FUNCTION enqueue_attachment_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.storage_key IS NOT NULL THEN INSERT INTO storage_deletion_queue (storage_key) VALUES (OLD.storage_key); END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_conversation_attachments_enqueue BEFORE DELETE ON conversation_attachments
  FOR EACH ROW EXECUTE FUNCTION enqueue_attachment_file();

CREATE FUNCTION enqueue_inbound_email_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.raw_storage_key IS NOT NULL THEN INSERT INTO storage_deletion_queue (storage_key) VALUES (OLD.raw_storage_key); END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_inbound_emails_enqueue BEFORE DELETE ON inbound_emails
  FOR EACH ROW EXECUTE FUNCTION enqueue_inbound_email_file();

-- Changement de statut atomique, avec contrôle de version et historique (US-75 RT2, RT4 ; US-77 ; US-80).
-- Retourne false si le RDV a déjà été traité ou modifié entre-temps (« Confirmé par … » est alors affiché).
-- MVP2 : un RDV annulé ou ignoré retire ses tâches proposées et à faire (US-95 RF7) ; p_scope = portée pour une séance de série.
CREATE FUNCTION change_family_event_status(
  p_event_id uuid, p_to event_status, p_user_id uuid,
  p_expected_version integer DEFAULT NULL, p_reason event_change_reason DEFAULT 'user_request',
  p_scope change_scope DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_event family_events%ROWTYPE; v_tz text;
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
         confirmed_at = CASE WHEN p_to = 'confirmed' THEN now() ELSE confirmed_at END,
         auto_confirmed = CASE WHEN p_to = 'confirmed' AND p_user_id IS NULL AND p_reason = 'no_response' THEN true ELSE auto_confirmed END
   WHERE id = p_event_id;
  -- Les tâches proposées avec le RDV deviennent « à faire » avec lui, en une seule opération (D48). Une échéance devenue passée
  -- entre-temps est ramenée à aujourd'hui : une tâche ne naît pas en retard.
  IF p_to = 'confirmed' THEN
    SELECT family_timezone INTO v_tz FROM accounts WHERE id = v_event.account_id;
    UPDATE family_tasks
       SET status = 'todo', status_changed_by_user_id = p_user_id, due_date = GREATEST(due_date, (now() AT TIME ZONE v_tz)::date)
     WHERE event_id = p_event_id AND status = 'proposed';
  END IF;
  IF p_to IN ('cancelled', 'dismissed') THEN
    UPDATE family_tasks
       SET status = 'cancelled', cancel_reason = 'event_cancelled', status_changed_by_user_id = p_user_id
     WHERE event_id = p_event_id AND status IN ('proposed', 'todo');
  END IF;
  INSERT INTO family_event_history (event_id, user_id, action, from_status, to_status, reason, series_id, scope)
  VALUES (p_event_id, p_user_id,
          CASE p_to WHEN 'confirmed' THEN 'confirmed' WHEN 'set_aside' THEN 'set_aside'
                    WHEN 'dismissed' THEN 'dismissed' ELSE 'cancelled' END::event_action,
          v_event.status, p_to, p_reason, v_event.series_id, CASE WHEN v_event.series_id IS NOT NULL THEN p_scope END);
  RETURN true;
END $$;
COMMENT ON FUNCTION change_family_event_status(uuid, event_status, uuid, integer, event_change_reason, change_scope) IS $$Change le statut d'un RDV de façon atomique (transition permise, version attendue), écrit l'historique, passe les tâches proposées à « à faire » à la confirmation et retire les tâches proposées ou à faire d'un RDV annulé ou ignoré (un RDV écarté garde ses tâches proposées). Auteur NULL et motif no_response = confirmation d'office. false = déjà traité ou modifié. [US-75, 77, 80, 83, 95 RF7, 109, D48, D49]$$;

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
COMMENT ON FUNCTION confirm_family_events_group(uuid[], uuid) IS $$Confirme plusieurs RDV d'un même mail en une seule transaction : tout ou rien. [US-91]$$;

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
COMMENT ON FUNCTION find_family_event_conflicts(uuid, uuid[], boolean, timestamptz, timestamptz, uuid) IS $$RDV en conflit avec un créneau donné (même membre ou toute la famille, statuts confirmé et provisoire). [US-74]$$;

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
COMMENT ON FUNCTION family_events_visible_to(uuid) IS $$RDV visibles par un profil selon son rang (décision D26). [US-78, 79]$$;

-- Droit de confirmer, modifier, ignorer ou annuler : parents = tous les RDV ; invité secondaire = ses propres demandes (D26)
CREATE FUNCTION can_manage_family_event(p_user_id uuid, p_event_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM family_events e JOIN users u ON u.id = p_user_id AND u.account_id = e.account_id
     WHERE e.id = p_event_id
       AND (u.role = 'primary_user' OR u.guest_rank = 'core' OR e.requested_by_user_id = u.id))
$$;
COMMENT ON FUNCTION can_manage_family_event(uuid, uuid) IS $$Vrai si le profil peut confirmer, modifier, ignorer ou annuler ce RDV (parents : tous ; invité secondaire : ses demandes). [US-75, 80, D26]$$;

-- Onglet « Famille » du carnet de bord : VUE sur l'historique des RDV, les propositions et le suivi des mails
-- (décision du PO : rien n'est écrit dans logbook_entries ; ces lignes disparaissent avec les RDV et le suivi purgés).
CREATE VIEW v_family_logbook AS
-- Une série confirmée ou annulée en une fois produit une seule ligne (même série, même action, même auteur, même transaction)
(SELECT DISTINCT ON (COALESCE(h.series_id, h.event_id), h.action, h.user_id, h.occurred_at, CASE WHEN h.series_id IS NULL THEN h.id END)
        h.event_id AS family_event_id, NULL::uuid AS inbound_email_id, e.account_id, h.occurred_at,
        h.user_id AS actor_user_id,
        CASE h.action WHEN 'confirmed' THEN CASE WHEN h.user_id IS NULL AND h.reason = 'no_response' THEN 'event_auto_confirmed' ELSE 'event_confirmed' END
                      WHEN 'set_aside' THEN 'event_set_aside'
                      WHEN 'dismissed' THEN 'event_dismissed' WHEN 'modified' THEN 'event_modified'
                      ELSE 'event_cancelled' END AS entry_kind
   FROM family_event_history h JOIN family_events e ON e.id = h.event_id
  WHERE h.action IN ('confirmed', 'set_aside', 'dismissed', 'modified', 'cancelled')
    AND (h.user_id IS NOT NULL OR h.action IN ('modified', 'cancelled') OR (h.action = 'confirmed' AND h.reason = 'no_response'))
  ORDER BY COALESCE(h.series_id, h.event_id), h.action, h.user_id, h.occurred_at, CASE WHEN h.series_id IS NULL THEN h.id END, h.event_id)
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
COMMENT ON VIEW v_family_logbook IS $$Entrées de l'onglet « Famille » du carnet : confirmations, abandons, modifications, annulations, propositions traitées, mails reçus. Produite à partir de l'historique des RDV (une ligne par série pour un changement de série ; « RDV ajouté automatiquement » pour une confirmation d'office) et du suivi des mails. [US-40, 75, 77, 80, 87, 89, 90, 109, D49]$$;

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
COMMENT ON FUNCTION family_logbook_visible_to(uuid) IS $$Onglet « Famille » du carnet visible par un profil selon son rang (décision D26). [US-40]$$;

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
COMMENT ON FUNCTION register_inbound_email(uuid, date) IS $$Compte un mail transféré et applique la limite quotidienne de la famille ; indique s'il faut alerter l'utilisateur principal. [US-87 RF12]$$;

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
COMMENT ON FUNCTION delete_orphan_sources(bigint[], uuid[]) IS $$Met en file de suppression les images et mails bruts qui ne sont plus liés à aucun RDV. [US-72 RF8, US-87 RF13, US-93 RT3]$$;

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
  -- MVP2 : tâches à faire non assignées, questions d'anticipation du membre supprimées (aussi faits à l'archivage)
  -- Lot 10 : données Devoirs de l'enfant (âge, progrès, tâches « Devoirs »), supprimées avant que ses tâches ne soient désassignées
  PERFORM erase_member_homework_data(p_member_id);
  UPDATE family_tasks SET assigned_member_id = NULL WHERE assigned_member_id = p_member_id AND status IN ('proposed', 'todo');
  UPDATE family_task_series SET assigned_member_id = NULL WHERE assigned_member_id = p_member_id AND ended_at IS NULL;
  DELETE FROM anticipation_questions WHERE member_id = p_member_id;
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
COMMENT ON FUNCTION anonymize_family_member(uuid, boolean) IS $$Efface un membre (anonymisation) et supprime ses RDV exclusifs et leurs fichiers, ses questions d'anticipation, ses données Devoirs ; ses tâches à faire deviennent non assignées ; trace non nominative. [US-57, 93, 96 RF8, 119 RT5, D34]$$;

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
  -- MVP2 : une série terminée ou annulée disparaît quand il ne lui reste plus aucune séance
  DELETE FROM family_event_series s
   WHERE (s.ended_at IS NOT NULL OR s.status IN ('cancelled', 'dismissed'))
     AND NOT EXISTS (SELECT 1 FROM family_events e WHERE e.series_id = s.id);
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_expired_family_events() IS $$Supprime les RDV annulés ou ignorés (30 jours) et passés (24 mois), avec leurs notifications, historique et tâches liées, puis les séries terminées ou annulées sans séance. À planifier chaque jour. [US-77 RT1, US-80 RT2, US-109, D35]$$;

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
COMMENT ON FUNCTION purge_expired_attachments() IS $$Supprime les images à l'échéance ou dès que tous les RDV qui en sont issus sont traités. À planifier chaque jour. [US-72 RF8]$$;

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
COMMENT ON FUNCTION purge_expired_inbound_emails() IS $$Supprime le contenu brut des mails devenu inutile ou échu, puis les informations de suivi après 90 jours (30 pour les non autorisés). À planifier chaque jour. [US-87 RF13, RT4, US-88 RT2]$$;

-- Messages du tchat conservés par MAAQ : supprimés au bout de 4 jours (US-44). Les images suivent en cascade.
CREATE FUNCTION purge_expired_conversation_messages() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM agent_conversation_messages WHERE expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_expired_conversation_messages() IS $$Supprime les messages conservés depuis plus de 4 jours (images en cascade). À planifier au moins chaque heure. [US-44]$$;

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
COMMENT ON FUNCTION erase_agent_conversations(uuid, bigint) IS $$Supprime les messages des conversations d'un profil (tous les agents, ou un seul). Pour les agents Digitorn, l'effacement reste demandé à Digitorn (chat_erasure_requests). [US-9, 28, 43, 53]$$;

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
COMMENT ON FUNCTION purge_old_daily_counters() IS $$Supprime les compteurs journaliers de demandes et de mails de plus de 7 jours. À planifier chaque jour. [US-38, 70, 87]$$;

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
COMMENT ON FUNCTION purge_expired_request_records() IS $$Supprime les clés d'idempotence et les demandes du tchat de plus de 24 h. À planifier chaque heure. [CC-7, US-38 RT2]$$;


-- ---------------------------------------------------------------------
-- Fonctions et triggers du MVP2
-- ---------------------------------------------------------------------

-- Pas de coordonnées de lieu pour un RDV médical : il n'a pas de suivi de trajet (D46, D47)
CREATE FUNCTION location_point_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_point IS NOT NULL
     AND EXISTS (SELECT 1 FROM event_types WHERE id = NEW.event_type_id AND code = 'medical') THEN
    RAISE EXCEPTION 'Pas de coordonnées de lieu pour un RDV médical (pas de suivi de trajet)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_events_location_point BEFORE INSERT OR UPDATE OF location_point, event_type_id ON family_events
  FOR EACH ROW EXECUTE FUNCTION location_point_guard();
CREATE TRIGGER trg_family_event_series_location_point BEFORE INSERT OR UPDATE OF location_point, event_type_id ON family_event_series
  FOR EACH ROW EXECUTE FUNCTION location_point_guard();

-- Série de RDV : au plus 30 séries actives par famille (D47)
CREATE FUNCTION family_event_series_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  IF NEW.ended_at IS NULL AND NEW.status IN ('provisional', 'confirmed') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family_event_series:' || NEW.account_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_active_event_series_per_family';
    SELECT count(*) INTO v_count FROM family_event_series
     WHERE account_id = NEW.account_id AND ended_at IS NULL AND status IN ('provisional', 'confirmed');
    IF v_count >= COALESCE(v_max, 30) THEN
      RAISE EXCEPTION 'Nombre maximal de séries de RDV actives atteint (%)', COALESCE(v_max, 30) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_event_series_before_insert BEFORE INSERT ON family_event_series
  FOR EACH ROW EXECUTE FUNCTION family_event_series_before_insert();

-- Mêmes transitions que les RDV (provisoire → confirmée ou ignorée ; confirmée → annulée), version, « toute la famille »
CREATE FUNCTION family_event_series_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT family_event_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Transition de statut interdite pour la série : % vers %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
  END IF;
  IF NEW.whole_family AND NOT OLD.whole_family
     AND EXISTS (SELECT 1 FROM family_event_series_members WHERE series_id = NEW.id) THEN
    RAISE EXCEPTION 'Une série « toute la famille » n''a pas de membres désignés' USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_event_series_before_update BEFORE UPDATE ON family_event_series
  FOR EACH ROW EXECUTE FUNCTION family_event_series_before_update();

CREATE FUNCTION family_event_series_member_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM family_event_series WHERE id = NEW.series_id AND whole_family) THEN
    RAISE EXCEPTION 'Une série « toute la famille » n''a pas de membres désignés' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_event_series_members_before_insert BEFORE INSERT ON family_event_series_members
  FOR EACH ROW EXECUTE FUNCTION family_event_series_member_before_insert();

-- Confirmation d'une série d'un seul geste : toutes les séances à venir sont confirmées, ou aucune (US-109 RF6, RT2).
-- Retourne le nombre de séances confirmées ; NULL si la série est introuvable, déjà traitée ou modifiée entre-temps.
CREATE FUNCTION confirm_family_series(p_series_id uuid, p_user_id uuid, p_expected_version integer DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_series family_event_series%ROWTYPE; v_id uuid; v_n integer := 0;
BEGIN
  SELECT * INTO v_series FROM family_event_series WHERE id = p_series_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_expected_version IS NOT NULL AND v_series.version <> p_expected_version THEN RETURN NULL; END IF;
  IF v_series.status <> 'provisional' THEN RETURN NULL; END IF;
  UPDATE family_event_series
     SET status = 'confirmed', confirmed_by_user_id = p_user_id, confirmed_at = now()
   WHERE id = p_series_id;
  -- Les modèles de tâches proposés avec la série deviennent des tâches récurrentes, en même temps qu'elle (D48)
  UPDATE family_task_series SET proposed = false WHERE event_series_id = p_series_id AND proposed;
  FOR v_id IN SELECT id FROM family_events
               WHERE series_id = p_series_id AND status IN ('provisional', 'set_aside') AND starts_at > now()
               ORDER BY starts_at LOOP
    IF NOT change_family_event_status(v_id, 'confirmed', p_user_id, NULL, 'user_request', 'all') THEN
      RAISE EXCEPTION 'La séance % ne peut pas être confirmée', v_id USING ERRCODE = 'check_violation';
    END IF;
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'Aucune séance à venir à confirmer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION confirm_family_series(uuid, uuid, integer) IS $$Confirme une série et toutes ses séances à venir en une seule transaction : tout ou rien. NULL = déjà traitée ou modifiée. [US-109 RF6, RT2]$$;

-- Annulation de toute la série : séances à venir annulées (série confirmée) ou ignorées (série provisoire), tâches liées retirées,
-- tâches qui suivent la série terminées (US-109 RF8, US-95 RF7). Retourne le nombre de séances traitées.
CREATE FUNCTION cancel_family_series(p_series_id uuid, p_user_id uuid, p_expected_version integer DEFAULT NULL,
                                     p_reason event_change_reason DEFAULT 'user_request')
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_series family_event_series%ROWTYPE; v_to event_status; v_from event_status; v_id uuid; v_n integer := 0;
BEGIN
  SELECT * INTO v_series FROM family_event_series WHERE id = p_series_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_expected_version IS NOT NULL AND v_series.version <> p_expected_version THEN RETURN NULL; END IF;
  IF v_series.status = 'provisional' THEN v_to := 'dismissed'; v_from := 'provisional';
  ELSIF v_series.status = 'confirmed' THEN v_to := 'cancelled'; v_from := 'confirmed';
  ELSE RETURN NULL; END IF;
  FOR v_id IN SELECT id FROM family_events
               WHERE series_id = p_series_id AND starts_at > now()
                 AND (status = v_from OR (v_from = 'provisional' AND status = 'set_aside'))
               ORDER BY starts_at LOOP
    IF NOT change_family_event_status(v_id, v_to, p_user_id, NULL, p_reason, 'all') THEN
      RAISE EXCEPTION 'La séance % ne peut pas être annulée', v_id USING ERRCODE = 'check_violation';
    END IF;
    v_n := v_n + 1;
  END LOOP;
  UPDATE family_event_series SET status = v_to, ended_at = now() WHERE id = p_series_id;
  -- Modèles de tâches proposés avec une série jamais confirmée : abandonnés sans trace (D48)
  DELETE FROM family_task_series WHERE event_series_id = p_series_id AND proposed;
  UPDATE family_task_series SET ended_at = now() WHERE event_series_id = p_series_id AND ended_at IS NULL;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION cancel_family_series(uuid, uuid, integer, event_change_reason) IS $$Annule (ou ignore, si provisoire) toute la série : séances à venir, tâches liées, tâches qui suivent la série ; les modèles de tâches proposés sont supprimés. Auteur NULL et motif event_started pour la fermeture automatique. Retourne le nombre de séances traitées. [US-109 RF8, US-95 RF7, D48]$$;

-- Une série jamais confirmée est fermée (ignorée) au début de sa première séance, avec ses séances restantes et ses modèles de
-- tâches proposés : sans cela elle resterait ouverte et compterait parmi les 30 séries actives. Une série n'est jamais
-- enregistrée d'office (D51). À planifier avec le planificateur de 5 minutes. Retourne le nombre de séries fermées.
CREATE FUNCTION dismiss_unconfirmed_family_series() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_n integer := 0;
BEGIN
  FOR v_id IN SELECT s.id FROM family_event_series s
               WHERE s.status = 'provisional' AND s.ended_at IS NULL
                 AND (SELECT min(e.starts_at) FROM family_events e WHERE e.series_id = s.id) <= now()
               ORDER BY s.created_at LOOP
    IF cancel_family_series(v_id, NULL, NULL, 'event_started') IS NOT NULL THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION dismiss_unconfirmed_family_series() IS $$Ferme (statut ignoré) les séries jamais confirmées dont la première séance a commencé : séances restantes ignorées, modèles de tâches proposés supprimés. À planifier toutes les 5 minutes. [US-109, US-83 RF6, D51]$$;

-- Tâche récurrente : au plus 50 actives par famille (règle propre) ; au plus 10 tâches par série de RDV (D47, PO du 26/10/2026)
CREATE FUNCTION family_task_series_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  IF NEW.assigned_member_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM family_members WHERE id = NEW.assigned_member_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Une tâche ne peut être assignée qu''à un membre actif' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ended_at IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.event_series_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('family_task_series:' || NEW.account_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_recurring_tasks_per_family';
    SELECT count(*) INTO v_count FROM family_task_series
     WHERE account_id = NEW.account_id AND event_series_id IS NULL AND ended_at IS NULL;
    IF v_count >= COALESCE(v_max, 50) THEN
      RAISE EXCEPTION 'Nombre maximal de tâches récurrentes atteint (%)', COALESCE(v_max, 50) USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('event_tasks:' || NEW.event_series_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_tasks_per_event';
    SELECT count(*) INTO v_count FROM family_task_series WHERE event_series_id = NEW.event_series_id AND ended_at IS NULL;
    IF v_count >= COALESCE(v_max, 10) THEN
      RAISE EXCEPTION 'Au plus % tâches préparatoires par série de RDV', COALESCE(v_max, 10) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_task_series_before_insert BEFORE INSERT ON family_task_series
  FOR EACH ROW EXECUTE FUNCTION family_task_series_before_insert();

CREATE FUNCTION family_task_series_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_member_id IS NOT NULL AND NEW.assigned_member_id IS DISTINCT FROM OLD.assigned_member_id
     AND EXISTS (SELECT 1 FROM family_members WHERE id = NEW.assigned_member_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Une tâche ne peut être assignée qu''à un membre actif' USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_task_series_before_update BEFORE UPDATE ON family_task_series
  FOR EACH ROW EXECUTE FUNCTION family_task_series_before_update();

-- Transitions d'une tâche (AT-1) : proposée → à faire / annulée ; à faire → faite / annulée ; faite → à faire (annulation du cochage)
CREATE FUNCTION family_task_transition_allowed(p_from task_status, p_to task_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (
    ('proposed', 'todo'), ('proposed', 'cancelled'),
    ('todo', 'done'), ('todo', 'cancelled'),
    ('done', 'todo'))
$$;
COMMENT ON FUNCTION family_task_transition_allowed(task_status, task_status) IS $$Transitions permises de statut d'une tâche : proposée → à faire / annulée ; à faire → faite / annulée ; faite → à faire (le cochage s'annule). Une tâche annulée ne revient pas. [AT-1]$$;

-- Au plus 10 tâches préparatoires par RDV (US-95 RF8) : les tâches proposées, à faire et faites, hors annulées. Les proposées
-- comptent (D48) : elles deviennent « à faire » avec le RDV, la confirmation ne doit pas échouer à la 11e tâche.
CREATE FUNCTION check_event_task_limit(p_event_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('event_tasks:' || p_event_id::text, 0));
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_tasks_per_event';
  SELECT count(*) INTO v_count FROM family_tasks
   WHERE event_id = p_event_id AND series_id IS NULL AND status IN ('proposed', 'todo', 'done');
  IF v_count >= COALESCE(v_max, 10) THEN
    RAISE EXCEPTION 'Au plus % tâches préparatoires par RDV', COALESCE(v_max, 10) USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- Une tâche proposée n'a jamais d'échéance déjà passée ni postérieure au RDV (dates locales, fuseau de la famille). Contrôle
-- seulement tant que le RDV est à venir : un RDV passé n'est plus proposé à personne (D51).
CREATE FUNCTION check_proposed_task_due(p_account_id uuid, p_event_id uuid, p_due date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_tz text; v_start timestamptz;
BEGIN
  SELECT starts_at INTO v_start FROM family_events WHERE id = p_event_id;
  IF v_start IS NULL OR v_start <= now() THEN RETURN; END IF;
  SELECT family_timezone INTO v_tz FROM accounts WHERE id = p_account_id;
  IF p_due < (now() AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'Une tâche proposée ne peut pas avoir une échéance passée' USING ERRCODE = 'check_violation';
  END IF;
  IF p_due > (v_start AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'Une tâche proposée ne peut pas être due après le RDV' USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION family_task_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_member_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM family_members WHERE id = NEW.assigned_member_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Une tâche ne peut être assignée qu''à un membre actif' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('proposed', 'todo', 'done') AND NEW.event_id IS NOT NULL AND NEW.series_id IS NULL THEN
    PERFORM check_event_task_limit(NEW.event_id);
  END IF;
  IF NEW.status = 'proposed' AND NEW.event_id IS NOT NULL THEN
    PERFORM check_proposed_task_due(NEW.account_id, NEW.event_id, NEW.due_date);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_tasks_before_insert BEFORE INSERT ON family_tasks
  FOR EACH ROW EXECUTE FUNCTION family_task_before_insert();

CREATE FUNCTION family_task_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT family_task_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Transition de statut interdite pour la tâche : % vers %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
    IF OLD.status = 'done' THEN
      NEW.done_at := NULL;
      NEW.done_by_member_id := NULL;
    END IF;
  END IF;
  -- Pas de nouveau contrôle de plafond à l'ajout d'une tâche proposée : elle compte déjà depuis sa création
  IF NEW.status = 'proposed' AND NEW.event_id IS NOT NULL AND NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    PERFORM check_proposed_task_due(NEW.account_id, NEW.event_id, NEW.due_date);
  END IF;
  IF NEW.assigned_member_id IS NOT NULL AND NEW.assigned_member_id IS DISTINCT FROM OLD.assigned_member_id
     AND EXISTS (SELECT 1 FROM family_members WHERE id = NEW.assigned_member_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Une tâche ne peut être assignée qu''à un membre actif' USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_tasks_before_update BEFORE UPDATE ON family_tasks
  FOR EACH ROW EXECUTE FUNCTION family_task_before_update();

-- Changement de statut atomique d'une tâche, avec contrôle de version. « Faite par » = le membre du profil qui coche.
-- Retourne false si la tâche est introuvable, modifiée entre-temps ou si la transition n'est pas permise.
CREATE FUNCTION change_family_task_status(
  p_task_id uuid, p_to task_status, p_user_id uuid,
  p_expected_version integer DEFAULT NULL, p_cancel_reason task_cancel_reason DEFAULT 'user'
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_task family_tasks%ROWTYPE; v_member uuid;
BEGIN
  SELECT * INTO v_task FROM family_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_expected_version IS NOT NULL AND v_task.version <> p_expected_version THEN RETURN false; END IF;
  IF NOT family_task_transition_allowed(v_task.status, p_to) THEN RETURN false; END IF;
  IF p_to = 'done' THEN
    SELECT id INTO v_member FROM family_members WHERE user_id = p_user_id AND account_id = v_task.account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ce profil n''a pas de membre : impossible de cocher la tâche' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE family_tasks
     SET status = p_to,
         status_changed_by_user_id = p_user_id,
         done_at = CASE WHEN p_to = 'done' THEN now() END,
         done_by_member_id = CASE WHEN p_to = 'done' THEN v_member END,
         cancel_reason = CASE WHEN p_to = 'cancelled' THEN p_cancel_reason END
   WHERE id = p_task_id;
  RETURN true;
END $$;
COMMENT ON FUNCTION change_family_task_status(uuid, task_status, uuid, integer, task_cancel_reason) IS $$Change le statut d'une tâche de façon atomique (transition permise, version attendue) ; « faite par » = membre du profil. false = introuvable, modifiée ou transition interdite. [US-110 RF7, AT-1]$$;

-- Termine une tâche récurrente (« Toutes », ou fin de la règle) : les occurrences à faire à partir d'aujourd'hui sont annulées.
-- Retourne le nombre d'occurrences annulées.
CREATE FUNCTION end_family_task_series(p_series_id uuid, p_user_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  UPDATE family_task_series SET ended_at = COALESCE(ended_at, now()) WHERE id = p_series_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE family_tasks
     SET status = 'cancelled', cancel_reason = 'series_ended', status_changed_by_user_id = p_user_id
   WHERE series_id = p_series_id AND status IN ('proposed', 'todo') AND due_date >= current_date;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION end_family_task_series(uuid, uuid) IS $$Termine une tâche récurrente et annule ses occurrences à faire à partir d'aujourd'hui ; les occurrences en retard restent. [US-110 RF5]$$;

-- Nombre de tâches retirées avec un RDV annulé ou ignoré : « 2 tâches de préparation ont été retirées » (US-95 RF7)
CREATE FUNCTION family_event_retired_task_count(p_event_id uuid) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM family_tasks WHERE event_id = p_event_id AND status = 'cancelled' AND cancel_reason = 'event_cancelled'
$$;
COMMENT ON FUNCTION family_event_retired_task_count(uuid) IS $$Nombre de tâches annulées avec leur RDV (annulation ou abandon), pour la notification aux parents. [US-95 RF7]$$;

-- Droits sur les tâches (AT-2, D26) : parents = toutes ; invité secondaire = celles qu'il a créées, celles qui lui sont assignées
-- et celles des RDV qu'il voit. Les tâches annulées ne s'affichent pas ; une tâche proposée n'est vue que des parents et du demandeur du RDV.
CREATE FUNCTION family_tasks_visible_to(p_viewer uuid) RETURNS SETOF family_tasks
LANGUAGE sql STABLE AS $$
  SELECT t.*
    FROM family_tasks t
    JOIN users v ON v.id = p_viewer AND v.account_id = t.account_id
   WHERE t.status <> 'cancelled'
     AND ( v.role = 'primary_user' OR v.guest_rank = 'core'
        OR ( t.status <> 'proposed'
             AND ( t.created_by_user_id = v.id
                OR EXISTS (SELECT 1 FROM family_members fm WHERE fm.id = t.assigned_member_id AND fm.user_id = v.id)
                OR t.event_id IN (SELECT id FROM family_events_visible_to(p_viewer)) ) )
        OR ( t.status = 'proposed'
             AND EXISTS (SELECT 1 FROM family_events e WHERE e.id = t.event_id AND e.requested_by_user_id = v.id) ) )
$$;
COMMENT ON FUNCTION family_tasks_visible_to(uuid) IS $$Tâches visibles par un profil selon son rang (décision D26, AT-2). [US-110, US-96]$$;

-- Droit de modifier, assigner ou annuler : parents = toutes ; invité secondaire = les tâches qu'il a créées
CREATE FUNCTION can_manage_family_task(p_user_id uuid, p_task_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM family_tasks t JOIN users u ON u.id = p_user_id AND u.account_id = t.account_id
     WHERE t.id = p_task_id
       AND (u.role = 'primary_user' OR u.guest_rank = 'core' OR t.created_by_user_id = u.id))
$$;
COMMENT ON FUNCTION can_manage_family_task(uuid, uuid) IS $$Vrai si le profil peut modifier, assigner ou annuler cette tâche (parents : toutes ; invité secondaire : ses créations). [US-96 RF3, AT-2]$$;

-- Droit de cocher : le droit de gérer, plus les tâches assignées à son propre membre
CREATE FUNCTION can_check_family_task(p_user_id uuid, p_task_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT can_manage_family_task(p_user_id, p_task_id)
      OR EXISTS (SELECT 1 FROM family_tasks t JOIN family_members fm ON fm.id = t.assigned_member_id
                  WHERE t.id = p_task_id AND fm.user_id = p_user_id)
$$;
COMMENT ON FUNCTION can_check_family_task(uuid, uuid) IS $$Vrai si le profil peut cocher cette tâche (parents : toutes ; invité secondaire : ses créations et les tâches qui lui sont assignées). [AT-2]$$;

-- « En retard » n'est pas un statut mais un affichage : tâche à faire dont l'échéance est passée, dans le fuseau de la famille (AT-1)
CREATE VIEW v_family_tasks AS
SELECT t.*,
       (t.status = 'todo'
        AND ((t.due_date + COALESCE(t.due_time, time '23:59:59')) AT TIME ZONE a.family_timezone) < now()) AS is_overdue
  FROM family_tasks t JOIN accounts a ON a.id = t.account_id;
COMMENT ON VIEW v_family_tasks IS $$Tâches avec l'affichage « En retard » calculé (à faire, échéance passée dans le fuseau de la famille). À combiner avec family_tasks_visible_to pour la visibilité. [US-110 RF6, AT-1]$$;

-- Un membre retiré (archivé, effacé ou profil supprimé) : ses tâches à faire deviennent « non assignées » (US-96 RF8),
-- ses questions d'anticipation disparaissent (information de santé indirecte), ses suivis de trajet sont arrêtés.
CREATE FUNCTION family_member_archived() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Lot 10 : données Devoirs de l'enfant (âge, progrès, tâches « Devoirs »), supprimées avant que ses tâches ne soient désassignées
  PERFORM erase_member_homework_data(NEW.id);
  UPDATE family_tasks SET assigned_member_id = NULL
   WHERE assigned_member_id = NEW.id AND status IN ('proposed', 'todo');
  UPDATE family_task_series SET assigned_member_id = NULL
   WHERE assigned_member_id = NEW.id AND ended_at IS NULL;
  DELETE FROM anticipation_questions WHERE member_id = NEW.id;
  IF COALESCE(NEW.user_id, OLD.user_id) IS NOT NULL THEN
    DELETE FROM travel_tracking WHERE user_id = COALESCE(NEW.user_id, OLD.user_id);
  END IF;
  RETURN NEW;
END $$;
-- Pas de « UPDATE OF » : quand le profil est supprimé, c'est un autre trigger (BEFORE UPDATE) qui archive le membre
CREATE TRIGGER trg_family_members_archived AFTER UPDATE ON family_members
  FOR EACH ROW WHEN (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
  EXECUTE FUNCTION family_member_archived();

-- RDV déplacé : échéance des tâches liées recalculée avec l'écart conservé (US-95 RF6) ; estimations de trajet remises à zéro ;
-- RDV annulé ou ignoré : estimations supprimées ; lieu retiré : plus de suivi (US-107 RF4).
CREATE FUNCTION family_event_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tz text; v_day date;
BEGIN
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
    SELECT family_timezone INTO v_tz FROM accounts WHERE id = NEW.account_id;
    v_day := (NEW.starts_at AT TIME ZONE v_tz)::date;
    -- Tâches à faire : l'écart au RDV est conservé. Tâches proposées : jamais d'échéance passée ni après le RDV (D51)
    UPDATE family_tasks SET due_date = v_day - days_before_event
     WHERE event_id = NEW.id AND days_before_event IS NOT NULL AND status = 'todo';
    UPDATE family_tasks SET due_date = LEAST(v_day, GREATEST((now() AT TIME ZONE v_tz)::date, v_day - days_before_event))
     WHERE event_id = NEW.id AND days_before_event IS NOT NULL AND status = 'proposed';
  END IF;
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR (NEW.status IN ('cancelled', 'dismissed') AND NEW.status IS DISTINCT FROM OLD.status) THEN
    DELETE FROM event_travel_advice WHERE event_id = NEW.id;
    UPDATE scheduled_notifications SET status = 'cancelled'
     WHERE event_id = NEW.id AND kind IN ('travel_first', 'travel_second') AND status = 'scheduled';
  END IF;
  IF NEW.location_point IS NULL AND OLD.location_point IS NOT NULL THEN
    DELETE FROM travel_tracking WHERE event_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_events_after_change AFTER UPDATE OF starts_at, status, location_point ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_after_change();

CREATE FUNCTION family_event_series_after_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_point IS NULL AND OLD.location_point IS NOT NULL THEN
    DELETE FROM travel_tracking WHERE series_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_event_series_after_change AFTER UPDATE OF location_point ON family_event_series
  FOR EACH ROW EXECUTE FUNCTION family_event_series_after_change();

-- Un membre retiré d'un RDV ou d'une série n'est plus concerné : son suivi de trajet s'arrête
CREATE FUNCTION family_event_member_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'family_event_members' THEN
    DELETE FROM travel_tracking t USING family_members fm
     WHERE t.event_id = OLD.event_id AND fm.id = OLD.member_id AND fm.user_id = t.user_id;
  ELSE
    DELETE FROM travel_tracking t USING family_members fm
     WHERE t.series_id = OLD.series_id AND fm.id = OLD.member_id AND fm.user_id = t.user_id;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_family_event_members_removed AFTER DELETE ON family_event_members
  FOR EACH ROW EXECUTE FUNCTION family_event_member_removed();
CREATE TRIGGER trg_family_event_series_members_removed AFTER DELETE ON family_event_series_members
  FOR EACH ROW EXECUTE FUNCTION family_event_member_removed();

-- Suivi de trajet : jamais pour un RDV médical, jamais sans lieu, seulement pour un RDV qui concerne le profil (US-107 RF4, D46, D47)
CREATE FUNCTION travel_tracking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_type integer; v_point bytea; v_whole boolean; v_concerned boolean;
BEGIN
  IF NOT NEW.enabled THEN RETURN NEW; END IF;
  IF NEW.event_id IS NOT NULL THEN
    SELECT event_type_id, location_point, whole_family INTO v_type, v_point, v_whole FROM family_events WHERE id = NEW.event_id;
    v_concerned := v_whole OR EXISTS (SELECT 1 FROM family_event_members m JOIN family_members fm ON fm.id = m.member_id
                                       WHERE m.event_id = NEW.event_id AND fm.user_id = NEW.user_id);
  ELSE
    SELECT event_type_id, location_point, whole_family INTO v_type, v_point, v_whole FROM family_event_series WHERE id = NEW.series_id;
    v_concerned := v_whole OR EXISTS (SELECT 1 FROM family_event_series_members m JOIN family_members fm ON fm.id = m.member_id
                                       WHERE m.series_id = NEW.series_id AND fm.user_id = NEW.user_id);
  END IF;
  IF EXISTS (SELECT 1 FROM event_types WHERE id = v_type AND code = 'medical') THEN
    RAISE EXCEPTION 'Pas de suivi de trajet pour un RDV médical' USING ERRCODE = 'check_violation';
  END IF;
  IF v_point IS NULL THEN
    RAISE EXCEPTION 'Le suivi de trajet exige l''adresse du RDV' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT COALESCE(v_concerned, false) THEN
    RAISE EXCEPTION 'Ce RDV ne concerne pas ce profil' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_travel_tracking_guard BEFORE INSERT OR UPDATE OF enabled, event_id, series_id, user_id ON travel_tracking
  FOR EACH ROW EXECUTE FUNCTION travel_tracking_guard();

-- Dernière position : refusée sans consentement actif de l'appareil ; échéance par défaut = 3 heures (le CHECK interdit davantage)
CREATE FUNCTION device_position_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expires_at IS NULL THEN
    NEW.expires_at := NEW.captured_at + interval '3 hours';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM device_location_consents c JOIN devices d ON d.id = c.device_id
                  WHERE c.device_id = NEW.device_id AND c.withdrawn_at IS NULL AND d.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Position refusée : aucun consentement actif de cet appareil' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_device_last_positions_guard BEFORE INSERT OR UPDATE ON device_last_positions
  FOR EACH ROW EXECUTE FUNCTION device_position_guard();

-- Suppression immédiate de la dernière position : consentement retiré, appareil révoqué, déconnexion (dernière session de l'appareil)
CREATE FUNCTION erase_device_position_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'device_location_consents' THEN
    DELETE FROM device_last_positions WHERE device_id = NEW.device_id;
  ELSIF TG_TABLE_NAME = 'devices' THEN
    DELETE FROM device_last_positions WHERE device_id = NEW.id;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = NEW.device_id AND s.id <> NEW.id
                    AND s.revoked_at IS NULL AND s.expires_at > now()) THEN
      DELETE FROM device_last_positions WHERE device_id = NEW.device_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_location_consents_withdrawn AFTER UPDATE OF withdrawn_at ON device_location_consents
  FOR EACH ROW WHEN (NEW.withdrawn_at IS NOT NULL) EXECUTE FUNCTION erase_device_position_trigger();
CREATE TRIGGER trg_devices_revoked_position AFTER UPDATE OF revoked_at ON devices
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION erase_device_position_trigger();
CREATE TRIGGER trg_sessions_revoked_position AFTER UPDATE OF revoked_at ON sessions
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION erase_device_position_trigger();

-- Lecture de la dernière position : seulement si elle n'est pas échue et si le consentement est actif
CREATE FUNCTION device_last_position(p_device_id uuid) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT p.position_encrypted FROM device_last_positions p
   WHERE p.device_id = p_device_id AND p.expires_at > now()
     AND EXISTS (SELECT 1 FROM device_location_consents c WHERE c.device_id = p.device_id AND c.withdrawn_at IS NULL)
$$;
COMMENT ON FUNCTION device_last_position(uuid) IS $$Dernière position connue d'un appareil (chiffrée), uniquement si elle n'est pas échue et si le consentement est actif. Aucun autre accès : jamais lisible par un autre profil. [US-107 RF5, RF12]$$;

-- Garde-fous des questions : jamais de suggestion tirée d'un RDV médical (D31, D44), ni quand le catalogue est désactivé
-- ou que le parent a demandé « Ne plus me le proposer » (la ligne n'est alors pas créée).
CREATE FUNCTION anticipation_question_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Question du catalogue : elle garde le libellé (avec le repère {membre}) qu'avait le catalogue quand elle est posée (D54)
  IF NEW.origin = 'catalog' AND NEW.label_template IS NULL THEN
    SELECT label INTO NEW.label_template FROM anticipation_catalog_items WHERE id = NEW.catalog_item_id;
  END IF;
  IF EXISTS (SELECT 1 FROM family_settings WHERE account_id = NEW.account_id AND NOT anticipation_enabled) THEN
    RETURN NULL;
  END IF;
  IF NEW.origin = 'history' THEN
    IF NEW.anchor_event_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM family_events e JOIN event_types t ON t.id = e.event_type_id
                       WHERE e.id = NEW.anchor_event_id AND e.account_id = NEW.account_id
                         AND e.status = 'confirmed' AND t.code <> 'medical') THEN
      RAISE EXCEPTION 'Suggestion refusée : RDV d''origine absent, non confirmé ou médical' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM anticipation_opt_outs WHERE account_id = NEW.account_id AND suggestion_key = NEW.suggestion_key) THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_anticipation_questions_before_insert BEFORE INSERT ON anticipation_questions
  FOR EACH ROW EXECUTE FUNCTION anticipation_question_before_insert();

-- Réponse à une question, atomique : réponse, état de la question et tâche créée dans une seule transaction (US-102 RF6, RF12 ;
-- US-108 RF3). Réservée aux parents. applied = false si la question a déjà reçu une réponse (elle disparaît pour l'autre parent).
CREATE FUNCTION answer_anticipation_question(
  p_question_id uuid, p_answer question_answer, p_user_id uuid,
  p_remind_months smallint DEFAULT NULL, p_task_title bytea DEFAULT NULL,
  p_assigned_member_id uuid DEFAULT NULL, p_due_date date DEFAULT NULL
) RETURNS TABLE (applied boolean, task_id uuid) LANGUAGE plpgsql AS $$
DECLARE v_q anticipation_questions%ROWTYPE; v_task uuid; v_remind date;
BEGIN
  SELECT * INTO v_q FROM anticipation_questions WHERE id = p_question_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, NULL::uuid; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.account_id = v_q.account_id
                    AND (u.role = 'primary_user' OR u.guest_rank = 'core') AND u.status <> 'removed') THEN
    RAISE EXCEPTION 'Seuls les parents répondent aux questions de rappel' USING ERRCODE = 'check_violation';
  END IF;
  IF v_q.status NOT IN ('pending', 'snoozed') THEN RETURN QUERY SELECT false, NULL::uuid; RETURN; END IF;
  IF p_answer = 'todo' THEN
    IF p_task_title IS NULL THEN
      RAISE EXCEPTION 'Le titre de la tâche est obligatoire pour la réponse « Non, à faire »' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO family_tasks (account_id, title, status, due_date, assigned_member_id, created_by_user_id, source, origin_question_id)
    VALUES (v_q.account_id, p_task_title, 'todo',
            COALESCE(p_due_date, CASE v_q.origin WHEN 'history' THEN v_q.anchor_date - 14 ELSE v_q.period_end END),
            p_assigned_member_id, p_user_id, 'anticipation', v_q.id)
    RETURNING id INTO v_task;
    UPDATE anticipation_questions SET status = 'task_created', status_changed_at = now(), remind_at = NULL WHERE id = v_q.id;
  ELSIF p_answer = 'done_or_planned' THEN
    UPDATE anticipation_questions SET status = 'settled', status_changed_at = now(), remind_at = NULL WHERE id = v_q.id;
  ELSE
    IF p_remind_months IS NULL OR p_remind_months NOT IN (1, 3, 6) OR (v_q.origin = 'history' AND p_remind_months = 6) THEN
      RAISE EXCEPTION 'Délai de rappel non permis' USING ERRCODE = 'check_violation';
    END IF;
    v_remind := LEAST((current_date + make_interval(months => p_remind_months))::date, v_q.period_end);
    UPDATE anticipation_questions SET status = 'snoozed', status_changed_at = now(), remind_at = v_remind WHERE id = v_q.id;
  END IF;
  INSERT INTO anticipation_answers (question_id, answer, remind_months, answered_by_user_id, created_task_id)
  VALUES (v_q.id, p_answer, CASE WHEN p_answer = 'remind_later' THEN p_remind_months END, p_user_id, v_task);
  RETURN QUERY SELECT true, v_task;
END $$;
COMMENT ON FUNCTION answer_anticipation_question(uuid, question_answer, uuid, smallint, bytea, uuid, date) IS $$Enregistre la réponse d'un parent à une question à trois choix, change l'état de la question et crée la tâche (réponse « Non ») dans une seule transaction, sans double création. applied = false si déjà traitée. [US-102 RF6, RF12, US-108 RF3, AT-6]$$;

-- « Ne plus me le proposer » : la suggestion ne reviendra plus pour ce RDV (US-108 RF7)
CREATE FUNCTION dismiss_anticipation_suggestion(p_question_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_q anticipation_questions%ROWTYPE;
BEGIN
  SELECT * INTO v_q FROM anticipation_questions WHERE id = p_question_id FOR UPDATE;
  IF NOT FOUND OR v_q.origin <> 'history' OR v_q.status NOT IN ('pending', 'snoozed') THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.account_id = v_q.account_id
                    AND (u.role = 'primary_user' OR u.guest_rank = 'core') AND u.status <> 'removed') THEN
    RAISE EXCEPTION 'Seuls les parents répondent aux suggestions' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO anticipation_opt_outs (account_id, suggestion_key, created_by_user_id)
  VALUES (v_q.account_id, v_q.suggestion_key, p_user_id)
  ON CONFLICT (account_id, suggestion_key) DO NOTHING;
  UPDATE anticipation_questions SET status = 'dismissed', status_changed_at = now(), remind_at = NULL
   WHERE account_id = v_q.account_id AND suggestion_key = v_q.suggestion_key AND status IN ('pending', 'snoozed');
  RETURN true;
END $$;
COMMENT ON FUNCTION dismiss_anticipation_suggestion(uuid, uuid) IS $$« Ne plus me le proposer » : enregistre le refus (empreinte du RDV) et clôt les suggestions ouvertes pour ce RDV. [US-108 RF7]$$;

-- Sélection hebdomadaire : au plus 5 questions par semaine et par famille, catalogue et historique confondus (AT-7).
-- Réveille d'abord les questions « Me le rappeler » arrivées à échéance et clôt celles dont la période est finie. Retourne les
-- questions nouvellement présentées. Aucune sélection si le catalogue est désactivé pour la famille.
CREATE FUNCTION pick_weekly_questions(p_account_id uuid, p_week date) RETURNS SETOF uuid LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_done integer;
BEGIN
  IF EXISTS (SELECT 1 FROM family_settings WHERE account_id = p_account_id AND NOT anticipation_enabled) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('anticipation_week:' || p_account_id::text, 0));
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_questions_per_week';
  UPDATE anticipation_questions SET status = 'pending', remind_at = NULL, status_changed_at = now()
   WHERE account_id = p_account_id AND status = 'snoozed' AND remind_at <= current_date;
  UPDATE anticipation_questions SET status = 'expired', remind_at = NULL, status_changed_at = now()
   WHERE account_id = p_account_id AND status IN ('pending', 'snoozed') AND period_end < current_date;
  SELECT count(*) INTO v_done FROM anticipation_questions WHERE account_id = p_account_id AND presented_week = p_week;
  RETURN QUERY
    WITH pick AS (
      SELECT id FROM anticipation_questions
       WHERE account_id = p_account_id AND status = 'pending' AND presented_week IS DISTINCT FROM p_week
       ORDER BY period_end, created_at
       LIMIT GREATEST(COALESCE(v_max, 5) - v_done, 0)
       FOR UPDATE)
    UPDATE anticipation_questions q SET presented_week = p_week, times_presented = q.times_presented + 1
      FROM pick WHERE q.id = pick.id
    RETURNING q.id;
END $$;
COMMENT ON FUNCTION pick_weekly_questions(uuid, date) IS $$Marque au plus 5 questions par semaine et par famille comme présentées (celles dont l'échéance est la plus proche d'abord), réveille les rappels échus et clôt les périodes finies. [US-102 RF4, US-108 RF5, AT-7]$$;

-- Enregistrement sans réponse (AT-8, D49, D51) -----------------------------------------------------------------------------

-- Sources dont le RDV peut être confirmé d'office : texte, dictée, photo envoyés dans le tchat. Le mail transféré, le partage
-- Android, WhatsApp, la synchronisation d'agenda et toute future source exigent une confirmation (valeur par défaut sûre).
CREATE FUNCTION family_event_auto_confirmable_source(p_source event_source) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_source IN ('chat_text', 'voice', 'photo')
$$;
COMMENT ON FUNCTION family_event_auto_confirmable_source(event_source) IS $$Vrai pour les RDV envoyés dans le tchat par texte, dictée ou photo ; faux pour toute information transmise hors de l'application (mail, partage Android, WhatsApp) et pour toute future source. [AT-8, D51]$$;

-- Échéance d'enregistrement automatique : le plus petit de (proposition + 72 h) et (début - 2 h). Le délai court depuis la
-- proposition (created_at) même si un parent modifie le RDV. NULL si le RDV ne peut jamais être confirmé d'office : statut autre
-- que provisoire (un RDV écarté n'est jamais concerné), source non autorisée, séance d'une série (une série n'est jamais
-- enregistrée d'office), ou RDV proposé moins de 2 h avant son début.
CREATE FUNCTION family_event_auto_confirm_at() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_delay integer; v_lead integer;
BEGIN
  NEW.auto_confirm_at := NULL;
  IF NEW.status = 'provisional' AND NEW.series_id IS NULL AND family_event_auto_confirmable_source(NEW.source) THEN
    SELECT value_text::integer INTO v_delay FROM platform_settings WHERE setting_key = 'auto_confirm_delay_hours';
    SELECT value_text::integer INTO v_lead FROM platform_settings WHERE setting_key = 'auto_confirm_min_lead_hours';
    IF NEW.starts_at - NEW.created_at >= make_interval(hours => COALESCE(v_lead, 2)) THEN
      NEW.auto_confirm_at := LEAST(NEW.created_at + make_interval(hours => COALESCE(v_delay, 72)),
                                   NEW.starts_at - make_interval(hours => COALESCE(v_lead, 2)));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_events_auto_confirm_at BEFORE INSERT OR UPDATE OF starts_at, status, source, series_id, created_at ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_auto_confirm_at();

-- Traitement du planificateur (toutes les 5 minutes) : confirme au nom de « MAAQ (sans réponse) » les RDV provisoires dont
-- l'échéance est atteinte depuis moins de la tolérance (60 minutes). Exceptions évaluées ici, car elles changent : RDV en conflit,
-- RDV dont le membre est à préciser. Chaque RDV est traité sous verrou (SKIP LOCKED) : si un parent confirme au même instant,
-- un seul gagne. Les tâches proposées passent à « à faire » avec le RDV. Les parents (et l'auteur de la demande) sont prévenus ;
-- la nuit (21 h à 8 h, fuseau de la famille), la notification est décalée à 8 h. Retourne le nombre de RDV confirmés.
CREATE FUNCTION auto_confirm_family_events() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_grace integer; v_ev record; v_n integer := 0; v_tz text; v_local timestamp; v_due timestamptz;
BEGIN
  SELECT value_text::integer INTO v_grace FROM platform_settings WHERE setting_key = 'auto_confirm_grace_minutes';
  FOR v_ev IN
    SELECT id, account_id, starts_at, ends_at, whole_family, requested_by_user_id FROM family_events
     WHERE status = 'provisional' AND auto_confirm_at IS NOT NULL AND auto_confirm_at <= now()
       AND now() < auto_confirm_at + make_interval(mins => COALESCE(v_grace, 60)) AND starts_at > now()
     ORDER BY auto_confirm_at FOR UPDATE SKIP LOCKED
  LOOP
    CONTINUE WHEN NOT v_ev.whole_family AND NOT EXISTS (SELECT 1 FROM family_event_members WHERE event_id = v_ev.id);
    CONTINUE WHEN EXISTS (SELECT 1 FROM find_family_event_conflicts(
        v_ev.account_id, ARRAY(SELECT member_id FROM family_event_members WHERE event_id = v_ev.id),
        v_ev.whole_family, v_ev.starts_at, v_ev.ends_at, v_ev.id));
    BEGIN
      IF NOT change_family_event_status(v_ev.id, 'confirmed', NULL, NULL, 'no_response') THEN CONTINUE; END IF;
    EXCEPTION WHEN check_violation THEN CONTINUE;
    END;
    v_n := v_n + 1;
    SELECT family_timezone INTO v_tz FROM accounts WHERE id = v_ev.account_id;
    v_local := now() AT TIME ZONE v_tz;
    v_due := CASE WHEN v_local::time >= time '21:00' THEN ((v_local::date + 1) + time '08:00') AT TIME ZONE v_tz
                  WHEN v_local::time < time '08:00' THEN (v_local::date + time '08:00') AT TIME ZONE v_tz
                  ELSE now() END;
    UPDATE scheduled_notifications SET status = 'cancelled'
     WHERE event_id = v_ev.id AND kind IN ('follow_up_24h', 'follow_up_48h') AND status = 'scheduled';
    INSERT INTO scheduled_notifications (event_id, recipient_user_id, kind, due_at)
    SELECT v_ev.id, u.id, 'auto_confirmed', v_due FROM users u
     WHERE u.account_id = v_ev.account_id AND u.status <> 'removed'
       AND (u.role = 'primary_user' OR u.guest_rank = 'core' OR u.id = v_ev.requested_by_user_id)
    ON CONFLICT (event_id, kind, recipient_user_id, due_at) WHERE event_id IS NOT NULL DO NOTHING;
  END LOOP;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION auto_confirm_family_events() IS $$Confirme d'office, au nom de « MAAQ (sans réponse) », les RDV provisoires sans réponse dont l'échéance est atteinte (hors conflit et membre à préciser), avec leurs tâches proposées, et prévient les parents. À planifier toutes les 5 minutes. [AT-8, D49, D51, US-83]$$;

-- Toute modification de la liste de tâches proposées fait monter la version du RDV : une carte ou un écran périmé est refusé à la
-- confirmation (« Mis à jour »), au lieu d'enregistrer des tâches que le parent ne voyait pas (D51). Pas de montée de version quand
-- le changement vient d'un autre trigger (déplacement du RDV, retrait d'un membre, suppression en cascade).
CREATE FUNCTION family_task_proposed_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_event uuid;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'proposed' THEN v_event := NEW.event_id; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'proposed' THEN v_event := OLD.event_id; END IF;
  ELSIF OLD.status = 'proposed' AND NEW.status = 'proposed' THEN
    v_event := NEW.event_id;
  END IF;
  IF v_event IS NOT NULL THEN
    UPDATE family_events SET updated_at = now() WHERE id = v_event;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_family_tasks_proposed_changed AFTER INSERT OR UPDATE OR DELETE ON family_tasks
  FOR EACH ROW EXECUTE FUNCTION family_task_proposed_changed();

-- Âge d'un membre en mois civils à partir du mois et de l'année de naissance (le jour n'est jamais saisi, D54). Convention :
-- différence des mois civils entre la date donnée et le mois de naissance. NULL si la naissance n'est pas connue.
CREATE FUNCTION family_member_age_months(p_birth_year smallint, p_birth_month smallint, p_on date DEFAULT current_date)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_birth_year IS NULL OR p_birth_month IS NULL THEN NULL
              ELSE (EXTRACT(year FROM p_on)::integer * 12 + EXTRACT(month FROM p_on)::integer) - (p_birth_year * 12 + p_birth_month) END
$$;
COMMENT ON FUNCTION family_member_age_months(smallint, smallint, date) IS $$Âge d'un membre en mois civils (différence des mois, sans jour) à une date ; NULL si le mois ou l'année de naissance manque. Sert aux conditions d'âge du catalogue (US-102) et aux tranches d'âge transmises au modèle. [US-92, US-102, D54]$$;

-- Archive de l'ancienne version d'une échéance du catalogue à chaque modification de contenu (D54) ; le numéro de version monte.
CREATE FUNCTION anticipation_catalog_item_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.code, OLD.label, OLD.category, OLD.is_medical, OLD.active, OLD.per_member, OLD.period_start_month, OLD.period_start_day,
         OLD.period_end_month, OLD.period_end_day, OLD.lead_days, OLD.every_n_years, OLD.target_role, OLD.min_age_months,
         OLD.max_age_months, OLD.situation_key, OLD.situation_required_value, OLD.source_reference, OLD.reviewed_at, OLD.reviewed_by)
     IS DISTINCT FROM
     ROW(NEW.code, NEW.label, NEW.category, NEW.is_medical, NEW.active, NEW.per_member, NEW.period_start_month, NEW.period_start_day,
         NEW.period_end_month, NEW.period_end_day, NEW.lead_days, NEW.every_n_years, NEW.target_role, NEW.min_age_months,
         NEW.max_age_months, NEW.situation_key, NEW.situation_required_value, NEW.source_reference, NEW.reviewed_at, NEW.reviewed_by) THEN
    INSERT INTO anticipation_catalog_item_history (item_id, version, produced_by_load_id, replaced_by_load_id, code, label, category,
      is_medical, active, per_member, period_start_month, period_start_day, period_end_month, period_end_day, lead_days, every_n_years,
      target_role, min_age_months, max_age_months, situation_key, situation_required_value, source_reference, reviewed_at, reviewed_by)
    VALUES (OLD.id, OLD.version, OLD.last_load_id, NEW.last_load_id, OLD.code, OLD.label, OLD.category,
      OLD.is_medical, OLD.active, OLD.per_member, OLD.period_start_month, OLD.period_start_day, OLD.period_end_month, OLD.period_end_day,
      OLD.lead_days, OLD.every_n_years, OLD.target_role, OLD.min_age_months, OLD.max_age_months, OLD.situation_key,
      OLD.situation_required_value, OLD.source_reference, OLD.reviewed_at, OLD.reviewed_by);
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_anticipation_catalog_items_history BEFORE UPDATE ON anticipation_catalog_items
  FOR EACH ROW EXECUTE FUNCTION anticipation_catalog_item_before_update();

CREATE FUNCTION purge_anticipation_catalog_history() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'catalog_version_retention_months';
  DELETE FROM anticipation_catalog_item_history WHERE replaced_at < now() - make_interval(months => COALESCE(v_months, 12));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_anticipation_catalog_history() IS $$Supprime les versions précédentes du catalogue remplacées depuis plus de 12 mois (réglable). À planifier chaque jour. [US-111, D54]$$;

CREATE FUNCTION purge_anticipation_catalog_loads() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'catalog_load_retention_months';
  DELETE FROM anticipation_catalog_loads WHERE loaded_at < now() - make_interval(months => COALESCE(v_months, 60));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_anticipation_catalog_loads() IS $$Supprime l'historique des chargements du catalogue au-delà de 5 ans (réglable) ; les liens des échéances et de leurs archives passent à NULL. À planifier chaque jour. [US-111 RF11, décision du PO du 26/10/2026]$$;

-- Journal des consentements à la position : chaque accord, retrait ou nouvelle version acceptée est inscrit, avec la durée de
-- conservation du réglage. Un retrait provoqué par la révocation de l'appareil (trigger imbriqué) porte la cause « device_revoked ».
CREATE FUNCTION device_location_consent_log() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_user uuid; v_months integer; v_action consent_action; v_cause location_consent_cause := 'user_action';
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'granted';
  ELSIF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    v_action := 'withdrawn';
    IF pg_trigger_depth() > 1 THEN v_cause := 'device_revoked'; END IF;
  ELSIF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS NULL THEN
    v_action := 'granted';
  ELSIF NEW.withdrawn_at IS NULL AND NEW.notice_version IS DISTINCT FROM OLD.notice_version THEN
    v_action := 'granted';
  ELSE
    RETURN NEW;
  END IF;
  SELECT user_id INTO v_user FROM devices WHERE id = NEW.device_id;
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'location_consent_proof_retention_months';
  INSERT INTO device_location_consent_events (device_id, user_id, action, cause, notice_version, retain_until)
  VALUES (NEW.device_id, v_user, v_action, v_cause, NEW.notice_version, (now() + make_interval(months => COALESCE(v_months, 60)))::date);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_device_location_consents_log AFTER INSERT OR UPDATE ON device_location_consents
  FOR EACH ROW EXECUTE FUNCTION device_location_consent_log();

-- Appareil révoqué : son consentement prend fin (retrait inscrit au journal). Appareil supprimé (ou profil, foyer) : retrait inscrit
-- avant la suppression, la preuve survivant sans clé étrangère.
CREATE FUNCTION device_location_consent_device_end() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_version varchar(20);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    UPDATE device_location_consents SET withdrawn_at = now() WHERE device_id = NEW.id AND withdrawn_at IS NULL;
    RETURN NEW;
  END IF;
  SELECT notice_version INTO v_version FROM device_location_consents WHERE device_id = OLD.id AND withdrawn_at IS NULL;
  IF FOUND THEN
    SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'location_consent_proof_retention_months';
    INSERT INTO device_location_consent_events (device_id, user_id, action, cause, notice_version, retain_until)
    VALUES (OLD.id, OLD.user_id, 'withdrawn', 'device_deleted', v_version, (now() + make_interval(months => COALESCE(v_months, 60)))::date);
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_devices_location_consent_revoked AFTER UPDATE OF revoked_at ON devices
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION device_location_consent_device_end();
CREATE TRIGGER trg_devices_location_consent_deleted BEFORE DELETE ON devices
  FOR EACH ROW EXECUTE FUNCTION device_location_consent_device_end();

CREATE FUNCTION purge_location_consent_events() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM device_location_consent_events WHERE retain_until < current_date;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_location_consent_events() IS $$Supprime les inscriptions du journal des consentements à la position au-delà de leur durée de conservation (5 ans par défaut). À planifier chaque jour. [US-107 RT5, D54]$$;

-- « Sur place » (US-112) ---------------------------------------------------------------------------------------------------

-- Garde-fous de toute recherche, même insérée directement : RDV non médical, avec un lieu, à venir, ni annulé ni ignoré ;
-- au plus 3 recherches non échouées par RDV ; rang attribué sans réutilisation.
CREATE FUNCTION event_place_search_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_e family_events%ROWTYPE; v_max integer; v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('place_searches:' || NEW.event_id::text, 0));
  SELECT * INTO v_e FROM family_events WHERE id = NEW.event_id;
  IF EXISTS (SELECT 1 FROM event_types WHERE id = v_e.event_type_id AND code = 'medical') THEN
    RAISE EXCEPTION 'Pas de recherche « Sur place » pour un RDV médical' USING ERRCODE = 'check_violation';
  END IF;
  IF v_e.location IS NULL THEN
    RAISE EXCEPTION 'La recherche « Sur place » exige un lieu' USING ERRCODE = 'check_violation';
  END IF;
  IF v_e.status IN ('cancelled', 'dismissed') OR v_e.ends_at <= now() THEN
    RAISE EXCEPTION 'Ce RDV est terminé, annulé ou ignoré' USING ERRCODE = 'check_violation';
  END IF;
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_place_searches_per_event';
  SELECT count(*) INTO v_count FROM event_place_searches WHERE event_id = NEW.event_id AND status <> 'failed';
  IF v_count >= COALESCE(v_max, 3) THEN
    RAISE EXCEPTION 'Au plus % recherches par RDV', COALESCE(v_max, 3) USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(max(seq), 0) + 1 INTO NEW.seq FROM event_place_searches WHERE event_id = NEW.event_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_event_place_searches_before_insert BEFORE INSERT ON event_place_searches
  FOR EACH ROW EXECUTE FUNCTION event_place_search_before_insert();

-- La suggestion automatique ne vise qu'un RDV familial ou personnel, avec un lieu
CREATE FUNCTION event_place_suggestion_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM family_events e JOIN event_types t ON t.id = e.event_type_id
                  WHERE e.id = NEW.event_id AND t.code IN ('family', 'personal') AND e.location IS NOT NULL) THEN
    RAISE EXCEPTION 'La suggestion ne vise qu''un RDV familial ou personnel avec un lieu' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_event_place_suggestions_before_insert BEFORE INSERT ON event_place_suggestions
  FOR EACH ROW EXECUTE FUNCTION event_place_suggestion_before_insert();

-- Adresse du RDV modifiée : les résultats sont effacés (statut obsolète) mais les recherches restent comptées. RDV devenu médical :
-- recherches et suggestion supprimées. L'application ne doit réécrire `location` que si l'adresse change.
CREATE FUNCTION family_event_place_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM event_types WHERE id = NEW.event_type_id AND code = 'medical') THEN
    DELETE FROM event_place_searches WHERE event_id = NEW.id;
    DELETE FROM event_place_suggestions WHERE event_id = NEW.id;
  ELSIF NEW.location IS DISTINCT FROM OLD.location OR NEW.location_point IS DISTINCT FROM OLD.location_point THEN
    UPDATE event_place_searches
       SET status = 'obsolete', result_payload = NULL, checked_on = NULL
     WHERE event_id = NEW.id AND status IN ('queued', 'running', 'done', 'no_result');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_events_place_changed AFTER UPDATE OF location, location_point, event_type_id ON family_events
  FOR EACH ROW EXECUTE FUNCTION family_event_place_changed();

-- Demande de recherche, atomique : RDV visible du profil, non médical, avec un lieu, à venir ; plafond de 3 par RDV (hors échecs) ;
-- puis plafond quotidien du profil (compté en dernier, pour ne rien compter quand le RDV refuse). Retourne la recherche créée (en
-- attente) ou le motif du refus : not_found, medical, no_location, ended, event_limit, daily_limit.
CREATE FUNCTION request_place_search(p_event_id uuid, p_user_id uuid, p_origin place_search_origin, p_request_date date DEFAULT NULL)
RETURNS TABLE (search_id uuid, refusal text) LANGUAGE plpgsql AS $$
DECLARE v_e family_events%ROWTYPE; v_max integer; v_count integer; v_tz text; v_id uuid;
BEGIN
  SELECT * INTO v_e FROM family_events_visible_to(p_user_id) WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, 'not_found'; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM event_types WHERE id = v_e.event_type_id AND code = 'medical') THEN
    RETURN QUERY SELECT NULL::uuid, 'medical'; RETURN; END IF;
  IF v_e.location IS NULL THEN RETURN QUERY SELECT NULL::uuid, 'no_location'; RETURN; END IF;
  IF v_e.ends_at <= now() THEN RETURN QUERY SELECT NULL::uuid, 'ended'; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('place_searches:' || p_event_id::text, 0));
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_place_searches_per_event';
  SELECT count(*) INTO v_count FROM event_place_searches WHERE event_id = p_event_id AND status <> 'failed';
  IF v_count >= COALESCE(v_max, 3) THEN RETURN QUERY SELECT NULL::uuid, 'event_limit'; RETURN; END IF;
  SELECT family_timezone INTO v_tz FROM accounts WHERE id = v_e.account_id;
  IF NOT register_agent_request(p_user_id, COALESCE(p_request_date, (now() AT TIME ZONE v_tz)::date)) THEN
    RETURN QUERY SELECT NULL::uuid, 'daily_limit'; RETURN; END IF;
  INSERT INTO event_place_searches (account_id, event_id, requested_by_user_id, seq, origin)
  VALUES (v_e.account_id, p_event_id, p_user_id, 0, p_origin) RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, NULL::text;
END $$;
COMMENT ON FUNCTION request_place_search(uuid, uuid, place_search_origin, date) IS $$Crée une recherche « Sur place » en attente, ou retourne le motif du refus (not_found, medical, no_location, ended, event_limit, daily_limit). La recherche compte dans le plafond quotidien du profil ; 3 par RDV hors échecs. [US-112 RF1, RF9, RT5]$$;

-- Prise d'une recherche par l'exécuteur lancé dès la demande (avec son identifiant) ou par le planificateur de 5 minutes, filet de
-- sécurité (sans identifiant : la plus ancienne recherche en attente depuis plus de 30 secondes, SKIP LOCKED). NULL si rien à prendre.
CREATE FUNCTION claim_place_search(p_search_id uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_grace integer; v_id uuid;
BEGIN
  IF p_search_id IS NOT NULL THEN
    v_id := p_search_id;
  ELSE
    SELECT value_text::integer INTO v_grace FROM platform_settings WHERE setting_key = 'place_search_queue_grace_seconds';
    SELECT id INTO v_id FROM event_place_searches
     WHERE status = 'queued' AND queued_at < now() - make_interval(secs => COALESCE(v_grace, 30))
     ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF v_id IS NULL THEN RETURN NULL; END IF;
  END IF;
  UPDATE event_place_searches SET status = 'running', started_at = now(), attempts = attempts + 1
   WHERE id = v_id AND status = 'queued' RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION claim_place_search(uuid) IS $$Passe une recherche de « en attente » à « en cours ». Avec un identifiant : l'exécuteur lancé dès la demande. Sans identifiant : le planificateur reprend la plus ancienne recherche en attente depuis plus de 30 secondes. NULL si rien à prendre ou déjà prise. [US-112 RT5]$$;

-- Fin d'une recherche en cours : terminée, aucune information ou échec. Retourne false si la recherche n'est plus en cours (par exemple
-- devenue obsolète parce que l'adresse du RDV a changé : le résultat est alors à jeter). p_notify : prévenir le profil demandeur
-- (« le résultat est prêt »), quand il a quitté le tchat.
CREATE FUNCTION complete_place_search(
  p_search_id uuid, p_status place_search_status, p_payload bytea DEFAULT NULL, p_failure_reason text DEFAULT NULL,
  p_checked_on date DEFAULT NULL, p_notify boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_s event_place_searches%ROWTYPE;
BEGIN
  IF p_status NOT IN ('done', 'no_result', 'failed') THEN
    RAISE EXCEPTION 'État final de recherche invalide : %', p_status USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_s FROM event_place_searches WHERE id = p_search_id AND status = 'running' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE event_place_searches
     SET status = p_status, finished_at = now(),
         result_payload = CASE WHEN p_status = 'done' THEN p_payload END,
         failure_reason = CASE WHEN p_status = 'failed' THEN COALESCE(p_failure_reason, 'error') END,
         checked_on = CASE WHEN p_status IN ('done', 'no_result') THEN COALESCE(p_checked_on, current_date) END
   WHERE id = p_search_id;
  IF p_notify AND p_status IN ('done', 'no_result') AND v_s.requested_by_user_id IS NOT NULL THEN
    INSERT INTO scheduled_notifications (event_id, recipient_user_id, kind, due_at)
    VALUES (v_s.event_id, v_s.requested_by_user_id, 'place_search_ready', now())
    ON CONFLICT (event_id, kind, recipient_user_id, due_at) WHERE event_id IS NOT NULL DO NOTHING;
  END IF;
  RETURN true;
END $$;
COMMENT ON FUNCTION complete_place_search(uuid, place_search_status, bytea, text, date, boolean) IS $$Termine une recherche en cours (done, no_result ou failed) ; false si elle n'est plus en cours (obsolète). Peut prévenir le profil demandeur. [US-112 RF4, RF10, RF11]$$;

-- Filet de sécurité du planificateur : une recherche en cours depuis plus de 120 secondes échoue (« La recherche n'a pas abouti »,
-- bouton « Réessayer ») ; une recherche en attente depuis plus de 15 minutes échoue aussi (service indisponible). Retourne le nombre.
CREATE FUNCTION fail_stale_place_searches() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_timeout integer; v_a integer; v_b integer;
BEGIN
  SELECT value_text::integer INTO v_timeout FROM platform_settings WHERE setting_key = 'place_search_timeout_seconds';
  UPDATE event_place_searches SET status = 'failed', failure_reason = 'timeout', finished_at = now()
   WHERE status = 'running' AND started_at < now() - make_interval(secs => COALESCE(v_timeout, 120));
  GET DIAGNOSTICS v_a = ROW_COUNT;
  UPDATE event_place_searches SET status = 'failed', failure_reason = 'service_unavailable', finished_at = now()
   WHERE status = 'queued' AND queued_at < now() - interval '15 minutes';
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
COMMENT ON FUNCTION fail_stale_place_searches() IS $$Fait échouer les recherches « Sur place » en cours depuis plus de 120 secondes (réglable) ou en attente depuis plus de 15 minutes. À planifier toutes les 5 minutes. [US-112 RF11, RT5]$$;

-- Les résultats sont gardés jusqu'à la fin du RDV, puis supprimés (RT4) ; ceux d'un RDV annulé ou ignoré partent aussi.
CREATE FUNCTION purge_place_searches() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM event_place_searches s USING family_events e
   WHERE e.id = s.event_id AND (e.ends_at < now() OR e.status IN ('cancelled', 'dismissed'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_place_searches() IS $$Supprime les recherches « Sur place » (et leurs résultats) des RDV terminés, annulés ou ignorés. À planifier chaque heure. [US-112 RT4]$$;

-- Durée du trajet sous le lieu : chaque profil ne voit que la sienne (D55) ; celle de l'autre parent révélerait où il se trouve.
CREATE FUNCTION travel_advice_visible_to(p_viewer uuid) RETURNS SETOF event_travel_advice
LANGUAGE sql STABLE AS $$
  SELECT a.* FROM event_travel_advice a WHERE a.user_id = p_viewer
$$;
COMMENT ON FUNCTION travel_advice_visible_to(uuid) IS $$Estimations de trajet d'un profil : uniquement les siennes, jamais celles d'un autre profil (D55). [US-107, US-112]$$;

-- Journal d'administration : conservé 5 ans (décision du PO du 26/10/2026)
CREATE FUNCTION purge_admin_audit_log() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'admin_audit_retention_months';
  DELETE FROM admin_audit_log WHERE occurred_at < now() - make_interval(months => COALESCE(v_months, 60));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_admin_audit_log() IS $$Supprime les entrées du journal d'administration de plus de 5 ans (réglable). À planifier chaque jour. [US-45, US-64]$$;

-- Notification de l'autre parent (US-113, D57 à D59) ------------------------------------------------------------------------

-- Date de mise en service (ou toute autre réglage de type horodatage) ; NULL si non renseignée
CREATE FUNCTION platform_setting_timestamp(p_key text) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN value_type = 'timestamp' AND value_text IS NOT NULL THEN value_text::timestamptz END
    FROM platform_settings WHERE setting_key = p_key
$$;
COMMENT ON FUNCTION platform_setting_timestamp(text) IS $$Valeur d'un réglage de type horodatage, NULL si non renseigné. [US-113 RT5]$$;

-- Une notification due entre 21 h et 8 h (fuseau de la famille) est reportée à 8 h (AF-2, US-113 RF12)
CREATE FUNCTION shift_to_morning(p_account_id uuid, p_at timestamptz DEFAULT now()) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE v_tz text; v_local timestamp;
BEGIN
  SELECT family_timezone INTO v_tz FROM accounts WHERE id = p_account_id;
  v_local := p_at AT TIME ZONE v_tz;
  RETURN CASE WHEN v_local::time >= time '21:00' THEN ((v_local::date + 1) + time '08:00') AT TIME ZONE v_tz
              WHEN v_local::time < time '08:00' THEN (v_local::date + time '08:00') AT TIME ZONE v_tz
              ELSE p_at END;
END $$;
COMMENT ON FUNCTION shift_to_morning(uuid, timestamptz) IS $$Reporte à 8 h (fuseau de la famille) une heure comprise entre 21 h et 8 h. [AF-2, US-113 RF12]$$;

-- Destinataires possibles d'une notification « RDV ajouté » (event_added) ou « RDV à confirmer » (event_to_confirm), avec la présence
-- d'au moins un appareil autorisé (canal). Règles : jamais le demandeur ni celui qui confirme ; seuls les RDV proposés après la date de
-- mise en service ; réglage personnel actif par défaut. Parents : « à confirmer » si le RDV est provisoire, « ajouté » s'il a été confirmé
-- par l'autre parent ou le demandeur dans le délai de 10 minutes (pas pour un enregistrement d'office, qui a son propre avis).
-- Invité secondaire nommé parmi les membres du RDV (un RDV de toute la famille ne désigne personne) : « ajouté » seulement, à toute confirmation, y compris d'office,
-- jamais « à confirmer ». Une série n'a qu'une notification : l'application désigne sa première séance.
CREATE FUNCTION family_event_notice_recipients(p_event_id uuid, p_kind notification_kind)
RETURNS TABLE (user_id uuid, has_device boolean) LANGUAGE plpgsql STABLE AS $$
DECLARE v_e family_events%ROWTYPE; v_activation timestamptz; v_delay integer;
BEGIN
  IF p_kind NOT IN ('event_added', 'event_to_confirm') THEN
    RAISE EXCEPTION 'Type de notification non géré : %', p_kind USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_e FROM family_events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN; END IF;
  -- RDV créé depuis une idée de sortie : le parent l'a voulu en connaissance de cause, l'autre parent n'est pas notifié (US-120 RF5, D64 S-06)
  IF v_e.source = 'outing' THEN RETURN; END IF;
  v_activation := platform_setting_timestamp('event_notice_activation_at');
  IF v_activation IS NULL OR v_e.created_at < v_activation THEN RETURN; END IF;
  IF (p_kind = 'event_to_confirm' AND v_e.status <> 'provisional') OR (p_kind = 'event_added' AND v_e.status <> 'confirmed') THEN
    RETURN;
  END IF;
  SELECT COALESCE(value_text::integer, 10) INTO v_delay FROM platform_settings WHERE setting_key = 'event_notice_delay_minutes';
  RETURN QUERY
  SELECT u.id,
         EXISTS (SELECT 1 FROM devices d JOIN push_subscriptions ps ON ps.device_id = d.id
                  WHERE d.user_id = u.id AND d.revoked_at IS NULL)
    FROM users u
   WHERE u.account_id = v_e.account_id AND u.status = 'active' AND u.role <> 'admin'
     AND u.id IS DISTINCT FROM v_e.requested_by_user_id
     AND u.id IS DISTINCT FROM v_e.confirmed_by_user_id
     AND COALESCE((SELECT s.notify_events_added FROM user_assistant_settings s WHERE s.user_id = u.id), true)
     AND CASE
           WHEN u.role = 'primary_user' OR u.guest_rank = 'core' THEN
             p_kind = 'event_to_confirm'
             OR (NOT v_e.auto_confirmed AND v_e.confirmed_at <= v_e.created_at + make_interval(mins => v_delay))
           ELSE
             p_kind = 'event_added'
             AND EXISTS (SELECT 1 FROM family_event_members m JOIN family_members fm ON fm.id = m.member_id
                          WHERE m.event_id = v_e.id AND fm.user_id = u.id)
         END;
END $$;
COMMENT ON FUNCTION family_event_notice_recipients(uuid, notification_kind) IS $$Destinataires d'une notification « RDV ajouté » ou « RDV à confirmer » avec leur canal (appareil autorisé ou non) : jamais le demandeur ni celui qui confirme, seulement après la date de mise en service, réglage personnel respecté ; invité secondaire seulement pour « ajouté » ; jamais pour un RDV créé depuis une idée de sortie (source « outing »). [US-113 RF1 à RF11, RF14, US-120 RF5]$$;

-- Réservation atomique de l'envoi : une ligne par RDV et par destinataire, tous types confondus (index unique). Les deux chemins (tentative
-- immédiate après la confirmation, puis planificateur) passent ici et ne produisent jamais de doublon. Canal « none » (statut
-- not_applicable) sans appareil autorisé : rien n'est envoyé, rien n'est retenté. Heure d'envoi reportée à 8 h la nuit. Retourne l'identifiant
-- de la ligne réservée, NULL si le destinataire n'est pas éligible ou si une notification existe déjà pour ce RDV.
CREATE FUNCTION reserve_event_notice(p_event_id uuid, p_recipient uuid, p_kind notification_kind) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_has boolean; v_account uuid; v_id bigint;
BEGIN
  SELECT r.has_device INTO v_has FROM family_event_notice_recipients(p_event_id, p_kind) r WHERE r.user_id = p_recipient;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT account_id INTO v_account FROM family_events WHERE id = p_event_id;
  INSERT INTO scheduled_notifications (event_id, recipient_user_id, kind, due_at, status, channel)
  VALUES (p_event_id, p_recipient, p_kind, shift_to_morning(v_account, now()),
          CASE WHEN v_has THEN 'scheduled'::notification_status ELSE 'not_applicable'::notification_status END,
          CASE WHEN v_has THEN 'push'::notification_channel ELSE 'none'::notification_channel END)
  ON CONFLICT (event_id, recipient_user_id) WHERE kind IN ('event_added', 'event_to_confirm') DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION reserve_event_notice(uuid, uuid, notification_kind) IS $$Réserve l'envoi d'une notification « RDV ajouté » ou « RDV à confirmer » : une seule par RDV et par destinataire, canal « none » sans appareil autorisé, report à 8 h la nuit. NULL si non éligible ou déjà réservée. [US-113 RF16, RT1, RT4]$$;

-- Planificateur (toutes les 5 minutes) et tentative immédiate après une confirmation (avec l'identifiant du RDV) : réserve les notifications
-- dues. « À confirmer » : RDV toujours provisoire 10 minutes après sa proposition. « Ajouté » : RDV confirmé (dans les 10 minutes pour
-- les parents, à tout moment pour l'invité secondaire concerné). Seuls les RDV récents sont examinés ; une série n'est notifiée que par
-- sa première séance. Retourne le nombre de notifications réservées.
CREATE FUNCTION plan_event_notices(p_event_id uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_activation timestamptz; v_delay integer; v_ev record; v_r record; v_kind notification_kind; v_n integer := 0;
BEGIN
  v_activation := platform_setting_timestamp('event_notice_activation_at');
  IF v_activation IS NULL THEN RETURN 0; END IF;
  SELECT COALESCE(value_text::integer, 10) INTO v_delay FROM platform_settings WHERE setting_key = 'event_notice_delay_minutes';
  FOR v_ev IN
    SELECT e.id, e.status FROM family_events e
     WHERE (p_event_id IS NULL OR e.id = p_event_id)
       AND e.created_at >= v_activation AND e.ends_at > now()
       AND (e.series_id IS NULL
            OR e.id = (SELECT x.id FROM family_events x WHERE x.series_id = e.series_id ORDER BY x.occurrence_date, x.id LIMIT 1))
       AND ((e.status = 'provisional' AND e.created_at <= now() - make_interval(mins => v_delay) AND e.created_at > now() - interval '3 days')
         OR (e.status = 'confirmed' AND e.confirmed_at > now() - interval '3 days'))
     ORDER BY e.created_at
  LOOP
    v_kind := CASE WHEN v_ev.status = 'provisional' THEN 'event_to_confirm' ELSE 'event_added' END;
    FOR v_r IN SELECT r.user_id FROM family_event_notice_recipients(v_ev.id, v_kind) r LOOP
      IF reserve_event_notice(v_ev.id, v_r.user_id, v_kind) IS NOT NULL THEN v_n := v_n + 1; END IF;
    END LOOP;
  END LOOP;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION plan_event_notices(uuid) IS $$Réserve les notifications « RDV ajouté » et « RDV à confirmer » dues (planificateur de 5 minutes, ou tentative immédiate après une confirmation avec l'identifiant du RDV). Idempotent. [US-113 RF2, RF3, RF10, RT1]$$;

-- À l'envoi (à 8 h pour une notification reportée la nuit), c'est l'état du RDV qui décide la notification envoyée (RF12, CA 12.1 et 12.2) :
-- une notification en attente peut donc changer de type. RDV encore provisoire : « à confirmer » ; RDV confirmé entre-temps :
-- « à confirmer » devient « ajouté » (la ligne réservée est mise à jour, l'index unique le permet), sauf pour celui qui a confirmé, le demandeur,
-- un enregistrement d'office (avis propre) ou un réglage personnel désactivé ; RDV écarté, annulé ou ignoré : la notification est annulée.
-- Cette conversion ne vaut que pour une notification pas encore envoyée : après l'envoi effectif d'un « à confirmer », plus rien ne part (RF4).
-- Retourne le nombre de lignes modifiées (converties ou annulées).
CREATE FUNCTION revalidate_event_notices() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_a integer; v_b integer;
BEGIN
  UPDATE scheduled_notifications n SET kind = 'event_added'
    FROM family_events e
   WHERE e.id = n.event_id AND n.status = 'scheduled' AND n.kind = 'event_to_confirm' AND e.status = 'confirmed'
     AND NOT e.auto_confirmed
     AND n.recipient_user_id IS DISTINCT FROM e.confirmed_by_user_id
     AND n.recipient_user_id IS DISTINCT FROM e.requested_by_user_id
     AND COALESCE((SELECT s.notify_events_added FROM user_assistant_settings s WHERE s.user_id = n.recipient_user_id), true);
  GET DIAGNOSTICS v_a = ROW_COUNT;
  UPDATE scheduled_notifications n SET status = 'cancelled'
    FROM family_events e
   WHERE e.id = n.event_id AND n.status = 'scheduled' AND n.kind IN ('event_added', 'event_to_confirm')
     AND ((n.kind = 'event_to_confirm' AND e.status <> 'provisional')
       OR (n.kind = 'event_added' AND e.status <> 'confirmed')
       OR NOT COALESCE((SELECT s.notify_events_added FROM user_assistant_settings s WHERE s.user_id = n.recipient_user_id), true));
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
COMMENT ON FUNCTION revalidate_event_notices() IS $$Remet les notifications « RDV ajouté » ou « RDV à confirmer » en attente en accord avec l'état du RDV : un « à confirmer » devient « ajouté » si le RDV a été confirmé entre-temps (sauf pour celui qui confirme, le demandeur, un enregistrement d'office), et la notification est annulée si le RDV est écarté, annulé ou ignoré ou si le réglage personnel est désactivé. Ne touche jamais une notification déjà envoyée. À appeler avant l'envoi des notifications dues. [US-113 RF4, RF5, RF12, CA 12.1, CA 12.2]$$;

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
COMMENT ON FUNCTION backfill_family_members() IS $$Crée la fiche « membre » des profils qui n'en ont pas (invités existants) ; une fiche archivée pour un invité retiré. Idempotent. [US-92 RF1, US-20, US-113 RT6]$$;

-- Purges du MVP2 ---------------------------------------------------------

-- Tâches : « à faire » jamais faites annulées 45 jours après l'échéance ; proposées supprimées quand le RDV a eu lieu ;
-- faites ou annulées supprimées après 90 jours ; séries terminées sans tâche supprimées. Retourne le nombre de tâches supprimées.
CREATE FUNCTION purge_expired_family_tasks() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_cancel integer; v_keep integer; v_a bigint; v_b bigint;
BEGIN
  SELECT value_text::integer INTO v_cancel FROM platform_settings WHERE setting_key = 'overdue_task_auto_cancel_days';
  SELECT value_text::integer INTO v_keep FROM platform_settings WHERE setting_key = 'task_retention_days';
  UPDATE family_tasks SET status = 'cancelled', cancel_reason = 'expired'
   WHERE status = 'todo' AND due_date < current_date - COALESCE(v_cancel, 45);
  DELETE FROM family_tasks t
   WHERE t.status = 'proposed' AND EXISTS (SELECT 1 FROM family_events e WHERE e.id = t.event_id AND e.ends_at < now());
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM family_tasks
   WHERE status IN ('done', 'cancelled') AND status_changed_at < now() - make_interval(days => COALESCE(v_keep, 90));
  GET DIAGNOSTICS v_b = ROW_COUNT;
  DELETE FROM family_task_series s
   WHERE s.ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM family_tasks t WHERE t.series_id = s.id);
  RETURN v_a + v_b;
END $$;
COMMENT ON FUNCTION purge_expired_family_tasks() IS $$Annule les tâches jamais faites 45 jours après leur échéance, supprime les tâches proposées d'un RDV passé, les tâches faites ou annulées après 90 jours et les séries terminées. À planifier chaque jour. [US-110 RT3, US-95 RF10, D47]$$;

-- Questions et réponses d'anticipation : 24 mois après la fin de leur période (les refus « Ne plus me le proposer » restent)
CREATE FUNCTION purge_expired_anticipation() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'anticipation_retention_months';
  DELETE FROM anticipation_questions WHERE period_end < current_date - make_interval(months => COALESCE(v_months, 24));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_expired_anticipation() IS $$Supprime les questions d'anticipation et leurs réponses 24 mois après la fin de leur période. À planifier chaque jour. [US-102 RT3, D47]$$;

CREATE FUNCTION purge_expired_weekly_digests() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_weeks integer; v_n bigint;
BEGIN
  SELECT value_text::integer INTO v_weeks FROM platform_settings WHERE setting_key = 'weekly_digest_retention_weeks';
  DELETE FROM weekly_digests WHERE week_start < current_date - COALESCE(v_weeks, 4) * 7;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_expired_weekly_digests() IS $$Supprime les résumés du point hebdomadaire de plus de 4 semaines. À planifier chaque jour. [US-98 RT3]$$;

-- Trajets : estimations et suivis des RDV terminés, suivis des séries terminées ou annulées. À planifier chaque heure.
CREATE FUNCTION purge_travel_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_a bigint; v_b bigint; v_c bigint;
BEGIN
  DELETE FROM event_travel_advice a USING family_events e WHERE e.id = a.event_id AND e.ends_at < now();
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM travel_tracking t USING family_events e WHERE t.event_id = e.id AND e.ends_at < now();
  GET DIAGNOSTICS v_b = ROW_COUNT;
  DELETE FROM travel_tracking t USING family_event_series s
   WHERE t.series_id = s.id AND (s.ended_at IS NOT NULL OR s.status IN ('cancelled', 'dismissed'));
  GET DIAGNOSTICS v_c = ROW_COUNT;
  RETURN v_a + v_b + v_c;
END $$;
COMMENT ON FUNCTION purge_travel_data() IS $$Supprime les estimations de trajet et les suivis des RDV terminés, et les suivis des séries terminées ou annulées. À planifier chaque heure. [US-107 RF12]$$;

-- Dernière position : supprimée à l'échéance (3 heures au plus). À planifier toutes les 5 minutes ; la lecture ignore déjà les lignes échues.
CREATE FUNCTION purge_expired_device_positions() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM device_last_positions WHERE expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_expired_device_positions() IS $$Supprime les dernières positions échues (3 heures au plus, jamais au-delà de la fin du RDV). À planifier toutes les 5 minutes. [US-107 RF12, D47]$$;

CREATE FUNCTION purge_old_school_holidays() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM school_holiday_periods WHERE ends_on < current_date - interval '2 years';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_old_school_holidays() IS $$Supprime les périodes de vacances scolaires terminées depuis plus de 2 ans. À planifier chaque année. [US-109 RT3]$$;

-- Notifications sans RDV (tâches, point de la semaine) : supprimées 30 jours après l'échéance (celles liées à un RDV partent avec lui)
CREATE FUNCTION purge_old_scheduled_notifications() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_days integer; v_n bigint; v_m bigint;
BEGIN
  SELECT value_text::integer INTO v_days FROM platform_settings WHERE setting_key = 'notification_retention_days';
  DELETE FROM scheduled_notifications
   WHERE event_id IS NULL AND status <> 'scheduled' AND due_at < now() - make_interval(days => COALESCE(v_days, 30));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- Registre des notifications « RDV ajouté » et « RDV à confirmer » : supprimé 30 jours après la fin du RDV (il part de toute façon avec le RDV)
  DELETE FROM scheduled_notifications n USING family_events e
   WHERE e.id = n.event_id AND n.kind IN ('event_added', 'event_to_confirm') AND n.status <> 'scheduled'
     AND e.ends_at < now() - make_interval(days => COALESCE(v_days, 30));
  GET DIAGNOSTICS v_m = ROW_COUNT;
  RETURN v_n + v_m;
END $$;
COMMENT ON FUNCTION purge_old_scheduled_notifications() IS $$Supprime les notifications sans RDV (tâches, point de la semaine) traitées depuis plus de 30 jours, et le registre des notifications « RDV ajouté » ou « RDV à confirmer » 30 jours après la fin du RDV. À planifier chaque jour. [US-97, US-98, US-113]$$;

-- =====================================================================
-- 8 quinquies. ASSISTANT FAMILLE — LOT 10 : SOUS-AGENTS SORTIES ET DEVOIRS
-- Sources : MAAQ_US_Detaillees_BA_Sorties_Devoirs.md (US-114 à US-121, décision D64, règles communes SG-1 à SG-6),
-- validé par le PO le 30/10/2026. Sorties et Devoirs sont des comportements de l'Assistant Famille, pas des agents du catalogue (SG-1).
-- Deux régimes de confidentialité :
--  * SORTIES : données PRIVÉES du PROFIL, jamais du foyer (US-117). Aucune clé étrangère d'une table du foyer ne les désigne, aucune
--    vue du foyer ne les lit, le carnet de bord ne les voit pas. Lecture par le seul propriétaire : fonctions outing_*_visible_to
--    et sécurité par ligne (RLS) sur les cinq tables. Réservées aux deux parents (invité secondaire exclu, S-02).
--  * DEVOIRS : données du FOYER (réglage commun, âge des devoirs et progrès par membre enfant, partagés entre les deux parents).
--    Données de MINEURS : supprimées avec le membre et à la demande « Effacer les progrès ». Aucune photo n'est jamais stockée (S-10).
-- =====================================================================

-- Profil connecté à la base : l'application l'indique au début de chaque transaction (SET LOCAL app.user_id = '<uuid du profil>').
-- Sert uniquement aux règles de sécurité par ligne ; vide (NULL) si rien n'est indiqué, et alors aucune ligne privée n'est visible.
CREATE FUNCTION app_current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
COMMENT ON FUNCTION app_current_user_id() IS $$Profil indiqué par l'application dans la variable de session app.user_id (SET LOCAL au début de la transaction) ; NULL si elle est absente. Sert aux règles de sécurité par ligne des données privées d'un profil (idées de sorties). [US-117 RT1]$$;

-- Une saisie qui ressemble à une adresse : numéro de voie en tête (« 12 rue… », « 5 bis, impasse… ») ou mot de type de voie. Filet de sécurité
-- de la base : le contrôle complet (message « Indiquez une ville ou un secteur, pas une adresse. ») reste celui de l'application. « place » et
-- « cours » ne sont pas retenus : ce sont aussi des noms de communes et de quartiers. (D47, US-114 RF5, RT2)
CREATE FUNCTION looks_like_address(p_text text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_text ~* '^\s*[0-9]+\s*(bis|ter|quater)?\s*,?\s+\S'
      OR p_text ~* '(^|[\s,;])(rue|avenue|av\.?|boulevard|bd|chemin|impasse|allée|allee|route|quai|passage|square|esplanade|ruelle|sentier|lotissement|résidence|residence|hameau|lieu-dit)([\s,;]|$)'
$$;
COMMENT ON FUNCTION looks_like_address(text) IS $$Vrai si le texte ressemble à une adresse (numéro de voie en tête ou mot de type de voie) : refusé pour le lieu de départ des sorties. Filet de sécurité de la base, en plus du contrôle de l'application. [US-114 RF5, RT2, D47]$$;

-- Jours de la semaine ISO (1 = lundi … 7 = dimanche) : au moins un, sans doublon
CREATE FUNCTION iso_weekdays_valid(p_days smallint[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(cardinality(p_days) BETWEEN 1 AND 7
                  AND p_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
                  AND (SELECT count(DISTINCT d) FROM unnest(p_days) d) = cardinality(p_days), false)
$$;
COMMENT ON FUNCTION iso_weekdays_valid(smallint[]) IS $$Vrai si la liste contient 1 à 7 jours ISO (1 = lundi) sans doublon. [US-119 RF2]$$;

-- Niveau scolaire correspondant à l'« âge des devoirs » : 6 ans = CP, 7 = CE1, 8 = CE2, 9 = CM1, 10 à 12 = CM2 (US-118 RF4)
CREATE FUNCTION homework_level_for_age(p_age smallint) RETURNS homework_level LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE WHEN p_age = 6 THEN 'cp' WHEN p_age = 7 THEN 'ce1' WHEN p_age = 8 THEN 'ce2' WHEN p_age = 9 THEN 'cm1'
               WHEN p_age BETWEEN 10 AND 12 THEN 'cm2' END)::homework_level
$$;
COMMENT ON FUNCTION homework_level_for_age(smallint) IS $$Niveau de maths de l'âge des devoirs : 6 ans CP, 7 CE1, 8 CE2, 9 CM1, 10 à 12 ans CM2 ; NULL hors de 6 à 12 ans. [US-118 RF4]$$;

-- =====================================================================
-- SORTIES (US-114 à US-117, US-120, US-121)
-- =====================================================================

-- Catalogue fermé des catégories et des thèmes (US-114 RF2) : chargé avec le schéma, évolue par ajout de lignes
CREATE TABLE outing_themes (
  category    outing_category NOT NULL,
  theme_key   text NOT NULL CHECK (theme_key ~ '^[a-z_]+$'),
  label       varchar(60) NOT NULL,
  -- Sous-groupe d'affichage (D68) : « concerts » pour les six thèmes de concert ; vide pour les autres
  theme_group text CHECK (theme_group ~ '^[a-z_]+$'),
  sort_order  smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (category, theme_key)
);
COMMENT ON COLUMN outing_themes.theme_group IS $$Sous-groupe d'affichage du thème (clé technique, par exemple « concerts » : l'écran range ces thèmes dans un sous-groupe repliable) ; vide = thème sans sous-groupe. Un thème d'un sous-groupe reste un thème ordinaire de sa catégorie (règle « au moins un thème », choix, idées). Le libellé du sous-groupe est porté par l'écran (D68)$$;
COMMENT ON TABLE outing_themes IS $$Listes fermées des thèmes de sorties, par catégorie (pour moi, en couple, enfants de 3 à 10 ans, ados de 11 à 17 ans). Le même thème peut exister dans plusieurs catégories. [US-114 RF2]$$;

-- Critères de sorties d'un profil (US-114) : réglages PERSONNELS, une ligne par profil parent. Table dédiée plutôt que des colonnes de
-- user_assistant_settings (RT1) : une dizaine de valeurs dont une liste de thèmes et des règles d'ensemble (« activé » exige budget, lieu et
-- au moins un thème), données privées à protéger par la sécurité par ligne alors que les réglages de notification sont lus par les
-- planificateurs, et traitement propre à l'export et à l'effacement.
CREATE TABLE outing_criteria (
  user_id          uuid PRIMARY KEY,
  account_id       uuid NOT NULL,
  -- « Recevoir des idées de sorties » : désactivé par défaut. Désactiver ne supprime rien (SG-2)
  enabled          boolean NOT NULL DEFAULT false,
  -- Budget total en euros (10 à 2 000) et nombre de personnes (1 à 10) ; obligatoires dès que l'interrupteur est activé
  budget_eur       integer CHECK (budget_eur BETWEEN 10 AND 2000),
  people_count     smallint CHECK (people_count BETWEEN 1 AND 10),
  -- Une ville ou un secteur, jamais une adresse (D47)
  departure_place  varchar(80),
  mood             outing_mood NOT NULL DEFAULT 'both',
  preferred_days   outing_day_pref[] NOT NULL DEFAULT ARRAY['weekend']::outing_day_pref[],
  frequency        outing_frequency NOT NULL DEFAULT 'monthly',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_outing_criteria_user FOREIGN KEY (user_id, account_id)
    REFERENCES users (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_outing_criteria_enabled CHECK (NOT enabled OR (budget_eur IS NOT NULL AND people_count IS NOT NULL AND departure_place IS NOT NULL)),
  CONSTRAINT ck_outing_criteria_place CHECK (departure_place IS NULL OR (length(btrim(departure_place)) >= 2 AND NOT looks_like_address(departure_place))),
  CONSTRAINT ck_outing_criteria_days CHECK (cardinality(preferred_days) BETWEEN 1 AND 9),
  -- D67 : « une par semaine » est retiré ; la valeur reste dans le type (on n'en retire pas une valeur), la contrainte la refuse
  CONSTRAINT ck_outing_criteria_frequency CHECK (frequency <> 'weekly')
);
CREATE INDEX idx_outing_criteria_account_id ON outing_criteria (account_id);
COMMENT ON TABLE outing_criteria IS $$Critères de sorties d'un profil parent : interrupteur (désactivé par défaut), budget et nombre de personnes, ville ou secteur de départ, ambiance, jours préférés, fréquence. Données PRIVÉES du profil : l'autre parent ne les voit pas. Les catégories et thèmes sont dans outing_criteria_themes. [US-114, US-117, RT1]$$;
COMMENT ON COLUMN outing_criteria.enabled IS $$« Recevoir des idées de sorties » : faux par défaut ; vrai exige budget, nombre de personnes, lieu de départ et au moins un thème. Désactiver arrête les propositions sans rien supprimer (SG-2)$$;
COMMENT ON COLUMN outing_criteria.departure_place IS $$Ville ou secteur (« Lyon », « Paris et Île-de-France »), 80 caractères au plus, jamais une adresse : refusé si la saisie ressemble à une adresse (looks_like_address). Aucune adresse de domicile n'est stockée (D47)$$;
COMMENT ON COLUMN outing_criteria.frequency IS $$Fréquence des propositions : une par mois (monthly, défaut) ou deux par mois (twice_monthly). La valeur weekly (une par semaine) est retirée par la décision D67 (coût d'une proposition) : elle reste dans le type énuméré mais la contrainte ck_outing_criteria_frequency la refuse$$;
COMMENT ON COLUMN outing_criteria.preferred_days IS $$Jours préférés : week-end (samedi, dimanche), soirs de semaine, ou un jour précis. Au moins un ; « week-end » par défaut. Le jour visé est choisi par l'application (US-115 RF1)$$;

-- Thèmes choisis : la catégorie est choisie si elle a au moins un thème (« au moins un thème par catégorie choisie », US-114 RF2)
CREATE TABLE outing_criteria_themes (
  user_id    uuid NOT NULL REFERENCES outing_criteria (user_id) ON DELETE CASCADE,
  category   outing_category NOT NULL,
  theme_key  text NOT NULL,
  PRIMARY KEY (user_id, category, theme_key),
  CONSTRAINT fk_outing_criteria_themes_theme FOREIGN KEY (category, theme_key)
    REFERENCES outing_themes (category, theme_key)
);
CREATE INDEX idx_outing_criteria_themes_theme ON outing_criteria_themes (category, theme_key);
COMMENT ON TABLE outing_criteria_themes IS $$Thèmes choisis par un profil, par catégorie : une catégorie est choisie quand elle a au moins un thème. Des critères activés exigent au moins un thème (contrôle différé à la fin de la transaction). Privé au profil. [US-114 RF2, RF6]$$;

-- Propositions de sorties (US-115, US-116) : données PRIVÉES du profil, préparées en arrière-plan. Une par profil et par jour visé.
CREATE TABLE outing_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL,
  user_id            uuid NOT NULL,
  -- Jour visé (jour local de la famille) ; la proposition reste visible jusqu'à la fin de ce jour et disparaît 30 jours après
  target_date        date NOT NULL,
  status             outing_proposal_status NOT NULL DEFAULT 'ready',
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  -- Critères au moment de la préparation (en-tête de l'écran, jauge « X % du budget ») : ils ne suivent pas une modification ultérieure
  budget_eur         integer NOT NULL CHECK (budget_eur BETWEEN 10 AND 2000),
  people_count       smallint NOT NULL CHECK (people_count BETWEEN 1 AND 10),
  departure_place    varchar(80) NOT NULL CHECK (length(btrim(departure_place)) >= 2 AND NOT looks_like_address(departure_place)),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, target_date),
  CONSTRAINT fk_outing_proposals_user FOREIGN KEY (user_id, account_id)
    REFERENCES users (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_outing_proposals_account_id ON outing_proposals (account_id);
CREATE INDEX idx_outing_proposals_target ON outing_proposals (target_date);
COMMENT ON TABLE outing_proposals IS $$Proposition de sorties préparée pour un profil parent, pour un jour visé : statut (prête, écartée, ajoutée) et critères du moment. Donnée PRIVÉE du profil : jamais dans le calendrier familial, le carnet de bord, le point de la semaine ni le compteur de l'icône ; sans lien avec le RDV éventuellement créé. Supprimée 30 jours après le jour visé. [US-115, US-116, US-117]$$;
COMMENT ON COLUMN outing_proposals.status IS $$ready = visible sur l'accueil du profil ; dismissed = retirée par le profil (revenir en arrière possible tant qu'une idée reste) ; added = une idée a été ajoutée au calendrier. Transitions : ready ↔ dismissed, ready → added$$;
COMMENT ON COLUMN outing_proposals.target_date IS $$Jour visé, choisi par l'application (prochain jour préféré au moins 4 jours plus tard et sans RDV sur toute la journée). Une seule proposition par profil et par jour visé : un second passage du planificateur ne crée pas de doublon$$;

-- Idées d'une proposition (US-115 RF2 à RF4). Les textes sont chiffrés par l'application : la proposition peut préparer une surprise (US-117)
-- et les administrateurs n'en voient pas le contenu (RF5). Aucun prix, horaire ou lien ne vient de la mémoire du modèle (RF4).
CREATE TABLE outing_proposal_ideas (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id         uuid NOT NULL,
  user_id             uuid NOT NULL,
  idea_position       smallint NOT NULL CHECK (idea_position >= 1),
  -- « Dans le budget » (2 idées par thème choisi, 6 au plus) ou « Nouveautés hors budget » (2 au plus)
  section             outing_idea_section NOT NULL,
  -- Thème de l'idée « dans le budget » (écran présenté par thème) ; vide pour une nouveauté
  category            outing_category,
  theme_key           text,
  name                bytea NOT NULL,
  place               bytea NOT NULL,
  description         bytea NOT NULL,
  -- Durée, accès, à savoir
  details             bytea,
  offer_url           bytea NOT NULL,
  price_eur           numeric(8,2) NOT NULL CHECK (price_eur >= 0),
  price_is_estimated  boolean NOT NULL DEFAULT false,
  -- Calcul de l'estimation, quand le prix est marqué « estimé »
  price_basis         bytea,
  -- Date du relevé du prix (source datée)
  price_checked_on    date NOT NULL,
  -- Année d'ouverture d'une nouveauté ouverte depuis plus d'un an (RF4)
  opened_year         smallint CHECK (opened_year BETWEEN 1900 AND 2100),
  status              outing_idea_status NOT NULL DEFAULT 'proposed',
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, idea_position),
  CONSTRAINT fk_outing_ideas_proposal FOREIGN KEY (proposal_id, user_id)
    REFERENCES outing_proposals (id, user_id) ON DELETE CASCADE,
  CONSTRAINT fk_outing_ideas_theme FOREIGN KEY (category, theme_key)
    REFERENCES outing_themes (category, theme_key) ON DELETE SET NULL (category, theme_key),
  CONSTRAINT ck_outing_ideas_theme CHECK ((category IS NULL) = (theme_key IS NULL) AND (section = 'in_budget' OR category IS NULL)),
  CONSTRAINT ck_outing_ideas_price_basis CHECK (price_is_estimated OR price_basis IS NULL),
  CONSTRAINT ck_outing_ideas_opened_year CHECK (section = 'novelty' OR opened_year IS NULL)
);
CREATE INDEX idx_outing_ideas_user ON outing_proposal_ideas (user_id);
CREATE INDEX idx_outing_ideas_theme ON outing_proposal_ideas (category, theme_key) WHERE category IS NOT NULL;
COMMENT ON TABLE outing_proposal_ideas IS $$Idées d'une proposition de sorties : rubrique, thème, nom, lieu, prix (relevé ou estimé, avec sa date de relevé), description, détails, lien « Voir l'offre », et statut de chaque idée (proposée, écartée, ajoutée). Textes chiffrés par l'application. Privé au profil propriétaire de la proposition. Supprimées avec elle. [US-115 RF2 à RF4, US-116 RF2, US-117]$$;
COMMENT ON COLUMN outing_proposal_ideas.price_is_estimated IS $$Prix non affiché par la source, estimé avec son calcul (price_basis) : l'application affiche « estimé », ou « ≈ » pour une nouveauté$$;
COMMENT ON COLUMN outing_proposal_ideas.status IS $$proposed ; dismissed = « Pas cette fois » (retire cette seule idée ; la dernière idée retirée retire la proposition) ; added = « Ajoutée au calendrier » (la proposition passe à « ajoutée ») . Aucun lien vers le RDV créé$$;

-- Mémoire anti-répétition (US-115 RF8, US-116 RF3) : une offre déjà proposée n'est pas reproposée au même parent pendant 90 jours, même si la
-- proposition a été écartée ou supprimée. Aucun texte : seule l'empreinte de l'offre (calculée par l'application) est gardée.
CREATE TABLE outing_offer_memory (
  user_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  -- Empreinte SHA-256 (32 octets) de l'offre (nom et lieu normalisés), calculée par l'application
  offer_hash   bytea NOT NULL CHECK (octet_length(offer_hash) = 32),
  proposed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, offer_hash),
  CONSTRAINT fk_outing_offer_memory_user FOREIGN KEY (user_id, account_id)
    REFERENCES users (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_outing_offer_memory_account_id ON outing_offer_memory (account_id);
CREATE INDEX idx_outing_offer_memory_proposed ON outing_offer_memory (proposed_at);
COMMENT ON TABLE outing_offer_memory IS $$Offres déjà proposées à un profil parent, pour ne pas les reproposer pendant 90 jours (réglage outing_offer_memory_days). Empreinte seulement, aucun texte ; une nouvelle proposition de la même offre renouvelle la date. Privée au profil ; supprimée avec lui. [US-115 RF8, US-116 RF3]$$;
COMMENT ON COLUMN outing_offer_memory.offer_hash IS $$Empreinte SHA-256 de l'offre (nom et lieu normalisés), calculée par l'application avec un secret : jamais un texte lisible$$;

-- Réservé aux deux parents : l'invité secondaire n'a ni critères, ni propositions (S-02)
CREATE FUNCTION outing_require_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND (u.role = 'primary_user' OR u.guest_rank = 'core') AND u.status <> 'removed') THEN
    RAISE EXCEPTION 'Les idées de sorties sont réservées aux deux parents' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_outing_criteria_parent BEFORE INSERT OR UPDATE ON outing_criteria
  FOR EACH ROW EXECUTE FUNCTION outing_require_parent();
CREATE TRIGGER trg_outing_proposals_parent BEFORE INSERT ON outing_proposals
  FOR EACH ROW EXECUTE FUNCTION outing_require_parent();
CREATE TRIGGER trg_outing_offer_memory_parent BEFORE INSERT ON outing_offer_memory
  FOR EACH ROW EXECUTE FUNCTION outing_require_parent();

-- Des critères activés ont au moins un thème. Contrôle différé à la fin de la transaction : l'application écrit les critères puis
-- leurs thèmes dans la même transaction, dans l'ordre de son choix. Un retrait du dernier thème d'un profil activé est refusé.
CREATE FUNCTION outing_criteria_themes_required() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_user uuid;
BEGIN
  v_user := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  IF EXISTS (SELECT 1 FROM outing_criteria c WHERE c.user_id = v_user AND c.enabled)
     AND NOT EXISTS (SELECT 1 FROM outing_criteria_themes t WHERE t.user_id = v_user) THEN
    RAISE EXCEPTION 'Des critères de sorties activés demandent au moins un thème' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_outing_criteria_themes_required AFTER INSERT OR UPDATE ON outing_criteria
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION outing_criteria_themes_required();
CREATE CONSTRAINT TRIGGER trg_outing_criteria_themes_kept AFTER DELETE OR UPDATE ON outing_criteria_themes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION outing_criteria_themes_required();

-- Transitions d'une proposition : prête ↔ écartée (retour en arrière du bouton « Annuler »), prête → ajoutée (terminal)
CREATE FUNCTION outing_proposal_transition_allowed(p_from outing_proposal_status, p_to outing_proposal_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (('ready', 'dismissed'), ('dismissed', 'ready'), ('ready', 'added'))
$$;
COMMENT ON FUNCTION outing_proposal_transition_allowed(outing_proposal_status, outing_proposal_status) IS $$Transitions permises d'une proposition de sorties : prête vers écartée et retour, prête vers ajoutée. [US-116 RF1, RF2, US-120 RF6]$$;

CREATE FUNCTION outing_proposal_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.target_date IS DISTINCT FROM OLD.target_date THEN
    RAISE EXCEPTION 'Le profil et le jour visé d''une proposition ne changent pas' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT outing_proposal_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Transition interdite pour une proposition de sorties : % vers %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    -- Revenir en arrière n'a de sens que s'il reste une idée à voir (la dernière idée écartée retire la proposition)
    IF NEW.status = 'ready' AND NOT EXISTS (SELECT 1 FROM outing_proposal_ideas i WHERE i.proposal_id = NEW.id AND i.status = 'proposed') THEN
      RAISE EXCEPTION 'Aucune idée à remettre dans la proposition' USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
    -- Une proposition retirée ou ajoutée n'a plus à être annoncée : la notification en attente est annulée
    IF NEW.status <> 'ready' THEN
      UPDATE scheduled_notifications SET status = 'cancelled'
       WHERE kind = 'outing_proposal' AND recipient_user_id = NEW.user_id AND subject_date = NEW.target_date AND status = 'scheduled';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_outing_proposals_before_update BEFORE UPDATE ON outing_proposals
  FOR EACH ROW EXECUTE FUNCTION outing_proposal_before_update();

-- Proposition supprimée (purge, effacement) : la notification qui ne serait pas encore partie est supprimée avec elle
CREATE FUNCTION outing_proposal_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM scheduled_notifications
   WHERE kind = 'outing_proposal' AND recipient_user_id = OLD.user_id AND subject_date = OLD.target_date AND status = 'scheduled';
  RETURN OLD;
END $$;
CREATE TRIGGER trg_outing_proposals_deleted AFTER DELETE ON outing_proposals
  FOR EACH ROW EXECUTE FUNCTION outing_proposal_deleted();

-- Ajout d'une idée : seulement à la création de la proposition ; 6 idées au plus « dans le budget » dont 2 par thème, 2 nouveautés au plus (RF2)
CREATE FUNCTION outing_idea_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status outing_proposal_status; v_n integer; v_max integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('outing_ideas:' || NEW.proposal_id::text, 0));
  SELECT status INTO v_status FROM outing_proposals WHERE id = NEW.proposal_id;
  IF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'Les idées se déposent à la création de la proposition' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_n FROM outing_proposal_ideas WHERE proposal_id = NEW.proposal_id AND section = NEW.section;
  v_max := CASE NEW.section WHEN 'in_budget' THEN 6 ELSE 2 END;
  IF v_n >= v_max THEN
    RAISE EXCEPTION 'Une proposition compte au plus 6 idées dans le budget et 2 nouveautés' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.category IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM outing_proposal_ideas
     WHERE proposal_id = NEW.proposal_id AND category = NEW.category AND theme_key = NEW.theme_key;
    IF v_n >= 2 THEN
      RAISE EXCEPTION 'Une proposition compte au plus 2 idées par thème' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_outing_ideas_before_insert BEFORE INSERT ON outing_proposal_ideas
  FOR EACH ROW EXECUTE FUNCTION outing_idea_before_insert();

-- Une idée ne change que de statut, et seulement tant que la proposition est prête : proposée → écartée ou ajoutée, écartée → proposée
CREATE FUNCTION outing_idea_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status outing_proposal_status;
BEGIN
  IF ROW(NEW.proposal_id, NEW.user_id, NEW.idea_position, NEW.section, NEW.category, NEW.theme_key, NEW.name, NEW.place, NEW.description,
         NEW.details, NEW.offer_url, NEW.price_eur, NEW.price_is_estimated, NEW.price_basis, NEW.price_checked_on, NEW.opened_year)
     IS DISTINCT FROM
     ROW(OLD.proposal_id, OLD.user_id, OLD.idea_position, OLD.section, OLD.category, OLD.theme_key, OLD.name, OLD.place, OLD.description,
         OLD.details, OLD.offer_url, OLD.price_eur, OLD.price_is_estimated, OLD.price_basis, OLD.price_checked_on, OLD.opened_year) THEN
    RAISE EXCEPTION 'Une idée de sortie ne se modifie pas : seul son statut change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (('proposed', 'dismissed'), ('proposed', 'added'), ('dismissed', 'proposed')) THEN
      RAISE EXCEPTION 'Transition interdite pour une idée de sortie : % vers %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    SELECT status INTO v_status FROM outing_proposals WHERE id = NEW.proposal_id FOR SHARE;
    IF v_status IS DISTINCT FROM 'ready' THEN
      RAISE EXCEPTION 'La proposition n''est plus affichée : ses idées ne changent plus' USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_outing_ideas_before_update BEFORE UPDATE ON outing_proposal_ideas
  FOR EACH ROW EXECUTE FUNCTION outing_idea_before_update();

-- Idée ajoutée au calendrier : la proposition passe à « ajoutée » (elle disparaît de l'accueil, US-120 RF6).
-- Dernière idée écartée : la proposition entière est retirée (US-116 RF2).
CREATE FUNCTION outing_idea_after_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'added' THEN
    UPDATE outing_proposals SET status = 'added' WHERE id = NEW.proposal_id AND status = 'ready';
  ELSIF NEW.status = 'dismissed'
        AND NOT EXISTS (SELECT 1 FROM outing_proposal_ideas i WHERE i.proposal_id = NEW.proposal_id AND i.status <> 'dismissed') THEN
    UPDATE outing_proposals SET status = 'dismissed' WHERE id = NEW.proposal_id AND status = 'ready';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_outing_ideas_after_status AFTER UPDATE OF status ON outing_proposal_ideas
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION outing_idea_after_status();

-- Lecture réservée au propriétaire : mêmes principes que travel_advice_visible_to, jamais un autre profil, même parent (US-117 RT1)
CREATE FUNCTION outing_criteria_visible_to(p_viewer uuid) RETURNS SETOF outing_criteria
LANGUAGE sql STABLE AS $$
  SELECT c.* FROM outing_criteria c WHERE c.user_id = p_viewer
$$;
COMMENT ON FUNCTION outing_criteria_visible_to(uuid) IS $$Critères de sorties d'un profil : uniquement les siens, jamais ceux de l'autre parent. [US-114 RF1, US-117]$$;
CREATE FUNCTION outing_proposals_visible_to(p_viewer uuid) RETURNS SETOF outing_proposals
LANGUAGE sql STABLE AS $$
  SELECT p.* FROM outing_proposals p WHERE p.user_id = p_viewer
$$;
COMMENT ON FUNCTION outing_proposals_visible_to(uuid) IS $$Propositions de sorties d'un profil : uniquement les siennes, tous statuts ; l'accueil n'affiche que les prêtes dont le jour visé n'est pas passé. [US-117 RF1, RT1]$$;
CREATE FUNCTION outing_ideas_visible_to(p_viewer uuid) RETURNS SETOF outing_proposal_ideas
LANGUAGE sql STABLE AS $$
  SELECT i.* FROM outing_proposal_ideas i WHERE i.user_id = p_viewer
$$;
COMMENT ON FUNCTION outing_ideas_visible_to(uuid) IS $$Idées des propositions d'un profil : uniquement les siennes. [US-117 RF1, RT1]$$;

-- Empreintes des offres à ne pas reproposer à un profil (proposées dans les 90 derniers jours, réglage outing_offer_memory_days)
CREATE FUNCTION outing_excluded_offers(p_user_id uuid) RETURNS SETOF bytea LANGUAGE sql STABLE AS $$
  SELECT m.offer_hash FROM outing_offer_memory m
   WHERE m.user_id = p_user_id
     AND m.proposed_at > now() - make_interval(days => COALESCE(
           (SELECT value_text::integer FROM platform_settings WHERE setting_key = 'outing_offer_memory_days'), 90))
$$;
COMMENT ON FUNCTION outing_excluded_offers(uuid) IS $$Empreintes des offres déjà proposées à un profil dans les 90 derniers jours (réglable) : à écarter de la prochaine proposition. [US-115 RF8, US-116 RF3]$$;

-- Purge : propositions et idées 30 jours après le jour visé ; offres mémorisées après 90 jours. Retourne le nombre de lignes supprimées
-- (propositions et offres ; les idées partent en cascade). À planifier chaque jour.
CREATE FUNCTION purge_expired_outing_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_keep integer; v_memory integer; v_a bigint; v_b bigint;
BEGIN
  SELECT value_text::integer INTO v_keep FROM platform_settings WHERE setting_key = 'outing_proposal_retention_days';
  SELECT value_text::integer INTO v_memory FROM platform_settings WHERE setting_key = 'outing_offer_memory_days';
  DELETE FROM outing_proposals WHERE target_date < current_date - COALESCE(v_keep, 30);
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM outing_offer_memory WHERE proposed_at < now() - make_interval(days => COALESCE(v_memory, 90));
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
COMMENT ON FUNCTION purge_expired_outing_data() IS $$Supprime les propositions de sorties et leurs idées 30 jours après le jour visé, et les offres mémorisées après 90 jours. À planifier chaque jour. [US-115 RF7, RF8, US-116 RT1]$$;

-- RDV créé depuis une idée (US-120) : nouvelle source « outing ». Enregistré directement comme confirmé par le parent (jamais proposé par l'agent,
-- jamais confirmé d'office, aucun lien avec un message ou un mail) ; sans AUCUN lien vers la proposition, qui reste privée (RT1).
-- La notification « RDV ajouté » de l'autre parent n'est pas envoyée (RF5, S-06) : voir family_event_notice_recipients.
ALTER TABLE family_events
  ADD CONSTRAINT ck_family_events_outing CHECK (source <> 'outing'
    OR (status IN ('confirmed', 'cancelled') AND source_message_id IS NULL AND source_inbound_email_id IS NULL AND NOT auto_confirmed));

-- Notification « L'heure de penser à vous » (US-115 RF6) : texte générique, au seul parent concerné, jamais par email (D63). Une par profil et par
-- jour visé (subject_date = jour visé) ; sans RDV ni tâche.
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT ck_scheduled_notifications_outing CHECK (kind <> 'outing_proposal' OR (email_sent_at IS NULL AND channel IS NULL));

-- Sécurité par ligne : un profil ne lit et n'écrit que ses propres lignes (US-117 RT1). Non forcée : le propriétaire des tables
-- (migrations, planificateurs de purge) la contourne ; elle protège les connexions faites avec un rôle limité qui indiquent le profil
-- (app.user_id). Sans cette indication, aucune ligne n'est visible.
ALTER TABLE outing_criteria ENABLE ROW LEVEL SECURITY;
CREATE POLICY outing_criteria_owner ON outing_criteria
  USING (user_id = (SELECT app_current_user_id())) WITH CHECK (user_id = (SELECT app_current_user_id()));
ALTER TABLE outing_criteria_themes ENABLE ROW LEVEL SECURITY;
CREATE POLICY outing_criteria_themes_owner ON outing_criteria_themes
  USING (user_id = (SELECT app_current_user_id())) WITH CHECK (user_id = (SELECT app_current_user_id()));
ALTER TABLE outing_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY outing_proposals_owner ON outing_proposals
  USING (user_id = (SELECT app_current_user_id())) WITH CHECK (user_id = (SELECT app_current_user_id()));
ALTER TABLE outing_proposal_ideas ENABLE ROW LEVEL SECURITY;
CREATE POLICY outing_proposal_ideas_owner ON outing_proposal_ideas
  USING (user_id = (SELECT app_current_user_id())) WITH CHECK (user_id = (SELECT app_current_user_id()));
ALTER TABLE outing_offer_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY outing_offer_memory_owner ON outing_offer_memory
  USING (user_id = (SELECT app_current_user_id())) WITH CHECK (user_id = (SELECT app_current_user_id()));

-- =====================================================================
-- DEVOIRS (US-118, US-119)
-- =====================================================================

-- Réglage familial « Aide Devoirs » (US-118 RF1) : lisible par tous les profils, modifiable par les deux parents (droits tenus par l'application,
-- comme les autres réglages familiaux). Désactivé par défaut ; désactiver n'efface rien (SG-2).
ALTER TABLE family_settings
  ADD COLUMN homework_help_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE family_settings
  ADD COLUMN homework_help_first_enabled_at timestamptz;
ALTER TABLE family_settings
  ADD COLUMN homework_help_disabled_at timestamptz;
ALTER TABLE family_settings
  ADD CONSTRAINT ck_family_settings_homework CHECK (NOT homework_help_enabled OR (homework_help_first_enabled_at IS NOT NULL AND homework_help_disabled_at IS NULL));
COMMENT ON COLUMN family_settings.homework_help_enabled IS $$Aide Devoirs activée pour toute la famille (faux par défaut). Ne s'active que si la famille compte au moins un membre enfant ; désactiver arrête l'aide sans effacer les plannings ni les progrès. [US-118 RF1, RF2, RF5, D64]$$;
COMMENT ON COLUMN family_settings.homework_help_first_enabled_at IS $$Date de la première activation, posée automatiquement : vide = la présentation en trois lignes n'a jamais été montrée (US-118 RF3)$$;
COMMENT ON COLUMN family_settings.homework_help_disabled_at IS $$Date de la dernière désactivation de l'aide, posée automatiquement quand elle passe de vraie à fausse et remise à vide à la réactivation. Les exercices validés sont gardés jusqu'à homework_validation_grace_days (30) après cette date : une réactivation pendant ce délai les retrouve (D65)$$;

CREATE FUNCTION family_settings_homework_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.homework_help_enabled AND NOT NEW.homework_help_enabled THEN
    NEW.homework_help_disabled_at := now();
  END IF;
  IF NEW.homework_help_enabled AND (TG_OP = 'INSERT' OR NOT OLD.homework_help_enabled) THEN
    NEW.homework_help_disabled_at := NULL;
    IF NOT EXISTS (SELECT 1 FROM family_members m WHERE m.account_id = NEW.account_id AND m.role = 'child' AND m.archived_at IS NULL) THEN
      RAISE EXCEPTION 'L''aide Devoirs demande au moins un membre enfant dans la famille' USING ERRCODE = 'check_violation';
    END IF;
    NEW.homework_help_first_enabled_at := COALESCE(NEW.homework_help_first_enabled_at, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_settings_homework BEFORE INSERT OR UPDATE ON family_settings
  FOR EACH ROW EXECUTE FUNCTION family_settings_homework_before_write();

-- Catalogue des manuels, des exercices et des activités (US-119 RT4) : préparé une fois à partir des manuels et des fiches d'activités dont MAAQ
-- a les droits (S-09). Les tables sont créées avec le schéma ; les exercices et les activités sont chargés par l'équipe, pas par ce fichier.
CREATE TABLE homework_textbooks (
  textbook_key  text PRIMARY KEY CHECK (textbook_key ~ '^[a-z_]+$'),
  label         varchar(80) NOT NULL,
  -- Manuel étranger (Singapour, Chine) : « surprise », jamais annoncé avant d'être proposé (US-119 RF7)
  is_foreign    boolean NOT NULL DEFAULT false,
  sort_order    smallint NOT NULL DEFAULT 1
);
COMMENT ON TABLE homework_textbooks IS $$Manuels de maths : France (toujours proposé) et manuels étrangers (Singapour, Chine), qui se débloquent par enfant et par niveau. [US-119 RF7, RT4]$$;

CREATE TABLE homework_exercises (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  textbook_key text NOT NULL REFERENCES homework_textbooks (textbook_key) ON DELETE RESTRICT,
  level        homework_level NOT NULL,
  number       integer NOT NULL CHECK (number >= 1),
  theme        varchar(120) NOT NULL,
  -- Énoncé de l'exercice (contenu de référence du manuel, D66) : 2 000 caractères au plus, jamais vide quand il est renseigné
  statement    text CHECK (statement IS NULL OR length(btrim(statement)) BETWEEN 1 AND 2000),
  -- Corrigé affiché au parent
  answer       text,
  UNIQUE (textbook_key, level, number)
);
CREATE INDEX idx_homework_exercises_level ON homework_exercises (level, textbook_key);
COMMENT ON COLUMN homework_exercises.statement IS $$Énoncé de l'exercice, contenu de référence du manuel porté par la base (D66) : 2 000 caractères au plus, facultatif. Aucune donnée personnelle : table de référence sans lien avec un compte, un profil ou un membre$$;
COMMENT ON TABLE homework_exercises IS $$Exercices de maths du catalogue : manuel, niveau (CP à CM2), numéro, thème, corrigé. Table de référence chargée une fois ; un rechargement met les lignes à jour sans les supprimer (les progrès les désignent). [US-119 RF2, RF4, RT4]$$;

CREATE TABLE homework_activities (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category     homework_activity_category NOT NULL,
  title        varchar(150) NOT NULL,
  -- Description : paragraphe d'introduction qui dit ce que fait l'enfant (affichée dans les questions et sur l'écran de la semaine) ; 1 000 caractères au plus
  description  text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000),
  -- Âge visé, de 6 à 12 ans : proposée à l'âge des devoirs de l'enfant, à un an près
  age          smallint NOT NULL CHECK (age BETWEEN 6 AND 12),
  needs_adult  boolean NOT NULL DEFAULT false,
  -- Étapes de l'activité (4 000 caractères au plus) et matériel nécessaire (1 000 au plus) : contenus de référence, D66
  steps        text CHECK (steps IS NULL OR length(btrim(steps)) BETWEEN 1 AND 4000),
  materials    text CHECK (materials IS NULL OR length(btrim(materials)) BETWEEN 1 AND 1000),
  -- Référence de la carte illustrée imprimable (fichier de l'application)
  card_ref     text,
  UNIQUE (category, title, age)
);
CREATE INDEX idx_homework_activities_pick ON homework_activities (category, age);
COMMENT ON COLUMN homework_activities.description IS $$Description de l'activité : paragraphe d'introduction qui dit ce que fait l'enfant, contenu de référence porté par la base : 1 000 caractères au plus, facultatif. Affichée dans les questions de l'aide et sur l'écran de la semaine. Aucune donnée personnelle$$;
COMMENT ON COLUMN homework_activities.steps IS $$Étapes de l'activité, contenu de référence porté par la base (D66) : 4 000 caractères au plus, facultatif. Aucune donnée personnelle$$;
COMMENT ON COLUMN homework_activities.materials IS $$Matériel nécessaire à l'activité, contenu de référence porté par la base (D66) : 1 000 caractères au plus, facultatif. Aucune donnée personnelle$$;
COMMENT ON TABLE homework_activities IS $$Activités d'éveil du catalogue : catégorie (nature, philo, STIM, art, imagination, jeux et projets), âge visé, « avec un adulte », carte illustrée. Table de référence chargée une fois. [US-119 RF2, RF4, RT4]$$;

-- Âge des devoirs d'un enfant (US-118 RF4, S-11) : saisi par le parent, de 6 à 12 ans, SANS LIEN avec la naissance (le mois et l'année de naissance,
-- US-92, ne sont ni lus ni modifiés). Une ligne = l'enfant est suivi par l'aide ; sans ligne, il n'est pas proposé.
CREATE TABLE homework_children (
  member_id     uuid PRIMARY KEY,
  account_id    uuid NOT NULL,
  homework_age  smallint NOT NULL CHECK (homework_age BETWEEN 6 AND 12),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, account_id),
  CONSTRAINT fk_homework_children_member FOREIGN KEY (member_id, account_id)
    REFERENCES family_members (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_homework_children_account_id ON homework_children (account_id);
COMMENT ON TABLE homework_children IS $$Âge des devoirs de chaque enfant suivi par l'aide Devoirs : 6 à 12 ans, saisi par le parent, distinct de la date de naissance (un enfant travaille souvent au-dessus de son âge). Partagé entre les deux parents. Donnée de mineur : supprimée avec le membre et à l'effacement des progrès. [US-118 RF4, RT1, D64 S-11]$$;
COMMENT ON COLUMN homework_children.homework_age IS $$Âge des devoirs (6 à 12 ans) : donne le niveau de maths (6 CP … 10 CM2, 11 et 12 CM2) et l'âge des activités à un an près. Sans lien avec family_members.birth_year et birth_month, qu'il ne modifie pas$$;

-- Progrès : exercices validés sur photos, par enfant. Seules les photos valident (US-119 RF6) ; la photo n'est jamais stockée (S-10, RT6).
CREATE TABLE homework_exercise_validations (
  member_id    uuid NOT NULL REFERENCES homework_children (member_id) ON DELETE CASCADE,
  exercise_id  bigint NOT NULL REFERENCES homework_exercises (id) ON DELETE RESTRICT,
  validated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, exercise_id)
);
CREATE INDEX idx_homework_validations_exercise ON homework_exercise_validations (exercise_id);
COMMENT ON TABLE homework_exercise_validations IS $$Exercices réussis sans aide, validés par l'analyse d'une photo du travail de l'enfant (la photo est supprimée, jamais conservée). Une ligne par enfant et par exercice. Une case cochée ne valide pas. Donnée de mineur. [US-119 RF5, RF6, RF7, RT5, RT6]$$;

-- Semaine de devoirs préparée (US-119 RF4) : une par famille et par semaine (lundi-dimanche)
CREATE TABLE homework_weeks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  week_start          date NOT NULL CHECK (date_part('isodow', week_start) = 1),
  -- Jours de travail choisis (1 = lundi … 7 = dimanche) : colonnes de l'écran « Semaine de devoirs »
  work_days           smallint[] NOT NULL CHECK (iso_weekdays_valid(work_days)),
  prepared_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  UNIQUE (account_id, week_start)
);
CREATE INDEX idx_homework_weeks_prepared_by ON homework_weeks (prepared_by_user_id);
COMMENT ON TABLE homework_weeks IS $$Semaine de devoirs préparée pour la famille : lundi de la semaine, jours de travail. Une par famille et par semaine : la carte « Préparer la semaine de devoirs » n'apparaît plus ensuite. Supprimée à l'effacement des progrès, avec ses éléments et ses tâches. [US-119 RF1, RF2, RF4, RT5]$$;

-- Manuels étrangers proposés à un enfant pour une semaine (US-119 RF7) : au plus un par enfant et par semaine, sauf si tous les exercices
-- France du niveau sont validés sur photos ; jamais avant que la moitié des exercices France du niveau soit validée sur photos
CREATE TABLE homework_week_foreign_books (
  week_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  member_id    uuid NOT NULL,
  textbook_key text NOT NULL REFERENCES homework_textbooks (textbook_key) ON DELETE RESTRICT,
  proposed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_id, member_id, textbook_key),
  CONSTRAINT fk_homework_foreign_books_week FOREIGN KEY (week_id, account_id)
    REFERENCES homework_weeks (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_homework_foreign_books_child FOREIGN KEY (member_id, account_id)
    REFERENCES homework_children (member_id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_homework_foreign_books_account_id ON homework_week_foreign_books (account_id);
CREATE INDEX idx_homework_foreign_books_member ON homework_week_foreign_books (member_id, account_id);
CREATE INDEX idx_homework_foreign_books_textbook ON homework_week_foreign_books (textbook_key);
COMMENT ON TABLE homework_week_foreign_books IS $$Manuel étranger proposé à un enfant pour une semaine. La base impose la règle de progression : débloqué par la moitié des exercices France du niveau validée sur photos, un seul par enfant et par semaine sauf si tous les exercices France du niveau sont validés sur photos. Un élément d'un manuel étranger n'existe que si le manuel est proposé ici. [US-119 RF7]$$;

-- Éléments prévus d'une semaine, par enfant et par jour : un exercice, une activité du catalogue, ou une activité libre du parent
CREATE TABLE homework_week_items (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  week_id       uuid NOT NULL,
  account_id    uuid NOT NULL,
  member_id     uuid NOT NULL,
  day           date NOT NULL,
  exercise_id   bigint REFERENCES homework_exercises (id) ON DELETE RESTRICT,
  activity_id   bigint REFERENCES homework_activities (id) ON DELETE RESTRICT,
  -- Activité du parent (titre libre), chiffré par l'application
  custom_title  bytea,
  -- Case cochée : « fait », sans valider (seules les photos valident, RF6)
  checked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_homework_items_week FOREIGN KEY (week_id, account_id)
    REFERENCES homework_weeks (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_homework_items_child FOREIGN KEY (member_id, account_id)
    REFERENCES homework_children (member_id, account_id) ON DELETE CASCADE,
  CONSTRAINT ck_homework_items_kind CHECK (num_nonnulls(exercise_id, activity_id, custom_title) = 1)
);
CREATE UNIQUE INDEX ux_homework_items_exercise ON homework_week_items (week_id, member_id, day, exercise_id) WHERE exercise_id IS NOT NULL;
CREATE UNIQUE INDEX ux_homework_items_activity ON homework_week_items (week_id, member_id, day, activity_id) WHERE activity_id IS NOT NULL;
CREATE INDEX idx_homework_items_account_id ON homework_week_items (account_id);
CREATE INDEX idx_homework_items_member ON homework_week_items (member_id, account_id);
CREATE INDEX idx_homework_items_exercise ON homework_week_items (exercise_id) WHERE exercise_id IS NOT NULL;
CREATE INDEX idx_homework_items_activity ON homework_week_items (activity_id) WHERE activity_id IS NOT NULL;
COMMENT ON TABLE homework_week_items IS $$Éléments prévus d'une semaine de devoirs, par enfant et par jour : exercice du catalogue, activité du catalogue ou activité libre du parent. Une case cochée (checked_at) compte comme « fait » sans valider. Un élément se déplace d'un jour à l'autre de la semaine ou se retire. Donnée de mineur. [US-119 RF2, RF4, RF6, RT5]$$;

-- Tâche « Devoirs — [prénom] (N éléments) » : une par enfant et par jour de travail, assignée à l'enfant et liée à la semaine (US-119 RF4)
ALTER TABLE family_tasks
  ADD CONSTRAINT fk_tasks_homework_week FOREIGN KEY (homework_week_id, account_id)
    REFERENCES homework_weeks (id, account_id) ON DELETE CASCADE;
ALTER TABLE family_tasks
  ADD CONSTRAINT ck_tasks_homework CHECK ((source = 'homework') = (homework_week_id IS NOT NULL));
CREATE UNIQUE INDEX ux_tasks_homework_day ON family_tasks (homework_week_id, assigned_member_id, due_date) WHERE homework_week_id IS NOT NULL;
CREATE INDEX idx_tasks_homework_week ON family_tasks (homework_week_id, account_id) WHERE homework_week_id IS NOT NULL;
-- D69 : « Préparer les devoirs de la semaine », tâche récurrente du dimanche à 18 h créée depuis la carte « Aide Devoirs » (source « homework_prep », sans semaine
-- de devoirs : c'est une série de tâches, pas une tâche liée à une semaine). Une seule série active par foyer. La série reste active quand l'aide est désactivée :
-- le code masque le lien, la base n'a rien à faire. Ses occurrences copient la source de leur série.
CREATE UNIQUE INDEX ux_task_series_homework_prep ON family_task_series (account_id) WHERE source = 'homework_prep' AND ended_at IS NULL;

-- D70 : répétition « chaque année » des RDV récurrents (anniversaires, fêtes) : même jour et même mois, ancre = first_date ; un 29 février tombe le 28 février les années
-- non bissextiles ; une série annuelle suit les délais de rappel de son type (series_only_d1_reminder) ; les deux prochaines occurrences sont toujours créées par le
-- planificateur, même au-delà de la fenêtre de 6 mois (code, la base ne porte que la date materialized_until). L'option « sauf vacances scolaires » est interdite pour
-- une série annuelle ; la répétition annuelle est réservée aux séries de RDV (une tâche récurrente n'est pas annuelle).
ALTER TABLE family_event_series
  ADD CONSTRAINT ck_event_series_yearly CHECK (repeat_unit <> 'yearly' OR NOT skip_school_holidays);
ALTER TABLE family_task_series
  ADD CONSTRAINT ck_task_series_unit CHECK (repeat_unit IS DISTINCT FROM 'yearly');
COMMENT ON COLUMN family_tasks.homework_week_id IS $$Semaine de devoirs à l'origine de la tâche « Devoirs — [prénom] (N éléments) » (source « homework ») : une tâche par enfant et par jour de travail ; supprimée avec la semaine. [US-119 RF4]$$;

-- L'âge des devoirs ne concerne qu'un membre enfant actif
CREATE FUNCTION homework_child_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM family_members m WHERE m.id = NEW.member_id AND m.role = 'child' AND m.archived_at IS NULL) THEN
    RAISE EXCEPTION 'L''âge des devoirs ne concerne qu''un membre enfant actif' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_homework_children_before_write BEFORE INSERT OR UPDATE OF member_id, homework_age ON homework_children
  FOR EACH ROW EXECUTE FUNCTION homework_child_before_write();

-- Avancement d'un enfant sur le manuel France d'un niveau : exercices du niveau et exercices validés sur photos (une case cochée ne compte pas)
CREATE FUNCTION homework_level_progress(p_member_id uuid, p_level homework_level)
RETURNS TABLE (total integer, validated integer) LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer,
         count(*) FILTER (WHERE v.exercise_id IS NOT NULL)::integer
    FROM homework_exercises e
    JOIN homework_textbooks b ON b.textbook_key = e.textbook_key AND NOT b.is_foreign
    LEFT JOIN homework_exercise_validations v ON v.exercise_id = e.id AND v.member_id = p_member_id
   WHERE e.level = p_level
$$;
COMMENT ON FUNCTION homework_level_progress(uuid, homework_level) IS $$Avancement d'un enfant sur les exercices du manuel France d'un niveau : nombre d'exercices et nombre d'exercices validés sur photos (une case cochée ne compte pas). [US-119 RF6, RF7]$$;

-- Critère de déblocage : la moitié au moins des exercices France du niveau est validée sur photos ; la règle repart à zéro au niveau suivant
CREATE FUNCTION homework_foreign_unlocked(p_member_id uuid, p_level homework_level) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p.total > 0 AND p.validated * 2 >= p.total FROM homework_level_progress(p_member_id, p_level) p
$$;
COMMENT ON FUNCTION homework_foreign_unlocked(uuid, homework_level) IS $$Vrai si la moitié au moins des exercices France du niveau est validée sur photos (les manuels étrangers sont alors débloqués) ; faux sans exercice au catalogue. La règle repart à zéro à chaque niveau. [US-119 RF7]$$;

-- Exception : tous les exercices France du niveau sont validés sur photos : plusieurs manuels étrangers possibles
CREATE FUNCTION homework_france_level_done(p_member_id uuid, p_level homework_level) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p.total > 0 AND p.validated = p.total FROM homework_level_progress(p_member_id, p_level) p
$$;
COMMENT ON FUNCTION homework_france_level_done(uuid, homework_level) IS $$Vrai si tous les exercices du manuel France du niveau sont validés sur photos (D65 : une case cochée ne suffit pas) : plusieurs manuels étrangers sont alors possibles dans la semaine. [US-119 RF7]$$;

CREATE FUNCTION homework_foreign_book_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_level homework_level;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('homework_foreign:' || NEW.week_id::text || NEW.member_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM homework_textbooks b WHERE b.textbook_key = NEW.textbook_key AND b.is_foreign) THEN
    RAISE EXCEPTION 'Seul un manuel étranger se propose ici (le manuel France est toujours proposé)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT homework_level_for_age(c.homework_age) INTO v_level FROM homework_children c WHERE c.member_id = NEW.member_id;
  IF NOT homework_foreign_unlocked(NEW.member_id, v_level) THEN
    RAISE EXCEPTION 'Un manuel étranger se débloque quand la moitié des exercices du niveau est validée sur photos' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM homework_week_foreign_books f WHERE f.week_id = NEW.week_id AND f.member_id = NEW.member_id)
     AND NOT homework_france_level_done(NEW.member_id, v_level) THEN
    RAISE EXCEPTION 'Une semaine compte au plus deux manuels : France et un seul manuel étranger' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_homework_foreign_books_before_insert BEFORE INSERT ON homework_week_foreign_books
  FOR EACH ROW EXECUTE FUNCTION homework_foreign_book_before_insert();

-- Élément d'une semaine : jour compris dans la semaine ; exercice d'un manuel étranger seulement s'il est proposé pour cet enfant cette semaine ;
-- un élément se déplace d'un jour à l'autre et se coche, il ne change pas de contenu ni d'enfant
CREATE FUNCTION homework_item_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_start date; v_book text;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.week_id, NEW.member_id, NEW.exercise_id, NEW.activity_id, NEW.custom_title)
                          IS DISTINCT FROM ROW(OLD.week_id, OLD.member_id, OLD.exercise_id, OLD.activity_id, OLD.custom_title) THEN
    RAISE EXCEPTION 'Un élément de devoirs se déplace d''un jour à l''autre ou se coche ; il ne change ni de contenu ni d''enfant' USING ERRCODE = 'check_violation';
  END IF;
  SELECT week_start INTO v_start FROM homework_weeks WHERE id = NEW.week_id;
  IF NEW.day < v_start OR NEW.day > v_start + 6 THEN
    RAISE EXCEPTION 'Le jour doit être dans la semaine préparée' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.exercise_id IS NOT NULL THEN
    SELECT b.textbook_key INTO v_book FROM homework_exercises e JOIN homework_textbooks b ON b.textbook_key = e.textbook_key AND b.is_foreign
     WHERE e.id = NEW.exercise_id;
    IF v_book IS NOT NULL AND NOT EXISTS (SELECT 1 FROM homework_week_foreign_books f
                                           WHERE f.week_id = NEW.week_id AND f.member_id = NEW.member_id AND f.textbook_key = v_book) THEN
      RAISE EXCEPTION 'Ce manuel étranger n''est pas proposé à cet enfant cette semaine' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_homework_items_before_write BEFORE INSERT OR UPDATE ON homework_week_items
  FOR EACH ROW EXECUTE FUNCTION homework_item_before_write();

-- Effacement des données Devoirs d'un enfant (retrait ou effacement du membre, changement de rôle) : tâches « Devoirs », éléments, manuels
-- proposés, exercices validés et âge des devoirs (sauf p_keep_age). Données de mineurs : rien ne reste. [US-93, US-119 RT5]
CREATE FUNCTION erase_member_homework_data(p_member_id uuid, p_keep_age boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM family_tasks WHERE source = 'homework' AND assigned_member_id = p_member_id;
  DELETE FROM homework_week_items WHERE member_id = p_member_id;
  DELETE FROM homework_week_foreign_books WHERE member_id = p_member_id;
  DELETE FROM homework_exercise_validations WHERE member_id = p_member_id;
  IF NOT p_keep_age THEN
    DELETE FROM homework_children WHERE member_id = p_member_id;
  END IF;
END $$;
COMMENT ON FUNCTION erase_member_homework_data(uuid, boolean) IS $$Supprime les données Devoirs d'un enfant : tâches « Devoirs », éléments prévus, manuels proposés, exercices validés et, sauf demande contraire, l'âge des devoirs. Appelée au retrait et à l'effacement du membre. [US-93, US-119 RT5]$$;

-- Bouton « Effacer les progrès de Devoirs » (US-118 RF5) : supprime les semaines préparées (avec éléments et tâches), les exercices validés et,
-- si p_keep_ages est faux, l'âge des devoirs des enfants. Retourne le nombre de semaines, de validations et de tâches supprimées.
CREATE FUNCTION erase_family_homework_progress(p_account_id uuid, p_keep_ages boolean DEFAULT true) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_tasks bigint; v_weeks bigint; v_valid bigint;
BEGIN
  DELETE FROM family_tasks WHERE account_id = p_account_id AND source = 'homework';
  GET DIAGNOSTICS v_tasks = ROW_COUNT;
  DELETE FROM homework_weeks WHERE account_id = p_account_id;
  GET DIAGNOSTICS v_weeks = ROW_COUNT;
  DELETE FROM homework_exercise_validations v USING homework_children c WHERE c.member_id = v.member_id AND c.account_id = p_account_id;
  GET DIAGNOSTICS v_valid = ROW_COUNT;
  IF NOT p_keep_ages THEN
    DELETE FROM homework_children WHERE account_id = p_account_id;
  END IF;
  RETURN v_tasks + v_weeks + v_valid;
END $$;
COMMENT ON FUNCTION erase_family_homework_progress(uuid, boolean) IS $$Efface les plannings et les progrès Devoirs d'une famille : semaines préparées (avec éléments et tâches « Devoirs »), exercices validés et, si demandé, l'âge des devoirs (conservé par défaut : c'est le comportement de l'écran, D65). Retourne le nombre de lignes supprimées. [US-118 RF5, US-119 RT5]$$;

-- Purge Devoirs (D65, à valider par le DPO et à écrire dans l'AIPD) : semaines préparées et leurs éléments supprimés 12 mois après la semaine
-- (avec les manuels proposés et les tâches « Devoirs » liées) ; exercices validés gardés tant que l'aide est active pour la famille de l'enfant,
-- puis encore 30 jours après sa désactivation (délai de grâce : une réactivation les retrouve). Retourne le nombre de semaines et de validations supprimées.
CREATE FUNCTION purge_expired_homework_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_months integer; v_grace integer; v_a bigint; v_b bigint;
BEGIN
  SELECT value_text::integer INTO v_months FROM platform_settings WHERE setting_key = 'homework_week_retention_months';
  SELECT value_text::integer INTO v_grace FROM platform_settings WHERE setting_key = 'homework_validation_grace_days';
  DELETE FROM homework_weeks WHERE week_start + 6 < current_date - make_interval(months => COALESCE(v_months, 12));
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM homework_exercise_validations v USING homework_children c
   WHERE c.member_id = v.member_id
     AND NOT EXISTS (SELECT 1 FROM family_settings st
                      WHERE st.account_id = c.account_id
                        AND (st.homework_help_enabled
                             OR st.homework_help_disabled_at >= now() - make_interval(days => COALESCE(v_grace, 30))));
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
COMMENT ON FUNCTION purge_expired_homework_data() IS $$Supprime les semaines de devoirs (avec éléments, manuels proposés et tâches « Devoirs ») 12 mois après la semaine, et les exercices validés des enfants dont la famille n'a plus l'aide Devoirs active depuis plus de 30 jours (homework_validation_grace_days). À planifier chaque jour. [US-119 RT5, D65]$$;

-- Un membre qui n'est plus enfant n'est plus suivi par l'aide Devoirs
CREATE FUNCTION family_member_homework_role_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM erase_member_homework_data(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_family_members_homework_role AFTER UPDATE OF role ON family_members
  FOR EACH ROW WHEN (OLD.role = 'child' AND NEW.role <> 'child') EXECUTE FUNCTION family_member_homework_role_changed();

-- Graines : catalogue des thèmes de sorties (US-114 RF2) et manuels de maths (US-119 RF7). Les exercices et les activités sont chargés par l'équipe.
INSERT INTO outing_themes (category, theme_key, label, sort_order) VALUES
  ('self', 'culture', 'Culture', 1), ('self', 'wellbeing', 'Bien-être', 2), ('self', 'nature', 'Nature', 3), ('self', 'foodie', 'Gourmand', 4),
  ('self', 'creative', 'Créatif', 5), ('self', 'sport', 'Sport', 6), ('self', 'show', 'Spectacle', 7), ('self', 'strolling', 'Flânerie', 8),
  ('self', 'with_friends', 'Entre amis', 9),
  ('couple', 'romantic', 'Romantique', 1), ('couple', 'relaxation', 'Détente', 2), ('couple', 'discovery', 'Découverte', 3),
  ('couple', 'gastronomy', 'Gastronomie', 4), ('couple', 'culture', 'Culture', 5), ('couple', 'couple_activities', 'Activités à deux', 6),
  ('couple', 'playful', 'Ludique', 7), ('couple', 'nature', 'Nature', 8),
  ('kids', 'animals', 'Animaux', 1), ('kids', 'outdoors', 'Plein air', 2), ('kids', 'theme_parks', 'Parcs d''attractions', 3),
  ('kids', 'science_discovery', 'Sciences et découverte', 4), ('kids', 'creative', 'Créatif', 5), ('kids', 'shows', 'Spectacles', 6),
  ('kids', 'sport_movement', 'Sport et mouvement', 7), ('kids', 'indoor_games', 'Jeux d''intérieur', 8), ('kids', 'seasonal', 'Saisonnier', 9),
  ('kids', 'gentle_adventure', 'Aventure douce', 10),
  ('teens', 'thrills', 'Sensations', 1), ('teens', 'sport', 'Sport', 2), ('teens', 'games_tech', 'Jeux et techno', 3),
  ('teens', 'pop_culture', 'Culture pop', 4), ('teens', 'creative', 'Créatif', 5), ('teens', 'social', 'Social', 6),
  ('teens', 'discovery', 'Découverte', 7), ('teens', 'adventure', 'Aventure', 8), ('teens', 'autonomy', 'Autonomie', 9),
  ('teens', 'parent_teen_time', 'Moment parent-ado', 10);

-- Sous-groupe « Concerts » (D68) : six thèmes pour « Pour moi », « En couple » et « Ados », aucun pour « Enfants de 3 à 10 ans » (absents du catalogue : refusés par la clé étrangère)
INSERT INTO outing_themes (category, theme_key, label, theme_group, sort_order) VALUES
  ('self', 'concert_world', 'Concert du monde', 'concerts', 10), ('self', 'concert_urban', 'Concert urbain', 'concerts', 11),
  ('self', 'concert_pop', 'Concert pop', 'concerts', 12), ('self', 'concert_hiphop', 'Concert hip-hop / rap', 'concerts', 13),
  ('self', 'concert_jazz', 'Concert jazz', 'concerts', 14), ('self', 'concert_rock', 'Concert rock', 'concerts', 15),
  ('couple', 'concert_world', 'Concert du monde', 'concerts', 9), ('couple', 'concert_urban', 'Concert urbain', 'concerts', 10),
  ('couple', 'concert_pop', 'Concert pop', 'concerts', 11), ('couple', 'concert_hiphop', 'Concert hip-hop / rap', 'concerts', 12),
  ('couple', 'concert_jazz', 'Concert jazz', 'concerts', 13), ('couple', 'concert_rock', 'Concert rock', 'concerts', 14),
  ('teens', 'concert_world', 'Concert du monde', 'concerts', 11), ('teens', 'concert_urban', 'Concert urbain', 'concerts', 12),
  ('teens', 'concert_pop', 'Concert pop', 'concerts', 13), ('teens', 'concert_hiphop', 'Concert hip-hop / rap', 'concerts', 14),
  ('teens', 'concert_jazz', 'Concert jazz', 'concerts', 15), ('teens', 'concert_rock', 'Concert rock', 'concerts', 16);

INSERT INTO homework_textbooks (textbook_key, label, is_foreign, sort_order) VALUES
  ('france', 'Manuel France', false, 1), ('singapore', 'Manuel Singapour', true, 2), ('china', 'Manuel Chine', true, 3);

-- Réglages du lot 10 (US-65)
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('outing_proposal_retention_days', 'integer', '30', 1, NULL, $$Conservation d'une proposition de sorties après son jour visé, en jours (US-115 RF7)$$),
  ('outing_offer_memory_days',       'integer', '90', 1, NULL, $$Durée pendant laquelle une offre déjà proposée n'est pas reproposée au même parent, en jours (US-115 RF8)$$),
  ('homework_week_retention_months', 'integer', '12', 1, NULL, $$Conservation d'une semaine de devoirs et de ses éléments après la semaine, en mois (US-119 RT5, D65)$$),
  ('homework_validation_grace_days', 'integer', '30', 1, NULL, $$Délai de grâce des exercices validés après la désactivation de l'aide Devoirs, en jours : une réactivation pendant ce délai les retrouve (US-119 RT5, D65)$$);

-- =====================================================================
-- 8 sexies. CONTRATS V2 — LOT 11 : catégories à champs de documents, contrats de base et complémentaires, documents chiffrés, anonymisation,
-- analyse IA et challenge (US-122 à US-138, décisions C-01 à C-18, règles CT-1 à CT-5).
-- Source : MAAQ_US_Detaillees_BA_Contrats_V2.md. Les « contrats obligatoires » (contract_definitions, US-48) deviennent les CATÉGORIES ; chaque catégorie
-- porte 0 à 10 champs de documents. account_contracts devient « un contrat de la famille » : un contrat de base (créé d'office, non supprimable) et des
-- contrats complémentaires par catégorie. Les contrats et leurs documents sont partagés par le noyau (utilisateur principal et invité 1, CT-1).
-- Minimisation (C-01, CT-3) : un document est supprimé 48 h après sa transmission, ou 30 jours après son dépôt s'il n'est jamais transmis. Seuls le rapport
-- et les détails texte restent. Anonymisation (US-136) : AUCUNE table de correspondance entre jetons et valeurs ; le texte masqué part avec le document.
-- Le Google Drive ne sert plus aux documents de contrat. L'ancienne table contract_documents (US-34) reste en place, vidée à la mise en service (C-04).
-- =====================================================================

-- Challenge disponible : le nom du courtier et l'adresse de sa boîte sont renseignés dans la console (vides = challenge bloqué, C-10)
CREATE FUNCTION contract_challenge_available() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT length(btrim(value_text)) > 0 FROM platform_settings WHERE setting_key = 'contract_broker_name'), false)
     AND COALESCE((SELECT length(btrim(value_text)) > 0 FROM platform_settings WHERE setting_key = 'contract_broker_email'), false)
$$;
COMMENT ON FUNCTION contract_challenge_available() IS $$Vrai si le nom du courtier et l'adresse de sa boîte (réglages de la console) sont renseignés ; faux = challenge bloqué : l'interrupteur est inactif et aucun consentement ne peut être donné. [US-128 RF2bis, C-10]$$;

-- Texte libre des réglages de la console (nom du courtier) : 120 caractères au plus
ALTER TABLE platform_settings
  ADD CONSTRAINT ck_platform_settings_free_text CHECK (value_type <> 'free_text' OR value_text IS NULL OR length(value_text) <= 120);

-- ---------------------------------------------------------------------
-- Champs de documents d'une catégorie (US-122, US-123) : 0 à 10 par catégorie, nom unique dans la catégorie, au moins un champ obligatoire dès
-- qu'il y en a un. Valent pour tous les contrats de la catégorie, de base comme complémentaires. Retirer un champ supprime les documents déposés.
-- ---------------------------------------------------------------------
CREATE TABLE contract_document_fields (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_definition_id  bigint NOT NULL REFERENCES contract_definitions (id) ON DELETE RESTRICT,
  name                    varchar(80) NOT NULL CHECK (name = btrim(name) AND length(name) >= 1),
  -- Aide affichée à la famille (200 caractères au plus)
  help                    varchar(200) CHECK (help IS NULL OR length(btrim(help)) >= 1),
  -- « Obligatoire » activé par défaut à la création (US-123 RF1) ; facultatif = mention « Facultatif »
  is_required             boolean NOT NULL DEFAULT true,
  sort_order              integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_contract_document_fields_name ON contract_document_fields (contract_definition_id, lower(name));
COMMENT ON TABLE contract_document_fields IS $$Champs de documents attendus pour une catégorie de contrat (nom, aide, obligatoire ou facultatif, ordre) : 0 à 10 par catégorie, au moins un obligatoire dès qu'il y en a un. Communs à tous les contrats de la catégorie. Retirer un champ supprime les documents qui y sont déposés. [US-122, US-123]$$;
COMMENT ON COLUMN contract_document_fields.name IS $$Nom du champ (80 caractères au plus), unique dans la catégorie sans tenir compte des majuscules, par exemple « Conditions particulières »$$;

CREATE FUNCTION contract_document_field_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.contract_definition_id IS DISTINCT FROM OLD.contract_definition_id THEN
    RAISE EXCEPTION 'Un champ de documents ne change pas de catégorie' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('contract_document_fields:' || NEW.contract_definition_id::text, 0));
    SELECT count(*) INTO v_n FROM contract_document_fields WHERE contract_definition_id = NEW.contract_definition_id;
    IF v_n >= 10 THEN
      RAISE EXCEPTION '10 champs au plus par catégorie' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contract_document_fields_before_write BEFORE INSERT OR UPDATE ON contract_document_fields
  FOR EACH ROW EXECUTE FUNCTION contract_document_field_before_write();

-- Une catégorie qui a des champs en a au moins un obligatoire (US-123 RF4). Contrôle différé à la fin de la transaction : on peut remplacer le dernier
-- champ obligatoire par un autre dans la même transaction.
CREATE FUNCTION contract_document_fields_required() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_def bigint;
BEGIN
  v_def := CASE WHEN TG_OP = 'DELETE' THEN OLD.contract_definition_id ELSE NEW.contract_definition_id END;
  IF EXISTS (SELECT 1 FROM contract_document_fields f WHERE f.contract_definition_id = v_def)
     AND NOT EXISTS (SELECT 1 FROM contract_document_fields f WHERE f.contract_definition_id = v_def AND f.is_required) THEN
    RAISE EXCEPTION 'Une catégorie doit avoir au moins un document obligatoire' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_contract_document_fields_required AFTER INSERT OR UPDATE OR DELETE ON contract_document_fields
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION contract_document_fields_required();

-- ---------------------------------------------------------------------
-- Contrats de la famille (US-124, US-125, US-127, US-128, US-133) : account_contracts devient « un contrat » ; la catégorie est contract_definitions.
-- Le contrat de base porte d'abord le nom de la catégorie ; il est créé d'office (ensure_base_contracts) et non supprimable. Le premier contrat d'une
-- catégorie pour une famille est toujours le contrat de base.
-- Interrupteur « challenge » : colonnes consent_* existantes (US-36), désormais par contrat. Interrupteur « analyse » : colonnes analysis_*.
-- ---------------------------------------------------------------------
ALTER TABLE account_contracts
  ADD COLUMN name varchar(60) NOT NULL CHECK (name = btrim(name) AND length(name) >= 1);
ALTER TABLE account_contracts
  ADD COLUMN is_base boolean NOT NULL DEFAULT false;
ALTER TABLE account_contracts
  ADD COLUMN created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE account_contracts
  ADD COLUMN analysis_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE account_contracts
  ADD COLUMN analysis_changed_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE account_contracts
  ADD COLUMN analysis_changed_at timestamptz;
-- Plusieurs contrats par catégorie et par famille : l'unicité (compte, catégorie) disparaît
ALTER TABLE account_contracts
  DROP CONSTRAINT account_contracts_account_id_contract_definition_id_key;
ALTER TABLE account_contracts
  ADD CONSTRAINT uq_account_contracts_id_account UNIQUE (id, account_id);
-- Un seul contrat de base par catégorie et par famille ; un nom unique dans la catégorie pour la famille, sans tenir compte des majuscules (US-125 RF1)
CREATE UNIQUE INDEX ux_account_contracts_base ON account_contracts (account_id, contract_definition_id) WHERE is_base;
CREATE UNIQUE INDEX ux_account_contracts_name ON account_contracts (account_id, contract_definition_id, lower(name));
CREATE INDEX idx_account_contracts_created_by ON account_contracts (created_by_user_id);
CREATE INDEX idx_account_contracts_analysis_changed_by ON account_contracts (analysis_changed_by_user_id);
COMMENT ON COLUMN account_contracts.name IS $$Nom libre du contrat, de 1 à 60 caractères, unique dans la catégorie pour la famille sans tenir compte des majuscules. Le contrat de base porte d'abord le nom de sa catégorie. Jamais envoyé à l'agent d'analyse (il peut contenir un prénom). [US-125]$$;
COMMENT ON COLUMN account_contracts.is_base IS $$Contrat de base de la catégorie : un seul par famille, créé d'office, jamais supprimé ; le premier contrat d'une catégorie est toujours le contrat de base. Faux = contrat complémentaire, supprimable. [US-124, US-133, CT-2]$$;
COMMENT ON COLUMN account_contracts.analysis_enabled IS $$Interrupteur « Analyse IA » du contrat : désactivé par défaut, durable, partagé par le noyau. La preuve est dans contract_consent_events (canal analysis). [US-127]$$;

CREATE FUNCTION account_contract_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_archived timestamptz; v_category text; v_max integer; v_n integer;
BEGIN
  SELECT archived_at, name INTO v_archived, v_category FROM contract_definitions WHERE id = NEW.contract_definition_id;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'Cette catégorie de contrat n''est plus proposée' USING ERRCODE = 'check_violation';
  END IF;
  -- Le contrat de base porte d'abord le nom de sa catégorie
  NEW.name := btrim(COALESCE(NEW.name, left(v_category, 60)));
  PERFORM pg_advisory_xact_lock(hashtextextended('account_contracts:' || NEW.account_id::text || ':' || NEW.contract_definition_id::text, 0));
  SELECT count(*) INTO v_n FROM account_contracts WHERE account_id = NEW.account_id AND contract_definition_id = NEW.contract_definition_id;
  SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'max_contracts_per_category';
  IF v_n >= COALESCE(v_max, 20) THEN
    RAISE EXCEPTION 'Nombre maximum de contrats atteint pour cette catégorie' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM account_contracts WHERE account_id = NEW.account_id AND contract_definition_id = NEW.contract_definition_id AND is_base) THEN
    NEW.is_base := true;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_account_contracts_before_insert BEFORE INSERT ON account_contracts
  FOR EACH ROW EXECUTE FUNCTION account_contract_before_insert();

CREATE FUNCTION account_contract_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.contract_definition_id IS DISTINCT FROM OLD.contract_definition_id
     OR NEW.is_base IS DISTINCT FROM OLD.is_base THEN
    RAISE EXCEPTION 'Le compte, la catégorie et le rang (base ou complémentaire) d''un contrat ne changent pas' USING ERRCODE = 'check_violation';
  END IF;
  -- Challenge bloqué tant que le courtier n'est pas désigné : aucun consentement ne peut être donné avant (C-10)
  IF NEW.consent_active AND NOT OLD.consent_active AND NOT contract_challenge_available() THEN
    RAISE EXCEPTION 'Le challenge sera disponible quand notre partenaire courtier sera désigné' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_account_contracts_before_update BEFORE UPDATE ON account_contracts
  FOR EACH ROW EXECUTE FUNCTION account_contract_before_update();

-- Le contrat de base n'est jamais supprimé seul (on peut seulement vider ses informations et ses documents, US-35) ; il part avec le compte (cascade)
CREATE FUNCTION account_contract_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_base AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'Le contrat de base d''une catégorie ne se supprime pas' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_account_contracts_before_delete BEFORE DELETE ON account_contracts
  FOR EACH ROW EXECUTE FUNCTION account_contract_before_delete();

-- Une catégorie qui contient des contrats, ou dont un consentement a été enregistré, s'archive (archived_at), elle ne se supprime pas (C-19) ; les clés étrangères
-- RESTRICT le refusaient déjà, ce trigger donne le motif. Une catégorie sans contrat se supprime AVEC ses champs de documents et de détail, en une seule opération.
CREATE FUNCTION contract_definition_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account_contracts WHERE contract_definition_id = OLD.id) THEN
    RAISE EXCEPTION 'Une catégorie qui contient des contrats s''archive, elle ne se supprime pas' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM contract_consent_events WHERE contract_definition_id = OLD.id) THEN
    RAISE EXCEPTION 'Une catégorie dont un consentement a été enregistré s''archive, elle ne se supprime pas' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM contract_document_fields WHERE contract_definition_id = OLD.id;
  DELETE FROM contract_field_definitions WHERE contract_definition_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_contract_definitions_before_delete BEFORE DELETE ON contract_definitions
  FOR EACH ROW EXECUTE FUNCTION contract_definition_before_delete();
COMMENT ON FUNCTION contract_definition_before_delete() IS $$Refuse la suppression d'une catégorie qui contient des contrats d'au moins une famille, ou dont un consentement a été enregistré : elle s'archive (archived_at), n'est plus proposée, ne reçoit plus de contrats ni de dépôt de documents, et ses contrats restent consultables sans transmission. Une catégorie sans contrat se supprime avec ses champs de documents et de détail. [C-19, US-139]$$;

-- Crée le contrat de base de chaque catégorie proposée qui n'en a pas encore pour la famille (idempotent) : à appeler à l'ouverture de « Mes contrats ».
-- Retourne le nombre de contrats créés.
CREATE FUNCTION ensure_base_contracts(p_account_id uuid, p_user_id uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  WITH ins AS (
    INSERT INTO account_contracts (account_id, contract_definition_id, name, is_base, created_by_user_id)
    SELECT p_account_id, d.id, left(d.name, 60), true, p_user_id
      FROM contract_definitions d
     WHERE d.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM account_contracts c WHERE c.account_id = p_account_id AND c.contract_definition_id = d.id AND c.is_base)
    RETURNING 1)
  SELECT count(*) INTO v_n FROM ins;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION ensure_base_contracts(uuid, uuid) IS $$Crée le contrat de base de chaque catégorie proposée qui n'en a pas pour la famille, avec le nom de la catégorie (idempotent). À appeler à l'ouverture de « Mes contrats ». Retourne le nombre de contrats créés. [US-124 RF1, US-125 RF2, CT-2]$$;

-- Contrats visibles par un profil : ceux du noyau (utilisateur principal et invité 1) ; jamais un invité secondaire (US-32 RF4, CT-1)
CREATE FUNCTION account_contracts_visible_to(p_viewer uuid) RETURNS SETOF account_contracts LANGUAGE sql STABLE AS $$
  SELECT c.* FROM account_contracts c JOIN users v ON v.id = p_viewer AND v.account_id = c.account_id
   WHERE v.role = 'primary_user' OR v.guest_rank = 'core'
$$;
COMMENT ON FUNCTION account_contracts_visible_to(uuid) IS $$Contrats d'un profil : ceux de sa famille s'il est utilisateur principal ou invité 1 ; aucun pour un invité secondaire. [US-32 RF4, CT-1]$$;

-- Preuve des consentements par contrat (CT-4) : deux canaux, analyse et challenge ; le journal existant (contract_consent_events) reçoit le canal et le
-- contrat, SANS clé étrangère pour survivre à la suppression du contrat et du compte
ALTER TABLE contract_consent_events
  ADD COLUMN channel contract_channel NOT NULL DEFAULT 'challenge';
ALTER TABLE contract_consent_events
  ADD COLUMN account_contract_id bigint;
CREATE INDEX idx_contract_consent_events_contract ON contract_consent_events (account_contract_id) WHERE account_contract_id IS NOT NULL;
COMMENT ON COLUMN contract_consent_events.channel IS $$Canal du consentement : analysis (analyse IA) ou challenge. Le texte accepté (legal_version_id) est celui du canal$$;
COMMENT ON COLUMN contract_consent_events.account_contract_id IS $$Contrat concerné (identifiant seul, SANS clé étrangère : la preuve est conservée après la suppression du contrat). Vide pour une preuve antérieure aux contrats par catégorie$$;

-- Le texte accepté est celui du canal : analyse -> contract_analysis_consent, challenge -> contract_challenge_consent
CREATE FUNCTION contract_consent_event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_type legal_document_type;
BEGIN
  SELECT document_type INTO v_type FROM legal_document_versions WHERE id = NEW.legal_version_id;
  IF v_type IS DISTINCT FROM (CASE NEW.channel WHEN 'analysis' THEN 'contract_analysis_consent' ELSE 'contract_challenge_consent' END)::legal_document_type THEN
    RAISE EXCEPTION 'Le texte accepté ne correspond pas au canal du consentement' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contract_consent_events_before_insert BEFORE INSERT ON contract_consent_events
  FOR EACH ROW EXECUTE FUNCTION contract_consent_event_before_insert();

-- ---------------------------------------------------------------------
-- Transmissions (US-129, US-130, US-135) : un envoi des documents d'un contrat pour analyse, challenge ou les deux, avec l'état de chaque canal
-- ---------------------------------------------------------------------
CREATE TABLE contract_transmissions (
  id                              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_contract_id             bigint NOT NULL REFERENCES account_contracts (id) ON DELETE CASCADE,
  transmitted_by_user_id          uuid REFERENCES users (id) ON DELETE SET NULL,
  transmitted_at                  timestamptz NOT NULL DEFAULT now(),
  for_analysis                    boolean NOT NULL,
  for_challenge                   boolean NOT NULL,
  -- Analyse : en cours, en attente d'un administrateur (US-138), terminée (rapport), échouée, annulée
  analysis_status                 contract_analysis_status,
  analysis_attempts               smallint NOT NULL DEFAULT 0 CHECK (analysis_attempts >= 0),
  analysis_finished_at            timestamptz,
  analysis_failure_notified_at    timestamptz,
  analysis_last_error             text,
  -- Challenge : envoi en cours, envoyé, échec de l'envoi (réessayé pendant 1 heure, puis « Renvoyer », US-135 RF3)
  challenge_status                delivery_status,
  challenge_attempts              smallint NOT NULL DEFAULT 0 CHECK (challenge_attempts >= 0),
  challenge_sent_at               timestamptz,
  challenge_last_error            text,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_contract_transmissions_channel CHECK (for_analysis OR for_challenge),
  CONSTRAINT ck_contract_transmissions_analysis CHECK ((analysis_status IS NOT NULL) = for_analysis),
  CONSTRAINT ck_contract_transmissions_challenge CHECK ((challenge_status IS NOT NULL) = for_challenge),
  CONSTRAINT ck_contract_transmissions_sent CHECK (COALESCE(challenge_status = 'sent', false) = (challenge_sent_at IS NOT NULL))
);
CREATE INDEX idx_contract_transmissions_contract ON contract_transmissions (account_contract_id, transmitted_at DESC);
CREATE INDEX idx_contract_transmissions_transmitted_by ON contract_transmissions (transmitted_by_user_id);
CREATE INDEX idx_contract_transmissions_analysis_open ON contract_transmissions (transmitted_at) WHERE analysis_status IN ('running', 'awaiting_admin');
COMMENT ON TABLE contract_transmissions IS $$Transmission des documents d'un contrat pour analyse, challenge ou les deux : qui, quand, état de chaque canal (analyse en cours, en attente d'un administrateur, terminée, échouée, annulée ; challenge en cours d'envoi, envoyé, échec), tentatives. Historique du contrat, supprimé avec lui. Aucun contenu. [US-129, US-135, US-138]$$;
COMMENT ON COLUMN contract_transmissions.analysis_last_error IS $$Dernier message d'erreur technique de l'analyse : aucun contenu de document ni donnée personnelle$$;
COMMENT ON COLUMN contract_transmissions.challenge_last_error IS $$Dernier message d'erreur technique de l'envoi du challenge : aucune donnée personnelle$$;

CREATE FUNCTION contract_analysis_transition_allowed(p_from contract_analysis_status, p_to contract_analysis_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (('running', 'awaiting_admin'), ('running', 'completed'), ('running', 'failed'), ('running', 'cancelled'),
                            ('awaiting_admin', 'running'), ('awaiting_admin', 'failed'), ('awaiting_admin', 'cancelled'), ('failed', 'running'))
$$;
COMMENT ON FUNCTION contract_analysis_transition_allowed(contract_analysis_status, contract_analysis_status) IS $$Transitions permises de l'état d'une analyse : en cours vers en attente d'un administrateur, terminée, échouée ou annulée ; en attente vers en cours (poursuivre), échouée ou annulée ; échouée vers en cours (relance). Terminée et annulée sont définitives. [US-135, US-138]$$;

-- Une transmission part avec tous les champs obligatoires remplis, des documents jamais transmis, et seulement les canaux dont l'interrupteur est actif
-- (US-129 RF1, RT1) ; elle n'a lieu qu'une fois (les documents sont ensuite verrouillés : pas de double transmission, CC-7)
CREATE FUNCTION contract_transmission_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_c account_contracts%ROWTYPE;
BEGIN
  SELECT * INTO v_c FROM account_contracts WHERE id = NEW.account_contract_id FOR UPDATE;
  -- Catégorie archivée : ses contrats se consultent, ils ne se transmettent plus (C-19)
  IF EXISTS (SELECT 1 FROM contract_definitions d WHERE d.id = v_c.contract_definition_id AND d.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cette catégorie est archivée : ses contrats ne se transmettent plus' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.for_analysis AND NOT v_c.analysis_enabled THEN
    RAISE EXCEPTION 'L''analyse n''est pas activée sur ce contrat' USING ERRCODE = 'check_violation';
  END IF;
  -- Un document obligatoire illisible bloque l'analyse (US-137 RF7) ; le challenge n'est pas concerné, il part avec les originaux ; un document facultatif illisible
  -- est laissé de côté par l'analyse
  IF NEW.for_analysis AND EXISTS (SELECT 1 FROM contract_field_documents d JOIN contract_document_fields f ON f.id = d.field_id
                                   WHERE d.account_contract_id = NEW.account_contract_id AND f.is_required AND d.masking_status = 'unreadable') THEN
    RAISE EXCEPTION 'Un document obligatoire est illisible : l''analyse ne peut pas être demandée' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.for_challenge AND (NOT v_c.consent_active OR NOT contract_challenge_available()) THEN
    RAISE EXCEPTION 'Le challenge n''est pas activé sur ce contrat ou n''est pas disponible' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM contract_field_documents d WHERE d.account_contract_id = NEW.account_contract_id AND d.transmitted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Les documents de ce contrat ont déjà été transmis' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM contract_document_fields f WHERE f.contract_definition_id = v_c.contract_definition_id) THEN
    RAISE EXCEPTION 'Cette catégorie n''a pas de champ de documents : rien à transmettre' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM contract_document_fields f
              WHERE f.contract_definition_id = v_c.contract_definition_id AND f.is_required
                AND NOT EXISTS (SELECT 1 FROM contract_field_documents d WHERE d.account_contract_id = NEW.account_contract_id AND d.field_id = f.id)) THEN
    RAISE EXCEPTION 'Un document obligatoire manque' USING ERRCODE = 'check_violation';
  END IF;
  NEW.analysis_status := CASE WHEN NEW.for_analysis THEN 'running'::contract_analysis_status END;
  NEW.analysis_attempts := CASE WHEN NEW.for_analysis THEN 1 ELSE 0 END;
  NEW.challenge_status := CASE WHEN NEW.for_challenge THEN 'sending'::delivery_status END;
  NEW.challenge_attempts := CASE WHEN NEW.for_challenge THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contract_transmissions_before_insert BEFORE INSERT ON contract_transmissions
  FOR EACH ROW EXECUTE FUNCTION contract_transmission_before_insert();

-- À la transmission, les documents du contrat sont datés et verrouillés ; leur suppression est fixée à 48 h après (trigger des documents)
CREATE FUNCTION contract_transmission_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contract_field_documents SET transmitted_at = NEW.transmitted_at WHERE account_contract_id = NEW.account_contract_id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_contract_transmissions_after_insert AFTER INSERT ON contract_transmissions
  FOR EACH ROW EXECUTE FUNCTION contract_transmission_after_insert();

CREATE FUNCTION contract_transmission_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_contract_id IS DISTINCT FROM OLD.account_contract_id OR NEW.for_analysis IS DISTINCT FROM OLD.for_analysis
     OR NEW.for_challenge IS DISTINCT FROM OLD.for_challenge OR NEW.transmitted_at IS DISTINCT FROM OLD.transmitted_at THEN
    RAISE EXCEPTION 'Une transmission ne change ni de contrat, ni de canaux, ni de date' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.analysis_status IS DISTINCT FROM OLD.analysis_status THEN
    IF NOT contract_analysis_transition_allowed(OLD.analysis_status, NEW.analysis_status) THEN
      RAISE EXCEPTION 'Transition interdite de l''état de l''analyse : % vers %', OLD.analysis_status, NEW.analysis_status USING ERRCODE = 'check_violation';
    END IF;
    -- Un rapport est écrit avant que l'analyse soit terminée
    IF NEW.analysis_status = 'completed' AND NOT EXISTS (SELECT 1 FROM contract_reports r WHERE r.account_contract_id = NEW.account_contract_id AND r.generated_at >= NEW.transmitted_at) THEN
      RAISE EXCEPTION 'Une analyse terminée a un rapport' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.analysis_status IN ('completed', 'cancelled') THEN NEW.analysis_finished_at := COALESCE(NEW.analysis_finished_at, now()); END IF;
  END IF;
  IF NEW.challenge_status IS DISTINCT FROM OLD.challenge_status AND (OLD.challenge_status, NEW.challenge_status) NOT IN (('sending', 'sent'), ('sending', 'failed'), ('failed', 'sending')) THEN
    RAISE EXCEPTION 'Transition interdite de l''état de l''envoi au challenge : % vers %', OLD.challenge_status, NEW.challenge_status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.challenge_status = 'sent' AND OLD.challenge_status IS DISTINCT FROM 'sent' THEN NEW.challenge_sent_at := COALESCE(NEW.challenge_sent_at, now()); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contract_transmissions_before_update BEFORE UPDATE ON contract_transmissions
  FOR EACH ROW EXECUTE FUNCTION contract_transmission_before_update();

-- Relances (US-135) : « Relancer l'analyse » et « Renvoyer » (challenge), tant que les documents existent ; une relance ne prolonge pas le délai de 48 h
CREATE TABLE contract_transmission_relaunches (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transmission_id       bigint NOT NULL REFERENCES contract_transmissions (id) ON DELETE CASCADE,
  channel               contract_channel NOT NULL,
  relaunched_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  relaunched_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contract_relaunches_transmission ON contract_transmission_relaunches (transmission_id);
CREATE INDEX idx_contract_relaunches_user ON contract_transmission_relaunches (relaunched_by_user_id);
COMMENT ON TABLE contract_transmission_relaunches IS $$Relances d'une transmission : relance de l'analyse ou renvoi au challenge, par qui et quand (une relance d'analyse compte comme une demande dans le plafond quotidien, C-11). Possibles tant que les documents existent ; ne prolongent pas le délai de 48 h. [US-135 RF1, RF3, RF5, US-131 RT4]$$;

CREATE FUNCTION contract_relaunch_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_t contract_transmissions%ROWTYPE;
BEGIN
  SELECT * INTO v_t FROM contract_transmissions WHERE id = NEW.transmission_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM contract_field_documents d WHERE d.account_contract_id = v_t.account_contract_id AND d.expires_at > now()) THEN
    RAISE EXCEPTION 'Documents supprimés : déposez-les à nouveau pour relancer' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.channel = 'analysis' AND v_t.analysis_status IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'Seule une analyse échouée se relance' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.channel = 'challenge' AND v_t.challenge_status IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'Seul un envoi au challenge échoué se renvoie' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contract_relaunches_before_insert BEFORE INSERT ON contract_transmission_relaunches
  FOR EACH ROW EXECUTE FUNCTION contract_relaunch_before_insert();

CREATE FUNCTION contract_relaunch_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel = 'analysis' THEN
    UPDATE contract_transmissions SET analysis_status = 'running', analysis_attempts = analysis_attempts + 1, analysis_failure_notified_at = NULL WHERE id = NEW.transmission_id;
  ELSE
    UPDATE contract_transmissions SET challenge_status = 'sending', challenge_attempts = challenge_attempts + 1 WHERE id = NEW.transmission_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_contract_relaunches_after_insert AFTER INSERT ON contract_transmission_relaunches
  FOR EACH ROW EXECUTE FUNCTION contract_relaunch_after_insert();

-- ---------------------------------------------------------------------
-- Documents d'un contrat (US-126) : un par champ et par contrat, PDF ou jusqu'à 10 pages de photos (C-09), stockés chiffrés chez MAAQ (C-01).
-- Verrouillés pendant les 48 h qui suivent la transmission ; supprimés 48 h après la transmission, ou 30 jours après le dépôt sans transmission.
-- Anonymisation (US-136, US-137) sur la même ligne : état, score, versions, texte masqué chiffré, qui a vérifié et quand ; compteurs par type à part.
-- ---------------------------------------------------------------------
CREATE TABLE contract_field_documents (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_contract_id      bigint NOT NULL REFERENCES account_contracts (id) ON DELETE CASCADE,
  field_id                 bigint NOT NULL REFERENCES contract_document_fields (id) ON DELETE CASCADE,
  source_kind              contract_document_kind NOT NULL,
  -- Nombre de pages : 1 à 10 pour des photos (qui forment un seul document), nombre de pages du fichier pour un PDF
  page_count               smallint NOT NULL CHECK (page_count BETWEEN 1 AND 1000),
  size_bytes               bigint NOT NULL CHECK (size_bytes > 0),
  -- Nom du fichier, chiffré par l'application ; le fichier lui-même est dans le stockage chiffré (storage_key), supprimé via la file de suppression
  file_name                bytea NOT NULL,
  storage_key              text NOT NULL,
  uploaded_by_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  uploaded_at              timestamptz NOT NULL DEFAULT now(),
  -- Date de transmission (verrouille le document) ; vide tant que le document n'est pas transmis
  transmitted_at           timestamptz,
  -- Date de suppression : dépôt + 30 jours (réglage), puis transmission + 48 h ; tenue par trigger
  expires_at               timestamptz NOT NULL,
  -- Avertissement envoyé au déposant 3 jours avant la suppression (document jamais transmis)
  expiry_warned_at         timestamptz,
  -- Anonymisation
  masking_status           contract_masking_status NOT NULL DEFAULT 'pending',
  confidence_pct           smallint CHECK (confidence_pct BETWEEN 0 AND 100),
  masking_tool_version     varchar(40),
  masking_rules_version    varchar(40),
  -- Texte masqué chiffré (jetons seulement) ; supprimé avec le document
  masked_text              bytea,
  verified_by_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  verified_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_contract_id, field_id),
  CONSTRAINT ck_contract_documents_photos CHECK (source_kind <> 'photos' OR page_count <= 10),
  CONSTRAINT ck_contract_documents_expiry CHECK (expires_at > uploaded_at),
  CONSTRAINT ck_contract_documents_masked_text CHECK ((masking_status IN ('to_verify', 'verified', 'uncertain')) = (masked_text IS NOT NULL)),
  CONSTRAINT ck_contract_documents_verified CHECK ((masking_status = 'verified') = (verified_at IS NOT NULL))
);
CREATE INDEX idx_contract_documents_field ON contract_field_documents (field_id);
CREATE INDEX idx_contract_documents_uploaded_by ON contract_field_documents (uploaded_by_user_id);
CREATE INDEX idx_contract_documents_verified_by ON contract_field_documents (verified_by_user_id);
CREATE INDEX idx_contract_documents_expiry ON contract_field_documents (expires_at);
COMMENT ON TABLE contract_field_documents IS $$Document déposé dans un champ d'un contrat : un PDF ou jusqu'à 10 photos formant un seul document, stocké chiffré (nom chiffré, fichier dans le stockage chiffré), avec qui l'a déposé et quand. Verrouillé 48 h après la transmission, puis supprimé ; supprimé au bout de 30 jours sans transmission (avertissement 3 jours avant). Porte aussi l'anonymisation : état, score, versions, texte masqué chiffré (supprimé avec le document), vérification. Donnée de famille sensible (documents de contrat). [US-126, US-134, US-136, US-137, C-01]$$;
COMMENT ON COLUMN contract_field_documents.expires_at IS $$Date de suppression, tenue par trigger : dépôt + 30 jours (réglage contract_document_retention_days) ; à la transmission, transmission + 48 h. La purge supprime le document à cette date (C-01)$$;
COMMENT ON COLUMN contract_field_documents.masking_status IS $$pending = en attente ; masking = masquage en cours ; to_verify = à vérifier (masquage terminé) ; verified = vérifié par l'utilisateur ; uncertain = lecture incertaine (score sous le seuil) ; unreadable = illisible (à remplacer). [US-136 RF7]$$;
COMMENT ON COLUMN contract_field_documents.masked_text IS $$Texte masqué chiffré, jetons typés seulement ([PERSONNE_1]…) : pseudonymisation, le texte reste une donnée personnelle. Aucune table de correspondance entre jetons et valeurs n'existe. Supprimé avec le document. [US-136 RT3, RT6]$$;
COMMENT ON COLUMN contract_field_documents.confidence_pct IS $$Score de confiance de la lecture (OCR), de 0 à 100 ; comparé au seuil contract_read_confidence_threshold_pct$$;

-- Compteurs de masques par type, sans les valeurs (US-136 RT4)
CREATE TABLE contract_document_mask_counts (
  document_id  bigint NOT NULL REFERENCES contract_field_documents (id) ON DELETE CASCADE,
  mask_type    contract_mask_type NOT NULL,
  mask_count   integer NOT NULL CHECK (mask_count >= 0),
  PRIMARY KEY (document_id, mask_type)
);
COMMENT ON TABLE contract_document_mask_counts IS $$Nombre de masques posés dans un document, par type (personne, adresse, email, téléphone, numéro de contrat, compte bancaire, véhicule, sécurité sociale, employeur, identifiant de compte, masque ajouté à la main, autre). Aucune valeur masquée. Supprimé avec le document. [US-136 RT4]$$;

CREATE FUNCTION contract_masking_transition_allowed(p_from contract_masking_status, p_to contract_masking_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (('pending', 'masking'), ('masking', 'pending'), ('masking', 'to_verify'), ('masking', 'uncertain'), ('masking', 'unreadable'),
                            ('to_verify', 'verified'), ('uncertain', 'verified'))
$$;
COMMENT ON FUNCTION contract_masking_transition_allowed(contract_masking_status, contract_masking_status) IS $$Transitions permises de l'état d'anonymisation d'un document : en attente vers masquage en cours (et retour pour un nouvel essai), masquage vers à vérifier, lecture incertaine ou illisible, à vérifier ou lecture incertaine vers vérifié. Un document illisible ne se vérifie pas : il se remplace (retour à « en attente »). [US-136, US-137 RF7]$$;

CREATE FUNCTION contract_field_document_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_def bigint; v_field_def bigint; v_max_mb integer; v_days integer;
BEGIN
  SELECT contract_definition_id INTO v_def FROM account_contracts WHERE id = NEW.account_contract_id;
  SELECT contract_definition_id INTO v_field_def FROM contract_document_fields WHERE id = NEW.field_id;
  IF v_def IS DISTINCT FROM v_field_def THEN
    RAISE EXCEPTION 'Ce champ n''appartient pas à la catégorie du contrat' USING ERRCODE = 'check_violation';
  END IF;
  -- Catégorie archivée : ni dépôt ni remplacement de documents (US-139 RF3) ; le retrait reste permis
  IF EXISTS (SELECT 1 FROM contract_definitions WHERE id = v_def AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cette catégorie est archivée : aucun dépôt de document' USING ERRCODE = 'check_violation';
  END IF;
  SELECT value_text::integer INTO v_max_mb FROM platform_settings WHERE setting_key = 'max_document_size_mb';
  IF NEW.size_bytes > COALESCE(v_max_mb, 15)::bigint * 1048576 THEN
    RAISE EXCEPTION 'Ce document dépasse % Mo', COALESCE(v_max_mb, 15) USING ERRCODE = 'check_violation';
  END IF;
  -- Pendant les 48 h qui suivent une transmission, les documents du contrat ne se modifient pas : aucun nouveau dépôt
  IF EXISTS (SELECT 1 FROM contract_field_documents d WHERE d.account_contract_id = NEW.account_contract_id AND d.transmitted_at IS NOT NULL AND d.expires_at > now()) THEN
    RAISE EXCEPTION 'Les documents de ce contrat sont verrouillés après leur transmission' USING ERRCODE = 'check_violation';
  END IF;
  SELECT value_text::integer INTO v_days FROM platform_settings WHERE setting_key = 'contract_document_retention_days';
  NEW.expires_at := NEW.uploaded_at + make_interval(days => COALESCE(v_days, 30));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contract_documents_before_insert BEFORE INSERT ON contract_field_documents
  FOR EACH ROW EXECUTE FUNCTION contract_field_document_before_insert();

CREATE FUNCTION contract_field_document_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_days integer;
BEGIN
  -- Verrouillé après la transmission : ni remplacement, ni retrait, ni déplacement
  -- (le déposant peut être mis à NULL : suppression du profil)
  IF OLD.transmitted_at IS NOT NULL
     AND (ROW(NEW.account_contract_id, NEW.field_id, NEW.source_kind, NEW.page_count, NEW.size_bytes, NEW.file_name, NEW.storage_key,
              NEW.uploaded_at, NEW.transmitted_at)
          IS DISTINCT FROM
          ROW(OLD.account_contract_id, OLD.field_id, OLD.source_kind, OLD.page_count, OLD.size_bytes, OLD.file_name, OLD.storage_key,
              OLD.uploaded_at, OLD.transmitted_at)
          OR (NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id AND NEW.uploaded_by_user_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Document verrouillé après sa transmission' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.account_contract_id IS DISTINCT FROM OLD.account_contract_id OR NEW.field_id IS DISTINCT FROM OLD.field_id THEN
    RAISE EXCEPTION 'Un document ne change ni de contrat ni de champ' USING ERRCODE = 'check_violation';
  END IF;
  -- Transmission : le document est daté et sa suppression fixée à 48 h après
  IF OLD.transmitted_at IS NULL AND NEW.transmitted_at IS NOT NULL THEN
    NEW.expires_at := NEW.transmitted_at + interval '48 hours';
    NEW.expiry_warned_at := NULL;
  END IF;
  -- Remplacement avant transmission : nouveau dépôt, 30 jours repartent, l'ancien fichier part à la suppression, anonymisation et vérification à refaire (US-137 RF5)
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key THEN
    IF EXISTS (SELECT 1 FROM account_contracts c JOIN contract_definitions d ON d.id = c.contract_definition_id
                WHERE c.id = NEW.account_contract_id AND d.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Cette catégorie est archivée : aucun remplacement de document' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO storage_deletion_queue (storage_key) VALUES (OLD.storage_key);
    SELECT value_text::integer INTO v_days FROM platform_settings WHERE setting_key = 'contract_document_retention_days';
    NEW.uploaded_at := now();
    NEW.expires_at := NEW.uploaded_at + make_interval(days => COALESCE(v_days, 30));
    NEW.expiry_warned_at := NULL;
    NEW.masking_status := 'pending';
    NEW.confidence_pct := NULL;
    NEW.masking_tool_version := NULL;
    NEW.masking_rules_version := NULL;
    NEW.masked_text := NULL;
    NEW.verified_by_user_id := NULL;
    NEW.verified_at := NULL;
    DELETE FROM contract_document_mask_counts WHERE document_id = OLD.id;
  ELSIF NEW.masking_status IS DISTINCT FROM OLD.masking_status THEN
    IF NOT contract_masking_transition_allowed(OLD.masking_status, NEW.masking_status) THEN
      RAISE EXCEPTION 'Transition interdite de l''état d''anonymisation : % vers %', OLD.masking_status, NEW.masking_status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.masking_status = 'verified' THEN NEW.verified_at := COALESCE(NEW.verified_at, now()); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contract_documents_before_update BEFORE UPDATE ON contract_field_documents
  FOR EACH ROW EXECUTE FUNCTION contract_field_document_before_update();

-- Suppression : refusée pendant les 48 h de verrouillage quand elle vient d'une demande directe (« Retirer ») ; permise à l'échéance (purge) et en
-- cascade (suppression du contrat, du champ ou du compte). Le fichier part à la file de suppression du stockage.
CREATE FUNCTION contract_field_document_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.transmitted_at IS NOT NULL AND OLD.expires_at > now() AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'Document verrouillé après sa transmission : il sera supprimé à l''échéance' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO storage_deletion_queue (storage_key) VALUES (OLD.storage_key);
  RETURN OLD;
END $$;
CREATE TRIGGER trg_contract_documents_before_delete BEFORE DELETE ON contract_field_documents
  FOR EACH ROW EXECUTE FUNCTION contract_field_document_before_delete();

-- ---------------------------------------------------------------------
-- Analyses à valider (US-138) : une demande par transmission dont la lecture est incertaine ; l'administrateur ne voit que le texte masqué
-- ---------------------------------------------------------------------
CREATE TABLE contract_analysis_reviews (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transmission_id       bigint NOT NULL UNIQUE REFERENCES contract_transmissions (id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Suppression des documents (48 h après la transmission) : la demande expire alors
  expires_at            timestamptz NOT NULL,
  decision              contract_review_decision,
  decided_by_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at            timestamptz,
  -- Nombre de masques ajoutés par l'administrateur (jamais les valeurs)
  masks_added_count     smallint NOT NULL DEFAULT 0 CHECK (masks_added_count >= 0),
  CONSTRAINT ck_contract_reviews_decided CHECK ((decision IS NULL) = (decided_at IS NULL))
);
CREATE INDEX idx_contract_reviews_pending ON contract_analysis_reviews (created_at) WHERE decision IS NULL;
CREATE INDEX idx_contract_reviews_decided_by ON contract_analysis_reviews (decided_by_user_id);
COMMENT ON TABLE contract_analysis_reviews IS $$Demande « Analyses à valider » : créée quand un contrat est transmis pour analyse avec une lecture incertaine ; décision de l'administrateur (poursuivre ou ne pas poursuivre), qui et quand, nombre de masques ajoutés. Expire à la suppression des documents. Chaque consultation et chaque décision sont inscrites dans le journal d'administration (admin_audit_log). L'administrateur ne lit que la vue v_contract_reviews_to_decide : texte masqué et catégorie, jamais le document, le nom du contrat ni la famille. [US-138]$$;

CREATE FUNCTION contract_review_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status contract_analysis_status; v_contract bigint;
BEGIN
  SELECT analysis_status, account_contract_id INTO v_status, v_contract FROM contract_transmissions WHERE id = NEW.transmission_id;
  IF v_status IS DISTINCT FROM 'awaiting_admin' THEN
    RAISE EXCEPTION 'Une demande ne concerne qu''une analyse en attente d''un administrateur' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decision IS NOT NULL THEN
    RAISE EXCEPTION 'Une demande est créée sans décision' USING ERRCODE = 'check_violation';
  END IF;
  NEW.expires_at := COALESCE(NEW.expires_at, (SELECT min(expires_at) FROM contract_field_documents WHERE account_contract_id = v_contract), now() + interval '48 hours');
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contract_reviews_before_insert BEFORE INSERT ON contract_analysis_reviews
  FOR EACH ROW EXECUTE FUNCTION contract_review_before_insert();

CREATE FUNCTION contract_review_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.decision IS NOT NULL AND ROW(NEW.decision, NEW.decided_by_user_id, NEW.decided_at, NEW.masks_added_count)
                                  IS DISTINCT FROM ROW(OLD.decision, OLD.decided_by_user_id, OLD.decided_at, OLD.masks_added_count) THEN
    RAISE EXCEPTION 'Une décision ne se modifie pas' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.decision IS NULL AND NEW.decision IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.decided_by_user_id AND u.role = 'admin') THEN
      RAISE EXCEPTION 'Seul un administrateur décide d''une analyse à valider' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'La demande a expiré : les documents sont supprimés' USING ERRCODE = 'check_violation';
    END IF;
    NEW.decided_at := COALESCE(NEW.decided_at, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contract_reviews_before_update BEFORE UPDATE ON contract_analysis_reviews
  FOR EACH ROW EXECUTE FUNCTION contract_review_before_update();

-- La décision fait avancer l'analyse : « poursuivre » la relance, « ne pas poursuivre » l'annule
CREATE FUNCTION contract_review_after_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contract_transmissions
     SET analysis_status = CASE NEW.decision WHEN 'continue' THEN 'running'::contract_analysis_status ELSE 'cancelled'::contract_analysis_status END
   WHERE id = NEW.transmission_id AND analysis_status = 'awaiting_admin';
  RETURN NULL;
END $$;
CREATE TRIGGER trg_contract_reviews_after_decision AFTER UPDATE OF decision ON contract_analysis_reviews
  FOR EACH ROW WHEN (OLD.decision IS NULL AND NEW.decision IS NOT NULL) EXECUTE FUNCTION contract_review_after_decision();

-- Ce que voit l'administrateur : la catégorie, et pour chaque document le texte masqué, le score, le nombre de pages et la date limite. Aucune colonne ne
-- désigne la famille, le profil, le contrat ou son nom, ni le document d'origine (US-138 RF2, RT1)
CREATE VIEW v_contract_reviews_to_decide AS
SELECT r.id AS review_id, cd.name AS category_name, r.created_at, r.expires_at, f.name AS field_name,
       d.page_count, d.confidence_pct, d.masking_status, d.masked_text
  FROM contract_analysis_reviews r
  JOIN contract_transmissions t ON t.id = r.transmission_id
  JOIN account_contracts c ON c.id = t.account_contract_id
  JOIN contract_definitions cd ON cd.id = c.contract_definition_id
  JOIN contract_field_documents d ON d.account_contract_id = c.id
  JOIN contract_document_fields f ON f.id = d.field_id
 WHERE r.decision IS NULL AND r.expires_at > now();
COMMENT ON VIEW v_contract_reviews_to_decide IS $$Demandes « Analyses à valider » en attente, document par document : catégorie, champ, pages, score de lecture, texte masqué chiffré, date limite. Ne contient jamais le document d'origine, le nom du contrat, la famille ni le profil : c'est la seule lecture de la console. À journaliser à chaque consultation (admin_audit_log). [US-138 RF2, RT1, RT3]$$;

-- ---------------------------------------------------------------------
-- Rapport d'analyse (US-132) : un seul par contrat, qui remplace le précédent, sans historique
-- ---------------------------------------------------------------------
CREATE TABLE contract_reports (
  account_contract_id  bigint PRIMARY KEY REFERENCES account_contracts (id) ON DELETE CASCADE,
  account_id           uuid NOT NULL,
  -- HTML produit par l'agent, nettoyé avant affichage, chiffré par l'application : jetons seulement, aucune valeur personnelle
  html                 bytea NOT NULL,
  generated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_contract_reports_contract FOREIGN KEY (account_contract_id, account_id)
    REFERENCES account_contracts (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_contract_reports_account_id ON contract_reports (account_id);
COMMENT ON TABLE contract_reports IS $$Rapport d'analyse d'un contrat : un seul, remplacé par le suivant (aucun historique), HTML chiffré avec des jetons et des références, jamais de valeur personnelle. Conservé jusqu'à son remplacement ou la suppression du contrat, même après la suppression des documents. [US-132, US-131]$$;

-- Jetons du rapport qui correspondent à une donnée que MAAQ détient déjà : référence à un membre ou à un détail du contrat, remplacée par la valeur à l'affichage.
-- Les autres jetons s'affichent sous une forme neutre ; aucune table de correspondance n'est conservée.
CREATE TABLE contract_report_refs (
  account_contract_id  bigint NOT NULL REFERENCES contract_reports (account_contract_id) ON DELETE CASCADE,
  account_id           uuid NOT NULL,
  token                varchar(40) NOT NULL CHECK (token ~ '^\[[A-Z_]+_[0-9]+\]$'),
  member_id            uuid,
  field_definition_id  bigint REFERENCES contract_field_definitions (id) ON DELETE RESTRICT,
  PRIMARY KEY (account_contract_id, token),
  CONSTRAINT ck_contract_report_refs_target CHECK (num_nonnulls(member_id, field_definition_id) = 1),
  CONSTRAINT fk_contract_report_refs_member FOREIGN KEY (member_id, account_id)
    REFERENCES family_members (id, account_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_contract_report_refs_contract FOREIGN KEY (account_contract_id, account_id)
    REFERENCES account_contracts (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_contract_report_refs_member ON contract_report_refs (member_id, account_id) WHERE member_id IS NOT NULL;
CREATE INDEX idx_contract_report_refs_field ON contract_report_refs (field_definition_id) WHERE field_definition_id IS NOT NULL;
CREATE INDEX idx_contract_report_refs_account ON contract_report_refs (account_contract_id, account_id);
COMMENT ON TABLE contract_report_refs IS $$Jetons d'un rapport qui désignent un membre de la famille ou un détail du contrat (références, comme D39) : le prénom ou la valeur est lu à l'affichage, jamais stocké ici. Aucune valeur personnelle, aucune table de correspondance pour les autres jetons. Supprimés avec le rapport. [US-132 RT3]$$;

-- ---------------------------------------------------------------------
-- Purges et avertissements (C-01, US-126 RF7, RT2)
-- ---------------------------------------------------------------------
-- Supprime les documents échus (transmis depuis plus de 48 h, ou déposés depuis plus de 30 jours sans transmission) avec leur texte masqué et leurs compteurs,
-- les fichiers partent à la file de suppression du stockage ; les demandes « Analyses à valider » échues sans décision sont fermées (analyse annulée) puis supprimées.
-- Retourne le nombre de documents supprimés. À planifier chaque heure (le délai de 48 h demande une purge plus fine qu'une purge quotidienne).
CREATE FUNCTION purge_expired_contract_documents() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  UPDATE contract_transmissions t SET analysis_status = 'cancelled'
    FROM contract_analysis_reviews r
   WHERE r.transmission_id = t.id AND r.decision IS NULL AND r.expires_at <= now() AND t.analysis_status = 'awaiting_admin';
  DELETE FROM contract_analysis_reviews WHERE expires_at <= now();
  DELETE FROM contract_field_documents WHERE expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_expired_contract_documents() IS $$Supprime les documents de contrat échus (48 h après la transmission, ou 30 jours après le dépôt sans transmission) avec leur texte masqué, ferme et supprime les demandes d'analyse à valider échues, et met les fichiers en file de suppression. À planifier chaque heure. [US-126 RT2, C-01, C-18]$$;

-- Documents jamais transmis qui seront supprimés dans 3 jours ou moins : marque l'avertissement et retourne ce qu'il faut notifier au déposant (une seule fois par
-- document). À planifier chaque heure ou chaque jour.
CREATE FUNCTION warn_expiring_contract_documents()
RETURNS TABLE (document_id bigint, account_contract_id bigint, uploaded_by_user_id uuid, expires_at timestamptz) LANGUAGE sql AS $$
  UPDATE contract_field_documents d SET expiry_warned_at = now()
   WHERE d.transmitted_at IS NULL AND d.expiry_warned_at IS NULL AND d.expires_at > now() AND d.expires_at <= now() + interval '3 days'
  RETURNING d.id, d.account_contract_id, d.uploaded_by_user_id, d.expires_at
$$;
COMMENT ON FUNCTION warn_expiring_contract_documents() IS $$Marque l'avertissement « supprimés dans 3 jours s'ils ne sont pas transmis » et retourne les documents concernés (identifiant, contrat, déposant, échéance) : une seule fois par document, atomique. La notification est envoyée par l'application. À planifier chaque heure ou chaque jour. [US-126 RF7, C-01]$$;

-- Réglages de la console (US-65) : partenaire du challenge (vides = challenge bloqué), plafond de contrats, conservation sans transmission, seuil de lecture
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('contract_broker_name',                    'free_text', NULL, NULL, NULL, $$Nom du courtier partenaire du challenge, cité dans le texte de consentement ; vide = challenge bloqué (US-128 RF2bis, C-10)$$),
  ('contract_broker_email',                   'email',     NULL, NULL, NULL, $$Adresse de la boîte du courtier qui reçoit les documents du challenge ; vide = challenge bloqué, modifiable sans livraison (US-129 RT2, C-10)$$),
  ('max_contracts_per_category',              'integer',   '20', 1, 200, $$Contrats au plus par catégorie et par famille, contrat de base compris : plafond technique, invisible en usage normal (US-124 RF3, C-08)$$),
  ('contract_document_retention_days',        'integer',   '30', 1, 365, $$Conservation d'un document de contrat sans transmission, en jours ; 48 h après la transmission dans tous les cas (US-126 RF7, C-01)$$),
  ('contract_read_confidence_threshold_pct',  'integer',   '80', 0, 100, $$Seuil de confiance de lecture (OCR) en pourcentage : en dessous, la lecture est incertaine et l'analyse attend la décision d'un administrateur (US-136 RF6, US-138 RT2)$$);

-- =====================================================================
-- ÉMOTIONS (lot 13, US-141 à US-151, décisions E-01 à E-24) : cœurs, mots libres, bilan de la semaine, envies à deux
--
-- Réservé au couple : l'utilisateur principal et l'invité 1, tous deux présents (E-03). Sans invité 1 actif (pas invité, invitation non acceptée, retiré),
-- il n'y a ni cœur, ni mot, ni bilan, ni envie (E-21) ; au retrait de l'invité 1, tout ce qui précède est supprimé (E-20, E-15). Un invité secondaire n'a
-- accès à rien, et les fonctions de lecture ne lui renvoient aucune ligne. Rien de tout cela n'est écrit dans le carnet de bord (E-09), ni lisible par l'agent.
-- Le bilan est calculé à l'ouverture, à partir des tâches, des RDV et des cœurs de la semaine : seule la ligne weekly_reviews est gardée, sans copie (E-13).
-- La charge d'un parent (E-16) est calculée par l'application, rien n'est gardé en base : seuls les seuils sont des réglages de la console.
-- =====================================================================

-- Le couple : retourne l'autre parent d'un profil, ou NULL quand le profil n'est pas l'un des deux parents ou que l'autre n'est pas présent et actif
CREATE FUNCTION emotion_partner_of(p_user uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT o.id
    FROM users u
    JOIN users o ON o.account_id = u.account_id AND o.id <> u.id
   WHERE u.id = p_user
     AND u.status IN ('active', 'grace_period') AND o.status IN ('active', 'grace_period')
     AND ((u.role = 'primary_user' AND o.role = 'guest' AND o.guest_rank = 'core')
       OR (u.role = 'guest' AND u.guest_rank = 'core' AND o.role = 'primary_user'))
   LIMIT 1
$$;
COMMENT ON FUNCTION emotion_partner_of(uuid) IS $$Autre parent du couple d'un profil (utilisateur principal ou invité 1, tous deux actifs) ; NULL pour un invité secondaire, un administrateur, ou quand l'autre parent n'est pas présent. Sert de garde à tous les objets « Émotions ». [US-141, E-03, E-21]$$;

CREATE FUNCTION emotion_couple_exists(p_account uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM users p WHERE p.account_id = p_account AND p.role = 'primary_user' AND emotion_partner_of(p.id) IS NOT NULL)
$$;
COMMENT ON FUNCTION emotion_couple_exists(uuid) IS $$Vrai si la famille a un couple actif : l'utilisateur principal et un invité 1 actif. [E-21]$$;

-- ---------------------------------------------------------------------
-- Bilan de la semaine (US-144, E-13, E-17) : une ligne par parent et par semaine, créée par le planificateur avec le point. Aucun contenu :
-- tâches faites, RDV passés et cœurs de la semaine (lundi-dimanche qui précède l'envoi) sont calculés à l'ouverture.
-- ---------------------------------------------------------------------
CREATE TABLE weekly_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  -- Lundi de la semaine couverte (lundi-dimanche qui précède l'envoi)
  week_start    date NOT NULL CHECK (date_part('isodow', week_start) = 1),
  generated_at  timestamptz NOT NULL DEFAULT now(),
  -- Première ouverture par le destinataire : rattache et fige ses mots (US-143 RF8) ; posée une seule fois
  opened_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id, week_start),
  UNIQUE (id, user_id),
  CONSTRAINT fk_weekly_reviews_user FOREIGN KEY (user_id, account_id) REFERENCES users (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_weekly_reviews_user ON weekly_reviews (user_id, account_id);
CREATE INDEX idx_weekly_reviews_week ON weekly_reviews (week_start);
COMMENT ON TABLE weekly_reviews IS $$Bilan de la semaine passée d'un parent du couple : seulement le destinataire, la semaine et la date d'ouverture, sans copie du contenu (calculé à l'ouverture, une tâche supprimée après le bilan en disparaît). Existe même si le point est désactivé. Conservé 4 semaines, avec les mots qui lui sont rattachés. [US-142, US-144, E-13, E-17]$$;
COMMENT ON COLUMN weekly_reviews.opened_at IS $$Première ouverture du bilan par son destinataire ; à cet instant, les mots écrits pour lui lui sont rattachés et figés (un mot écrit après l'envoi mais avant l'ouverture entre dans ce bilan). Posée une seule fois. [US-143 RF8]$$;

CREATE FUNCTION weekly_review_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF emotion_partner_of(NEW.user_id) IS NULL THEN
      RAISE EXCEPTION 'Le bilan est réservé aux deux parents du couple' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.opened_at IS NOT NULL THEN
      RAISE EXCEPTION 'Un bilan est créé non ouvert' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.week_start IS DISTINCT FROM OLD.week_start
       OR NEW.generated_at IS DISTINCT FROM OLD.generated_at THEN
      RAISE EXCEPTION 'Seule l''ouverture d''un bilan se modifie' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
      RAISE EXCEPTION 'La date d''ouverture du bilan ne change plus' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_weekly_reviews_before_write BEFORE INSERT OR UPDATE ON weekly_reviews
  FOR EACH ROW EXECUTE FUNCTION weekly_review_before_write();

-- ---------------------------------------------------------------------
-- Mot libre (US-143, E-07, E-22) : chiffré par l'application, lisible par son auteur et, après l'ouverture de son bilan, par son destinataire.
-- Non rattaché (weekly_review_id vide) tant que le destinataire n'a pas ouvert son bilan : l'auteur peut le relire, le modifier, le retirer. À la première
-- ouverture, tous les mots non rattachés de l'autre parent sont rattachés à ce bilan et figés. Un mot jamais lu est supprimé 4 semaines après son écriture.
-- ---------------------------------------------------------------------
CREATE TABLE partner_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  author_user_id     uuid NOT NULL,
  recipient_user_id  uuid NOT NULL,
  -- Bilan auquel le mot est rattaché (à l'ouverture de ce bilan par le destinataire) ; vide tant qu'il n'est pas lu
  weekly_review_id          uuid,
  -- Texte chiffré par l'application (500 caractères au plus, vérifiés par l'application) : la base borne seulement la taille du chiffré
  body               bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 2500),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_partner_notes_distinct CHECK (author_user_id <> recipient_user_id),
  CONSTRAINT fk_partner_notes_author FOREIGN KEY (author_user_id, account_id) REFERENCES users (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_partner_notes_recipient FOREIGN KEY (recipient_user_id, account_id) REFERENCES users (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_partner_notes_review FOREIGN KEY (weekly_review_id, recipient_user_id) REFERENCES weekly_reviews (id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_partner_notes_account ON partner_notes (account_id);
CREATE INDEX idx_partner_notes_author ON partner_notes (author_user_id, account_id);
CREATE INDEX idx_partner_notes_recipient ON partner_notes (recipient_user_id, account_id);
CREATE INDEX idx_partner_notes_review ON partner_notes (weekly_review_id, recipient_user_id) WHERE weekly_review_id IS NOT NULL;
CREATE INDEX idx_partner_notes_unread ON partner_notes (created_at) WHERE weekly_review_id IS NULL;
COMMENT ON TABLE partner_notes IS $$Mot libre d'un parent à l'autre, chiffré par l'application, jamais envoyé à l'agent ni utilisé dans un résumé ni écrit dans un journal. Lisible par son auteur, et par son destinataire après l'ouverture de son bilan seulement ; modifiable et retirable par l'auteur jusqu'à cette ouverture, puis figé. Supprimé avec le bilan (4 semaines), ou 4 semaines après son écriture s'il n'est jamais lu. Donnée sensible (texte libre, E-10). [US-143, E-07, E-22]$$;
COMMENT ON COLUMN partner_notes.weekly_review_id IS $$Bilan du destinataire auquel le mot est rattaché, posé par la base à la première ouverture de ce bilan (jamais directement) ; vide = pas encore lu, l'auteur peut encore le modifier ou le retirer. [US-143 RF4, RF8]$$;
COMMENT ON COLUMN partner_notes.body IS $$Texte chiffré par l'application (500 caractères au plus, vérifiés par l'application) ; la base borne seulement la taille du chiffré$$;

CREATE FUNCTION partner_note_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF emotion_partner_of(NEW.author_user_id) IS DISTINCT FROM NEW.recipient_user_id THEN
      RAISE EXCEPTION 'Un mot s''écrit d''un parent du couple à l''autre' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.weekly_review_id IS NOT NULL THEN
      RAISE EXCEPTION 'Un mot est rattaché à l''ouverture du bilan, pas à l''écriture' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.weekly_review_id IS NOT NULL THEN
    RAISE EXCEPTION 'Ce mot est figé : le bilan de son destinataire a été ouvert' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id THEN
    RAISE EXCEPTION 'Un mot ne change ni d''auteur ni de destinataire' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.weekly_review_id IS NOT NULL AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'Un mot est rattaché à l''ouverture du bilan, pas directement' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_partner_notes_before_write BEFORE INSERT OR UPDATE ON partner_notes
  FOR EACH ROW EXECUTE FUNCTION partner_note_before_write();

-- Retrait direct refusé une fois le mot figé ; la suppression par cascade (bilan, profil, compte) et par purge reste permise
CREATE FUNCTION partner_note_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.weekly_review_id IS NOT NULL AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'Ce mot est figé : le bilan de son destinataire a été ouvert' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_partner_notes_before_delete BEFORE DELETE ON partner_notes
  FOR EACH ROW EXECUTE FUNCTION partner_note_before_delete();

-- Première ouverture du bilan : les mots non rattachés de l'autre parent lui sont rattachés et figés (US-143 RF8). SECURITY DEFINER : le destinataire
-- ne voit pas encore ces mots, la sécurité par ligne l'empêcherait de les mettre à jour.
CREATE FUNCTION weekly_review_attach_notes() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE partner_notes SET weekly_review_id = NEW.id
   WHERE account_id = NEW.account_id AND recipient_user_id = NEW.user_id AND weekly_review_id IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_weekly_reviews_attach_notes AFTER UPDATE OF opened_at ON weekly_reviews
  FOR EACH ROW WHEN (OLD.opened_at IS NULL AND NEW.opened_at IS NOT NULL) EXECUTE FUNCTION weekly_review_attach_notes();
COMMENT ON FUNCTION weekly_review_attach_notes() IS $$À la première ouverture d'un bilan, rattache et fige les mots non rattachés écrits pour son destinataire (un mot écrit après l'envoi mais avant l'ouverture entre dans ce bilan). Exécutée avec les droits du propriétaire (le destinataire ne voit pas encore ces mots). [US-143 RF8]$$;

CREATE FUNCTION partner_notes_visible_to(p_viewer uuid) RETURNS SETOF partner_notes
LANGUAGE sql STABLE AS $$
  SELECT n.* FROM partner_notes n
   WHERE emotion_partner_of(p_viewer) IS NOT NULL
     AND (n.author_user_id = p_viewer OR (n.recipient_user_id = p_viewer AND n.weekly_review_id IS NOT NULL))
$$;
COMMENT ON FUNCTION partner_notes_visible_to(uuid) IS $$Mots lisibles par un profil : ceux qu'il a écrits, et ceux qu'il a reçus une fois son bilan ouvert (il ne sait pas qu'un mot l'attend avant). Aucun pour un invité secondaire. [US-143 RF3, RT2, E-23]$$;

-- ---------------------------------------------------------------------
-- Cœur (US-141) : un seul par tâche ou par RDV, avec son auteur et sa date ; supprimé avec l'élément
-- ---------------------------------------------------------------------
CREATE TABLE appreciation_hearts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  task_id         uuid,
  event_id        uuid,
  author_user_id  uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_hearts_target CHECK (num_nonnulls(task_id, event_id) = 1),
  CONSTRAINT fk_hearts_task FOREIGN KEY (task_id, account_id) REFERENCES family_tasks (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_hearts_event FOREIGN KEY (event_id, account_id) REFERENCES family_events (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_hearts_author FOREIGN KEY (author_user_id, account_id) REFERENCES users (id, account_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_hearts_task ON appreciation_hearts (task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX ux_hearts_event ON appreciation_hearts (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_hearts_account ON appreciation_hearts (account_id);
CREATE INDEX idx_hearts_author ON appreciation_hearts (author_user_id, account_id);
CREATE INDEX idx_hearts_event_account ON appreciation_hearts (event_id, account_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_hearts_task_account ON appreciation_hearts (task_id, account_id) WHERE task_id IS NOT NULL;
COMMENT ON TABLE appreciation_hearts IS $$Cœur posé par un parent sur une tâche faite par l'autre parent, ou sur un RDV passé créé par l'autre parent : un seul par élément, avec son auteur et sa date, supprimé avec l'élément. Retiré si la tâche n'est plus faite, si le RDV passe dans le futur ou est annulé, ou quand le couple se défait. Visible des deux parents, pas des invités secondaires ; sans notification ; jamais dans le carnet de bord. [US-141, E-04, E-15]$$;

CREATE FUNCTION appreciation_heart_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_partner uuid; v_task family_tasks%ROWTYPE; v_event family_events%ROWTYPE; v_done_user uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Un cœur ne se modifie pas : on le retire et on le repose' USING ERRCODE = 'check_violation';
  END IF;
  v_partner := emotion_partner_of(NEW.author_user_id);
  IF v_partner IS NULL THEN
    RAISE EXCEPTION 'Le cœur est réservé aux deux parents du couple' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.task_id IS NOT NULL THEN
    SELECT * INTO v_task FROM family_tasks WHERE id = NEW.task_id;
    SELECT user_id INTO v_done_user FROM family_members WHERE id = v_task.done_by_member_id;
    IF v_task.status IS DISTINCT FROM 'done' OR v_done_user IS DISTINCT FROM v_partner THEN
      RAISE EXCEPTION 'Un cœur se pose sur une tâche faite par l''autre parent' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO v_event FROM family_events WHERE id = NEW.event_id;
    IF v_event.status IS DISTINCT FROM 'confirmed' OR v_event.ends_at > now() OR v_event.requested_by_user_id IS DISTINCT FROM v_partner THEN
      RAISE EXCEPTION 'Un cœur se pose sur un RDV passé créé par l''autre parent' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_appreciation_hearts_before_write BEFORE INSERT OR UPDATE ON appreciation_hearts
  FOR EACH ROW EXECUTE FUNCTION appreciation_heart_before_write();

-- Le cœur d'une tâche part quand elle n'est plus faite, ou quand elle n'est plus faite par l'autre parent (US-141 RF6)
CREATE FUNCTION appreciation_heart_task_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM appreciation_hearts h
   WHERE h.task_id = NEW.id
     AND (NEW.status <> 'done'
          OR (SELECT fm.user_id FROM family_members fm WHERE fm.id = NEW.done_by_member_id) IS DISTINCT FROM emotion_partner_of(h.author_user_id));
  RETURN NULL;
END $$;
CREATE TRIGGER trg_family_tasks_heart AFTER UPDATE OF status, done_by_member_id ON family_tasks
  FOR EACH ROW EXECUTE FUNCTION appreciation_heart_task_changed();

-- Le cœur d'un RDV part si le RDV passe dans le futur (E-15), s'il n'est plus confirmé ou si son créateur change
CREATE FUNCTION appreciation_heart_event_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM appreciation_hearts h
   WHERE h.event_id = NEW.id
     AND (NEW.status <> 'confirmed' OR NEW.ends_at > now() OR NEW.requested_by_user_id IS DISTINCT FROM emotion_partner_of(h.author_user_id));
  RETURN NULL;
END $$;
CREATE TRIGGER trg_family_events_heart AFTER UPDATE OF status, ends_at, requested_by_user_id ON family_events
  FOR EACH ROW EXECUTE FUNCTION appreciation_heart_event_changed();

CREATE FUNCTION appreciation_hearts_visible_to(p_viewer uuid) RETURNS SETOF appreciation_hearts
LANGUAGE sql STABLE AS $$
  SELECT h.* FROM appreciation_hearts h
   JOIN users v ON v.id = p_viewer AND v.account_id = h.account_id
   WHERE emotion_partner_of(p_viewer) IS NOT NULL
     AND (h.task_id IS NOT NULL OR h.event_id IN (SELECT id FROM family_events_visible_to(p_viewer)))
$$;
COMMENT ON FUNCTION appreciation_hearts_visible_to(uuid) IS $$Cœurs visibles d'un profil : ceux de sa famille s'il est l'un des deux parents ; pour un RDV, selon la visibilité du RDV (D26). Aucun pour un invité secondaire. [US-141 RF3, RF7]$$;

-- ---------------------------------------------------------------------
-- Envies à deux (US-147 à US-151) : titre et description chiffrés par l'application (E-14), horizon facultatif, sans date, assignation, pièce
-- jointe ni montant ; 50 au plus par famille ; pas de purge automatique. « Retirer » pose removed_at (l'envie disparaît de la carte aussitôt) ;
-- « Annuler » le remet à vide pendant 10 secondes ; le planificateur supprime ensuite définitivement l'envie (purge_removed_wishes).
-- ---------------------------------------------------------------------
CREATE TABLE couple_wishes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Titre (60 caractères) et description (200 caractères) chiffrés par l'application : la base borne seulement la taille du chiffré
  title               bytea NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 500),
  description         bytea CHECK (description IS NULL OR octet_length(description) BETWEEN 1 AND 1200),
  -- Liste floue facultative (E-24) : bientôt, cette année, un jour
  horizon             text CHECK (horizon IN ('soon', 'this_year', 'someday')),
  created_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Retirée le : l'envie n'est plus affichée ni comptée ; supprimée définitivement par le planificateur peu après
  removed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_couple_wishes_account ON couple_wishes (account_id) WHERE removed_at IS NULL;
CREATE INDEX idx_couple_wishes_created_by ON couple_wishes (created_by_user_id);
CREATE INDEX idx_couple_wishes_removed ON couple_wishes (removed_at) WHERE removed_at IS NOT NULL;
COMMENT ON TABLE couple_wishes IS $$Envie partagée par le couple de la famille (« Nos envies ») : titre et description chiffrés, horizon facultatif, auteur, date. Aucune date cible, assignation, pièce jointe ni montant. 50 au plus par famille (réglage wish_max_per_family), lues et écrites par l'utilisateur principal et l'invité 1 seulement, jamais par l'agent ni dans le carnet de bord. Pas de purge automatique : suppression manuelle définitive (retrait, puis purge après les 10 secondes d'annulation) ; supprimées au retrait de l'invité 1. [US-147 à US-151, E-08, E-14, E-20]$$;
COMMENT ON COLUMN couple_wishes.removed_at IS $$Retirée le : posée par « Retirer », remise à vide par « Annuler » (10 secondes) ; une envie retirée n'est plus affichée ni comptée dans les 50, et purge_removed_wishes() la supprime définitivement. [US-150 RF2]$$;
COMMENT ON COLUMN couple_wishes.horizon IS $$Horizon flou facultatif : soon (« Bientôt »), this_year (« Cette année »), someday (« Un jour ») ; ne rien choisir suffit. [US-148 RF2, E-24]$$;

CREATE FUNCTION couple_wish_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max integer; v_n integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT emotion_couple_exists(NEW.account_id) THEN
      RAISE EXCEPTION 'Les envies sont réservées au couple : un invité 1 actif est nécessaire' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.created_by_user_id IS NULL OR emotion_partner_of(NEW.created_by_user_id) IS NULL
       OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by_user_id AND account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'Une envie est ajoutée par l''un des deux parents du couple' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Une envie ne change ni de famille ni de date de création' USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
  END IF;
  -- Plafond de la famille : les envies retirées ne comptent pas ; l'annulation d'un retrait compte comme un ajout
  IF NEW.removed_at IS NULL AND (TG_OP = 'INSERT' OR OLD.removed_at IS NOT NULL) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('couple_wishes:' || NEW.account_id::text, 0));
    SELECT value_text::integer INTO v_max FROM platform_settings WHERE setting_key = 'wish_max_per_family';
    SELECT count(*) INTO v_n FROM couple_wishes WHERE account_id = NEW.account_id AND removed_at IS NULL AND id <> NEW.id;
    IF v_n >= COALESCE(v_max, 50) THEN
      RAISE EXCEPTION 'Une famille a % envies au plus', COALESCE(v_max, 50) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_couple_wishes_before_write BEFORE INSERT OR UPDATE ON couple_wishes
  FOR EACH ROW EXECUTE FUNCTION couple_wish_before_write();

CREATE FUNCTION couple_wishes_visible_to(p_viewer uuid) RETURNS SETOF couple_wishes
LANGUAGE sql STABLE AS $$
  SELECT w.* FROM couple_wishes w
   JOIN users v ON v.id = p_viewer AND v.account_id = w.account_id
   WHERE emotion_partner_of(p_viewer) IS NOT NULL AND w.removed_at IS NULL
$$;
COMMENT ON FUNCTION couple_wishes_visible_to(uuid) IS $$Envies visibles d'un profil : celles de sa famille s'il est l'un des deux parents, hors envies retirées ; aucune pour un invité secondaire. [US-147 RF1, RT2]$$;

-- Notification « [Prénom] a ajouté une envie à deux » (US-149) : une ligne par envie et par destinataire (sans le titre)
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT fk_scheduled_notifications_wish FOREIGN KEY (wish_id) REFERENCES couple_wishes (id) ON DELETE CASCADE;
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT ck_scheduled_notifications_wish CHECK ((kind = 'wish_added') = (wish_id IS NOT NULL));
CREATE UNIQUE INDEX ux_scheduled_notifications_wish ON scheduled_notifications (wish_id, recipient_user_id) WHERE wish_id IS NOT NULL;
COMMENT ON COLUMN scheduled_notifications.wish_id IS $$Envie dont l'ajout est annoncé à l'autre parent (type wish_added) ; la notification ne cite pas le titre. Notification sur le téléphone, e-mail seulement à défaut (D63), pas d'envoi la nuit. [US-149]$$;

-- ---------------------------------------------------------------------
-- Quand le couple se défait (retrait ou rétrogradation de l'invité 1) : cœurs, mots, bilans et envies de la famille sont supprimés (E-15, E-20, E-21).
-- SECURITY DEFINER : la sécurité par ligne des mots et des envies ne doit pas laisser de reste selon le rôle qui retire l'invité.
-- ---------------------------------------------------------------------
CREATE FUNCTION emotion_couple_dissolved() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM appreciation_hearts WHERE account_id = OLD.account_id;
  DELETE FROM weekly_reviews WHERE account_id = OLD.account_id;
  DELETE FROM partner_notes WHERE account_id = OLD.account_id;
  DELETE FROM couple_wishes WHERE account_id = OLD.account_id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_users_couple_dissolved AFTER UPDATE OF status, role, guest_rank ON users
  FOR EACH ROW WHEN (OLD.role = 'guest' AND OLD.guest_rank = 'core' AND OLD.status IN ('active', 'grace_period')
                     AND NOT (NEW.role = 'guest' AND NEW.guest_rank = 'core' AND NEW.status IN ('active', 'grace_period')))
  EXECUTE FUNCTION emotion_couple_dissolved();
CREATE TRIGGER trg_users_couple_dissolved_delete AFTER DELETE ON users
  FOR EACH ROW WHEN (OLD.role = 'guest' AND OLD.guest_rank = 'core' AND OLD.status IN ('active', 'grace_period'))
  EXECUTE FUNCTION emotion_couple_dissolved();
COMMENT ON FUNCTION emotion_couple_dissolved() IS $$Supprime les cœurs, les bilans, les mots et les envies d'une famille quand son invité 1 la quitte (retrait, rétrogradation ou suppression) : sans couple, rien de « Émotions » n'existe ; un nouveau partenaire arrive sur une carte vide. Exécutée avec les droits du propriétaire. [E-15, E-20, E-21]$$;

-- ---------------------------------------------------------------------
-- Purges : bilans de plus de 4 semaines (avec les mots qui leur sont rattachés) et mots jamais lus de plus de 4 semaines (E-22) ; envies retirées
-- ---------------------------------------------------------------------
-- Aucun historique (E-22) : chaque bilan, ouvert ou non, est supprimé 4 semaines après son envoi (réglage weekly_digest_retention_weeks, comme le point de
-- la semaine) ; la date de référence est celle de sa préparation par le planificateur (generated_at), juste avant l'envoi. Un mot lu part avec son bilan ;
-- un mot jamais lu est supprimé 4 semaines après son écriture. À planifier chaque jour.
CREATE FUNCTION purge_expired_emotion_data() RETURNS bigint LANGUAGE plpgsql AS $$
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

CREATE FUNCTION purge_removed_wishes() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM couple_wishes WHERE removed_at IS NOT NULL AND removed_at <= now() - interval '10 seconds';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION purge_removed_wishes() IS $$Supprime définitivement les envies retirées depuis plus de 10 secondes (le délai du bouton « Annuler »). À planifier avec le planificateur existant (toutes les 5 minutes) : tant qu'elle n'a pas passé, l'envie retirée reste en base mais n'est plus affichée ni comptée. [US-150 RF2]$$;

-- ---------------------------------------------------------------------
-- Sécurité par ligne des mots et des envies, comme les données privées des Sorties (activée, non forcée ; variable de session app.user_id)
-- ---------------------------------------------------------------------
ALTER TABLE partner_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_notes_parties ON partner_notes
  USING (author_user_id = (SELECT app_current_user_id())
         OR (recipient_user_id = (SELECT app_current_user_id()) AND weekly_review_id IS NOT NULL))
  WITH CHECK (author_user_id = (SELECT app_current_user_id()));
ALTER TABLE couple_wishes ENABLE ROW LEVEL SECURITY;
CREATE POLICY couple_wishes_couple ON couple_wishes
  USING (emotion_partner_of((SELECT app_current_user_id())) IS NOT NULL
         AND account_id = (SELECT account_id FROM users WHERE id = (SELECT app_current_user_id())))
  WITH CHECK (emotion_partner_of((SELECT app_current_user_id())) IS NOT NULL
         AND account_id = (SELECT account_id FROM users WHERE id = (SELECT app_current_user_id())));

-- Réglages de la console (US-65) : nombre maximal d'envies, seuils de l'indicateur de charge (calculé par l'application, E-16)
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('wish_max_per_family',     'integer', '50', 1, 500, $$Nombre maximal d'envies « Nos envies » par famille ; au-delà, le message « Vous avez beaucoup d'envies ! » (US-148 RF5, RT1)$$),
  ('workload_busy_min',       'integer', '2',  1, 50,  $$Nombre d'éléments d'un parent un jour donné à partir duquel la journée est « Chargé » (par défaut 2 ; 0 à 1 = « Calme »). Calculé par l'application, rien n'est gardé (US-145 RT1, E-16)$$),
  ('workload_very_busy_min',  'integer', '4',  2, 50,  $$Nombre d'éléments d'un parent un jour donné à partir duquel la journée est « Très chargé » (par défaut 4). Calculé par l'application, rien n'est gardé (US-145 RT1, E-16)$$);

-- =====================================================================
-- COURSES ET REPAS (lot 14, US-152 à US-175, décisions CR-01 à CR-34) : agent natif de préparation des menus et des courses
--
-- Deux familles de données.
--  * COMMUN (console, US-164 à US-175) : cuisines, catégories, étiquettes, plats et leurs ingrédients, rayons, produits, références par enseigne, critères
--    d'additifs, saisons, semaines types de batch cooking et leurs correspondances, versions allégées, produits à référencer, base commune des prix.
--    La base commune des prix est ANONYME : aucune colonne ne désigne un foyer, un profil ou un jour (CR-17) ; une seule porte d'écriture, share_grocery_price().
--  * FOYER (account_id, supprimé avec le compte) : réglages, enseignes, cuisines préférées, allergies et régimes CHIFFRÉS, plats personnels, menus validés,
--    liste de courses, tickets et lignes (aucune photo, CR-05). Le couple (utilisateur principal et invité 1) a tout ; un invité secondaire consulte la liste
--    et y ajoute un produit, rien d'autre (CR-10). Sécurité par ligne comme pour les Émotions (activée, non forcée ; variable de session app.user_id).
-- Le choix du menu, les prix, les scénarios d'achat et le budget sont CALCULÉS par l'application (CR-13) : la base garde les données, les bornes et les règles
-- qui ne doivent jamais être contournées (accès, anonymat, consentement, unicité, purges). Le menu se compose depuis CR-42 en conversation libre avec l'IA, qui reçoit
-- les régimes et les allergies du foyer sans nom ni prénom (CR-43, accord du DPO à obtenir avant la production) : aucune vue ni fonction de la base ne les lit pour l'agent, c'est
-- l'application qui les déchiffre et les envoie. Ils n'existent qu'en bytea chiffré, dans grocery_household_dietary.
-- =====================================================================

-- Clé normalisée d'un texte (minuscules, espaces simples) : le calcul des accents, tirets et pluriels est celui de l'application (CR-25) ; la base garde la clé
-- et son unicité
CREATE FUNCTION grocery_norm(p_text text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(regexp_replace(p_text, '\s+', ' ', 'g')))
$$;
COMMENT ON FUNCTION grocery_norm(text) IS $$Clé normalisée d'un texte : minuscules, espaces de début et de fin retirés, espaces multiples réduits à un. Sert de clé d'unicité aux produits, enseignes, villes et références ; la normalisation fine (accents, pluriels) est celle de l'application. [CR-25]$$;

-- Réglage entier de la console, avec sa valeur par défaut si la ligne manque
CREATE FUNCTION grocery_setting_int(p_key text, p_default integer) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT value_text::integer FROM platform_settings WHERE setting_key = p_key), p_default)
$$;
COMMENT ON FUNCTION grocery_setting_int(text, integer) IS $$Valeur entière d'un réglage de la console (platform_settings), ou la valeur par défaut donnée si le réglage n'existe pas. Sert aux règles de Courses et repas. [US-153, US-175]$$;

-- Droit d'un profil sur l'agent : « couple » = utilisateur principal et invité 1 (tout) ; « list » = invité secondaire (liste de courses seulement) ; NULL sinon
CREATE FUNCTION grocery_access(p_user uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN u.role = 'primary_user' OR (u.role = 'guest' AND u.guest_rank = 'core') THEN 'couple'
              WHEN u.role = 'guest' AND u.guest_rank = 'secondary' THEN 'list' END
    FROM users u
   WHERE u.id = p_user AND u.status IN ('active', 'grace_period')
$$;
COMMENT ON FUNCTION grocery_access(uuid) IS $$Droit d'un profil sur l'agent Courses et repas : couple (utilisateur principal et invité 1 : tout), list (invité secondaire : consulter la liste et y ajouter un produit), NULL (administrateur, profil retiré ou inconnu). [US-155 RF5, CR-10]$$;

-- Famille du profil indiqué par l'application, si son droit est au moins celui demandé (sert aux règles de sécurité par ligne)
CREATE FUNCTION grocery_couple_account() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT u.account_id FROM users u WHERE u.id = app_current_user_id() AND grocery_access(u.id) = 'couple'
$$;
COMMENT ON FUNCTION grocery_couple_account() IS $$Famille du profil indiqué par l'application (app.user_id) s'il fait partie du couple ; NULL sinon. Sert aux règles de sécurité par ligne des données du foyer. [CR-10]$$;
CREATE FUNCTION grocery_member_account() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT u.account_id FROM users u WHERE u.id = app_current_user_id() AND grocery_access(u.id) IS NOT NULL
$$;
COMMENT ON FUNCTION grocery_member_account() IS $$Famille du profil indiqué par l'application (app.user_id) s'il est du couple ou invité secondaire ; NULL sinon. Sert aux règles de sécurité par ligne de la liste de courses. [CR-10]$$;

-- Ancienneté d'un prix (CR-20) : fresh = moins de grocery_price_fresh_months (6) ; aging = moins de grocery_price_max_months (12) ; NULL = plus d'affichage
CREATE FUNCTION grocery_price_age(p_date date) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_date >= current_date - make_interval(months => grocery_setting_int('grocery_price_fresh_months', 6)) THEN 'fresh'
              WHEN p_date >= current_date - make_interval(months => grocery_setting_int('grocery_price_max_months', 12)) THEN 'aging' END
$$;
COMMENT ON FUNCTION grocery_price_age(date) IS $$Ancienneté d'un prix à partir de sa date : fresh (« < 6 mois »), aging (« < 12 mois »), NULL au-delà de 12 mois (le prix n'est plus affiché). Les deux durées sont des réglages de la console. [US-166 RF3, CR-20]$$;

-- Statut d'une correspondance entre un plat de planning et le catalogue (US-171 RF1) : sûr (identifiant renseigné ou 80 % et plus), à confirmer (40 % à
-- moins de 80 %), absent (moins de 40 %, bloque la semaine). Les seuils sont des réglages de la console.
CREATE FUNCTION meal_match_status(p_pct smallint, p_dish_id bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_dish_id IS NOT NULL OR p_pct >= grocery_setting_int('meal_match_sure_pct', 80) THEN 'sure'
              WHEN p_pct >= grocery_setting_int('meal_match_check_pct', 40) THEN 'to_confirm'
              ELSE 'absent' END
$$;
COMMENT ON FUNCTION meal_match_status(smallint, bigint) IS $$Statut de la correspondance d'un plat de planning : sure (plat du catalogue identifié, ou pourcentage au moins égal au seuil « sûr », 80 par défaut), to_confirm (au moins le seuil « à confirmer », 40 par défaut), absent (en dessous : la semaine est bloquée). [US-171 RF1]$$;

-- ---------------------------------------------------------------------
-- Cuisines, catégories, étiquettes et rayons (US-165, US-169, CR-30) : des listes de la console, masquées plutôt que supprimées quand elles servent
-- ---------------------------------------------------------------------
CREATE TABLE meal_cuisines (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        varchar(60) NOT NULL CHECK (btrim(name) <> ''),
  sort_order  smallint NOT NULL DEFAULT 100,
  is_hidden   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_meal_cuisines_name ON meal_cuisines (grocery_norm(name));
COMMENT ON TABLE meal_cuisines IS $$Cuisines du catalogue (Afro, Français, Italien…), gérées dans la console : ordre d'affichage, masquage. Une cuisine utilisée par un plat ne se supprime pas, elle se masque. Une nouvelle cuisine est aussitôt choisissable dans les réglages des foyers. [US-165 RF1, RF2]$$;

CREATE TABLE meal_dish_categories (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        varchar(60) NOT NULL CHECK (btrim(name) <> ''),
  sort_order  smallint NOT NULL DEFAULT 100,
  is_hidden   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_meal_dish_categories_name ON meal_dish_categories (grocery_norm(name));
COMMENT ON TABLE meal_dish_categories IS $$Catégories des plats (salades, soupes, viandes, végétarien…), gérées dans la console. Une catégorie utilisée ne se supprime pas, elle se masque : les plats sont classés par des données, pas devinés à partir de leur nom. [US-165 RF1, RF2]$$;

CREATE TABLE meal_dish_tags (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        meal_tag_kind NOT NULL,
  name        varchar(80) NOT NULL CHECK (btrim(name) <> ''),
  sort_order  smallint NOT NULL DEFAULT 100,
  is_hidden   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_meal_dish_tags_name ON meal_dish_tags (kind, grocery_norm(name));
COMMENT ON TABLE meal_dish_tags IS $$Étiquettes des plats, gérées dans la console : régimes (« végétarien », « sans gluten »), viandes (« viande : poulet ») et allergènes (« contient du gluten »). Le filtrage des régimes et des allergies d'un foyer s'appuie sur elles, non sur des mots-clés codés en dur. Une étiquette utilisée ne se supprime pas, elle se masque. [US-164 RF1, CR-30]$$;
COMMENT ON COLUMN meal_dish_tags.kind IS $$diet = régime que le plat respecte ; meat = viande ou poisson que le plat contient ; allergen = allergène que le plat contient. [CR-30]$$;

CREATE TABLE grocery_aisles (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        varchar(60) NOT NULL CHECK (btrim(name) <> ''),
  sort_order  smallint NOT NULL DEFAULT 100,
  is_hidden   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_grocery_aisles_name ON grocery_aisles (grocery_norm(name));
COMMENT ON TABLE grocery_aisles IS $$Rayons de magasin, communs à tous les foyers : tickets, liste de courses et budget sont rangés de la même façon. Un rayon utilisé ne se supprime pas : il se renomme ou se fusionne avec un autre (merge_grocery_aisles). [US-169]$$;
INSERT INTO grocery_aisles (name, sort_order) VALUES
  ('Féculents', 1), ('Fruits et légumes', 2), ('Crémerie', 3), ('Épicerie du monde', 4), ('Épices et aromates', 5), ('Huiles et condiments', 6),
  ('Légumineuses', 7), ('Charcuterie', 8), ('Conserves et surgelés', 9), ('Épicerie sucrée', 10), ('Boucherie', 11), ('Poissonnerie', 12),
  ('Volaille', 13), ('Sauces tomate', 14), ('Boissons', 15), ('Entretien', 16), ('Soins du corps', 17), ('Petit-déjeuner', 18), ('Autres', 19);

-- ---------------------------------------------------------------------
-- Produits, références par enseigne, critères d'additifs et saisons (US-166 à US-168)
-- ---------------------------------------------------------------------
CREATE TABLE grocery_products (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        varchar(120) NOT NULL CHECK (btrim(name) <> ''),
  -- Nom normalisé par l'application : la base garde la clé et son unicité (CR-25)
  name_key    text NOT NULL UNIQUE CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  aisle_id    integer NOT NULL REFERENCES grocery_aisles (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_grocery_products_aisle_id ON grocery_products (aisle_id);
COMMENT ON TABLE grocery_products IS $$Produit du catalogue commun (lait, riz basmati…) : nom, clé normalisée unique, rayon. Les ingrédients des plats, les références par enseigne, les prix partagés et le calendrier de saison s'y rattachent. [US-166 RF1]$$;
COMMENT ON COLUMN grocery_products.name_key IS $$Nom normalisé du produit (minuscules, espaces simples) : clé d'unicité, calculée par l'application. Un produit sans ligne ici est « inconnu » (produits à référencer). [CR-25, US-173 RF1]$$;

CREATE TABLE grocery_product_references (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id      bigint NOT NULL REFERENCES grocery_products (id) ON DELETE CASCADE,
  -- Enseigne : texte normalisé, pas une liste de la console (CR-25)
  store_chain     varchar(80) NOT NULL CHECK (store_chain <> '' AND store_chain = grocery_norm(store_chain)),
  reference_name  varchar(160) NOT NULL CHECK (btrim(reference_name) <> ''),
  -- Format du conditionnement (« 1 kg », « sachet de 250 g »), facultatif, tel que donné par le catalogue d'origine (colonne « Format » de l'import, US-166 RF2)
  package_format  varchar(80) CHECK (package_format IS NULL OR btrim(package_format) <> ''),
  -- Quantité normalisée du format, en kg ou en litres (« 500 g » = 0,5 kg), déduite de package_format ou fournie à l'import (elle prime) ; vide quand le format n'est pas compris (CR-39)
  package_amount  numeric(10,3) CHECK (package_amount > 0),
  package_unit    varchar(2) CHECK (package_unit IN ('kg', 'l')),
  -- Le prix est exprimé par article (défaut) ou par kg / par litre (produit vendu au poids ou en vrac, CR-39, CR-40)
  price_unit      varchar(4) NOT NULL DEFAULT 'unit' CHECK (price_unit IN ('unit', 'kg', 'l')),
  -- Prix et date facultatifs, les deux ou aucun : une référence peut exister sans prix connu (« N/A »), rien n'est jamais inventé (US-157 RF8, CR-36)
  unit_price      numeric(8,2) CHECK (unit_price > 0),
  price_date      date,
  -- Additifs de la référence (codes ou noms normalisés) : un critère actif qui y correspond rend la référence non conforme, quel que soit son statut
  additives       text[] NOT NULL DEFAULT '{}',
  -- Statut déclaré par le catalogue d'origine (CR-37) ; la conformité finale est calculée par v_grocery_product_references
  compliance_status grocery_reference_status NOT NULL DEFAULT 'compliant',
  -- Résumé de composition en texte libre, facultatif
  composition_text text CHECK (composition_text IS NULL OR length(composition_text) <= 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, store_chain, reference_name),
  CONSTRAINT ck_grocery_product_references_price CHECK ((unit_price IS NULL) = (price_date IS NULL)),
  CONSTRAINT ck_grocery_product_references_package CHECK ((package_amount IS NULL) = (package_unit IS NULL))
);
COMMENT ON TABLE grocery_product_references IS $$Référence d'un produit dans une enseigne : nom, prix unitaire (paquet, boîte) et date du prix facultatifs (les deux ou aucun : sans prix connu, « N/A »), additifs contenus, statut de conformité déclaré, résumé de composition. Le prix perd son affichage après 12 mois. La conformité finale se calcule (v_grocery_product_references), elle n'est pas stockée : une modification des critères la recalcule d'elle-même. [US-157 RF8, US-166 RF1, RF3, US-167 RF2, CR-36, CR-37]$$;
COMMENT ON COLUMN grocery_product_references.package_format IS $$Format du conditionnement de la référence (« 1 kg », « sachet de 250 g »), 80 caractères au plus, facultatif ; colonne « format » du fichier d'import des références. Visible de tous les profils du foyer, sans prix. [US-166 RF2, US-157 RF7]$$;
COMMENT ON COLUMN grocery_product_references.package_amount IS $$Quantité du format en kilogrammes ou en litres (« 500 g » = 0,5 kg, « 75 cl » = 0,75 l, « 6 x 33 cl » = 1,98 l), vide quand le format n'est pas compris (« 6 œufs », « la pièce »). Déduite de package_format à l'écriture (grocery_parse_package) ; si l'import la fournit avec package_unit, elle prime. Aucun poids moyen par pièce n'est jamais supposé. [CR-39]$$;
COMMENT ON COLUMN grocery_product_references.package_unit IS $$Unité de package_amount : kg ou l (les grammes et les centilitres sont convertis). Vide en même temps que la quantité. [CR-39]$$;
COMMENT ON COLUMN grocery_product_references.price_unit IS $$Unité dans laquelle unit_price est exprimé : unit = par article (défaut, un paquet, une boîte), kg ou l = par kilo ou par litre (produit vendu au poids ou en vrac). Un article au kilo n'entre pas dans le total estimé de la liste. [CR-39, CR-40]$$;
COMMENT ON COLUMN grocery_product_references.unit_price IS $$Prix unitaire de la référence ; vide = prix inconnu (« N/A », jamais un prix inventé). Vide en même temps que la date du prix. [US-157 RF8, CR-36]$$;
COMMENT ON COLUMN grocery_product_references.compliance_status IS $$Statut du catalogue d'origine : compliant = conforme, not_applicable = sans objet (produit frais), to_check = à vérifier (ingrédients non publiés : proposée avec « Composition à vérifier sur l'étiquette »), none_found = aucun conforme trouvé (jamais proposée, listée dans « Ingrédients exclus des références proposées »). Une liste d'additifs qui correspond à un critère actif rend la référence non conforme quel que soit ce statut. [US-166, US-167, CR-37]$$;
COMMENT ON COLUMN grocery_product_references.composition_text IS $$Résumé de la composition en texte libre (2 000 caractères au plus), tel que donné par le catalogue d'origine ; facultatif. [CR-37]$$;
COMMENT ON COLUMN grocery_product_references.additives IS $$Additifs de la référence (codes comme E250 ou noms), normalisés par l'application ; comparés aux critères actifs de grocery_additive_criteria$$;

-- Lecture d'un format de conditionnement (CR-39) : « 1 kg », « 500 g », « 1,5 l », « 75 cl », « sachet de 250 g », « 6 x 33 cl ». Rend une quantité en kg ou en litres,
-- ou deux valeurs vides quand le format n'est pas compris (« 6 œufs », « 1 pièce », « barquette ») : rien n'est deviné, aucun poids moyen par pièce.
CREATE FUNCTION grocery_parse_package(p_format text) RETURNS TABLE (amount numeric, unit text) LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text; m text[]; v_amount numeric;
BEGIN
  v := replace(replace(lower(btrim(COALESCE(p_format, ''))), ',', '.'), '×', 'x');
  m := regexp_match(v, '^(?:[a-zàâäçéèêëîïôöùûüÿœ''’ -]+ de\s+)?(?:(\d{1,4})\s*x\s*)?(\d{1,6}(?:\.\d{1,3})?)\s*(kg|gr|g|cl|ml|l)\.?$');
  IF m IS NULL THEN
    RETURN QUERY SELECT NULL::numeric, NULL::text;
    RETURN;
  END IF;
  v_amount := round(COALESCE(m[1]::numeric, 1) * m[2]::numeric * CASE m[3] WHEN 'g' THEN 0.001 WHEN 'gr' THEN 0.001 WHEN 'ml' THEN 0.001 WHEN 'cl' THEN 0.01 ELSE 1 END, 3);
  IF v_amount <= 0 OR v_amount >= 10000000 THEN
    RETURN QUERY SELECT NULL::numeric, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT v_amount, CASE WHEN m[3] IN ('kg', 'g', 'gr') THEN 'kg' ELSE 'l' END;
END $$;
COMMENT ON FUNCTION grocery_parse_package(text) IS $$Lit un format de conditionnement et rend sa quantité en kg ou en litres : « 1 kg », « 500 g », « 1,5 l », « 75 cl », « sachet de 250 g », « 6 x 33 cl » (= 1,98 l). Rend des valeurs vides quand le format n'est pas compris (« 6 œufs », « 1 pièce », « barquette ») : rien n'est deviné, aucun poids moyen par pièce. [CR-39]$$;

-- Quantité normalisée d'une référence : déduite du format quand elle n'est pas fournie ; une valeur fournie (l'import) prime et n'est pas écrasée par un changement de format
CREATE FUNCTION grocery_product_reference_package_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; o record;
BEGIN
  SELECT * INTO p FROM grocery_parse_package(NEW.package_format);
  IF TG_OP = 'INSERT' THEN
    IF NEW.package_amount IS NULL AND NEW.package_unit IS NULL THEN
      NEW.package_amount := p.amount; NEW.package_unit := p.unit;
    END IF;
  ELSIF NEW.package_format IS DISTINCT FROM OLD.package_format
        AND NEW.package_amount IS NOT DISTINCT FROM OLD.package_amount AND NEW.package_unit IS NOT DISTINCT FROM OLD.package_unit THEN
    SELECT * INTO o FROM grocery_parse_package(OLD.package_format);
    IF OLD.package_amount IS NOT DISTINCT FROM o.amount AND OLD.package_unit IS NOT DISTINCT FROM o.unit THEN
      NEW.package_amount := p.amount; NEW.package_unit := p.unit;     -- les valeurs étaient déduites : elles suivent le nouveau format
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_grocery_product_references_package BEFORE INSERT OR UPDATE ON grocery_product_references
  FOR EACH ROW EXECUTE FUNCTION grocery_product_reference_package_before_write();
COMMENT ON FUNCTION grocery_product_reference_package_before_write() IS $$Remplit package_amount et package_unit d'après package_format quand ils ne sont pas fournis. Un changement de format seul refait la déduction si les valeurs actuelles étaient celles du format précédent ; des valeurs fournies par l'import (différentes de la déduction) ne sont pas écrasées. [CR-39]$$;

CREATE TABLE grocery_additive_criteria (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label       varchar(80) NOT NULL CHECK (btrim(label) <> ''),
  reason      varchar(200) NOT NULL CHECK (btrim(reason) <> ''),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_grocery_additive_criteria_label ON grocery_additive_criteria (grocery_norm(label));
COMMENT ON TABLE grocery_additive_criteria IS $$Additifs à éviter (code ou nom, raison courte). Affichés aux foyers dans « Critères additifs appliqués » ; une référence qui en contient un actif n'est pas proposée et figure dans « Ingrédients exclus des références proposées ». [US-167 RF1, RF2]$$;

CREATE TABLE grocery_product_seasons (
  product_id  bigint NOT NULL REFERENCES grocery_products (id) ON DELETE CASCADE,
  season_month  smallint NOT NULL CHECK (season_month BETWEEN 1 AND 12),
  PRIMARY KEY (product_id, season_month)
);
COMMENT ON TABLE grocery_product_seasons IS $$Mois de saison d'un fruit ou d'un légume. Avec l'objectif « saison », les plats dont les ingrédients sont de saison passent devant. [US-168 RF1, RF2]$$;

-- ---------------------------------------------------------------------
-- Catalogue des plats (US-164) : plats, catégories, étiquettes, ingrédients
-- ---------------------------------------------------------------------
CREATE TABLE meal_dishes (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Identifiant du classeur d'origine (A5, F12…) : sert aux plannings et aux versions allégées
  code                  varchar(12) NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9]{1,12}$'),
  name                  varchar(120) NOT NULL CHECK (btrim(name) <> ''),
  cuisine_id            integer NOT NULL REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  recipe                text,
  duration_minutes      smallint NOT NULL CHECK (duration_minutes BETWEEN 1 AND 600),
  batch_active_minutes  smallint CHECK (batch_active_minutes BETWEEN 0 AND 600),
  -- Plat express : 15 minutes au plus (US-156 RF4)
  is_express            boolean GENERATED ALWAYS AS (duration_minutes <= 15) STORED,
  -- Retiré : n'est plus proposé, reste dans l'historique des foyers (menus validés)
  retired_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_meal_dishes_cuisine_id ON meal_dishes (cuisine_id);
COMMENT ON TABLE meal_dishes IS $$Plat du catalogue commun (60 au départ, chargés depuis le classeur actuel) : identifiant, nom, cuisine, recette, durée, durée active en batch. Les catégories, étiquettes (régimes, viandes, allergènes) et ingrédients sont dans des tables de liens. Un plat retiré n'est plus proposé mais reste dans les menus déjà validés. Les plats personnels d'un foyer sont à part (meal_household_dishes). [US-164 RF1, RF3, CR-04]$$;
COMMENT ON COLUMN meal_dishes.is_express IS $$Calculé : durée de 15 minutes au plus (plat express). La console en donne le nombre. [US-156 RF4, US-164 RF4]$$;
COMMENT ON COLUMN meal_dishes.retired_at IS $$Date de retrait : le plat n'est plus proposé aux foyers ; les menus déjà validés le gardent (nom conservé). NULL = proposé. [US-164 RF3, CR-25]$$;

CREATE TABLE meal_dish_category_links (
  dish_id      bigint NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  category_id  integer NOT NULL REFERENCES meal_dish_categories (id) ON DELETE RESTRICT,
  PRIMARY KEY (dish_id, category_id)
);
CREATE INDEX idx_meal_dish_category_links_category_id ON meal_dish_category_links (category_id);
COMMENT ON TABLE meal_dish_category_links IS $$Catégories d'un plat du catalogue (un plat peut en avoir plusieurs). [US-164 RF1, US-165]$$;

CREATE TABLE meal_dish_tag_links (
  dish_id  bigint NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  tag_id   integer NOT NULL REFERENCES meal_dish_tags (id) ON DELETE RESTRICT,
  PRIMARY KEY (dish_id, tag_id)
);
CREATE INDEX idx_meal_dish_tag_links_tag_id ON meal_dish_tag_links (tag_id);
COMMENT ON TABLE meal_dish_tag_links IS $$Étiquettes d'un plat du catalogue : régimes respectés, viandes et allergènes contenus. Le filtrage des régimes et des allergies du foyer s'appuie dessus. [US-164 RF1, CR-30]$$;

CREATE TABLE meal_dish_ingredients (
  dish_id     bigint NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  product_id  bigint NOT NULL REFERENCES grocery_products (id) ON DELETE RESTRICT,
  position    smallint NOT NULL DEFAULT 1 CHECK (position >= 1),
  PRIMARY KEY (dish_id, product_id)
);
CREATE INDEX idx_meal_dish_ingredients_product_id ON meal_dish_ingredients (product_id);
COMMENT ON TABLE meal_dish_ingredients IS $$Ingrédients d'un plat du catalogue, en produits du catalogue. Aucune quantité par ingrédient : la recette reste un texte. [US-164 RF1, CR-25]$$;

-- ---------------------------------------------------------------------
-- Semaines types de batch cooking et correspondances avec le catalogue (US-170, US-171)
-- ---------------------------------------------------------------------
CREATE TABLE meal_batch_weeks (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                   varchar(12) NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9]{1,12}$'),
  cuisine_id             integer NOT NULL REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  theme                  varchar(120),
  -- Déroulé de la séance du dimanche
  session_text           text NOT NULL CHECK (btrim(session_text) <> ''),
  session_minutes        smallint NOT NULL CHECK (session_minutes BETWEEN 1 AND 1000),
  shared_ingredients_pct smallint CHECK (shared_ingredients_pct BETWEEN 0 AND 100),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_meal_batch_weeks_cuisine_id ON meal_batch_weeks (cuisine_id);
COMMENT ON TABLE meal_batch_weeks IS $$Semaine type de batch cooking (AS5…) : cuisine, thème facultatif, déroulé et durée de la séance du dimanche, part d'ingrédients mis en commun. Les 12 semaines actuelles sont conservées au premier import. Une semaine n'est utilisable que si aucun de ses plats n'est « absent » du catalogue (v_meal_batch_weeks). [US-170 RF1, RF3, RF4]$$;

CREATE TABLE meal_batch_week_days (
  week_id                bigint NOT NULL REFERENCES meal_batch_weeks (id) ON DELETE CASCADE,
  weekday                smallint NOT NULL CHECK (weekday BETWEEN 1 AND 5),
  -- Nom du plat tel qu'il figure dans le planning
  planning_dish_name     varchar(160) NOT NULL CHECK (btrim(planning_dish_name) <> ''),
  -- Plat du catalogue confirmé (identifiant renseigné ou correspondance confirmée par l'administrateur) : enregistré par identifiant, plus par le nom
  dish_id                bigint REFERENCES meal_dishes (id) ON DELETE RESTRICT,
  -- Plat le plus proche du catalogue, utilisé en attendant la confirmation (statut « à confirmer »)
  suggested_dish_id      bigint REFERENCES meal_dishes (id) ON DELETE RESTRICT,
  match_pct              smallint NOT NULL DEFAULT 0 CHECK (match_pct BETWEEN 0 AND 100),
  -- L'administrateur signale qu'il faut ajouter ce plat au catalogue
  needs_catalog_addition boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_id, weekday),
  CONSTRAINT ck_meal_batch_week_days_confirmed CHECK (dish_id IS NULL OR match_pct = 100)
);
CREATE INDEX idx_meal_batch_week_days_dish_id ON meal_batch_week_days (dish_id) WHERE dish_id IS NOT NULL;
CREATE INDEX idx_meal_batch_week_days_suggested_dish_id ON meal_batch_week_days (suggested_dish_id) WHERE suggested_dish_id IS NOT NULL;
COMMENT ON TABLE meal_batch_week_days IS $$Plat de chaque jour (lundi à vendredi) d'une semaine type : nom du planning, plat du catalogue confirmé, plat suggéré et pourcentage de correspondance. Le statut (sûr / à confirmer / absent) se déduit du pourcentage et des seuils de la console (meal_match_status). Une correspondance confirmée vaut 100 %. [US-170 RF1, US-171 RF1, RF5, RT1]$$;
COMMENT ON COLUMN meal_batch_week_days.match_pct IS $$Pourcentage de correspondance avec le catalogue, calculé par l'application à l'import (100 si l'identifiant du plat est renseigné ou confirmé). Le statut se déduit des seuils de la console : 80 % et plus sûr, 40 % à moins de 80 % à confirmer, en dessous absent (bloque la semaine). [US-171 RF1]$$;

-- ---------------------------------------------------------------------
-- Versions allégées (US-172) : texte et produits à retirer ou à ajouter, plat par plat
-- ---------------------------------------------------------------------
CREATE TABLE meal_light_versions (
  dish_id       bigint PRIMARY KEY REFERENCES meal_dishes (id) ON DELETE CASCADE,
  display_text  text NOT NULL CHECK (btrim(display_text) <> ''),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE meal_light_versions IS $$Version allégée d'un plat du catalogue : texte affiché aux foyers. Sans produit à retirer ni à ajouter (meal_light_version_items), il n'y a pas d'adaptation automatique de la liste : le texte reste un conseil de préparation. [US-172 RF1, RF2]$$;

CREATE TABLE meal_light_version_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dish_id     bigint NOT NULL REFERENCES meal_light_versions (dish_id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('remove', 'add')),
  -- Produit du catalogue ; vide pour un produit ajouté qui n'y est pas encore (« riz basmati complet »), noté alors dans les produits à référencer
  product_id  bigint REFERENCES grocery_products (id) ON DELETE RESTRICT,
  name_key    text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  UNIQUE (dish_id, kind, name_key),
  CONSTRAINT ck_meal_light_items_remove_known CHECK (kind = 'add' OR product_id IS NOT NULL)
);
CREATE INDEX idx_meal_light_version_items_product_id ON meal_light_version_items (product_id) WHERE product_id IS NOT NULL;
COMMENT ON TABLE meal_light_version_items IS $$Produits à retirer (du catalogue) et à ajouter (du catalogue, ou nom d'un produit pas encore référencé) pour passer un plat à sa version allégée. Un produit commun à deux plats n'est retiré que si tous les plats qui l'utilisent sont allégés (calculé par l'application). [US-172 RF1, RF4, US-157 RF5]$$;

-- ---------------------------------------------------------------------
-- Produits à référencer (US-173, US-174) : journal anonyme des produits sans référence conforme, regroupés par nom normalisé
-- ---------------------------------------------------------------------
CREATE TABLE grocery_unreferenced_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name_key          text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  kind              grocery_unreferenced_kind NOT NULL,
  source            grocery_unreferenced_source NOT NULL,
  aisle_id          integer REFERENCES grocery_aisles (id) ON DELETE SET NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  -- Renseignés seulement pour un foyer qui partage ses prix (note_grocery_unreferenced) ; jamais de prénom ni d'identifiant de foyer
  seen_city         varchar(80),
  seen_reference    varchar(160),
  seen_unit_price   numeric(8,2),
  seen_store_chain  varchar(80),
  CONSTRAINT ck_grocery_unreferenced_seen CHECK (num_nonnulls(seen_city, seen_reference, seen_unit_price, seen_store_chain) IN (0, 4))
);
CREATE INDEX idx_grocery_unreferenced_events_name ON grocery_unreferenced_events (name_key, occurred_at DESC);
CREATE INDEX idx_grocery_unreferenced_events_aisle_id ON grocery_unreferenced_events (aisle_id) WHERE aisle_id IS NOT NULL;
CREATE INDEX idx_grocery_unreferenced_events_occurred_at ON grocery_unreferenced_events (occurred_at);
COMMENT ON TABLE grocery_unreferenced_events IS $$Journal ANONYME des produits utilisés par les foyers sans référence conforme (ajoutés à la liste, issus d'un menu validé ou lus sur un ticket) : aucune colonne ne désigne un foyer ou un profil. La ville, la référence vue, le prix vu et le magasin ne sont renseignés que pour un foyer qui partage ses prix. Conservé 12 mois (réglable), purgé par purge_expired_grocery_data(). [US-173 RF1, RF3, CR-23]$$;
COMMENT ON COLUMN grocery_unreferenced_events.kind IS $$unknown = absent du catalogue ; no_reference = présent mais sans référence conforme. [US-173 RF1]$$;

CREATE TABLE grocery_unreferenced_status (
  name_key             text PRIMARY KEY CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  state                grocery_unreferenced_state NOT NULL DEFAULT 'to_reference',
  changed_at           timestamptz NOT NULL DEFAULT now(),
  changed_by_user_id   uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX idx_grocery_unreferenced_status_changed_by ON grocery_unreferenced_status (changed_by_user_id) WHERE changed_by_user_id IS NOT NULL;
COMMENT ON TABLE grocery_unreferenced_status IS $$Statut d'un produit à référencer, par nom normalisé : à référencer (défaut), référencé (sort de la liste des foyers) ou rejeté. Passé à « référencé » d'office quand une référence est importée pour le produit. [US-173 RF2, RF5, US-174 RF2]$$;

-- ---------------------------------------------------------------------
-- Base commune des prix (US-154, US-175) : ANONYME. Aucune colonne ne désigne un foyer, un profil ni un jour ; la date est la semaine (CR-17).
-- ---------------------------------------------------------------------
CREATE TABLE grocery_shared_prices (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id          bigint NOT NULL REFERENCES grocery_products (id) ON DELETE CASCADE,
  reference_name      varchar(160) NOT NULL CHECK (reference_name <> '' AND reference_name = grocery_norm(reference_name)),
  unit_price          numeric(8,2) NOT NULL CHECK (unit_price > 0),
  -- Unité du prix : par article (défaut), par kg ou par litre (ligne de ticket pesée, CR-39). Le poids pesé n'est jamais partagé, seulement le prix au kilo.
  price_unit          varchar(4) NOT NULL DEFAULT 'unit' CHECK (price_unit IN ('unit', 'kg', 'l')),
  store_chain         varchar(80) NOT NULL CHECK (store_chain <> '' AND store_chain = grocery_norm(store_chain)),
  city                varchar(80) NOT NULL CHECK (city <> '' AND city = grocery_norm(city)),
  -- Lundi de la semaine du relevé : jamais la date du jour
  week_start          date NOT NULL CHECK (date_part('isodow', week_start) = 1),
  -- Ligne retirée par l'administrateur : plus utilisée dans les comparatifs (US-175 RF3)
  removed_at          timestamptz,
  removed_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Une ligne identique n'est pas dupliquée : sa semaine est mise à jour (US-154 RT1)
  CONSTRAINT uq_grocery_shared_prices_line UNIQUE (product_id, reference_name, store_chain, city, unit_price, price_unit),
  CONSTRAINT ck_grocery_shared_prices_removed CHECK ((removed_at IS NULL) = (removed_by_user_id IS NULL) OR removed_by_user_id IS NULL)
);
CREATE INDEX idx_grocery_shared_prices_median ON grocery_shared_prices (product_id, store_chain, week_start);
CREATE INDEX idx_grocery_shared_prices_place ON grocery_shared_prices (store_chain, city);
CREATE INDEX idx_grocery_shared_prices_removed_by ON grocery_shared_prices (removed_by_user_id) WHERE removed_by_user_id IS NOT NULL;
COMMENT ON TABLE grocery_shared_prices IS $$Base commune des prix partagés par les foyers qui l'ont accepté : produit, référence, prix unitaire, enseigne, ville du magasin, semaine. ANONYME PAR CONSTRUCTION : aucune colonne foyer, profil ou jour, aucun moyen de retrouver qui a partagé. Une seule porte d'écriture, share_grocery_price() ; la lecture par un foyer passe par grocery_shared_prices_for() (réciprocité, enseignes de proximité, ville affichée dès 2 foyers). Les lignes déjà partagées restent quand le partage est désactivé. [US-154, US-175, CR-03, CR-12, CR-17]$$;
COMMENT ON COLUMN grocery_shared_prices.price_unit IS $$Unité de unit_price : unit = par article (défaut), kg ou l = par kilo ou par litre (ligne de ticket pesée). Seul le prix au kilo est partagé, jamais le poids du ticket. Les comparaisons et la médiane de contrôle ne rapprochent que des prix de même unité. [CR-39]$$;
COMMENT ON COLUMN grocery_shared_prices.week_start IS $$Lundi de la semaine du relevé (jamais le jour du ticket) ; remis à la semaine la plus récente quand une ligne identique est partagée de nouveau. [CR-17, US-154 RT1]$$;
COMMENT ON COLUMN grocery_shared_prices.removed_at IS $$Retirée par l'administrateur (prix erroné) : la ligne n'est plus utilisée dans les comparatifs ni dans la médiane de contrôle. [US-175 RF3]$$;

CREATE FUNCTION grocery_shared_price_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.reference_name IS DISTINCT FROM OLD.reference_name OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
     OR NEW.price_unit IS DISTINCT FROM OLD.price_unit OR NEW.store_chain IS DISTINCT FROM OLD.store_chain OR NEW.city IS DISTINCT FROM OLD.city OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Une ligne de la base commune des prix ne se modifie pas : seuls son retrait et sa semaine changent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.week_start < OLD.week_start THEN
    RAISE EXCEPTION 'La semaine d''une ligne de la base commune ne recule pas' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_grocery_shared_prices_before_update BEFORE UPDATE ON grocery_shared_prices
  FOR EACH ROW EXECUTE FUNCTION grocery_shared_price_before_update();

-- Compteur des foyers par ville (CR-17, CR-22) : la ville n'est montrée aux autres foyers qu'à partir de 2 foyers. Tenu par trigger depuis
-- grocery_household_city_sharing (privé) ; ne contient que la ville et un nombre.
CREATE TABLE grocery_city_sharing (
  city_key         text PRIMARY KEY CHECK (city_key <> '' AND city_key = grocery_norm(city_key)),
  household_count  integer NOT NULL CHECK (household_count >= 0)
);
COMMENT ON TABLE grocery_city_sharing IS $$Nombre de foyers qui partagent leurs prix, par ville : une ville n'est affichée aux autres foyers qu'à partir de 2 foyers (réglage grocery_city_min_households). Le foyer qui consulte compte parmi les deux, dans sa propre ville (déjà comptée ici) comme dans une ville voisine (ajouté à la lecture, CR-35) ; un foyer ne sort du compteur qu'à la suppression de son compte, pas à la désactivation du partage. Tenu par trigger, sans identifiant de foyer. [US-154 RT2, CR-17, CR-22, CR-35]$$;

-- Preuve du consentement au partage des prix (CR-24) : comme contract_consent_events et forwarding_consent_events, sans clé étrangère vers le compte,
-- elle survit à sa suppression (conservation à valider par le DPO, CR-26)
CREATE TABLE grocery_price_sharing_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        uuid NOT NULL,
  actor_user_id     uuid,
  actor_email_hash  bytea NOT NULL,
  action_type       consent_action NOT NULL,
  legal_version_id  bigint NOT NULL REFERENCES legal_document_versions (id) ON DELETE RESTRICT,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  retain_until      date
);
CREATE INDEX idx_grocery_price_sharing_events_account ON grocery_price_sharing_events (account_id, occurred_at DESC);
CREATE INDEX idx_grocery_price_sharing_events_legal_version_id ON grocery_price_sharing_events (legal_version_id);
CREATE INDEX idx_grocery_price_sharing_events_retain_until ON grocery_price_sharing_events (retain_until) WHERE retain_until IS NOT NULL;
COMMENT ON TABLE grocery_price_sharing_events IS $$Journal append-only des activations et désactivations du partage anonyme des prix (qui, quand, quelle version du texte accepté). Survit au compte, comme les consentements aux contrats ; durée de conservation à valider par le DPO. Le réglage share_prices ne change qu'après l'inscription de l'événement correspondant. [US-154 RF4bis, CR-24]$$;
COMMENT ON COLUMN grocery_price_sharing_events.account_id IS $$Identifiant du compte, SANS clé étrangère : référence conservée après suppression du compte$$;
COMMENT ON COLUMN grocery_price_sharing_events.actor_email_hash IS $$Empreinte HMAC-SHA256 de l'email de la personne qui a activé ou désactivé le partage (clé hors base) : preuve nominative sans conserver l'email$$;

INSERT INTO legal_document_versions (document_type, version_label, content, published_at) VALUES
  ('grocery_price_sharing_consent', '1.0', 'Les prix de vos tickets sont ajoutés, sans votre nom, à une base commune. En échange, vous voyez les prix relevés par les autres foyers.', now());

CREATE FUNCTION grocery_price_sharing_event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_type legal_document_type;
BEGIN
  SELECT document_type INTO v_type FROM legal_document_versions WHERE id = NEW.legal_version_id;
  IF v_type IS DISTINCT FROM 'grocery_price_sharing_consent' THEN
    RAISE EXCEPTION 'Le texte accepté n''est pas celui du partage des prix' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_grocery_price_sharing_events_before_insert BEFORE INSERT ON grocery_price_sharing_events
  FOR EACH ROW EXECUTE FUNCTION grocery_price_sharing_event_before_insert();

-- ---------------------------------------------------------------------
-- RÉGLAGES DU FOYER (US-153, US-154) : communs au couple
-- ---------------------------------------------------------------------
CREATE TABLE grocery_household_settings (
  account_id             uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  -- Une ville, jamais une adresse (US-153 RT1)
  city                   varchar(80) CHECK (city IS NULL OR (btrim(city) <> '' AND NOT looks_like_address(city))),
  household_size         smallint CHECK (household_size BETWEEN 1 AND 12),
  shopping_days          smallint[] CHECK (shopping_days IS NULL OR iso_weekdays_valid(shopping_days)),
  goal_time              boolean NOT NULL DEFAULT false,
  goal_own_dishes        boolean NOT NULL DEFAULT false,
  goal_season            boolean NOT NULL DEFAULT false,
  -- Un plat ne revient pas avant N semaines (1 à 4) ; vide = valeur par défaut de la console (2)
  repeat_weeks           smallint CHECK (repeat_weeks BETWEEN 1 AND 4),
  replacement_source     text NOT NULL DEFAULT 'own' CHECK (replacement_source IN ('own', 'cuisine')),
  replacement_cuisine_id integer REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  budget_day             smallint NOT NULL DEFAULT 1 CHECK (budget_day BETWEEN 1 AND 31),
  share_prices           boolean NOT NULL DEFAULT false,
  updated_by_user_id     uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_grocery_household_replacement CHECK ((replacement_source = 'cuisine') = (replacement_cuisine_id IS NOT NULL)),
  CONSTRAINT ck_grocery_household_share_city CHECK (NOT share_prices OR city IS NOT NULL),
  CONSTRAINT fk_grocery_household_settings_updated_by FOREIGN KEY (updated_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (updated_by_user_id)
);
CREATE INDEX idx_grocery_household_settings_cuisine ON grocery_household_settings (replacement_cuisine_id) WHERE replacement_cuisine_id IS NOT NULL;
CREATE INDEX idx_grocery_household_settings_updated_by ON grocery_household_settings (updated_by_user_id, account_id);
COMMENT ON TABLE grocery_household_settings IS $$Réglages Courses et repas du foyer, communs au couple (un invité secondaire ne les voit pas) : ville, nombre de personnes, jours de courses, objectifs cumulables (temps, mes plats, saison), répétition, source des remplacements, jour du budget, partage anonyme des prix (désactivé par défaut). Les allergies et les régimes sont à part, chiffrés (grocery_household_dietary). [US-153 RF2, RF5, US-154 RF1, CR-01, CR-10]$$;
COMMENT ON COLUMN grocery_household_settings.repeat_weeks IS $$Un plat n'est pas servi avant N semaines (1 à 4) ; vide = valeur par défaut de la console (meal_repeat_weeks_default, 2). [US-153 RF2, US-156 RF9, RT3]$$;
COMMENT ON COLUMN grocery_household_settings.share_prices IS $$Partage anonyme des prix de nos tickets avec les autres foyers (réciproque) ; désactivé par défaut. Ne passe à vrai qu'après l'inscription de la preuve de consentement, avec une ville renseignée. Le désactiver arrête les envois suivants sans retirer les lignes déjà partagées. [US-154 RF1 à RF5, CR-12, CR-24]$$;
COMMENT ON COLUMN grocery_household_settings.shopping_days IS $$Jours de courses (jours ISO, 1 = lundi), au moins un, sans doublon$$;

CREATE TABLE grocery_household_cuisines (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  cuisine_id  integer NOT NULL REFERENCES meal_cuisines (id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, cuisine_id)
);
CREATE INDEX idx_grocery_household_cuisines_cuisine_id ON grocery_household_cuisines (cuisine_id);
COMMENT ON TABLE grocery_household_cuisines IS $$Cuisines préférées du foyer, parmi celles du catalogue ; aucune ligne = toutes. [US-153 RF2]$$;

CREATE TABLE grocery_household_stores (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  store_chain  varchar(80) NOT NULL CHECK (store_chain <> '' AND store_chain = grocery_norm(store_chain)),
  store_city   varchar(80) NOT NULL CHECK (store_city <> '' AND store_city = grocery_norm(store_city)),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, store_chain, store_city)
);
COMMENT ON TABLE grocery_household_stores IS $$Enseignes de proximité gardées par le foyer, chacune avec sa ville (« Lidl — Rezé ») : proposées d'après la ville du foyer par une recherche web (seuls la ville et le type de commerce partent), gardées ou retirées par le foyer. Servent au comparatif et à la lecture des prix des autres foyers. [US-153 RF3, US-154 RF3, CR-09, CR-21]$$;

CREATE TABLE grocery_household_dietary (
  account_id          uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  -- Régimes et allergies chiffrés par l'application (étiquettes choisies et texte libre) : la base borne seulement la taille du chiffré
  diets_encrypted     bytea CHECK (diets_encrypted IS NULL OR octet_length(diets_encrypted) BETWEEN 1 AND 4000),
  allergies_encrypted bytea CHECK (allergies_encrypted IS NULL OR octet_length(allergies_encrypted) BETWEEN 1 AND 4000),
  updated_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_grocery_household_dietary_updated_by FOREIGN KEY (updated_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (updated_by_user_id)
);
CREATE INDEX idx_grocery_household_dietary_updated_by ON grocery_household_dietary (updated_by_user_id, account_id);
COMMENT ON TABLE grocery_household_dietary IS $$Régimes et allergies du foyer : donnée de santé, CHIFFRÉE par l'application, lue par l'application seule : elle les déchiffre pour filtrer les plats connus (filtrage indicatif) et, depuis CR-43, les envoie à l'IA pour composer le menu, sans nom ni prénom (accord du DPO à obtenir avant la production). Aucune vue ni fonction de la base ne les lit. Réservée au couple. [US-153 RF2, RF4, RT2, US-156 RT2, CR-16, CR-43]$$;

-- Foyers inscrits au compteur de leur ville (privé, tenu par trigger depuis les réglages). Une ligne reste quand le partage est désactivé (CR-22).
CREATE TABLE grocery_household_city_sharing (
  account_id  uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  city_key    text NOT NULL CHECK (city_key <> '' AND city_key = grocery_norm(city_key)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_grocery_household_city_sharing_city ON grocery_household_city_sharing (city_key);
COMMENT ON TABLE grocery_household_city_sharing IS $$Inscription du foyer au compteur de sa ville, posée la première fois qu'il active le partage des prix (et déplacée s'il change de ville en partageant). Conservée quand le partage est désactivé ; supprimée avec le compte, ce qui fait baisser le compteur. Sert uniquement à tenir grocery_city_sharing ; jamais lue par une vue ni exposée. [CR-17, CR-22]$$;

-- ---------------------------------------------------------------------
-- Plats personnels du foyer (US-159, CR-04) : jamais dans le catalogue commun, jamais vus d'un autre foyer
-- ---------------------------------------------------------------------
CREATE TABLE meal_household_dishes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name                 varchar(120) NOT NULL CHECK (btrim(name) <> ''),
  cuisine_id           integer NOT NULL REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  recipe               text,
  duration_minutes     smallint CHECK (duration_minutes BETWEEN 1 AND 600),
  created_by_user_id   uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_meal_household_dishes_created_by FOREIGN KEY (created_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (created_by_user_id)
);
-- Un plat personnel peut porter le nom d'un plat du catalogue (CR-25) ; deux plats du même foyer ne portent pas le même nom
CREATE UNIQUE INDEX ux_meal_household_dishes_name ON meal_household_dishes (account_id, grocery_norm(name));
CREATE INDEX idx_meal_household_dishes_cuisine_id ON meal_household_dishes (cuisine_id);
CREATE INDEX idx_meal_household_dishes_created_by ON meal_household_dishes (created_by_user_id, account_id);
COMMENT ON TABLE meal_household_dishes IS $$Plat personnel du foyer : nom, cuisine, ingrédients (au moins un), durée et recette facultatives. Propre au foyer : ni validation par l'administrateur, ni entrée dans le catalogue commun, jamais proposé à un autre foyer. Peut porter le nom d'un plat du catalogue. Modifiable et supprimable par le couple. [US-159 RF1, RF3 à RF5, CR-04, CR-25]$$;

CREATE TABLE meal_household_dish_ingredients (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_dish_id uuid NOT NULL,
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  label             varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key          text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  -- Produit du catalogue reconnu par l'application ; vide si inconnu (noté alors dans les produits à référencer)
  product_id        bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  position          smallint NOT NULL DEFAULT 1 CHECK (position >= 1),
  UNIQUE (household_dish_id, name_key),
  CONSTRAINT fk_meal_household_dish_ingredients_dish FOREIGN KEY (household_dish_id, account_id) REFERENCES meal_household_dishes (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_meal_household_dish_ingredients_account ON meal_household_dish_ingredients (account_id);
CREATE INDEX idx_meal_household_dish_ingredients_product_id ON meal_household_dish_ingredients (product_id) WHERE product_id IS NOT NULL;
COMMENT ON TABLE meal_household_dish_ingredients IS $$Ingrédients d'un plat personnel : nom saisi, clé normalisée, produit du catalogue s'il est reconnu. Aucune quantité par ingrédient. Un plat personnel a au moins un ingrédient (contrôlé à la validation de la transaction). [US-159 RF1, CR-25]$$;

CREATE TABLE meal_household_dish_tags (
  household_dish_id uuid NOT NULL,
  account_id        uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  tag_id            integer NOT NULL REFERENCES meal_dish_tags (id) ON DELETE CASCADE,
  PRIMARY KEY (household_dish_id, tag_id),
  CONSTRAINT fk_meal_household_dish_tags_dish FOREIGN KEY (household_dish_id, account_id) REFERENCES meal_household_dishes (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_meal_household_dish_tags_account ON meal_household_dish_tags (account_id);
CREATE INDEX idx_meal_household_dish_tags_tag_id ON meal_household_dish_tags (tag_id);
COMMENT ON TABLE meal_household_dish_tags IS $$Étiquettes (régimes, viandes, allergènes) d'un plat personnel, pour que le filtrage des régimes et des allergies du foyer s'applique aussi à ses plats. [US-159, CR-30]$$;

-- Un plat personnel a au moins un ingrédient : contrôle différé à la fin de la transaction (le plat et ses ingrédients s'écrivent ensemble)
CREATE FUNCTION meal_household_dish_needs_ingredient() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_dish uuid;
BEGIN
  IF TG_TABLE_NAME = 'meal_household_dishes' THEN
    v_dish := NEW.id;
  ELSE
    v_dish := OLD.household_dish_id;
  END IF;
  IF EXISTS (SELECT 1 FROM meal_household_dishes WHERE id = v_dish)
     AND NOT EXISTS (SELECT 1 FROM meal_household_dish_ingredients WHERE household_dish_id = v_dish) THEN
    RAISE EXCEPTION 'Un plat personnel a au moins un ingrédient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_meal_household_dishes_ingredient AFTER INSERT ON meal_household_dishes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_household_dish_needs_ingredient();
CREATE CONSTRAINT TRIGGER trg_meal_household_dish_ingredients_delete AFTER DELETE ON meal_household_dish_ingredients
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_household_dish_needs_ingredient();

-- ---------------------------------------------------------------------
-- Menus validés (US-156) : l'historique du foyer (12 mois), dont se servent la répétition et le choix standard ou allégé
-- ---------------------------------------------------------------------
CREATE TABLE meal_menus (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Lundi de la semaine du menu
  week_start           date NOT NULL CHECK (date_part('isodow', week_start) = 1),
  validated_at         timestamptz NOT NULL DEFAULT now(),
  validated_by_user_id uuid,
  -- Semaine type de batch cooking utilisée ; vide si MAAQ a composé le menu par ingrédients (durée estimée)
  batch_week_id        bigint REFERENCES meal_batch_weeks (id) ON DELETE SET NULL,
  session_minutes      smallint CHECK (session_minutes BETWEEN 1 AND 1000),
  session_is_estimated boolean NOT NULL DEFAULT false,
  session_over_cap     boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, week_start),
  UNIQUE (id, account_id),
  CONSTRAINT fk_meal_menus_validated_by FOREIGN KEY (validated_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (validated_by_user_id)
);
CREATE INDEX idx_meal_menus_validated_by ON meal_menus (validated_by_user_id, account_id);
CREATE INDEX idx_meal_menus_batch_week_id ON meal_menus (batch_week_id) WHERE batch_week_id IS NOT NULL;
CREATE INDEX idx_meal_menus_validated_at ON meal_menus (validated_at);
COMMENT ON TABLE meal_menus IS $$Menu validé d'un foyer pour une semaine (le menu proposé n'est pas gardé tant qu'il n'est pas validé) : semaine type utilisée, durée de la séance du dimanche, indication « estimée » ou « au-dessus du plafond ». Une validation par semaine. Conservé 12 mois (réglable), purgé par purge_expired_grocery_data(). [US-156 RF5, RF6, RF12, CR-23]$$;
COMMENT ON COLUMN meal_menus.session_is_estimated IS $$Vrai si aucune semaine type n'était adaptée : la durée est estimée (le plat le plus long, plus 40 % des autres) et signalée comme telle. [US-156 RF6]$$;

CREATE TABLE meal_menu_entries (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  menu_id            uuid NOT NULL,
  account_id         uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- pleasure = plat plaisir choisi (1 ou 2) ; dinner = dîner du lundi (1) au dimanche (7) ; express = plat express (1 à 4)
  kind               meal_entry_kind NOT NULL,
  slot               smallint NOT NULL CHECK (slot BETWEEN 1 AND 7),
  -- Nom conservé tel qu'au moment de la validation : un plat retiré ou supprimé reste lisible dans l'historique (CR-25)
  dish_name          varchar(160) NOT NULL CHECK (btrim(dish_name) <> ''),
  -- Origine du plat (CR-42) : catalog = plat du catalogue, household = plat de « Mes plats », ai = plat libre composé par l'IA (jamais dans le catalogue). Sans valeur par défaut :
  -- l'application dit toujours d'où vient le plat.
  dish_origin        text NOT NULL CHECK (dish_origin IN ('catalog', 'household', 'ai')),
  dish_id            bigint REFERENCES meal_dishes (id) ON DELETE SET NULL,
  -- Plat de « Mes plats » : le plat choisi (origine household) ou la copie faite après la validation (origines ai et catalog, CR-42, CR-45)
  household_dish_id  uuid,
  -- Contenu d'un plat libre, gardé avec le menu (CR-42) : cuisine, recette en texte, durée ; ses ingrédients sont dans meal_menu_entry_ingredients
  cuisine_id         integer REFERENCES meal_cuisines (id) ON DELETE RESTRICT,
  recipe             text,
  duration_minutes   smallint CHECK (duration_minutes BETWEEN 1 AND 600),
  -- Version allégée proposée par l'IA (texte et adaptation de la liste) pour un plat qui n'en a pas dans le catalogue ; light_chosen = retenue par le foyer
  light_by_ai        boolean NOT NULL DEFAULT false,
  light_text         text CHECK (light_text IS NULL OR btrim(light_text) <> ''),
  light_chosen       boolean NOT NULL DEFAULT false,
  -- Plat remplacé dans la liste déroulante : sorti de la séance de batch (inutilisé depuis CR-42)
  is_off_batch       boolean NOT NULL DEFAULT false,
  -- Plat de planning rapproché du catalogue, correspondance à confirmer (US-156 RF7, inutilisé depuis CR-42)
  planning_match_to_confirm boolean NOT NULL DEFAULT false,
  UNIQUE (id, account_id),
  UNIQUE (id, menu_id),
  UNIQUE (menu_id, kind, slot),
  CONSTRAINT ck_meal_menu_entries_slot CHECK (slot <= CASE kind WHEN 'pleasure' THEN 2 WHEN 'express' THEN 4 ELSE 7 END),
  CONSTRAINT ck_meal_menu_entries_origin CHECK (dish_origin = 'catalog' OR dish_id IS NULL),
  CONSTRAINT ck_meal_menu_entries_free_dish CHECK ((dish_origin = 'ai' AND cuisine_id IS NOT NULL) OR (dish_origin <> 'ai' AND cuisine_id IS NULL AND recipe IS NULL AND duration_minutes IS NULL)),
  CONSTRAINT ck_meal_menu_entries_light CHECK (light_by_ai = (light_text IS NOT NULL) AND (light_by_ai OR NOT light_chosen)),
  CONSTRAINT fk_meal_menu_entries_menu FOREIGN KEY (menu_id, account_id) REFERENCES meal_menus (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_meal_menu_entries_household_dish FOREIGN KEY (household_dish_id, account_id) REFERENCES meal_household_dishes (id, account_id) ON DELETE SET NULL (household_dish_id)
);
CREATE INDEX idx_meal_menu_entries_account ON meal_menu_entries (account_id);
CREATE INDEX idx_meal_menu_entries_dish_id ON meal_menu_entries (dish_id) WHERE dish_id IS NOT NULL;
CREATE INDEX idx_meal_menu_entries_household_dish ON meal_menu_entries (household_dish_id, account_id) WHERE household_dish_id IS NOT NULL;
CREATE INDEX idx_meal_menu_entries_cuisine_id ON meal_menu_entries (cuisine_id) WHERE cuisine_id IS NOT NULL;
COMMENT ON TABLE meal_menu_entries IS $$Plats d'un menu validé : 7 dîners et plats express (le type « plaisir » n'est plus utilisé depuis CR-42). Chaque ligne garde le nom du plat tel qu'il était et son origine : catalogue, Mes plats ou plat libre composé par l'IA. Un plat libre garde dans la ligne sa cuisine, sa recette et sa durée, et ses ingrédients dans meal_menu_entry_ingredients : il n'entre jamais dans le catalogue commun (CR-04) et part avec le menu (12 mois). Après la validation, un plat (libre ou du catalogue) ajouté à Mes plats y est copié et la ligne en garde le lien (household_dish_id). La ligne peut porter une version allégée proposée par l'IA (texte, adaptation dans meal_menu_entry_light_items, choix du foyer). Un plat retiré ou supprimé ensuite reste lisible dans les menus déjà validés. Un menu remplacé par un autre de la même semaine garde son identifiant et voit ses lignes remplacées. [US-156 RF3 à RF10, RT4, CR-25, CR-42, CR-45]$$;
COMMENT ON COLUMN meal_menu_entries.dish_origin IS $$Origine du plat : catalog (plat du catalogue commun), household (plat de Mes plats) ou ai (plat libre composé par l'IA avec le foyer, avec ses ingrédients, jamais dans le catalogue). Renseignée par l'application, sans valeur par défaut ; les menus déjà validés avant CR-42 ont reçu household s'ils pointaient vers un plat personnel, sinon catalog. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.household_dish_id IS $$Plat de Mes plats : le plat choisi (origine household) ou, après « Ajouter à vos plats », la copie faite dans Mes plats d'un plat libre ou du catalogue (la ligne garde son contenu). Vide si le foyer a supprimé ce plat ensuite. [US-156 RF10, CR-42, CR-45]$$;
COMMENT ON COLUMN meal_menu_entries.cuisine_id IS $$Cuisine d'un plat libre (origine ai, obligatoire) ; vide pour un plat du catalogue ou de Mes plats. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.recipe IS $$Recette en texte d'un plat libre ; vide pour un plat du catalogue ou de Mes plats. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.duration_minutes IS $$Durée d'un plat libre en minutes (1 à 600) ; vide pour un plat du catalogue ou de Mes plats. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.light_by_ai IS $$Vrai si une version allégée a été proposée par l'IA pour ce plat (texte dans light_text, adaptation de la liste dans meal_menu_entry_light_items) ; possible pour toute origine dont le plat n'a pas de version allégée dans le catalogue. [US-157 RF5, CR-42, CR-45]$$;
COMMENT ON COLUMN meal_menu_entries.light_text IS $$Texte de la version allégée proposée par l'IA ; renseigné si et seulement si light_by_ai. [CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.light_chosen IS $$Le foyer a retenu la version allégée proposée par l'IA (la liste suit l'adaptation). Ne peut être vrai que si light_by_ai. Pour les plats du catalogue, le choix reste dans meal_light_choices. [US-157 RF9, CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.is_off_batch IS $$Inutilisé depuis CR-42 (plus de liste déroulante de remplacements) : laissé à faux ; les dîners du samedi et du dimanche, hors séance de batch, se déduisent du rang. [US-156 RF8, CR-42]$$;
COMMENT ON COLUMN meal_menu_entries.planning_match_to_confirm IS $$Inutilisé depuis CR-42 (le menu ne vient plus d'un planning à rapprocher du catalogue) : laissé à faux. Les correspondances des semaines types (US-170, US-171) restent dans meal_batch_week_days. [US-156 RF7, CR-42]$$;

-- Ingrédients d'un plat libre du menu (CR-42) : nom, clé normalisée, produit du catalogue s'il est reconnu. Conservés avec le menu, effacés avec lui.
CREATE TABLE meal_menu_entry_ingredients (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id    bigint NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  label       varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key    text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  -- Produit du catalogue reconnu par l'application ; vide si inconnu (la liste le prend sans prix, noté dans les produits à référencer)
  product_id  bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  position    smallint NOT NULL DEFAULT 1 CHECK (position >= 1),
  UNIQUE (entry_id, name_key),
  CONSTRAINT fk_meal_menu_entry_ingredients_entry FOREIGN KEY (entry_id, account_id) REFERENCES meal_menu_entries (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_meal_menu_entry_ingredients_account ON meal_menu_entry_ingredients (account_id);
CREATE INDEX idx_meal_menu_entry_ingredients_product_id ON meal_menu_entry_ingredients (product_id) WHERE product_id IS NOT NULL;
COMMENT ON TABLE meal_menu_entry_ingredients IS $$Ingrédients d'un plat libre d'un menu validé : nom saisi, clé normalisée, produit du catalogue s'il est reconnu (un ingrédient inconnu entre dans la liste sans prix et dans les produits à référencer). Aucune quantité par ingrédient. Un plat libre a au moins un ingrédient (contrôlé à la validation de la transaction). Jamais dans le catalogue commun ; conservé et purgé avec le menu. [US-156 RF8, RT4, CR-04, CR-42]$$;

-- Adaptation de la liste pour la version allégée proposée par l'IA : produits à retirer ou à ajouter
CREATE TABLE meal_menu_entry_light_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id    bigint NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('remove', 'add')),
  label       varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key    text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  product_id  bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  UNIQUE (entry_id, kind, name_key),
  CONSTRAINT fk_meal_menu_entry_light_items_entry FOREIGN KEY (entry_id, account_id) REFERENCES meal_menu_entries (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_meal_menu_entry_light_items_account ON meal_menu_entry_light_items (account_id);
CREATE INDEX idx_meal_menu_entry_light_items_product_id ON meal_menu_entry_light_items (product_id) WHERE product_id IS NOT NULL;
COMMENT ON TABLE meal_menu_entry_light_items IS $$Produits à retirer et à ajouter pour passer un plat du menu à la version allégée proposée par l'IA (la ligne de menu porte le texte, light_by_ai). Un produit inconnu du catalogue est noté dans les produits à référencer. Conservé et purgé avec le menu. [US-157 RF5, CR-42]$$;

-- Déroulé de la séance de batch rédigé par l'IA (CR-47, US-156 RF6bis, US-157 RF1ter) : étapes numérotées d'un menu qui ne reprend pas une semaine type
CREATE TABLE meal_menu_session_steps (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  menu_id     uuid NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  position    smallint NOT NULL CHECK (position >= 1),
  body        text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 2000),
  -- Plat concerné par l'étape (facultatif) : une ligne du même menu ; vide si la ligne de menu est remplacée
  entry_id    bigint,
  -- Durée approximative de l'étape, en minutes (facultative)
  duration_minutes smallint CHECK (duration_minutes BETWEEN 1 AND 600),
  -- Rang d'une étape PRÉCÉDENTE du même menu avec laquelle celle-ci se chevauche (« en même temps, pendant la cuisson ») : une étape en chevauchement n'allonge pas la séance (durée totale recalculée par l'application)
  overlaps_position smallint CHECK (overlaps_position >= 1),
  -- Conservation d'un plat (étape de fin de déroulé) : réfrigérateur ou congélateur, et jour où le sortir (jour ISO de la semaine du menu, 1 = lundi)
  storage_mode text CHECK (storage_mode IN ('fridge', 'freezer')),
  take_out_day smallint CHECK (take_out_day BETWEEN 1 AND 7),
  UNIQUE (menu_id, position),
  CONSTRAINT ck_meal_menu_session_steps_overlap CHECK (overlaps_position IS NULL OR overlaps_position < position),
  CONSTRAINT ck_meal_menu_session_steps_storage CHECK (take_out_day IS NULL OR storage_mode IS NOT NULL),
  CONSTRAINT fk_meal_menu_session_steps_menu FOREIGN KEY (menu_id, account_id) REFERENCES meal_menus (id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_meal_menu_session_steps_entry FOREIGN KEY (entry_id, menu_id) REFERENCES meal_menu_entries (id, menu_id) ON DELETE SET NULL (entry_id),
  CONSTRAINT fk_meal_menu_session_steps_overlap FOREIGN KEY (menu_id, overlaps_position) REFERENCES meal_menu_session_steps (menu_id, position) ON DELETE SET NULL (overlaps_position)
);
-- Une seule étape de conservation par plat
CREATE UNIQUE INDEX ux_meal_menu_session_steps_storage ON meal_menu_session_steps (entry_id) WHERE storage_mode IS NOT NULL AND entry_id IS NOT NULL;
CREATE INDEX idx_meal_menu_session_steps_account ON meal_menu_session_steps (account_id);
CREATE INDEX idx_meal_menu_session_steps_entry ON meal_menu_session_steps (entry_id, menu_id) WHERE entry_id IS NOT NULL;
COMMENT ON TABLE meal_menu_session_steps IS $$Déroulé de la séance de batch du dimanche, rédigé par l'IA pour un menu qui ne reprend pas une semaine type : étapes numérotées (texte, plat concerné facultatif, durée approximative facultative). Le déroulé finit par la conservation de chaque plat, écrite comme des étapes de fin de déroulé : plat concerné, réfrigérateur ou congélateur, jour où le sortir. Une étape peut se chevaucher avec une étape précédente (elle n'allonge alors pas la séance). Réservé aux menus sans semaine type (batch_week_id vide) : avec une semaine type, le déroulé est celui du planning (US-170) et rien n'est enregistré ici. Conservé et purgé avec le menu (12 mois), effacé avec le compte. [US-156 RF6bis, US-157 RF1ter, CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.position IS $$Rang de l'étape dans le déroulé, à partir de 1 [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.body IS $$Texte de l'étape (2 000 caractères au plus), rédigé par l'IA [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.entry_id IS $$Plat concerné par l'étape : une ligne du même menu (facultatif) ; repasse à vide si cette ligne est supprimée, l'étape reste lisible [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.duration_minutes IS $$Durée approximative de l'étape en minutes, 1 à 600 (facultative) [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.overlaps_position IS $$Rang d'une étape précédente du même menu avec laquelle cette étape se chevauche (« en même temps, pendant la cuisson ») ; facultatif, toujours inférieur au rang de l'étape (pas de cycle). Une étape en chevauchement n'allonge pas la séance : l'application recalcule la durée totale. Repasse à vide si l'étape référencée est supprimée. [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.storage_mode IS $$Étape de conservation d'un plat : fridge (réfrigérateur) ou freezer (congélateur) ; le plat est entry_id. Vide pour une étape ordinaire. Une seule étape de conservation par plat. [CR-47]$$;
COMMENT ON COLUMN meal_menu_session_steps.take_out_day IS $$Jour où sortir le plat, jour ISO de la semaine du menu (1 = lundi … 7 = dimanche) ; facultatif, uniquement pour une étape de conservation. [CR-47]$$;

-- Les étapes d'un déroulé écrit par l'IA n'existent que pour un menu sans semaine type : contrôle différé à la fin de la transaction (le menu est mis à jour, puis ses étapes remplacées)
CREATE FUNCTION meal_menu_session_steps_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_menu uuid;
BEGIN
  IF TG_TABLE_NAME = 'meal_menus' THEN
    v_menu := NEW.id;
  ELSE
    v_menu := NEW.menu_id;
  END IF;
  IF EXISTS (SELECT 1 FROM meal_menus WHERE id = v_menu AND batch_week_id IS NOT NULL)
     AND EXISTS (SELECT 1 FROM meal_menu_session_steps WHERE menu_id = v_menu) THEN
    RAISE EXCEPTION 'Un menu qui reprend une semaine type n''a pas de déroulé de séance enregistré : c''est celui du planning' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_meal_menu_session_steps_check AFTER INSERT ON meal_menu_session_steps
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_session_steps_check();
CREATE CONSTRAINT TRIGGER trg_meal_menus_session_steps_check AFTER UPDATE OF batch_week_id ON meal_menus
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_session_steps_check();
COMMENT ON FUNCTION meal_menu_session_steps_check() IS $$Contrôle différé : un menu qui reprend une semaine type (batch_week_id renseigné) n'a aucune étape de déroulé enregistrée, son déroulé étant celui du planning. [US-156 RF6bis, CR-47]$$;

-- Plafond de menus complets par foyer et par jour (CR-44, US-156 RF12ter) : un compteur par foyer et par jour, sans autre donnée que le compte
CREATE TABLE meal_menu_daily_counters (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  menu_date   date NOT NULL,
  menu_count  smallint NOT NULL DEFAULT 0 CHECK (menu_count >= 0),
  PRIMARY KEY (account_id, menu_date)
);
COMMENT ON TABLE meal_menu_daily_counters IS $$Nombre de menus complets composés par un foyer un jour donné, pour le plafond quotidien (réglage de la console meal_menu_daily_cap, 10 par défaut) : chaque menu proposé et chaque correction compte comme un menu. Aucune donnée personnelle hors le compte ; incrémenté seulement par register_meal_menu() ; purgé après 7 jours (purge_expired_grocery_data) ; effacé avec le compte. [US-156 RF12ter, CR-44]$$;
COMMENT ON COLUMN meal_menu_daily_counters.menu_date IS $$Jour du décompte, calculé par l'application dans le fuseau du foyer [CR-44]$$;
COMMENT ON COLUMN meal_menu_daily_counters.menu_count IS $$Menus complets déjà acceptés ce jour-là ; borné par le plafond, jamais au-dessus [CR-44]$$;

-- Compte un menu complet d'un foyer et applique le plafond quotidien, de façon atomique (même principe que register_agent_request)
CREATE FUNCTION register_meal_menu(p_account uuid, p_day date, p_cap integer DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_cap integer; v_count integer;
BEGIN
  v_cap := LEAST(COALESCE(p_cap, grocery_setting_int('meal_menu_daily_cap', 10)), 32000);
  IF v_cap < 1 THEN RETURN false; END IF;
  INSERT INTO meal_menu_daily_counters AS c (account_id, menu_date, menu_count)
       VALUES (p_account, p_day, 1)
  ON CONFLICT (account_id, menu_date) DO UPDATE SET menu_count = c.menu_count + 1
        WHERE c.menu_count < v_cap
  RETURNING c.menu_count INTO v_count;
  RETURN v_count IS NOT NULL;
END $$;
COMMENT ON FUNCTION register_meal_menu(uuid, date, integer) IS $$Compte un menu complet d'un foyer pour un jour et applique le plafond quotidien : true = accepté (le compteur est incrémenté), false = plafond atteint (rien n'est compté). Le plafond est le paramètre ou, s'il est vide, le réglage de la console meal_menu_daily_cap (10 par défaut). Atomique : deux demandes simultanées ne dépassent jamais le plafond. [US-156 RF12ter, CR-44]$$;

-- Un plat libre a au moins un ingrédient : contrôle différé à la fin de la transaction (la ligne de menu et ses ingrédients s'écrivent ensemble)
CREATE FUNCTION meal_menu_entry_needs_ingredient() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_entry bigint;
BEGIN
  IF TG_TABLE_NAME = 'meal_menu_entries' THEN
    v_entry := NEW.id;
  ELSE
    v_entry := OLD.entry_id;
  END IF;
  IF EXISTS (SELECT 1 FROM meal_menu_entries WHERE id = v_entry AND dish_origin = 'ai')
     AND NOT EXISTS (SELECT 1 FROM meal_menu_entry_ingredients WHERE entry_id = v_entry) THEN
    RAISE EXCEPTION 'Un plat libre du menu a au moins un ingrédient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_meal_menu_entries_ingredient AFTER INSERT OR UPDATE OF dish_origin ON meal_menu_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_entry_needs_ingredient();
CREATE CONSTRAINT TRIGGER trg_meal_menu_entry_ingredients_delete AFTER DELETE ON meal_menu_entry_ingredients
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meal_menu_entry_needs_ingredient();
COMMENT ON FUNCTION meal_menu_entry_needs_ingredient() IS $$Contrôle différé : un plat libre d'un menu (origine ai) a au moins un ingrédient à la fin de la transaction. [US-156 RF8, RT3, CR-42]$$;

-- Une adaptation de version allégée n'existe que pour un plat dont l'IA a proposé une version allégée
CREATE FUNCTION meal_menu_entry_light_item_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM meal_menu_entries WHERE id = NEW.entry_id AND light_by_ai) THEN
    RAISE EXCEPTION 'Une adaptation allégée suppose une version allégée proposée par l''IA pour ce plat' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_meal_menu_entry_light_items_before_write BEFORE INSERT OR UPDATE ON meal_menu_entry_light_items
  FOR EACH ROW EXECUTE FUNCTION meal_menu_entry_light_item_before_write();
COMMENT ON FUNCTION meal_menu_entry_light_item_before_write() IS $$Refuse une adaptation de version allégée sur un plat de menu qui n'a pas de version allégée proposée par l'IA. [US-157 RF5, CR-42]$$;

-- Version standard ou allégée choisie pour un plat, reprise au menu suivant (US-157 RF9)
CREATE TABLE meal_light_choices (
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  dish_id     bigint NOT NULL REFERENCES meal_dishes (id) ON DELETE CASCADE,
  choice      text NOT NULL CHECK (choice IN ('standard', 'light')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, dish_id)
);
CREATE INDEX idx_meal_light_choices_dish_id ON meal_light_choices (dish_id);
COMMENT ON TABLE meal_light_choices IS $$Choix du foyer, plat par plat, entre la version standard et la version allégée : enregistré à « Valider ma liste » et repris au menu suivant. Un retour à la version standard rétablit la liste. [US-157 RF5, RF9]$$;

-- ---------------------------------------------------------------------
-- Liste de courses (US-157, US-158, US-162, CR-27, CR-28)
-- ---------------------------------------------------------------------
CREATE TABLE grocery_lists (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  menu_id              uuid,
  -- Scénario d'achat choisi : 1 tout dans le magasin qui couvre le plus de produits, 2 chaque référence choisie, 3 mes produits habituels
  scenario             smallint NOT NULL CHECK (scenario BETWEEN 1 AND 3),
  validated_at         timestamptz NOT NULL DEFAULT now(),
  validated_by_user_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_grocery_lists_menu FOREIGN KEY (menu_id, account_id) REFERENCES meal_menus (id, account_id) ON DELETE SET NULL (menu_id),
  CONSTRAINT fk_grocery_lists_validated_by FOREIGN KEY (validated_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (validated_by_user_id)
);
CREATE INDEX idx_grocery_lists_account ON grocery_lists (account_id, validated_at DESC);
CREATE INDEX idx_grocery_lists_menu ON grocery_lists (menu_id, account_id) WHERE menu_id IS NOT NULL;
CREATE INDEX idx_grocery_lists_validated_by ON grocery_lists (validated_by_user_id, account_id);
COMMENT ON TABLE grocery_lists IS $$Liste de courses validée (« Valider ma liste ») : scénario d'achat choisi, menu d'origine, date, profil. La dernière liste validée est « Ma liste de courses », consultée en magasin par magasin puis par rayon. La liste vide de tout produit est supprimée par la purge. [US-157 RF7, RF9]$$;

CREATE TABLE grocery_list_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  list_id              uuid,
  -- preparing = en préparation (ingrédients du menu, produits ajoutés, historique) ; validated = dans la liste validée ; added_after_validation = ajouté
  -- depuis la validation, sans magasin ni prix (CR-28) ; bought = acheté (rejoint l'historique)
  state                grocery_item_state NOT NULL DEFAULT 'preparing',
  source               text NOT NULL DEFAULT 'added' CHECK (source IN ('menu', 'added', 'habit')),
  label                varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key             text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  product_id           bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  aisle_id             integer REFERENCES grocery_aisles (id) ON DELETE SET NULL,
  quantity             smallint NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 99),
  added_by_user_id     uuid,
  -- Repris de la liste précédente : « pas acheté la dernière fois » (CR-28)
  not_bought_last_time boolean NOT NULL DEFAULT false,
  -- Choix du scénario, posés à la validation (estimation : prix d'une unité × quantité)
  store_chain          varchar(80) CHECK (store_chain IS NULL OR (store_chain <> '' AND store_chain = grocery_norm(store_chain))),
  reference_name       varchar(160),
  unit_price           numeric(8,2) CHECK (unit_price IS NULL OR unit_price > 0),
  -- Unité du prix, copiée de la référence à la validation : un article au kilo ou au litre n'entre pas dans le total estimé (CR-40)
  price_unit           varchar(4) CHECK (price_unit IS NULL OR price_unit IN ('unit', 'kg', 'l')),
  bought_at            timestamptz,
  bought_by_user_id    uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_grocery_list_items_list FOREIGN KEY (list_id, account_id) REFERENCES grocery_lists (id, account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_grocery_list_items_added_by FOREIGN KEY (added_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (added_by_user_id),
  CONSTRAINT fk_grocery_list_items_bought_by FOREIGN KEY (bought_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (bought_by_user_id),
  CONSTRAINT ck_grocery_list_items_bought CHECK ((state = 'bought') = (bought_at IS NOT NULL)),
  CONSTRAINT ck_grocery_list_items_list CHECK ((state = 'preparing') = (list_id IS NULL)),
  CONSTRAINT ck_grocery_list_items_no_store CHECK (state NOT IN ('preparing', 'added_after_validation') OR (store_chain IS NULL AND reference_name IS NULL AND unit_price IS NULL AND price_unit IS NULL)),
  CONSTRAINT ck_grocery_list_items_price_store CHECK (unit_price IS NULL OR store_chain IS NOT NULL),
  CONSTRAINT ck_grocery_list_items_price_unit CHECK (price_unit IS NULL OR store_chain IS NOT NULL)
);
-- Un produit déjà dans la liste n'est pas ajouté deux fois : sa quantité augmente (US-158 RF3)
CREATE UNIQUE INDEX ux_grocery_list_items_open ON grocery_list_items (account_id, name_key) WHERE state <> 'bought';
CREATE INDEX idx_grocery_list_items_list ON grocery_list_items (list_id, account_id) WHERE list_id IS NOT NULL;
CREATE INDEX idx_grocery_list_items_history ON grocery_list_items (account_id, bought_at DESC) WHERE state = 'bought';
CREATE INDEX idx_grocery_list_items_product_id ON grocery_list_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_grocery_list_items_aisle_id ON grocery_list_items (aisle_id) WHERE aisle_id IS NOT NULL;
CREATE INDEX idx_grocery_list_items_added_by ON grocery_list_items (added_by_user_id, account_id);
CREATE INDEX idx_grocery_list_items_bought_by ON grocery_list_items (bought_by_user_id, account_id);
COMMENT ON TABLE grocery_list_items IS $$Produit de la liste de courses du foyer, avec son état : en préparation, validé, ajouté depuis la validation (sans magasin ni prix, en tête de « Ma liste de courses »), acheté. Un produit n'est qu'une fois dans la liste ouverte (la quantité augmente). Les produits non achetés reviennent en préparation avec « pas acheté la dernière fois » (grocery_carry_over_unbought). Les produits achetés forment l'historique du foyer, conservé 3 mois (réglable). Le couple retire tout ; un invité secondaire ne retire que ses propres ajouts, n'augmente que les quantités et peut cocher « acheté » (CR-38), sans voir aucun prix (grocery_list_for). [US-157 RF3, RF9, US-158, US-162, CR-10, CR-27, CR-28]$$;
COMMENT ON COLUMN grocery_list_items.price_unit IS $$Unité de unit_price, copiée de la référence choisie à la validation : unit (ou vide) = par article, kg ou l = par kilo ou par litre. Un article au kilo ou au litre s'affiche « x,xx €/kg » avec la mention « prix au kilo, non totalisé » et n'entre pas dans le total estimé : l'application ne totalise que les articles dont price_unit est vide ou unit. Aucun poids n'est supposé. [CR-40]$$;
COMMENT ON COLUMN grocery_list_items.state IS $$preparing = en préparation (aucun magasin, aucun prix) ; validated = dans la liste validée, avec son magasin, sa référence et son prix estimé ; added_after_validation = ajouté depuis la validation, sans magasin ni prix ; bought = acheté (date et profil). [US-157 RF9, US-158 RF3bis, CR-28]$$;

CREATE FUNCTION grocery_list_item_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_user uuid := app_current_user_id();
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'Un produit de la liste ne change pas de foyer' USING ERRCODE = 'check_violation';
  END IF;
  -- Invité secondaire (CR-10, CR-38) : il ajoute un produit en son nom, augmente sa quantité en le rajoutant, ou coche « acheté » un article de la liste validée ; rien d'autre
  IF v_user IS NOT NULL AND grocery_access(v_user) = 'list' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.state NOT IN ('preparing', 'added_after_validation') OR NEW.added_by_user_id IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'Un invité secondaire ajoute un produit en son nom, sans autre changement' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (to_jsonb(NEW) - 'quantity' - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'quantity' - 'updated_at') AND NEW.quantity > OLD.quantity THEN
      NULL;                                              -- quantité qui augmente seule
    ELSIF (to_jsonb(NEW) - 'state' - 'bought_at' - 'bought_by_user_id' - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'state' - 'bought_at' - 'bought_by_user_id' - 'updated_at')
          AND ((OLD.state IN ('validated', 'added_after_validation') AND NEW.state = 'bought' AND NEW.bought_at IS NOT NULL AND NEW.bought_by_user_id = v_user)
            OR (OLD.state = 'bought' AND OLD.bought_by_user_id = v_user AND NEW.state IN ('validated', 'added_after_validation')
                AND NEW.bought_at IS NULL AND NEW.bought_by_user_id IS NULL)) THEN
      NULL;                                              -- coche « acheté » (n'importe quel article validé) ou décoche de sa propre coche
    ELSE
      RAISE EXCEPTION 'Un invité secondaire peut seulement augmenter une quantité ou cocher « acheté » un article de la liste validée' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_grocery_list_items_before_write BEFORE INSERT OR UPDATE ON grocery_list_items
  FOR EACH ROW EXECUTE FUNCTION grocery_list_item_before_write();
COMMENT ON FUNCTION grocery_list_item_before_write() IS $$Garde-fou de la liste de courses : un invité secondaire (profil indiqué dans app.user_id) peut ajouter un produit en son nom, augmenter une quantité, cocher « acheté » n'importe quel article de la liste validée (état validé ou ajouté depuis la validation, à son nom) et décocher ce qu'il a lui-même coché ; il ne change jamais un magasin, une référence, un prix, une quantité en même temps ni le libellé. Sans profil indiqué, le garde-fou ne s'applique pas (H144). [US-158 RF2, RF3, US-162, CR-10, CR-38]$$;

-- Lecture de la liste sans prix pour l'invité secondaire (CR-38) : le prix estimé est vide pour lui, intact pour le couple ; magasin et référence restent visibles
CREATE FUNCTION grocery_list_for(p_viewer uuid)
RETURNS TABLE (id uuid, list_id uuid, state grocery_item_state, source text, label varchar, name_key text, product_id bigint, aisle_id integer, quantity smallint,
               added_by_user_id uuid, not_bought_last_time boolean, store_chain varchar, reference_name varchar, unit_price numeric, bought_at timestamptz,
               bought_by_user_id uuid, package_format varchar, price_unit varchar)
LANGUAGE sql STABLE AS $$
  SELECT i.id, i.list_id, i.state, i.source, i.label, i.name_key, i.product_id, i.aisle_id, i.quantity, i.added_by_user_id, i.not_bought_last_time,
         i.store_chain, i.reference_name, CASE WHEN grocery_access(p_viewer) = 'couple' THEN i.unit_price END, i.bought_at, i.bought_by_user_id,
         (SELECT r.package_format FROM grocery_product_references r
           WHERE r.product_id = i.product_id AND r.store_chain = i.store_chain AND r.reference_name = i.reference_name),
         i.price_unit
    FROM users v
    JOIN grocery_list_items i ON i.account_id = v.account_id
   WHERE v.id = p_viewer AND grocery_access(p_viewer) IS NOT NULL
$$;
COMMENT ON FUNCTION grocery_list_for(uuid) IS $$Articles de la liste de courses de la famille d'un profil, pour l'affichage : le prix estimé n'est rendu qu'au couple, l'invité secondaire ne voit aucun prix (il voit le magasin, la référence, le format du conditionnement et l'unité du prix, sans prix). L'application l'utilise pour lire la liste ; tant qu'elle se connecte avec un seul rôle, la protection effective des colonnes est cette fonction et le code (H150). [US-157 RF8, US-158, CR-10, CR-38, CR-40]$$;

-- À la préparation de la liste suivante, les produits non achetés (liste validée et « ajoutés depuis la validation ») reviennent en préparation
CREATE FUNCTION grocery_carry_over_unbought(p_account uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  UPDATE grocery_list_items
     SET state = 'preparing', list_id = NULL, store_chain = NULL, reference_name = NULL, unit_price = NULL, price_unit = NULL, not_bought_last_time = true
   WHERE account_id = p_account AND state IN ('validated', 'added_after_validation');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION grocery_carry_over_unbought(uuid) IS $$Reprend dans la préparation suivante les produits non achetés de la liste validée et du bloc « Ajoutés depuis la validation » : ils redeviennent « en préparation », sans magasin ni prix, avec la mention « pas acheté la dernière fois ». Retourne le nombre de produits repris. À appeler à l'ouverture de la préparation de la liste. [US-162 RF4, CR-28]$$;

-- ---------------------------------------------------------------------
-- Tickets de caisse (US-161, US-163) : aucune photo (supprimée dès la lecture, CR-05), seulement le texte lu et les montants. Conservés 3 ans.
-- ---------------------------------------------------------------------
CREATE TABLE grocery_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  store_chain          varchar(80) NOT NULL CHECK (store_chain <> '' AND store_chain = grocery_norm(store_chain)),
  store_city           varchar(80) CHECK (store_city IS NULL OR (store_city <> '' AND store_city = grocery_norm(store_city))),
  purchased_on         date NOT NULL,
  -- Heure du ticket, à la seconde (secondes à 00 quand elles ne sont pas lues), heure locale du magasin ; facultative pour les anciens tickets (CR-41)
  purchased_time       time(0),
  total_amount         numeric(9,2) NOT NULL,
  recorded_by_user_id  uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  CONSTRAINT fk_grocery_receipts_recorded_by FOREIGN KEY (recorded_by_user_id, account_id) REFERENCES users (id, account_id) ON DELETE SET NULL (recorded_by_user_id)
);
-- Un ticket déjà enregistré est refusé en entier (US-161 RT2, CR-41) : avec une heure, même date, même heure et même total (le magasin n'entre pas en compte) ;
-- sans heure, même magasin, même date et même total, comme avant. Les deux contrôles sont garantis par la base.
CREATE UNIQUE INDEX ux_grocery_receipts_duplicate_time ON grocery_receipts (account_id, purchased_on, purchased_time, total_amount) WHERE purchased_time IS NOT NULL;
CREATE UNIQUE INDEX ux_grocery_receipts_duplicate_no_time ON grocery_receipts (account_id, store_chain, purchased_on, total_amount) WHERE purchased_time IS NULL;
CREATE INDEX idx_grocery_receipts_recorded_by ON grocery_receipts (recorded_by_user_id, account_id);
CREATE INDEX idx_grocery_receipts_date ON grocery_receipts (account_id, purchased_on DESC);
COMMENT ON TABLE grocery_receipts IS $$Ticket de caisse enregistré : magasin, ville, date, heure, total, profil. Aucune photo ni image (supprimée dès la lecture, confirmée ou non), le nom et la carte de fidélité sont masqués avant que l'agent ne reçoive le texte. Un doublon est refusé en entier par la base : même date, même heure exacte et même total (le magasin n'entre pas en compte) ; sans heure (anciens tickets), même magasin, même date et même total. Source du budget par rayon. Conservé 3 ans (année en cours et deux précédentes, réglable). [US-161, US-163, CR-05, CR-08, CR-23, CR-41]$$;
COMMENT ON COLUMN grocery_receipts.purchased_time IS $$Heure du ticket (heures, minutes et secondes si elles sont lues, sinon secondes à 00), heure locale du magasin. Lue sur le ticket ou saisie par l'utilisateur quand elle n'est pas lue. Vide pour les tickets enregistrés avant CR-41 : leur contrôle de doublon reste magasin, date et total. [CR-41, US-161 RT2]$$;

CREATE TABLE grocery_receipt_lines (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id       uuid NOT NULL,
  account_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  position         smallint NOT NULL DEFAULT 1 CHECK (position >= 1),
  label            varchar(120) NOT NULL CHECK (btrim(label) <> ''),
  name_key         text NOT NULL CHECK (name_key <> '' AND name_key = grocery_norm(name_key)),
  reference_name   varchar(160),
  -- Prix total de la ligne ; une remise peut être négative
  line_total       numeric(9,2) NOT NULL,
  quantity         numeric(8,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  aisle_id         integer NOT NULL REFERENCES grocery_aisles (id) ON DELETE RESTRICT,
  product_id       bigint REFERENCES grocery_products (id) ON DELETE SET NULL,
  -- Poids ou volume mesuré à la caisse (« 1,234 kg ») et prix au kilo ou au litre ; vides pour une ligne vendue à la pièce (CR-39)
  measured_quantity numeric(9,3) CHECK (measured_quantity > 0),
  measure_unit      varchar(2) CHECK (measure_unit IN ('kg', 'l')),
  price_per_measure numeric(8,2) CHECK (price_per_measure > 0),
  CONSTRAINT ck_grocery_receipt_lines_measure CHECK ((measured_quantity IS NULL) = (measure_unit IS NULL) AND (price_per_measure IS NULL OR measured_quantity IS NOT NULL)),
  CONSTRAINT fk_grocery_receipt_lines_receipt FOREIGN KEY (receipt_id, account_id) REFERENCES grocery_receipts (id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_grocery_receipt_lines_receipt ON grocery_receipt_lines (receipt_id, account_id);
CREATE INDEX idx_grocery_receipt_lines_account ON grocery_receipt_lines (account_id);
CREATE INDEX idx_grocery_receipt_lines_aisle_id ON grocery_receipt_lines (aisle_id);
CREATE INDEX idx_grocery_receipt_lines_product_id ON grocery_receipt_lines (product_id) WHERE product_id IS NOT NULL;
COMMENT ON COLUMN grocery_receipt_lines.measured_quantity IS $$Poids ou volume mesuré à la caisse, en kilogrammes ou en litres (« 1,234 kg ») ; vide pour une ligne vendue à la pièce. Les grammes et les centilitres sont convertis avant l'écriture. Reste dans le foyer : jamais partagé. quantity (nombre d'articles) ne le porte pas. [CR-39]$$;
COMMENT ON COLUMN grocery_receipt_lines.measure_unit IS $$Unité du poids ou du volume mesuré : kg ou l. Vide en même temps que la quantité mesurée ; vide = vendu à la pièce. [CR-39]$$;
COMMENT ON COLUMN grocery_receipt_lines.price_per_measure IS $$Prix au kilo ou au litre lu sur le ticket (« 1,49 €/kg »). S'il n'est pas lu et que le poids est connu, il est calculé (total de la ligne divisé par le poids, arrondi à 2 décimales) ; le prix lu l'emporte toujours. Vide sans poids, sur une remise, ou si le calcul sort des bornes. [CR-39, CR-40]$$;
COMMENT ON TABLE grocery_receipt_lines IS $$Ligne d'un ticket : produit, référence, prix total de la ligne, quantité, poids ou volume mesuré et prix au kilo ou au litre pour un article pesé, rayon (choisi dans la liste des rayons). Les lignes alimentent le budget par rayon, les prix du foyer et les produits de son historique. [US-161 RF2 à RF5, US-163, CR-39]$$;

CREATE FUNCTION grocery_receipt_line_measure_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v numeric;
BEGIN
  IF NEW.price_per_measure IS NULL AND NEW.measured_quantity > 0 AND NEW.line_total > 0 THEN
    v := round(NEW.line_total / NEW.measured_quantity, 2);
    IF v > 0 AND v < 1000000 THEN
      NEW.price_per_measure := v;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_grocery_receipt_lines_measure BEFORE INSERT OR UPDATE ON grocery_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION grocery_receipt_line_measure_before_write();
COMMENT ON FUNCTION grocery_receipt_line_measure_before_write() IS $$Calcule le prix au kilo ou au litre d'une ligne pesée quand le ticket ne le donne pas : total de la ligne divisé par le poids, arrondi à 2 décimales. Le prix lu sur le ticket l'emporte toujours ; rien n'est calculé sans poids, sur une remise ou hors bornes. [CR-39, CR-40]$$;

-- ---------------------------------------------------------------------
-- Fonctions et déclencheurs
-- ---------------------------------------------------------------------

-- Règles des réglages : le partage des prix ne change qu'après l'inscription de la preuve de consentement correspondante (CR-24)
CREATE FUNCTION grocery_household_settings_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_last consent_action;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.share_prices) OR (TG_OP = 'UPDATE' AND NEW.share_prices IS DISTINCT FROM OLD.share_prices) THEN
    SELECT action_type INTO v_last FROM grocery_price_sharing_events WHERE account_id = NEW.account_id ORDER BY occurred_at DESC, id DESC LIMIT 1;
    IF v_last IS DISTINCT FROM (CASE WHEN NEW.share_prices THEN 'granted' ELSE 'withdrawn' END)::consent_action THEN
      RAISE EXCEPTION 'Le partage des prix ne change qu''après l''inscription de la preuve de consentement' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_grocery_household_settings_before_write BEFORE INSERT OR UPDATE ON grocery_household_settings
  FOR EACH ROW EXECUTE FUNCTION grocery_household_settings_before_write();

-- Inscription du foyer au compteur de sa ville : posée à l'activation du partage, déplacée s'il change de ville en partageant, conservée à la désactivation (CR-22).
-- Exécutée avec les droits du propriétaire : le compteur n'est écrit par aucun autre rôle.
CREATE FUNCTION grocery_sync_city_sharing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.share_prices THEN
    INSERT INTO grocery_household_city_sharing (account_id, city_key) VALUES (NEW.account_id, grocery_norm(NEW.city))
    ON CONFLICT (account_id) DO UPDATE SET city_key = EXCLUDED.city_key;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_grocery_household_settings_city AFTER INSERT OR UPDATE OF share_prices, city ON grocery_household_settings
  FOR EACH ROW EXECUTE FUNCTION grocery_sync_city_sharing();
COMMENT ON FUNCTION grocery_sync_city_sharing() IS $$Inscrit le foyer au compteur de sa ville quand il partage ses prix (et le déplace s'il change de ville en partageant) ; ne le retire jamais à la désactivation du partage. Exécutée avec les droits du propriétaire. [CR-17, CR-22]$$;

CREATE FUNCTION grocery_city_counter_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE grocery_city_sharing SET household_count = household_count - 1 WHERE city_key = OLD.city_key;
    DELETE FROM grocery_city_sharing WHERE city_key = OLD.city_key AND household_count <= 0;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO grocery_city_sharing (city_key, household_count) VALUES (NEW.city_key, 1)
    ON CONFLICT (city_key) DO UPDATE SET household_count = grocery_city_sharing.household_count + 1;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_grocery_household_city_sharing_count AFTER INSERT OR DELETE ON grocery_household_city_sharing
  FOR EACH ROW EXECUTE FUNCTION grocery_city_counter_sync();
CREATE TRIGGER trg_grocery_household_city_sharing_move AFTER UPDATE OF city_key ON grocery_household_city_sharing
  FOR EACH ROW WHEN (OLD.city_key IS DISTINCT FROM NEW.city_key) EXECUTE FUNCTION grocery_city_counter_sync();
COMMENT ON FUNCTION grocery_city_counter_sync() IS $$Tient le compteur des foyers par ville : +1 à l'inscription d'un foyer, déplacement s'il change de ville, -1 à la suppression de son compte (la ligne du compteur disparaît à zéro). Exécutée avec les droits du propriétaire. [CR-17, CR-22]$$;

-- Porte d'écriture UNIQUE de la base commune (US-154 RT1) : refuse silencieusement si le foyer ne partage pas ; ne garde ni le foyer ni le jour
CREATE FUNCTION share_grocery_price(p_account uuid, p_product_id bigint, p_reference_name text, p_unit_price numeric, p_store_chain text, p_city text,
                                    p_purchased_on date, p_price_unit text DEFAULT 'unit') RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id bigint;
BEGIN
  IF NOT COALESCE((SELECT share_prices FROM grocery_household_settings WHERE account_id = p_account), false) THEN
    RETURN NULL;
  END IF;
  INSERT INTO grocery_shared_prices AS sp (product_id, reference_name, unit_price, price_unit, store_chain, city, week_start)
  VALUES (p_product_id, grocery_norm(p_reference_name), p_unit_price, COALESCE(p_price_unit, 'unit'), grocery_norm(p_store_chain), grocery_norm(p_city),
          p_purchased_on - (extract(isodow FROM p_purchased_on)::integer - 1))
  ON CONFLICT ON CONSTRAINT uq_grocery_shared_prices_line DO UPDATE SET week_start = greatest(sp.week_start, EXCLUDED.week_start)
  RETURNING sp.id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION share_grocery_price(uuid, bigint, text, numeric, text, text, date, text) IS $$Seule porte d'écriture de la base commune des prix. Le prix est par article, par kg ou par litre (p_price_unit : unit, kg, l) ; un article pesé est partagé avec son prix au kilo, jamais avec son poids. Reçoit le foyer pour vérifier qu'il partage ses prix (sinon ne fait rien et retourne NULL) mais ne le garde pas : la date du ticket devient le lundi de sa semaine. Une ligne identique (même unité de prix comprise) n'est pas dupliquée : sa semaine est mise à jour. Exécutée avec les droits du propriétaire. [US-154 RF1, RF2, RF4, RT1, CR-17, CR-39]$$;

-- Lecture des prix des autres foyers (US-154 RF3, CR-12, CR-21) : réciprocité (le foyer partage), enseignes de proximité du foyer seulement, ville affichée
-- dès 2 foyers (le foyer qui consulte compte aussi dans la ville consultée, CR-35), prix de moins de 12 mois, lignes non retirées
CREATE FUNCTION grocery_shared_prices_for(p_viewer uuid)
RETURNS TABLE (product_id bigint, reference_name varchar, unit_price numeric, store_chain varchar, city varchar, week_start date, price_age text,
               price_unit varchar, measure_unit varchar, price_per_measure numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.product_id, p.reference_name, p.unit_price, p.store_chain, p.city, p.week_start, grocery_price_age(p.week_start), p.price_unit,
         CASE WHEN p.price_unit <> 'unit' THEN p.price_unit ELSE rf.package_unit END,
         CASE WHEN p.price_unit <> 'unit' THEN p.unit_price WHEN rf.package_amount IS NOT NULL THEN round(p.unit_price / rf.package_amount, 2) END
    FROM users v
    JOIN grocery_household_settings hs ON hs.account_id = v.account_id AND hs.share_prices
    JOIN grocery_household_stores s ON s.account_id = v.account_id
    JOIN grocery_shared_prices p ON p.store_chain = s.store_chain AND p.city = s.store_city
    JOIN grocery_city_sharing cs ON cs.city_key = grocery_norm(p.city)
    LEFT JOIN grocery_household_city_sharing hc ON hc.account_id = v.account_id
    LEFT JOIN LATERAL (SELECT r.package_amount, r.package_unit FROM grocery_product_references r
                        WHERE r.product_id = p.product_id AND r.store_chain = p.store_chain AND grocery_norm(r.reference_name) = p.reference_name
                          AND r.price_unit = 'unit' AND r.package_amount IS NOT NULL LIMIT 1) rf ON true
   WHERE v.id = p_viewer AND grocery_access(p_viewer) = 'couple'
     -- Le foyer qui consulte compte aussi dans la ville consultée (CR-35) : dans sa propre ville il est déjà compté, ailleurs il s'ajoute
     AND cs.household_count + CASE WHEN hc.city_key = cs.city_key THEN 0 ELSE 1 END >= grocery_setting_int('grocery_city_min_households', 2)
     AND p.removed_at IS NULL AND grocery_price_age(p.week_start) IS NOT NULL
$$;
COMMENT ON FUNCTION grocery_shared_prices_for(uuid) IS $$Prix des autres foyers lisibles par un profil du couple : seulement s'il partage lui-même ses prix (réciprocité), pour ses enseignes de proximité (enseigne et ville), dans une ville où au moins 2 foyers partagent, le foyer qui consulte comptant aussi dans la ville consultée (une ville voisine est visible dès qu'un autre foyer y est inscrit ; dans sa propre ville il est déjà compté), hors lignes retirées et au plus 12 mois. Chaque prix porte son enseigne, sa ville et son ancienneté, son unité (par article, kg ou litre) et, quand il peut l'être, son prix au kilo ou au litre (le prix lui-même s'il est déjà au kilo, sinon le prix divisé par la quantité du format de la référence ; vide sans format connu, jamais estimé). Aucun lien avec un foyer. Exécutée avec les droits du propriétaire. [US-154 RF3, RT2, US-157 RF4, US-166 RF3, CR-12, CR-17, CR-21, CR-35, CR-39]$$;

-- Journal des produits à référencer (US-173) : la ville, la référence, le prix et le magasin ne sont gardés que pour un foyer qui partage ses prix
CREATE FUNCTION note_grocery_unreferenced(p_account uuid, p_name text, p_kind grocery_unreferenced_kind, p_source grocery_unreferenced_source,
                                           p_aisle_id integer DEFAULT NULL, p_city text DEFAULT NULL, p_reference text DEFAULT NULL,
                                           p_unit_price numeric DEFAULT NULL, p_store_chain text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_share boolean; v_id bigint; v_details boolean;
BEGIN
  v_share := COALESCE((SELECT share_prices FROM grocery_household_settings WHERE account_id = p_account), false);
  v_details := v_share AND num_nonnulls(p_city, p_reference, p_unit_price, p_store_chain) = 4;
  INSERT INTO grocery_unreferenced_events (name_key, kind, source, aisle_id, seen_city, seen_reference, seen_unit_price, seen_store_chain)
  VALUES (grocery_norm(p_name), p_kind, p_source, p_aisle_id,
          CASE WHEN v_details THEN grocery_norm(p_city) END, CASE WHEN v_details THEN grocery_norm(p_reference) END,
          CASE WHEN v_details THEN p_unit_price END, CASE WHEN v_details THEN grocery_norm(p_store_chain) END)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION note_grocery_unreferenced(uuid, text, grocery_unreferenced_kind, grocery_unreferenced_source, integer, text, text, numeric, text) IS $$Note un produit sans référence conforme (liste, menu validé ou ticket), sans rien demander au foyer et sans garder le foyer. La ville, la référence vue, le prix vu et le magasin ne sont gardés que si le foyer partage ses prix et que les quatre sont donnés ; sinon ils restent vides. Exécutée avec les droits du propriétaire. [US-173 RF1, RF3, CA 3.1]$$;

-- Un produit référencé sort de la liste des produits à référencer (US-173 RF5, US-174 RF2)
CREATE FUNCTION grocery_reference_marks_referenced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO grocery_unreferenced_status (name_key, state)
  SELECT p.name_key, 'referenced' FROM grocery_products p
   WHERE p.id = NEW.product_id AND EXISTS (SELECT 1 FROM grocery_unreferenced_events e WHERE e.name_key = p.name_key)
  ON CONFLICT (name_key) DO UPDATE SET state = 'referenced', changed_at = now() WHERE grocery_unreferenced_status.state <> 'referenced';
  RETURN NULL;
END $$;
CREATE TRIGGER trg_grocery_product_references_referenced AFTER INSERT ON grocery_product_references
  FOR EACH ROW EXECUTE FUNCTION grocery_reference_marks_referenced();
COMMENT ON FUNCTION grocery_reference_marks_referenced() IS $$À l'ajout d'une référence, passe au statut « référencé » le produit du même nom normalisé dans la liste des produits à référencer, qui sort alors de la liste des foyers. [US-173 RF5, US-174 RF2]$$;

-- Budget par rayon et par mois d'un foyer (US-163) : réservé au couple ; les moyennes et le mois passé se déduisent de ces totaux (calculés par l'application)
CREATE FUNCTION grocery_monthly_spend_for(p_viewer uuid)
RETURNS TABLE (aisle_id integer, spend_month date, total numeric)
LANGUAGE sql STABLE AS $$
  SELECT l.aisle_id, date_trunc('month', r.purchased_on)::date, sum(l.line_total)
    FROM users v
    JOIN grocery_receipts r ON r.account_id = v.account_id
    JOIN grocery_receipt_lines l ON l.receipt_id = r.id AND l.account_id = r.account_id
   WHERE v.id = p_viewer AND grocery_access(p_viewer) = 'couple'
   GROUP BY l.aisle_id, date_trunc('month', r.purchased_on)
$$;
COMMENT ON FUNCTION grocery_monthly_spend_for(uuid) IS $$Dépenses d'un foyer par rayon et par mois, d'après ses tickets enregistrés seulement (sans ticket, aucun prix : le budget n'en tient pas compte). Aucune ligne pour un invité secondaire : il n'a pas accès au budget. [US-163 RF1, RF2, RF4, CR-10]$$;

-- Fusion de deux rayons (US-169 RF2) : les produits, lignes de tickets, produits de liste et notes de l'ancien rayon passent au rayon conservé, puis l'ancien disparaît
CREATE FUNCTION merge_grocery_aisles(p_from integer, p_into integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_from = p_into THEN
    RAISE EXCEPTION 'Deux rayons différents sont nécessaires pour une fusion' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM grocery_aisles WHERE id = p_from) OR NOT EXISTS (SELECT 1 FROM grocery_aisles WHERE id = p_into) THEN
    RAISE EXCEPTION 'Rayon inconnu' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE grocery_products SET aisle_id = p_into WHERE aisle_id = p_from;
  UPDATE grocery_receipt_lines SET aisle_id = p_into WHERE aisle_id = p_from;
  UPDATE grocery_list_items SET aisle_id = p_into WHERE aisle_id = p_from;
  UPDATE grocery_unreferenced_events SET aisle_id = p_into WHERE aisle_id = p_from;
  DELETE FROM grocery_aisles WHERE id = p_from;
END $$;
COMMENT ON FUNCTION merge_grocery_aisles(integer, integer) IS $$Fusionne le premier rayon dans le second : produits, lignes de tickets (donc budget passé), produits de liste et produits à référencer sont rangés dans le rayon conservé, puis le premier rayon est supprimé. Exécutée avec les droits du propriétaire (touche les données de tous les foyers). [US-169 RF2, CA 2.1]$$;

-- Un agent retiré (CR-34) est invisible du catalogue et des tableaux de bord : on ne peut plus l'ajouter à un dashboard
CREATE FUNCTION profile_agent_not_retired() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.removed_at IS NULL AND (TG_OP = 'INSERT' OR OLD.removed_at IS NOT NULL)
     AND EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id AND status = 'retired') THEN
    RAISE EXCEPTION 'Cet agent est retiré du catalogue' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_profile_agents_not_retired BEFORE INSERT OR UPDATE ON profile_agents
  FOR EACH ROW EXECUTE FUNCTION profile_agent_not_retired();
COMMENT ON FUNCTION profile_agent_not_retired() IS $$Refuse l'ajout (ou le ré-ajout) d'un agent retiré à un dashboard. Un agent retiré est réversible et invisible du catalogue et des tableaux de bord. [CR-34]$$;

-- Un agent retiré porte sa date de retrait ; un agent qui ne l'est pas n'en porte pas
ALTER TABLE agents
  ADD CONSTRAINT ck_agents_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL));

-- L'Assistant Famille a une tuile fixe : il n'est jamais listé dans le catalogue
UPDATE agents SET listed_in_catalog = false WHERE platform = 'anthropic' AND platform_agent_ref = 'assistant-famille';

-- Agent natif « Courses et repas » (US-152, décision du PO du 07/11/2026) : appelé par l'API Anthropic directe comme l'Assistant Famille, rubrique Perso, listé dans le catalogue ; sa ligne est une donnée
-- de référence (les données du foyer se rattachent au compte, pas à l'agent). Les exemples de demandes se saisissent dans la console.
INSERT INTO agents (platform, platform_agent_ref, name, category_id, short_description, full_description, status) VALUES
  ('anthropic', 'courses-repas', 'Courses et repas', (SELECT id FROM agent_categories WHERE code = 'perso'),
   'Le menu de la semaine en 5 minutes, des courses sans oubli, une séance de batch cooking de 2 h au plus et vos prix comparés.',
   '1. Penser aux courses une seule fois par semaine.
2. Utiliser vos propres recettes, ou en recevoir d''autres.
3. Établir le menu de la semaine et les recettes en 5 minutes.
4. Faire les courses sans oubli grâce à l''historique, en 5 minutes.
5. Préparer les repas de la semaine en 2 heures au plus.
6. Réduire les achats à emporter et en livraison.
7. Des références et des substituts sans ingrédients nocifs.
8. Comparer les prix aux prix de référence et à ceux des foyers proches.
9. Suivre l''évolution du budget courses et repas.
10. Comparer votre stratégie d''achat.

Réglages, listes et menus partagés par le foyer.
Partagez vos prix pour voir ceux des foyers proches.', 'available');

-- ---------------------------------------------------------------------
-- Vues de la console (US-164, US-166, US-170 à US-173, US-175)
-- ---------------------------------------------------------------------
CREATE VIEW v_grocery_product_references AS
SELECT r.id AS reference_id, r.product_id, r.store_chain, r.reference_name, r.unit_price, r.price_date,
       grocery_price_age(r.price_date) AS price_age,
       (r.compliance_status <> 'none_found' AND NOT EXISTS (SELECT 1 FROM grocery_additive_criteria c WHERE c.is_active
                    AND grocery_norm(c.label) IN (SELECT grocery_norm(a) FROM unnest(r.additives) a))) AS is_compliant,
       ARRAY(SELECT c.label FROM grocery_additive_criteria c WHERE c.is_active
              AND grocery_norm(c.label) IN (SELECT grocery_norm(a) FROM unnest(r.additives) a) ORDER BY c.label) AS excluded_because,
       r.unit_price IS NOT NULL AS has_price,
       r.compliance_status,
       (r.compliance_status = 'to_check' AND NOT EXISTS (SELECT 1 FROM grocery_additive_criteria c WHERE c.is_active
                    AND grocery_norm(c.label) IN (SELECT grocery_norm(a) FROM unnest(r.additives) a))) AS needs_label_check,
       r.composition_text,
       r.package_format,
       r.package_amount,
       r.package_unit,
       r.price_unit,
       CASE WHEN r.price_unit <> 'unit' THEN r.price_unit ELSE r.package_unit END AS measure_unit,
       CASE WHEN r.unit_price IS NULL THEN NULL
            WHEN r.price_unit <> 'unit' THEN r.unit_price
            WHEN r.package_amount IS NOT NULL THEN round(r.unit_price / r.package_amount, 2) END AS price_per_measure
  FROM grocery_product_references r;
COMMENT ON VIEW v_grocery_product_references IS $$Références par enseigne avec leur ancienneté (fresh / aging / NULL au-delà de 12 mois ou sans prix ; has_price les distingue : sans prix, « N/A ») et leur conformité, recalculée à chaque lecture : non conforme si le statut déclaré est « aucun conforme trouvé » (none_found) ou si un additif correspond à un critère actif, quel que soit le statut (excluded_because liste alors les critères). Une référence non conforme n'est jamais proposée et sert à la rubrique « Ingrédients exclus des références proposées ». needs_label_check : référence proposée avec la mention « Composition à vérifier sur l'étiquette » (statut « à vérifier »). package_format : format du conditionnement. package_amount, package_unit : sa quantité en kg ou en litres. price_unit : le prix est par article, par kg ou par litre. measure_unit, price_per_measure : prix au kilo ou au litre, calculé (le prix tel quel s'il est déjà au kilo, sinon le prix divisé par la quantité du format) ; vide sans prix ou sans quantité connue, jamais estimé. [US-157 RF1, RF8, US-166 RF3, US-167 RF2, CA 1.1, CR-36, CR-37, CR-39]$$;

CREATE VIEW v_meal_batch_week_days AS
SELECT d.week_id, d.weekday, d.planning_dish_name, d.dish_id, d.suggested_dish_id, d.match_pct, d.needs_catalog_addition,
       meal_match_status(d.match_pct, d.dish_id) AS match_status,
       CASE WHEN d.dish_id IS NOT NULL THEN d.dish_id
            WHEN meal_match_status(d.match_pct, d.dish_id) IN ('sure', 'to_confirm') THEN d.suggested_dish_id END AS effective_dish_id,
       meal_match_status(d.match_pct, d.dish_id) = 'absent' AS blocks_week
  FROM meal_batch_week_days d;
COMMENT ON VIEW v_meal_batch_week_days IS $$Plats de planning avec leur statut de correspondance (sure / to_confirm / absent, d'après les seuils de la console), le plat du catalogue effectivement utilisé (le plat confirmé, sinon le plat suggéré tant que la correspondance est sûre par son pourcentage ou à confirmer) et s'ils bloquent leur semaine (« absent »). Alimente la liste des correspondances à corriger. [US-171 RF1, RF2, CA 1.1]$$;

CREATE VIEW v_meal_batch_weeks AS
SELECT w.id AS week_id, w.code, w.cuisine_id, w.theme, w.session_minutes,
       (SELECT count(*) FROM meal_batch_week_days d WHERE d.week_id = w.id) AS day_count,
       (SELECT count(*) FROM v_meal_batch_week_days d WHERE d.week_id = w.id AND d.effective_dish_id IS NOT NULL) AS linked_count,
       (SELECT count(*) FROM meal_batch_week_days d WHERE d.week_id = w.id) = 5
         AND NOT EXISTS (SELECT 1 FROM v_meal_batch_week_days d WHERE d.week_id = w.id AND d.blocks_week) AS is_usable
  FROM meal_batch_weeks w;
COMMENT ON VIEW v_meal_batch_weeks IS $$Semaines types avec leur durée, le nombre de plats reliés au catalogue et si elles sont utilisables : cinq jours renseignés et aucun plat « absent » du catalogue. Une semaine bloquée n'est pas proposée aux foyers. [US-170 RF4, US-171 CA 1.1]$$;

CREATE VIEW v_meal_dishes_console AS
SELECT d.id AS dish_id, d.code, d.name, d.cuisine_id, d.duration_minutes, d.is_express, d.retired_at,
       EXISTS (SELECT 1 FROM meal_batch_week_days b WHERE b.dish_id = d.id OR b.suggested_dish_id = d.id) AS in_batch_week,
       EXISTS (SELECT 1 FROM meal_light_versions v WHERE v.dish_id = d.id) AS has_light_version
  FROM meal_dishes d;
COMMENT ON VIEW v_meal_dishes_console IS $$Plats du catalogue pour la console : plat express (15 minutes au plus), retiré ou non, présence dans une semaine type et d'une version allégée. Permet de signaler les plats sans semaine type et de compter les plats express. [US-164 RF2, RF4]$$;

CREATE VIEW v_grocery_unreferenced AS
SELECT e.name_key, count(*) AS occurrences, min(e.occurred_at) AS first_seen_at, max(e.occurred_at) AS last_seen_at,
       CASE WHEN bool_or(e.kind = 'unknown') THEN 'unknown' ELSE 'no_reference' END AS kind,
       max(e.aisle_id) AS aisle_id, COALESCE(s.state, 'to_reference') AS state
  FROM grocery_unreferenced_events e
  LEFT JOIN grocery_unreferenced_status s ON s.name_key = e.name_key
 GROUP BY e.name_key, s.state;
COMMENT ON VIEW v_grocery_unreferenced IS $$Produits à référencer regroupés par nom normalisé, avec leur nombre d'occurrences (du plus demandé au moins demandé), leur type (inconnu / sans référence), leur rayon et leur statut (à référencer par défaut). Aucune donnée de foyer. [US-173 RF2, CA 2.1]$$;

CREATE VIEW v_grocery_shared_prices_moderation AS
SELECT p.id AS price_id, p.product_id, p.reference_name, p.unit_price, p.store_chain, p.city, p.week_start, p.removed_at,
       b.basis, b.baseline,
       p.removed_at IS NULL AND CASE
         WHEN b.basis IS NOT NULL THEN p.unit_price * 100 < b.baseline * grocery_setting_int('grocery_check_low_pct', 50)
                                    OR p.unit_price * 100 > b.baseline * grocery_setting_int('grocery_check_high_pct', 200)
           ELSE p.unit_price < grocery_setting_int('grocery_check_floor_cents', 5) / 100.0
           OR p.unit_price > grocery_setting_int('grocery_check_ceiling_cents', 50000) / 100.0 END AS needs_check,
       p.price_unit
  FROM grocery_shared_prices p
  LEFT JOIN LATERAL (
    SELECT CASE WHEN m.n >= grocery_setting_int('grocery_check_min_samples', 3) THEN 'median'
                WHEN rf.ref_price IS NOT NULL THEN 'reference' END AS basis,
           CASE WHEN m.n >= grocery_setting_int('grocery_check_min_samples', 3) THEN m.median_price ELSE rf.ref_price END AS baseline
      FROM (SELECT count(*) AS n, (percentile_cont(0.5) WITHIN GROUP (ORDER BY o.unit_price))::numeric AS median_price
              FROM grocery_shared_prices o
             WHERE o.product_id = p.product_id AND o.store_chain = p.store_chain AND o.id <> p.id AND o.removed_at IS NULL
               AND o.price_unit = p.price_unit
               AND o.week_start >= current_date - make_interval(months => grocery_setting_int('grocery_check_window_months', 12))) m,
           (SELECT CASE WHEN p.price_unit = 'unit' THEN
                    COALESCE((SELECT r.unit_price FROM grocery_product_references r
                               WHERE r.product_id = p.product_id AND r.store_chain = p.store_chain AND grocery_norm(r.reference_name) = p.reference_name),
                             (SELECT avg(r.unit_price) FROM grocery_product_references r
                               WHERE r.product_id = p.product_id AND r.store_chain = p.store_chain))
                  ELSE
                    COALESCE((SELECT v.price_per_measure FROM v_grocery_product_references v
                               WHERE v.product_id = p.product_id AND v.store_chain = p.store_chain AND grocery_norm(v.reference_name) = p.reference_name
                                 AND v.measure_unit = p.price_unit),
                             (SELECT avg(v.price_per_measure) FROM v_grocery_product_references v
                               WHERE v.product_id = p.product_id AND v.store_chain = p.store_chain AND v.measure_unit = p.price_unit))
                  END AS ref_price) rf
  ) b ON true;
COMMENT ON VIEW v_grocery_shared_prices_moderation IS $$Base commune pour la modération, avec le signalement « à vérifier » : le prix est comparé à la médiane du même produit dans la même enseigne sur 12 mois (au moins 3 autres valeurs), sinon au prix de référence de l'enseigne ; il est à vérifier sous 50 % ou au-dessus de 200 % de cette base. Sans aucune base : sous 0,05 € ou au-dessus de 500 €. Les quatre bornes, le nombre de valeurs et la fenêtre sont des réglages de la console. Une ligne retirée n'est jamais signalée. Aucune colonne ne retrouve le foyer. Un prix au kilo ou au litre n'est comparé qu'à des prix de même unité (médiane) ou, à défaut, au prix au kilo ou au litre des références (price_unit, en dernière colonne). [US-175 RF1 à RF4, CR-33, CR-39]$$;

-- ---------------------------------------------------------------------
-- Purge (CR-23) : menus validés, tickets et lignes, produits achetés de la liste, journal des produits à référencer, preuves arrivées à échéance
-- ---------------------------------------------------------------------
CREATE FUNCTION purge_expired_grocery_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint; v_total bigint := 0;
BEGIN
  DELETE FROM meal_menus WHERE validated_at < now() - make_interval(months => grocery_setting_int('meal_menu_retention_months', 12));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  -- Tickets : l'année en cours et les deux précédentes (3 ans par défaut)
  DELETE FROM grocery_receipts
   WHERE purchased_on < make_date(extract(year FROM current_date)::integer - (grocery_setting_int('grocery_receipt_retention_years', 3) - 1), 1, 1);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_list_items
   WHERE state = 'bought' AND bought_at < now() - make_interval(months => grocery_setting_int('grocery_bought_retention_months', 3));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_lists l
   WHERE l.validated_at < now() - make_interval(months => grocery_setting_int('grocery_bought_retention_months', 3))
     AND NOT EXISTS (SELECT 1 FROM grocery_list_items i WHERE i.list_id = l.id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_unreferenced_events
   WHERE occurred_at < now() - make_interval(months => grocery_setting_int('grocery_unreferenced_retention_months', 12));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_unreferenced_status s
   WHERE s.state = 'to_reference' AND NOT EXISTS (SELECT 1 FROM grocery_unreferenced_events e WHERE e.name_key = s.name_key);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  DELETE FROM grocery_price_sharing_events WHERE retain_until < current_date;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  -- Base commune des prix : les lignes de plus de 12 mois (fenêtre du contrôle des prix) sont supprimées, retirées ou non (CR-35) ; le catalogue n'est pas concerné
  DELETE FROM grocery_shared_prices
   WHERE week_start < current_date - make_interval(months => grocery_setting_int('grocery_check_window_months', 12));
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  -- Compteurs du plafond quotidien de menus : 7 jours (CR-44)
  DELETE FROM meal_menu_daily_counters WHERE menu_date < current_date - 7;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RETURN v_total;
END $$;
COMMENT ON FUNCTION purge_expired_grocery_data() IS $$Supprime les menus validés de plus de 12 mois, les tickets (avec leurs lignes) antérieurs à l'année en cours moins deux, les produits achetés de la liste de plus de 3 mois (et les listes validées devenues vides), les entrées du journal des produits à référencer de plus de 12 mois, les preuves de consentement arrivées à échéance, les lignes de la base commune des prix de plus de 12 mois (réglage de la fenêtre grocery_check_window_months ; le catalogue n'est pas concerné) et les compteurs du plafond quotidien de menus de plus de 7 jours. Les durées sont des réglages de la console (à confirmer par le DPO, CR-26). À planifier chaque jour. [CR-23, CR-35, CR-44]$$;

-- ---------------------------------------------------------------------
-- Sécurité par ligne des données du foyer (activée, non forcée ; variable de session app.user_id) : le couple a tout, l'invité secondaire lit la liste et
-- y ajoute un produit. La base commune des prix n'a aucune règle : un rôle limité n'y lit rien, la lecture passe par grocery_shared_prices_for().
-- ---------------------------------------------------------------------
ALTER TABLE grocery_household_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_household_settings_couple ON grocery_household_settings
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE grocery_household_cuisines ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_household_cuisines_couple ON grocery_household_cuisines
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE grocery_household_stores ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_household_stores_couple ON grocery_household_stores
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE grocery_household_dietary ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_household_dietary_couple ON grocery_household_dietary
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_household_dishes ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_household_dishes_couple ON meal_household_dishes
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_household_dish_ingredients ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_household_dish_ingredients_couple ON meal_household_dish_ingredients
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_household_dish_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_household_dish_tags_couple ON meal_household_dish_tags
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menus ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menus_couple ON meal_menus
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menu_entries_couple ON meal_menu_entries
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_entry_ingredients ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menu_entry_ingredients_couple ON meal_menu_entry_ingredients
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_entry_light_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menu_entry_light_items_couple ON meal_menu_entry_light_items
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_session_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menu_session_steps_couple ON meal_menu_session_steps
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_menu_daily_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_menu_daily_counters_couple ON meal_menu_daily_counters
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE meal_light_choices ENABLE ROW LEVEL SECURITY;
CREATE POLICY meal_light_choices_couple ON meal_light_choices
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE grocery_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_receipts_couple ON grocery_receipts
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
ALTER TABLE grocery_receipt_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_receipt_lines_couple ON grocery_receipt_lines
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
-- Liste de courses : le couple a tout ; l'invité secondaire lit, ajoute en son nom, augmente une quantité (garde-fou du trigger) et retire ses propres ajouts
ALTER TABLE grocery_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_lists_couple ON grocery_lists
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
CREATE POLICY grocery_lists_member_read ON grocery_lists FOR SELECT
  USING (account_id = (SELECT grocery_member_account()));
ALTER TABLE grocery_list_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_list_items_couple ON grocery_list_items
  USING (account_id = (SELECT grocery_couple_account())) WITH CHECK (account_id = (SELECT grocery_couple_account()));
CREATE POLICY grocery_list_items_member_read ON grocery_list_items FOR SELECT
  USING (account_id = (SELECT grocery_member_account()));
CREATE POLICY grocery_list_items_member_add ON grocery_list_items FOR INSERT
  WITH CHECK (account_id = (SELECT grocery_member_account()) AND added_by_user_id = (SELECT app_current_user_id()));
CREATE POLICY grocery_list_items_member_update ON grocery_list_items FOR UPDATE
  USING (account_id = (SELECT grocery_member_account())) WITH CHECK (account_id = (SELECT grocery_member_account()));
CREATE POLICY grocery_list_items_member_delete ON grocery_list_items FOR DELETE
  USING (account_id = (SELECT grocery_member_account()) AND added_by_user_id = (SELECT app_current_user_id()));
ALTER TABLE grocery_shared_prices ENABLE ROW LEVEL SECURITY;

-- Réglages de la console (US-65) : plafond de séance, répétition, seuils de correspondance, ancienneté des prix, ville affichée, seuils « à vérifier »
-- (en centimes pour les bornes absolues), durées de conservation
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('meal_session_cap_minutes',          'integer', '120',   30, 600,      $$Plafond de la séance de batch cooking du dimanche, en minutes ; avec l'objectif « temps », seules les semaines sous ce plafond sont retenues, sinon l'alerte « Séance au-dessus de 2 h » (US-156 RF5, RT3)$$),
  ('meal_menu_daily_cap',               'integer', '10',    1,  100,      $$Nombre maximum de menus complets composés par un foyer et par jour, corrections comprises ; au-delà, l'agent invite à reprendre le lendemain (US-156 RF12ter, CR-44)$$),
  ('meal_repeat_weeks_default',         'integer', '2',     1,  4,        $$Nombre de semaines avant qu'un plat revienne, par défaut, pour les foyers qui n'ont pas choisi (US-153 RF2, US-156 RT3)$$),
  ('meal_match_sure_pct',               'integer', '80',    1,  100,      $$Pourcentage de correspondance à partir duquel un plat de planning est « sûr » (US-171 RF1)$$),
  ('meal_match_check_pct',              'integer', '40',    1,  99,       $$Pourcentage de correspondance à partir duquel un plat de planning est « à confirmer » ; en dessous il est « absent » et bloque sa semaine (US-171 RF1)$$),
  ('grocery_price_fresh_months',        'integer', '6',     1,  36,       $$Âge en mois jusqu'auquel un prix s'affiche « < 6 mois » (US-166 RF3, CR-20)$$),
  ('grocery_price_max_months',          'integer', '12',    1,  60,       $$Âge en mois au-delà duquel un prix n'est plus affiché (« < 12 mois » jusque-là) (US-166 RF3, CR-20)$$),
  ('grocery_city_min_households',       'integer', '2',     2,  100,      $$Nombre de foyers qui partagent leurs prix dans une ville à partir duquel la ville est affichée aux autres foyers ; ne descend pas sous 2 (US-154 RT2, CR-17)$$),
  ('grocery_check_low_pct',             'integer', '50',    1,  100,      $$Un prix partagé est « à vérifier » en dessous de ce pourcentage de la médiane (ou du prix de référence) (US-175 RF2, CR-33)$$),
  ('grocery_check_high_pct',            'integer', '200',   100, 10000,   $$Un prix partagé est « à vérifier » au-dessus de ce pourcentage de la médiane (ou du prix de référence) (US-175 RF2, CR-33)$$),
  ('grocery_check_floor_cents',         'integer', '5',     0,  100000,   $$Sans médiane ni prix de référence, un prix partagé est « à vérifier » en dessous de ce montant, en centimes (0,05 €) (US-175 RF2, CR-33)$$),
  ('grocery_check_ceiling_cents',       'integer', '50000', 1,  10000000, $$Sans médiane ni prix de référence, un prix partagé est « à vérifier » au-dessus de ce montant, en centimes (500 €) (US-175 RF2, CR-33)$$),
  ('grocery_check_min_samples',         'integer', '3',     1,  100,      $$Nombre d'autres valeurs du même produit dans la même enseigne nécessaires pour utiliser la médiane comme base du contrôle (US-175 RF2, CR-33)$$),
  ('grocery_check_window_months',       'integer', '12',    1,  36,       $$Fenêtre, en mois, des valeurs retenues pour la médiane du contrôle des prix partagés ; au-delà, les lignes de la base commune sont supprimées par la purge quotidienne (US-175 RF2, CR-33, CR-35)$$),
  ('meal_menu_retention_months',        'integer', '12',    1,  60,       $$Conservation des menus validés d'un foyer, en mois ; à confirmer par le DPO (CR-23, CR-26)$$),
  ('grocery_receipt_retention_years',   'integer', '3',     1,  10,       $$Conservation des tickets, de leurs lignes et du budget, en années civiles (l'année en cours et les précédentes : 3 = l'année en cours et deux précédentes) ; à confirmer par le DPO (CR-23, CR-26)$$),
  ('grocery_bought_retention_months',   'integer', '3',     1,  24,       $$Conservation des produits achetés de la liste de courses (« Produits de mon historique »), en mois ; à confirmer par le DPO (US-157 RF3, CR-23, CR-26)$$),
  ('grocery_unreferenced_retention_months', 'integer', '12', 1, 60,       $$Conservation du journal des produits à référencer, en mois ; à confirmer par le DPO (US-173, CR-23, CR-26)$$);

-- =====================================================================
-- 9. FONCTIONS, TRIGGERS ET VUES
-- =====================================================================

-- Mise à jour automatique de updated_at (audit)
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Rappel « suppression dans 7 jours » (US-58 RF3) : un seul par délai de grâce. Quand le compte sort du délai de grâce (reprise), le rappel
-- est remis à vide, pour qu'un nouveau délai de grâce puisse en recevoir un.
CREATE FUNCTION account_grace_reminder_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.grace_reminder_sent_at := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_accounts_grace_reminder_reset BEFORE UPDATE OF status ON accounts
  FOR EACH ROW WHEN (NEW.status <> 'grace_period' AND NEW.grace_reminder_sent_at IS NOT NULL)
  EXECUTE FUNCTION account_grace_reminder_reset();
COMMENT ON FUNCTION account_grace_reminder_reset() IS $$Remet à vide le rappel de suppression d'un compte qui sort du délai de grâce (reprise), pour qu'un nouveau délai puisse en recevoir un. [US-58 RF3]$$;

-- Pose le trigger sur TOUTES les tables possédant une colonne updated_at (évite 25 déclarations répétitives)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', r.table_name);
  END LOOP;
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
CREATE TRIGGER trg_users_guest_quota BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION enforce_guest_quota();

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
CREATE TRIGGER trg_profile_agents_rules BEFORE INSERT OR UPDATE ON profile_agents
  FOR EACH ROW EXECUTE FUNCTION enforce_profile_agent_rules();

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
CREATE TRIGGER trg_cc_addresses_limit BEFORE INSERT ON cc_addresses FOR EACH ROW EXECUTE FUNCTION enforce_cc_limit();

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
CREATE TRIGGER trg_user_agent_info_values_position BEFORE INSERT OR UPDATE OF item_position, info_field_id ON user_agent_info_values
  FOR EACH ROW EXECUTE FUNCTION enforce_info_value_position();

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
CREATE TRIGGER trg_contract_documents_limit BEFORE INSERT ON contract_documents
  FOR EACH ROW EXECUTE FUNCTION enforce_contract_document_limit();

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
COMMENT ON VIEW v_profile_agent_missing_items IS $$Éléments manquants (connecteur ou information) et responsable (profil ou utilisateur principal) par agent du dashboard. [US-29 RT1]$$;

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
 WHERE pa.removed_at IS NULL
   AND a.status <> 'retired';
COMMENT ON VIEW v_dashboard_agents IS $$Agents actifs d'un profil avec statut Prêt / À configurer / Bloqué ; les agents retirés du catalogue n'y figurent pas. [US-22, 29, 31, 42, CR-34]$$;

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
COMMENT ON VIEW v_info_prefill_suggestions IS $$Valeurs déjà saisies pour un autre agent (même clé commune et même type) proposées pré-remplies pour un champ encore vide. [US-10 RF12]$$;

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
COMMENT ON VIEW v_never_activated_purge_candidates IS $$Profils jamais activés dont le dernier lien a plus de 30 jours (réglable) : à purger (compte entier pour un utilisateur principal). [US-58, décision N8]$$;

-- Quota d'invités : « N invités sur M — M−N places disponibles » (US-21)
CREATE VIEW v_account_guest_quota AS
SELECT a.id AS account_id, a.guest_quota,
       count(u.id) AS guests_used,
       greatest(a.guest_quota - count(u.id), 0) AS places_left
  FROM accounts a
  LEFT JOIN users u ON u.account_id = a.id AND u.role = 'guest' AND u.status IN ('pending_activation', 'active')
 GROUP BY a.id, a.guest_quota;
COMMENT ON VIEW v_account_guest_quota IS $$Quota d'invités par compte : invités comptés (en attente, expirés, échec d'envoi, actifs ; pas les invités retirés ni en délai de grâce), places restantes. [US-21]$$;

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
COMMENT ON VIEW v_guest_display_status IS $$Statut affiché des invités : Envoi en cours, Invitation envoyée, Invitation expirée, Échec d'envoi, Actif. [US-4, 5, 18, 21]$$;

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
COMMENT ON FUNCTION logbook_visible_entries(uuid) IS $$Entrées du carnet visibles par un profil selon son rang (décision D3). [US-40, 50]$$;

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
COMMENT ON FUNCTION ensure_logbook_partitions(integer) IS $$Crée les partitions mensuelles du carnet et de ses participants (mois courant + N à venir). À planifier chaque mois. [US-40]$$;

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
COMMENT ON FUNCTION purge_expired_logbook(interval) IS $$Supprime les entrées du carnet au-delà de la durée de rétention (réglage logbook_retention_months, 14 mois par défaut) : partitions entières puis lignes du mois frontière. À planifier chaque jour. [US-40 RF6, RT6]$$;

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
COMMENT ON FUNCTION register_agent_request(uuid, date) IS $$Compte une demande d'un profil et applique le plafond quotidien du compte : true = acceptée, false = plafond atteint. [US-38]$$;

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
COMMENT ON FUNCTION purge_expired_error_reports() IS $$Supprime les signalements plus anciens que error_report_retention_months (14 mois par défaut). À planifier chaque jour. [US-61 RT2]$$;

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
COMMENT ON FUNCTION purge_expired_security_events() IS $$Supprime les événements de sécurité plus anciens que security_event_retention_months (36 mois par défaut). À planifier chaque mois. [US-7, 19, 53]$$;

-- Partitions initiales du carnet : mois courant + 3 mois à venir
SELECT ensure_logbook_partitions(3);
