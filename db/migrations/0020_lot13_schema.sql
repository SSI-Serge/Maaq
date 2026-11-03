-- MAAQ — lot 13 : Émotions : cœurs, mots libres, bilan de la semaine, envies à deux, couple (US-141 à US-151)
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_13_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- Envie ajoutée à « Nos envies » (US-149) : la clé étrangère vers couple_wishes est posée avec cette table (lot 13)
ALTER TABLE scheduled_notifications
  ADD COLUMN wish_id uuid;
ALTER TABLE scheduled_notifications
  DROP CONSTRAINT ck_scheduled_notifications_subject;
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT ck_scheduled_notifications_subject CHECK (
    CASE WHEN kind = 'wish_added'
           THEN wish_id IS NOT NULL AND event_id IS NULL AND task_id IS NULL AND subject_date IS NULL
         WHEN kind IN ('task_daily', 'weekly_digest', 'outing_proposal')
           THEN subject_date IS NOT NULL AND event_id IS NULL AND task_id IS NULL
         WHEN kind IN ('task_due_1h', 'task_assigned')
           THEN task_id IS NOT NULL AND event_id IS NULL AND subject_date IS NULL
         ELSE event_id IS NOT NULL AND task_id IS NULL AND subject_date IS NULL END);
-- Notification « [Prénom] a ajouté une envie à deux » (US-149) : une ligne par envie et par destinataire (sans le titre)
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT fk_scheduled_notifications_wish FOREIGN KEY (wish_id) REFERENCES couple_wishes (id) ON DELETE CASCADE;
ALTER TABLE scheduled_notifications
  ADD CONSTRAINT ck_scheduled_notifications_wish CHECK ((kind = 'wish_added') = (wish_id IS NOT NULL));

-- ---------------------------------------------------------------------
-- Fonctions et vues
-- ---------------------------------------------------------------------
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
CREATE FUNCTION emotion_couple_exists(p_account uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM users p WHERE p.account_id = p_account AND p.role = 'primary_user' AND emotion_partner_of(p.id) IS NOT NULL)
$$;
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
-- Retrait direct refusé une fois le mot figé ; la suppression par cascade (bilan, profil, compte) et par purge reste permise
CREATE FUNCTION partner_note_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.weekly_review_id IS NOT NULL AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'Ce mot est figé : le bilan de son destinataire a été ouvert' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
-- Première ouverture du bilan : les mots non rattachés de l'autre parent lui sont rattachés et figés (US-143 RF8). SECURITY DEFINER : le destinataire
-- ne voit pas encore ces mots, la sécurité par ligne l'empêcherait de les mettre à jour.
CREATE FUNCTION weekly_review_attach_notes() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE partner_notes SET weekly_review_id = NEW.id
   WHERE account_id = NEW.account_id AND recipient_user_id = NEW.user_id AND weekly_review_id IS NULL;
  RETURN NULL;
END $$;
CREATE FUNCTION partner_notes_visible_to(p_viewer uuid) RETURNS SETOF partner_notes
LANGUAGE sql STABLE AS $$
  SELECT n.* FROM partner_notes n
   WHERE emotion_partner_of(p_viewer) IS NOT NULL
     AND (n.author_user_id = p_viewer OR (n.recipient_user_id = p_viewer AND n.weekly_review_id IS NOT NULL))
$$;
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
-- Le cœur d'une tâche part quand elle n'est plus faite, ou quand elle n'est plus faite par l'autre parent (US-141 RF6)
CREATE FUNCTION appreciation_heart_task_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM appreciation_hearts h
   WHERE h.task_id = NEW.id
     AND (NEW.status <> 'done'
          OR (SELECT fm.user_id FROM family_members fm WHERE fm.id = NEW.done_by_member_id) IS DISTINCT FROM emotion_partner_of(h.author_user_id));
  RETURN NULL;
END $$;
-- Le cœur d'un RDV part si le RDV passe dans le futur (E-15), s'il n'est plus confirmé ou si son créateur change
CREATE FUNCTION appreciation_heart_event_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM appreciation_hearts h
   WHERE h.event_id = NEW.id
     AND (NEW.status <> 'confirmed' OR NEW.ends_at > now() OR NEW.requested_by_user_id IS DISTINCT FROM emotion_partner_of(h.author_user_id));
  RETURN NULL;
END $$;
CREATE FUNCTION appreciation_hearts_visible_to(p_viewer uuid) RETURNS SETOF appreciation_hearts
LANGUAGE sql STABLE AS $$
  SELECT h.* FROM appreciation_hearts h
   JOIN users v ON v.id = p_viewer AND v.account_id = h.account_id
   WHERE emotion_partner_of(p_viewer) IS NOT NULL
     AND (h.task_id IS NOT NULL OR h.event_id IN (SELECT id FROM family_events_visible_to(p_viewer)))
