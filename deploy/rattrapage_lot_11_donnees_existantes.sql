-- MAAQ — lot 11 (Contrats V2) pour une base qui contient déjà des contrats et des documents : variante de lot_11_2_schema.sql.
-- À appliquer APRÈS lot_11_1_valeurs_enumerees.sql (identique pour tous), À LA PLACE de lot_11_2_schema.sql, une seule fois, en une transaction.
-- Une base neuve (sans contrat) applique lot_11_2_schema.sql tel quel et n'a pas besoin de ce fichier. Résultat identique : même catalogue, mêmes contraintes.
-- Différences avec lot_11_2_schema.sql, et seulement elles :
--  1. la colonne account_contracts.name est ajoutée facultative, remplie avec le nom de la catégorie (60 caractères au plus), puis rendue obligatoire ;
--  2. les contrats existants deviennent le contrat de base de leur catégorie (is_base = true) ;
--  3. les documents de l'ancien dépôt libre (contract_documents, US-34) sont supprimés (C-04) : la table reste, vide et obsolète.
-- Aucune autre donnée n'est modifiée. Dérivé mécaniquement de lot_11_2_schema.sql (trois passages remplacés ou ajoutés).

-- ---------------------------------------------------------------------
-- Types énumérés
-- ---------------------------------------------------------------------
-- Contrats V2 (lot 11, US-122 à US-138)
CREATE TYPE contract_channel      AS ENUM ('analysis', 'challenge');
CREATE TYPE contract_document_kind AS ENUM ('pdf', 'photos');
CREATE TYPE contract_masking_status AS ENUM ('pending', 'masking', 'to_verify', 'verified', 'uncertain', 'unreadable');
CREATE TYPE contract_mask_type    AS ENUM ('person', 'address', 'email', 'phone', 'contract_number', 'bank_account', 'vehicle', 'social_security',
                                           'employer', 'account_identifier', 'manual', 'other');
CREATE TYPE contract_analysis_status AS ENUM ('running', 'awaiting_admin', 'completed', 'failed', 'cancelled');
CREATE TYPE contract_review_decision AS ENUM ('continue', 'stop');

-- ---------------------------------------------------------------------
-- Contraintes d'unicité que les clés étrangères des tables ci-dessous référencent
-- ---------------------------------------------------------------------
ALTER TABLE account_contracts
  ADD CONSTRAINT uq_account_contracts_id_account UNIQUE (id, account_id);

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
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
-- Relances (US-135) : « Relancer l'analyse » et « Renvoyer » (challenge), tant que les documents existent ; une relance ne prolonge pas le délai de 48 h
CREATE TABLE contract_transmission_relaunches (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transmission_id       bigint NOT NULL REFERENCES contract_transmissions (id) ON DELETE CASCADE,
  channel               contract_channel NOT NULL,
  relaunched_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  relaunched_at         timestamptz NOT NULL DEFAULT now()
);
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
-- Compteurs de masques par type, sans les valeurs (US-136 RT4)
CREATE TABLE contract_document_mask_counts (
  document_id  bigint NOT NULL REFERENCES contract_field_documents (id) ON DELETE CASCADE,
  mask_type    contract_mask_type NOT NULL,
  mask_count   integer NOT NULL CHECK (mask_count >= 0),
  PRIMARY KEY (document_id, mask_type)
);
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

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- Texte libre des réglages de la console (nom du courtier) : 120 caractères au plus
ALTER TABLE platform_settings
  ADD CONSTRAINT ck_platform_settings_free_text CHECK (value_type <> 'free_text' OR value_text IS NULL OR length(value_text) <= 120);
