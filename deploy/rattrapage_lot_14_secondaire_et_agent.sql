-- MAAQ — rattrapage additif du lot 14 (décision du PO du 07/11/2026 sur l'agent natif ; CR-38 : l'invité secondaire coche « acheté ») pour une base qui a DÉJÀ reçu
-- lot_14_2_schema.sql (version 5298e454…) ET rattrapage_lot_14_references_sans_prix.sql (ebbb0218…). Une base neuve applique le lot_14_2_schema.sql régénéré (nouvelle
-- empreinte) et n'a pas besoin de ce fichier. Une seule transaction, idempotent (réappliqué, il ne change rien). Aucune ligne existante n'est supprimée.
--  1. agents.listed_in_catalog (vrai par défaut), mis à faux pour l'Assistant Famille (tuile fixe) : le catalogue filtre dessus au lieu de la plateforme.
--  2. Ligne de l'agent natif « Courses et repas » (platform 'anthropic', platform_agent_ref 'courses-repas', rubrique Perso, disponible), insérée si elle n'existe pas.
--  3. CR-38 : nouveau garde-fou grocery_list_item_before_write() (l'invité secondaire coche « acheté » n'importe quel article de la liste validée, décoche ce qu'il a coché,
--     rien d'autre) et nouvelle fonction de lecture grocery_list_for() (le prix estimé n'est rendu qu'au couple) ; commentaires.
--  Pas de valeur d'énumération ajoutée : aucun fichier de valeurs à part.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS listed_in_catalog boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN agents.listed_in_catalog IS $$Vrai = l'agent est proposé dans le catalogue (rubriques Pro et Perso) ; faux = agent à tuile fixe, jamais listé (Assistant Famille). Remplace le filtre sur la plateforme, qui ne distingue pas un agent natif à tuile fixe d'un agent natif du catalogue (Courses et repas). Vrai par défaut. [US-22, 23, 106, décision du PO du 07/11/2026]$$;

UPDATE agents SET listed_in_catalog = false WHERE platform = 'anthropic' AND platform_agent_ref = 'assistant-famille';

INSERT INTO agents (platform, platform_agent_ref, name, category_id, short_description, full_description, status) SELECT 'anthropic', 'courses-repas', 'Courses et repas', (SELECT id FROM agent_categories WHERE code = 'perso'),
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
Partagez vos prix pour voir ceux des foyers proches.', 'available'
WHERE NOT EXISTS (SELECT 1 FROM agents WHERE platform = 'anthropic' AND platform_agent_ref = 'courses-repas');

CREATE OR REPLACE FUNCTION grocery_list_item_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
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
COMMENT ON FUNCTION grocery_list_item_before_write() IS $$Garde-fou de la liste de courses : un invité secondaire (profil indiqué dans app.user_id) peut ajouter un produit en son nom, augmenter une quantité, cocher « acheté » n'importe quel article de la liste validée (état validé ou ajouté depuis la validation, à son nom) et décocher ce qu'il a lui-même coché ; il ne change jamais un magasin, une référence, un prix, une quantité en même temps ni le libellé. Sans profil indiqué, le garde-fou ne s'applique pas (H144). [US-158 RF2, RF3, US-162, CR-10, CR-38]$$;

CREATE OR REPLACE FUNCTION grocery_list_for(p_viewer uuid)
RETURNS TABLE (id uuid, list_id uuid, state grocery_item_state, source text, label varchar, name_key text, product_id bigint, aisle_id integer, quantity smallint,
               added_by_user_id uuid, not_bought_last_time boolean, store_chain varchar, reference_name varchar, unit_price numeric, bought_at timestamptz,
               bought_by_user_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT i.id, i.list_id, i.state, i.source, i.label, i.name_key, i.product_id, i.aisle_id, i.quantity, i.added_by_user_id, i.not_bought_last_time,
         i.store_chain, i.reference_name, CASE WHEN grocery_access(p_viewer) = 'couple' THEN i.unit_price END, i.bought_at, i.bought_by_user_id
    FROM users v
    JOIN grocery_list_items i ON i.account_id = v.account_id
   WHERE v.id = p_viewer AND grocery_access(p_viewer) IS NOT NULL
$$;
COMMENT ON FUNCTION grocery_list_for(uuid) IS $$Articles de la liste de courses de la famille d'un profil, pour l'affichage : le prix estimé n'est rendu qu'au couple, l'invité secondaire ne voit aucun prix (il voit le magasin et la référence). L'application l'utilise pour lire la liste ; tant qu'elle se connecte avec un seul rôle, la protection effective des colonnes est cette fonction et le code (H150). [US-157 RF8, US-158, CR-10, CR-38]$$;
COMMENT ON TABLE grocery_list_items IS $$Produit de la liste de courses du foyer, avec son état : en préparation, validé, ajouté depuis la validation (sans magasin ni prix, en tête de « Ma liste de courses »), acheté. Un produit n'est qu'une fois dans la liste ouverte (la quantité augmente). Les produits non achetés reviennent en préparation avec « pas acheté la dernière fois » (grocery_carry_over_unbought). Les produits achetés forment l'historique du foyer, conservé 3 mois (réglable). Le couple retire tout ; un invité secondaire ne retire que ses propres ajouts, n'augmente que les quantités et peut cocher « acheté » (CR-38), sans voir aucun prix (grocery_list_for). [US-157 RF3, RF9, US-158, US-162, CR-10, CR-27, CR-28]$$;