$$;
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
CREATE FUNCTION couple_wishes_visible_to(p_viewer uuid) RETURNS SETOF couple_wishes
LANGUAGE sql STABLE AS $$
  SELECT w.* FROM couple_wishes w
   JOIN users v ON v.id = p_viewer AND v.account_id = w.account_id
   WHERE emotion_partner_of(p_viewer) IS NOT NULL AND w.removed_at IS NULL
$$;
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
-- ---------------------------------------------------------------------
-- Purges : bilans de plus de 4 semaines (avec les mots qui leur sont rattachés) et mots jamais lus de plus de 4 semaines (E-22) ; envies retirées
-- ---------------------------------------------------------------------
-- Même durée que le point de la semaine (réglage weekly_digest_retention_weeks, 4 semaines) ; le bilan couvre la semaine qui précède l'envoi,
-- une semaine avant celle du point : son lundi de départ est donc compté une semaine plus tôt. À planifier chaque jour.
CREATE FUNCTION purge_expired_emotion_data() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_weeks integer; v_a bigint; v_b bigint;
BEGIN
  SELECT value_text::integer INTO v_weeks FROM platform_settings WHERE setting_key = 'weekly_digest_retention_weeks';
  v_weeks := COALESCE(v_weeks, 4);
  DELETE FROM weekly_reviews WHERE week_start < current_date - (v_weeks + 1) * 7;
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM partner_notes WHERE weekly_review_id IS NULL AND created_at < now() - make_interval(weeks => v_weeks);
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;
CREATE FUNCTION purge_removed_wishes() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  DELETE FROM couple_wishes WHERE removed_at IS NOT NULL AND removed_at <= now() - interval '10 seconds';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------
CREATE INDEX idx_weekly_reviews_user ON weekly_reviews (user_id, account_id);
CREATE INDEX idx_weekly_reviews_week ON weekly_reviews (week_start);
CREATE INDEX idx_partner_notes_account ON partner_notes (account_id);
CREATE INDEX idx_partner_notes_author ON partner_notes (author_user_id, account_id);
CREATE INDEX idx_partner_notes_recipient ON partner_notes (recipient_user_id, account_id);
CREATE INDEX idx_partner_notes_review ON partner_notes (weekly_review_id, recipient_user_id) WHERE weekly_review_id IS NOT NULL;
CREATE INDEX idx_partner_notes_unread ON partner_notes (created_at) WHERE weekly_review_id IS NULL;
CREATE UNIQUE INDEX ux_hearts_task ON appreciation_hearts (task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX ux_hearts_event ON appreciation_hearts (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_hearts_account ON appreciation_hearts (account_id);
CREATE INDEX idx_hearts_author ON appreciation_hearts (author_user_id, account_id);
CREATE INDEX idx_hearts_event_account ON appreciation_hearts (event_id, account_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_hearts_task_account ON appreciation_hearts (task_id, account_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_couple_wishes_account ON couple_wishes (account_id) WHERE removed_at IS NULL;
CREATE INDEX idx_couple_wishes_created_by ON couple_wishes (created_by_user_id);
CREATE INDEX idx_couple_wishes_removed ON couple_wishes (removed_at) WHERE removed_at IS NOT NULL;
CREATE UNIQUE INDEX ux_scheduled_notifications_wish ON scheduled_notifications (wish_id, recipient_user_id) WHERE wish_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Triggers et sécurité par ligne
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_weekly_reviews_before_write BEFORE INSERT OR UPDATE ON weekly_reviews
  FOR EACH ROW EXECUTE FUNCTION weekly_review_before_write();
CREATE TRIGGER trg_partner_notes_before_write BEFORE INSERT OR UPDATE ON partner_notes
  FOR EACH ROW EXECUTE FUNCTION partner_note_before_write();
CREATE TRIGGER trg_partner_notes_before_delete BEFORE DELETE ON partner_notes
  FOR EACH ROW EXECUTE FUNCTION partner_note_before_delete();
CREATE TRIGGER trg_weekly_reviews_attach_notes AFTER UPDATE OF opened_at ON weekly_reviews
  FOR EACH ROW WHEN (OLD.opened_at IS NULL AND NEW.opened_at IS NOT NULL) EXECUTE FUNCTION weekly_review_attach_notes();
CREATE TRIGGER trg_appreciation_hearts_before_write BEFORE INSERT OR UPDATE ON appreciation_hearts
  FOR EACH ROW EXECUTE FUNCTION appreciation_heart_before_write();
CREATE TRIGGER trg_family_tasks_heart AFTER UPDATE OF status, done_by_member_id ON family_tasks
  FOR EACH ROW EXECUTE FUNCTION appreciation_heart_task_changed();
CREATE TRIGGER trg_family_events_heart AFTER UPDATE OF status, ends_at, requested_by_user_id ON family_events
  FOR EACH ROW EXECUTE FUNCTION appreciation_heart_event_changed();
CREATE TRIGGER trg_couple_wishes_before_write BEFORE INSERT OR UPDATE ON couple_wishes
  FOR EACH ROW EXECUTE FUNCTION couple_wish_before_write();
CREATE TRIGGER trg_users_couple_dissolved AFTER UPDATE OF status, role, guest_rank ON users
  FOR EACH ROW WHEN (OLD.role = 'guest' AND OLD.guest_rank = 'core' AND OLD.status IN ('active', 'grace_period')
                     AND NOT (NEW.role = 'guest' AND NEW.guest_rank = 'core' AND NEW.status IN ('active', 'grace_period')))
  EXECUTE FUNCTION emotion_couple_dissolved();
CREATE TRIGGER trg_users_couple_dissolved_delete AFTER DELETE ON users
  FOR EACH ROW WHEN (OLD.role = 'guest' AND OLD.guest_rank = 'core' AND OLD.status IN ('active', 'grace_period'))
  EXECUTE FUNCTION emotion_couple_dissolved();
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
-- Réglages de la console (US-65) : nombre maximal d'envies, seuils de l'indicateur de charge (calculé par l'application, E-16)
INSERT INTO platform_settings (setting_key, value_type, value_text, min_value, max_value, description) VALUES
  ('wish_max_per_family',     'integer', '50', 1, 500, $$Nombre maximal d'envies « Nos envies » par famille ; au-delà, le message « Vous avez beaucoup d'envies ! » (US-148 RF5, RT1)$$),
  ('workload_busy_min',       'integer', '2',  1, 50,  $$Nombre d'éléments d'un parent un jour donné à partir duquel la journée est « Chargé » (par défaut 2 ; 0 à 1 = « Calme »). Calculé par l'application, rien n'est gardé (US-145 RT1, E-16)$$),
  ('workload_very_busy_min',  'integer', '4',  2, 50,  $$Nombre d'éléments d'un parent un jour donné à partir duquel la journée est « Très chargé » (par défaut 4). Calculé par l'application, rien n'est gardé (US-145 RT1, E-16)$$);

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON FUNCTION emotion_partner_of(uuid) IS $$Autre parent du couple d'un profil (utilisateur principal ou invité 1, tous deux actifs) ; NULL pour un invité secondaire, un administrateur, ou quand l'autre parent n'est pas présent. Sert de garde à tous les objets « Émotions ». [US-141, E-03, E-21]$$;
COMMENT ON FUNCTION emotion_couple_exists(uuid) IS $$Vrai si la famille a un couple actif : l'utilisateur principal et un invité 1 actif. [E-21]$$;
COMMENT ON TABLE weekly_reviews IS $$Bilan de la semaine passée d'un parent du couple : seulement le destinataire, la semaine et la date d'ouverture, sans copie du contenu (calculé à l'ouverture, une tâche supprimée après le bilan en disparaît). Existe même si le point est désactivé. Conservé 4 semaines, avec les mots qui lui sont rattachés. [US-142, US-144, E-13, E-17]$$;
COMMENT ON COLUMN weekly_reviews.opened_at IS $$Première ouverture du bilan par son destinataire ; à cet instant, les mots écrits pour lui lui sont rattachés et figés (un mot écrit après l'envoi mais avant l'ouverture entre dans ce bilan). Posée une seule fois. [US-143 RF8]$$;
COMMENT ON TABLE partner_notes IS $$Mot libre d'un parent à l'autre, chiffré par l'application, jamais envoyé à l'agent ni utilisé dans un résumé ni écrit dans un journal. Lisible par son auteur, et par son destinataire après l'ouverture de son bilan seulement ; modifiable et retirable par l'auteur jusqu'à cette ouverture, puis figé. Supprimé avec le bilan (4 semaines), ou 4 semaines après son écriture s'il n'est jamais lu. Donnée sensible (texte libre, E-10). [US-143, E-07, E-22]$$;
COMMENT ON COLUMN partner_notes.weekly_review_id IS $$Bilan du destinataire auquel le mot est rattaché, posé par la base à la première ouverture de ce bilan (jamais directement) ; vide = pas encore lu, l'auteur peut encore le modifier ou le retirer. [US-143 RF4, RF8]$$;
COMMENT ON COLUMN partner_notes.body IS $$Texte chiffré par l'application (500 caractères au plus, vérifiés par l'application) ; la base borne seulement la taille du chiffré$$;
COMMENT ON FUNCTION weekly_review_attach_notes() IS $$À la première ouverture d'un bilan, rattache et fige les mots non rattachés écrits pour son destinataire (un mot écrit après l'envoi mais avant l'ouverture entre dans ce bilan). Exécutée avec les droits du propriétaire (le destinataire ne voit pas encore ces mots). [US-143 RF8]$$;
COMMENT ON FUNCTION partner_notes_visible_to(uuid) IS $$Mots lisibles par un profil : ceux qu'il a écrits, et ceux qu'il a reçus une fois son bilan ouvert (il ne sait pas qu'un mot l'attend avant). Aucun pour un invité secondaire. [US-143 RF3, RT2, E-23]$$;
COMMENT ON TABLE appreciation_hearts IS $$Cœur posé par un parent sur une tâche faite par l'autre parent, ou sur un RDV passé créé par l'autre parent : un seul par élément, avec son auteur et sa date, supprimé avec l'élément. Retiré si la tâche n'est plus faite, si le RDV passe dans le futur ou est annulé, ou quand le couple se défait. Visible des deux parents, pas des invités secondaires ; sans notification ; jamais dans le carnet de bord. [US-141, E-04, E-15]$$;
COMMENT ON FUNCTION appreciation_hearts_visible_to(uuid) IS $$Cœurs visibles d'un profil : ceux de sa famille s'il est l'un des deux parents ; pour un RDV, selon la visibilité du RDV (D26). Aucun pour un invité secondaire. [US-141 RF3, RF7]$$;
COMMENT ON TABLE couple_wishes IS $$Envie partagée par le couple de la famille (« Nos envies ») : titre et description chiffrés, horizon facultatif, auteur, date. Aucune date cible, assignation, pièce jointe ni montant. 50 au plus par famille (réglage wish_max_per_family), lues et écrites par l'utilisateur principal et l'invité 1 seulement, jamais par l'agent ni dans le carnet de bord. Pas de purge automatique : suppression manuelle définitive (retrait, puis purge après les 10 secondes d'annulation) ; supprimées au retrait de l'invité 1. [US-147 à US-151, E-08, E-14, E-20]$$;
COMMENT ON COLUMN couple_wishes.removed_at IS $$Retirée le : posée par « Retirer », remise à vide par « Annuler » (10 secondes) ; une envie retirée n'est plus affichée ni comptée dans les 50, et purge_removed_wishes() la supprime définitivement. [US-150 RF2]$$;
COMMENT ON COLUMN couple_wishes.horizon IS $$Horizon flou facultatif : soon (« Bientôt »), this_year (« Cette année »), someday (« Un jour ») ; ne rien choisir suffit. [US-148 RF2, E-24]$$;
COMMENT ON FUNCTION couple_wishes_visible_to(uuid) IS $$Envies visibles d'un profil : celles de sa famille s'il est l'un des deux parents, hors envies retirées ; aucune pour un invité secondaire. [US-147 RF1, RT2]$$;
COMMENT ON COLUMN scheduled_notifications.wish_id IS $$Envie dont l'ajout est annoncé à l'autre parent (type wish_added) ; la notification ne cite pas le titre. Notification sur le téléphone, e-mail seulement à défaut (D63), pas d'envoi la nuit. [US-149]$$;
COMMENT ON FUNCTION emotion_couple_dissolved() IS $$Supprime les cœurs, les bilans, les mots et les envies d'une famille quand son invité 1 la quitte (retrait, rétrogradation ou suppression) : sans couple, rien de « Émotions » n'existe ; un nouveau partenaire arrive sur une carte vide. Exécutée avec les droits du propriétaire. [E-15, E-20, E-21]$$;
COMMENT ON FUNCTION purge_expired_emotion_data() IS $$Supprime les bilans de plus de 4 semaines (avec les mots qui leur sont rattachés) et les mots jamais lus écrits il y a plus de 4 semaines. À planifier chaque jour. [US-143 RT1, US-144 RT1, E-22]$$;
COMMENT ON FUNCTION purge_removed_wishes() IS $$Supprime définitivement les envies retirées depuis plus de 10 secondes (le délai du bouton « Annuler »). À planifier avec le planificateur existant (toutes les 5 minutes) : tant qu'elle n'a pas passé, l'envie retirée reste en base mais n'est plus affichée ni comptée. [US-150 RF2]$$;