-- ---------------------------------------------------------------------
-- Contrats de la famille (US-124, US-125, US-127, US-128, US-133) : account_contracts devient « un contrat » ; la catégorie est contract_definitions.
-- Le contrat de base porte d'abord le nom de la catégorie ; il est créé d'office (ensure_base_contracts) et non supprimable. Le premier contrat d'une
-- catégorie pour une famille est toujours le contrat de base.
-- Interrupteur « challenge » : colonnes consent_* existantes (US-36), désormais par contrat. Interrupteur « analyse » : colonnes analysis_*.
-- ---------------------------------------------------------------------
ALTER TABLE account_contracts
  ADD COLUMN name varchar(60) CHECK (name = btrim(name) AND length(name) >= 1);
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
-- Contrats existants (au plus un par catégorie et par famille jusqu'ici) : chacun devient le contrat de base de sa catégorie et reprend son nom
UPDATE account_contracts c
   SET name = btrim(left(btrim(d.name), 60)), is_base = true
  FROM contract_definitions d
 WHERE d.id = c.contract_definition_id;
ALTER TABLE account_contracts
  ALTER COLUMN name SET NOT NULL;
-- Plusieurs contrats par catégorie et par famille : l'unicité (compte, catégorie) disparaît
ALTER TABLE account_contracts
  DROP CONSTRAINT account_contracts_account_id_contract_definition_id_key;
-- Preuve des consentements par contrat (CT-4) : deux canaux, analyse et challenge ; le journal existant (contract_consent_events) reçoit le canal et le
-- contrat, SANS clé étrangère pour survivre à la suppression du contrat et du compte
ALTER TABLE contract_consent_events
  ADD COLUMN channel contract_channel NOT NULL DEFAULT 'challenge';
ALTER TABLE contract_consent_events
  ADD COLUMN account_contract_id bigint;

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
-- Challenge disponible : le nom du courtier et l'adresse de sa boîte sont renseignés dans la console (vides = challenge bloqué, C-10)
CREATE FUNCTION contract_challenge_available() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT length(btrim(value_text)) > 0 FROM platform_settings WHERE setting_key = 'contract_broker_name'), false)
     AND COALESCE((SELECT length(btrim(value_text)) > 0 FROM platform_settings WHERE setting_key = 'contract_broker_email'), false)
$$;
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
-- Le contrat de base n'est jamais supprimé seul (on peut seulement vider ses informations et ses documents, US-35) ; il part avec le compte (cascade)
CREATE FUNCTION account_contract_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_base AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'Le contrat de base d''une catégorie ne se supprime pas' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
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
-- Contrats visibles par un profil : ceux du noyau (utilisateur principal et invité 1) ; jamais un invité secondaire (US-32 RF4, CT-1)
CREATE FUNCTION account_contracts_visible_to(p_viewer uuid) RETURNS SETOF account_contracts LANGUAGE sql STABLE AS $$
  SELECT c.* FROM account_contracts c JOIN users v ON v.id = p_viewer AND v.account_id = c.account_id
   WHERE v.role = 'primary_user' OR v.guest_rank = 'core'
