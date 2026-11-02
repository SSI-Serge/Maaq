-- MAAQ — lot 12 : Vidéo de présentation : écran « Découvrir MAAQ » vu ou passé, remplacement de la vidéo journalisé (US-140)
-- Fichier généré par construire_migrations.py à partir de maaq_schema.sql ; ne pas modifier à la main.
-- À appliquer dans une seule transaction, après lot_12_1_valeurs_enumerees.sql s'il existe.

-- ---------------------------------------------------------------------
-- Colonnes et contraintes ajoutées à des tables existantes
-- ---------------------------------------------------------------------
-- Écran « Découvrir MAAQ » (vidéo de présentation) vu ou passé : une seule date par profil, aucune autre statistique de lecture (US-140 RF4, RT3)
ALTER TABLE users
  ADD COLUMN presentation_seen_at    timestamptz;

-- ---------------------------------------------------------------------
-- Commentaires
-- ---------------------------------------------------------------------
COMMENT ON COLUMN users.presentation_seen_at IS $$Date à laquelle le profil a vu ou passé l'écran « Découvrir MAAQ » (vidéo de présentation) : l'écran n'est plus proposé ensuite ; vide tant qu'il n'a pas été vu. Seule donnée de lecture conservée (aucune durée, aucun compteur). Entre dans l'export des données du profil et disparaît avec lui. [US-140 RF4, RT3]$$;