$$;
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
CREATE FUNCTION contract_analysis_transition_allowed(p_from contract_analysis_status, p_to contract_analysis_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (('running', 'awaiting_admin'), ('running', 'completed'), ('running', 'failed'), ('running', 'cancelled'),
                            ('awaiting_admin', 'running'), ('awaiting_admin', 'failed'), ('awaiting_admin', 'cancelled'), ('failed', 'running'))
$$;
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
-- À la transmission, les documents du contrat sont datés et verrouillés ; leur suppression est fixée à 48 h après (trigger des documents)
CREATE FUNCTION contract_transmission_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contract_field_documents SET transmitted_at = NEW.transmitted_at WHERE account_contract_id = NEW.account_contract_id;
  RETURN NULL;
END $$;
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
CREATE FUNCTION contract_relaunch_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel = 'analysis' THEN
    UPDATE contract_transmissions SET analysis_status = 'running', analysis_attempts = analysis_attempts + 1, analysis_failure_notified_at = NULL WHERE id = NEW.transmission_id;
  ELSE
    UPDATE contract_transmissions SET challenge_status = 'sending', challenge_attempts = challenge_attempts + 1 WHERE id = NEW.transmission_id;
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION contract_masking_transition_allowed(p_from contract_masking_status, p_to contract_masking_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (('pending', 'masking'), ('masking', 'pending'), ('masking', 'to_verify'), ('masking', 'uncertain'), ('masking', 'unreadable'),
                            ('to_verify', 'verified'), ('uncertain', 'verified'))
$$;
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
-- La décision fait avancer l'analyse : « poursuivre » la relance, « ne pas poursuivre » l'annule
CREATE FUNCTION contract_review_after_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contract_transmissions
     SET analysis_status = CASE NEW.decision WHEN 'continue' THEN 'running'::contract_analysis_status ELSE 'cancelled'::contract_analysis_status END
   WHERE id = NEW.transmission_id AND analysis_status = 'awaiting_admin';
  RETURN NULL;
END $$;
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
-- Documents jamais transmis qui seront supprimés dans 3 jours ou moins : marque l'avertissement et retourne ce qu'il faut notifier au déposant (une seule fois par
-- document). À planifier chaque heure ou chaque jour.
CREATE FUNCTION warn_expiring_contract_documents()
RETURNS TABLE (document_id bigint, account_contract_id bigint, uploaded_by_user_id uuid, expires_at timestamptz) LANGUAGE sql AS $$
  UPDATE contract_field_documents d SET expiry_warned_at = now()
   WHERE d.transmitted_at IS NULL AND d.expiry_warned_at IS NULL AND d.expires_at > now() AND d.expires_at <= now() + interval '3 days'
  RETURNING d.id, d.account_contract_id, d.uploaded_by_user_id, d.expires_at
$$;

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX ux_contract_document_fields_name ON contract_document_fields (contract_definition_id, lower(name));
-- Un seul contrat de base par catégorie et par famille ; un nom unique dans la catégorie pour la famille, sans tenir compte des majuscules (US-125 RF1)
CREATE UNIQUE INDEX ux_account_contracts_base ON account_contracts (account_id, contract_definition_id) WHERE is_base;
CREATE UNIQUE INDEX ux_account_contracts_name ON account_contracts (account_id, contract_definition_id, lower(name));
CREATE INDEX idx_account_contracts_created_by ON account_contracts (created_by_user_id);
CREATE INDEX idx_account_contracts_analysis_changed_by ON account_contracts (analysis_changed_by_user_id);
CREATE INDEX idx_contract_consent_events_contract ON contract_consent_events (account_contract_id) WHERE account_contract_id IS NOT NULL;
CREATE INDEX idx_contract_transmissions_contract ON contract_transmissions (account_contract_id, transmitted_at DESC);
CREATE INDEX idx_contract_transmissions_transmitted_by ON contract_transmissions (transmitted_by_user_id);
CREATE INDEX idx_contract_transmissions_analysis_open ON contract_transmissions (transmitted_at) WHERE analysis_status IN ('running', 'awaiting_admin');
CREATE INDEX idx_contract_relaunches_transmission ON contract_transmission_relaunches (transmission_id);
CREATE INDEX idx_contract_relaunches_user ON contract_transmission_relaunches (relaunched_by_user_id);
CREATE INDEX idx_contract_documents_field ON contract_field_documents (field_id);
CREATE INDEX idx_contract_documents_uploaded_by ON contract_field_documents (uploaded_by_user_id);
CREATE INDEX idx_contract_documents_verified_by ON contract_field_documents (verified_by_user_id);
CREATE INDEX idx_contract_documents_expiry ON contract_field_documents (expires_at);
CREATE INDEX idx_contract_reviews_pending ON contract_analysis_reviews (created_at) WHERE decision IS NULL;
CREATE INDEX idx_contract_reviews_decided_by ON contract_analysis_reviews (decided_by_user_id);
CREATE INDEX idx_contract_reports_account_id ON contract_reports (account_id);
CREATE INDEX idx_contract_report_refs_member ON contract_report_refs (member_id, account_id) WHERE member_id IS NOT NULL;
CREATE INDEX idx_contract_report_refs_field ON contract_report_refs (field_definition_id) WHERE field_definition_id IS NOT NULL;
CREATE INDEX idx_contract_report_refs_account ON contract_report_refs (account_contract_id, account_id);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_contract_document_fields_before_write BEFORE INSERT OR UPDATE ON contract_document_fields
  FOR EACH ROW EXECUTE FUNCTION contract_document_field_before_write();
CREATE CONSTRAINT TRIGGER trg_contract_document_fields_required AFTER INSERT OR UPDATE OR DELETE ON contract_document_fields
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION contract_document_fields_required();
CREATE TRIGGER trg_account_contracts_before_insert BEFORE INSERT ON account_contracts
  FOR EACH ROW EXECUTE FUNCTION account_contract_before_insert();
CREATE TRIGGER trg_account_contracts_before_update BEFORE UPDATE ON account_contracts
  FOR EACH ROW EXECUTE FUNCTION account_contract_before_update();
CREATE TRIGGER trg_account_contracts_before_delete BEFORE DELETE ON account_contracts
  FOR EACH ROW EXECUTE FUNCTION account_contract_before_delete();
CREATE TRIGGER trg_contract_definitions_before_delete BEFORE DELETE ON contract_definitions
  FOR EACH ROW EXECUTE FUNCTION contract_definition_before_delete();
CREATE TRIGGER trg_contract_consent_events_before_insert BEFORE INSERT ON contract_consent_events
  FOR EACH ROW EXECUTE FUNCTION contract_consent_event_before_insert();
CREATE TRIGGER trg_contract_transmissions_before_insert BEFORE INSERT ON contract_transmissions
  FOR EACH ROW EXECUTE FUNCTION contract_transmission_before_insert();
CREATE TRIGGER trg_contract_transmissions_after_insert AFTER INSERT ON contract_transmissions
  FOR EACH ROW EXECUTE FUNCTION contract_transmission_after_insert();
CREATE TRIGGER trg_contract_transmissions_before_update BEFORE UPDATE ON contract_transmissions
  FOR EACH ROW EXECUTE FUNCTION contract_transmission_before_update();
CREATE TRIGGER trg_contract_relaunches_before_insert BEFORE INSERT ON contract_transmission_relaunches
  FOR EACH ROW EXECUTE FUNCTION contract_relaunch_before_insert();
CREATE TRIGGER trg_contract_relaunches_after_insert AFTER INSERT ON contract_transmission_relaunches
  FOR EACH ROW EXECUTE FUNCTION contract_relaunch_after_insert();
CREATE TRIGGER trg_contract_documents_before_insert BEFORE INSERT ON contract_field_documents
  FOR EACH ROW EXECUTE FUNCTION contract_field_document_before_insert();
CREATE TRIGGER trg_contract_documents_before_update BEFORE UPDATE ON contract_field_documents
  FOR EACH ROW EXECUTE FUNCTION contract_field_document_before_update();
CREATE TRIGGER trg_contract_documents_before_delete BEFORE DELETE ON contract_field_documents
  FOR EACH ROW EXECUTE FUNCTION contract_field_document_before_delete();
CREATE TRIGGER trg_contract_reviews_before_insert BEFORE INSERT ON contract_analysis_reviews
  FOR EACH ROW EXECUTE FUNCTION contract_review_before_insert();
CREATE TRIGGER trg_contract_reviews_before_update BEFORE UPDATE ON contract_analysis_reviews
  FOR EACH ROW EXECUTE FUNCTION contract_review_before_update();
CREATE TRIGGER trg_contract_reviews_after_decision AFTER UPDATE OF decision ON contract_analysis_reviews
  FOR EACH ROW WHEN (OLD.decision IS NULL AND NEW.decision IS NOT NULL) EXECUTE FUNCTION contract_review_after_decision();
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
-- Réglages de la console (US-65) : partenaire du challenge (vides = challenge bloqué), plafond de contrats, conservation sans transmission, seuil de lecture
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('contract_broker_name',                    'free_text', NULL, NULL, NULL, $$Nom du courtier partenaire du challenge, cité dans le texte de consentement ; vide = challenge bloqué (US-128 RF2bis, C-10)$$),
  ('contract_broker_email',                   'email',     NULL, NULL, NULL, $$Adresse de la boîte du courtier qui reçoit les documents du challenge ; vide = challenge bloqué, modifiable sans livraison (US-129 RT2, C-10)$$),
  ('max_contracts_per_category',              'integer',   '20', 1, 200, $$Contrats au plus par catégorie et par famille, contrat de base compris : plafond technique, invisible en usage normal (US-124 RF3, C-08)$$),
  ('contract_document_retention_days',        'integer',   '30', 1, 365, $$Conservation d'un document de contrat sans transmission, en jours ; 48 h après la transmission dans tous les cas (US-126 RF7, C-01)$$),
  ('contract_read_confidence_threshold_pct',  'integer',   '80', 0, 100, $$Seuil de confiance de lecture (OCR) en pourcentage : en dessous, la lecture est incertaine et l'analyse attend la décision d'un administrateur (US-136 RF6, US-138 RT2)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON TABLE contract_definitions IS $$Catégories de contrats proposées dans « Mes contrats » (Assurance Auto, Mutuelle…), communes à tous les clients : ex-« contrats obligatoires ». Chaque catégorie a, pour chaque famille, un contrat de base et des contrats complémentaires, ses champs de documents (contract_document_fields) et ses champs de détail (contract_field_definitions). [US-32, 48, 122, 124]$$;
COMMENT ON TABLE account_contracts IS $$Contrat d'une famille (accessible au noyau seulement) : de base (un par catégorie, créé d'office, non supprimable) ou complémentaire (supprimable), nom libre, interrupteurs d'analyse (analysis_*) et de challenge (consent_*), dernière modification. [US-32, 33, 35, 36, 124, 125, 127, 128, 133]$$;
COMMENT ON COLUMN account_contracts.consent_active IS $$Interrupteur « challenge » du contrat : désactivé par défaut, partagé par le noyau, impossible à activer tant que le courtier n'est pas désigné (C-10). La preuve est dans contract_consent_events (canal challenge). Remis à false par la suppression complète des informations du contrat (US-35 RF5). [US-128]$$;
COMMENT ON TABLE contract_documents IS $$OBSOLÈTE depuis les contrats V2 (C-01, C-04) : ancien dépôt libre de documents classés dans le Drive de l'utilisateur principal (US-34), remplacé par contract_field_documents ; vidée à la mise en service, conservée vide en attendant sa suppression. [US-34, 35]$$;
COMMENT ON TABLE contract_consent_events IS $$Journal append-only des consentements à l'analyse IA et au challenge, par contrat (qui, quand, quelle version du texte). Conservé 5 ans après la fin d'abonnement, d'où l'absence de FK vers le compte. [US-36 RT1]$$;
COMMENT ON FUNCTION contract_challenge_available() IS $$Vrai si le nom du courtier et l'adresse de sa boîte (réglages de la console) sont renseignés ; faux = challenge bloqué : l'interrupteur est inactif et aucun consentement ne peut être donné. [US-128 RF2bis, C-10]$$;
COMMENT ON TABLE contract_document_fields IS $$Champs de documents attendus pour une catégorie de contrat (nom, aide, obligatoire ou facultatif, ordre) : 0 à 10 par catégorie, au moins un obligatoire dès qu'il y en a un. Communs à tous les contrats de la catégorie. Retirer un champ supprime les documents qui y sont déposés. [US-122, US-123]$$;
COMMENT ON COLUMN contract_document_fields.name IS $$Nom du champ (80 caractères au plus), unique dans la catégorie sans tenir compte des majuscules, par exemple « Conditions particulières »$$;
COMMENT ON COLUMN account_contracts.name IS $$Nom libre du contrat, de 1 à 60 caractères, unique dans la catégorie pour la famille sans tenir compte des majuscules. Le contrat de base porte d'abord le nom de sa catégorie. Jamais envoyé à l'agent d'analyse (il peut contenir un prénom). [US-125]$$;
COMMENT ON COLUMN account_contracts.is_base IS $$Contrat de base de la catégorie : un seul par famille, créé d'office, jamais supprimé ; le premier contrat d'une catégorie est toujours le contrat de base. Faux = contrat complémentaire, supprimable. [US-124, US-133, CT-2]$$;
COMMENT ON COLUMN account_contracts.analysis_enabled IS $$Interrupteur « Analyse IA » du contrat : désactivé par défaut, durable, partagé par le noyau. La preuve est dans contract_consent_events (canal analysis). [US-127]$$;
COMMENT ON FUNCTION contract_definition_before_delete() IS $$Refuse la suppression d'une catégorie qui contient des contrats d'au moins une famille, ou dont un consentement a été enregistré : elle s'archive (archived_at), n'est plus proposée, ne reçoit plus de contrats ni de dépôt de documents, et ses contrats restent consultables sans transmission. Une catégorie sans contrat se supprime avec ses champs de documents et de détail. [C-19, US-139]$$;
COMMENT ON FUNCTION ensure_base_contracts(uuid, uuid) IS $$Crée le contrat de base de chaque catégorie proposée qui n'en a pas pour la famille, avec le nom de la catégorie (idempotent). À appeler à l'ouverture de « Mes contrats ». Retourne le nombre de contrats créés. [US-124 RF1, US-125 RF2, CT-2]$$;
COMMENT ON FUNCTION account_contracts_visible_to(uuid) IS $$Contrats d'un profil : ceux de sa famille s'il est utilisateur principal ou invité 1 ; aucun pour un invité secondaire. [US-32 RF4, CT-1]$$;
COMMENT ON COLUMN contract_consent_events.channel IS $$Canal du consentement : analysis (analyse IA) ou challenge. Le texte accepté (legal_version_id) est celui du canal$$;
COMMENT ON COLUMN contract_consent_events.account_contract_id IS $$Contrat concerné (identifiant seul, SANS clé étrangère : la preuve est conservée après la suppression du contrat). Vide pour une preuve antérieure aux contrats par catégorie$$;
COMMENT ON TABLE contract_transmissions IS $$Transmission des documents d'un contrat pour analyse, challenge ou les deux : qui, quand, état de chaque canal (analyse en cours, en attente d'un administrateur, terminée, échouée, annulée ; challenge en cours d'envoi, envoyé, échec), tentatives. Historique du contrat, supprimé avec lui. Aucun contenu. [US-129, US-135, US-138]$$;
COMMENT ON COLUMN contract_transmissions.analysis_last_error IS $$Dernier message d'erreur technique de l'analyse : aucun contenu de document ni donnée personnelle$$;
COMMENT ON COLUMN contract_transmissions.challenge_last_error IS $$Dernier message d'erreur technique de l'envoi du challenge : aucune donnée personnelle$$;
COMMENT ON FUNCTION contract_analysis_transition_allowed(contract_analysis_status, contract_analysis_status) IS $$Transitions permises de l'état d'une analyse : en cours vers en attente d'un administrateur, terminée, échouée ou annulée ; en attente vers en cours (poursuivre), échouée ou annulée ; échouée vers en cours (relance). Terminée et annulée sont définitives. [US-135, US-138]$$;
COMMENT ON TABLE contract_transmission_relaunches IS $$Relances d'une transmission : relance de l'analyse ou renvoi au challenge, par qui et quand (une relance d'analyse compte comme une demande dans le plafond quotidien, C-11). Possibles tant que les documents existent ; ne prolongent pas le délai de 48 h. [US-135 RF1, RF3, RF5, US-131 RT4]$$;
COMMENT ON TABLE contract_field_documents IS $$Document déposé dans un champ d'un contrat : un PDF ou jusqu'à 10 photos formant un seul document, stocké chiffré (nom chiffré, fichier dans le stockage chiffré), avec qui l'a déposé et quand. Verrouillé 48 h après la transmission, puis supprimé ; supprimé au bout de 30 jours sans transmission (avertissement 3 jours avant). Porte aussi l'anonymisation : état, score, versions, texte masqué chiffré (supprimé avec le document), vérification. Donnée de famille sensible (documents de contrat). [US-126, US-134, US-136, US-137, C-01]$$;
COMMENT ON COLUMN contract_field_documents.expires_at IS $$Date de suppression, tenue par trigger : dépôt + 30 jours (réglage contract_document_retention_days) ; à la transmission, transmission + 48 h. La purge supprime le document à cette date (C-01)$$;
COMMENT ON COLUMN contract_field_documents.masking_status IS $$pending = en attente ; masking = masquage en cours ; to_verify = à vérifier (masquage terminé) ; verified = vérifié par l'utilisateur ; uncertain = lecture incertaine (score sous le seuil) ; unreadable = illisible (à remplacer). [US-136 RF7]$$;
COMMENT ON COLUMN contract_field_documents.masked_text IS $$Texte masqué chiffré, jetons typés seulement ([PERSONNE_1]…) : pseudonymisation, le texte reste une donnée personnelle. Aucune table de correspondance entre jetons et valeurs n'existe. Supprimé avec le document. [US-136 RT3, RT6]$$;
COMMENT ON COLUMN contract_field_documents.confidence_pct IS $$Score de confiance de la lecture (OCR), de 0 à 100 ; comparé au seuil contract_read_confidence_threshold_pct$$;
COMMENT ON TABLE contract_document_mask_counts IS $$Nombre de masques posés dans un document, par type (personne, adresse, email, téléphone, numéro de contrat, compte bancaire, véhicule, sécurité sociale, employeur, identifiant de compte, masque ajouté à la main, autre). Aucune valeur masquée. Supprimé avec le document. [US-136 RT4]$$;
COMMENT ON FUNCTION contract_masking_transition_allowed(contract_masking_status, contract_masking_status) IS $$Transitions permises de l'état d'anonymisation d'un document : en attente vers masquage en cours (et retour pour un nouvel essai), masquage vers à vérifier, lecture incertaine ou illisible, à vérifier ou lecture incertaine vers vérifié. Un document illisible ne se vérifie pas : il se remplace (retour à « en attente »). [US-136, US-137 RF7]$$;
COMMENT ON TABLE contract_analysis_reviews IS $$Demande « Analyses à valider » : créée quand un contrat est transmis pour analyse avec une lecture incertaine ; décision de l'administrateur (poursuivre ou ne pas poursuivre), qui et quand, nombre de masques ajoutés. Expire à la suppression des documents. Chaque consultation et chaque décision sont inscrites dans le journal d'administration (admin_audit_log). L'administrateur ne lit que la vue v_contract_reviews_to_decide : texte masqué et catégorie, jamais le document, le nom du contrat ni la famille. [US-138]$$;
COMMENT ON VIEW v_contract_reviews_to_decide IS $$Demandes « Analyses à valider » en attente, document par document : catégorie, champ, pages, score de lecture, texte masqué chiffré, date limite. Ne contient jamais le document d'origine, le nom du contrat, la famille ni le profil : c'est la seule lecture de la console. À journaliser à chaque consultation (admin_audit_log). [US-138 RF2, RT1, RT3]$$;
COMMENT ON TABLE contract_reports IS $$Rapport d'analyse d'un contrat : un seul, remplacé par le suivant (aucun historique), HTML chiffré avec des jetons et des références, jamais de valeur personnelle. Conservé jusqu'à son remplacement ou la suppression du contrat, même après la suppression des documents. [US-132, US-131]$$;
COMMENT ON TABLE contract_report_refs IS $$Jetons d'un rapport qui désignent un membre de la famille ou un détail du contrat (références, comme D39) : le prénom ou la valeur est lu à l'affichage, jamais stocké ici. Aucune valeur personnelle, aucune table de correspondance pour les autres jetons. Supprimés avec le rapport. [US-132 RT3]$$;
COMMENT ON FUNCTION purge_expired_contract_documents() IS $$Supprime les documents de contrat échus (48 h après la transmission, ou 30 jours après le dépôt sans transmission) avec leur texte masqué, ferme et supprime les demandes d'analyse à valider échues, et met les fichiers en file de suppression. À planifier chaque heure. [US-126 RT2, C-01, C-18]$$;
COMMENT ON FUNCTION warn_expiring_contract_documents() IS $$Marque l'avertissement « supprimés dans 3 jours s'ils ne sont pas transmis » et retourne les documents concernés (identifiant, contrat, déposant, échéance) : une seule fois par document, atomique. La notification est envoyée par l'application. À planifier chaque heure ou chaque jour. [US-126 RF7, C-01]$$;

-- Mise en service (C-04) : les documents de l'ancien dépôt libre (US-34) sont supprimés ; la table reste, vide et obsolète
DELETE FROM contract_documents;
