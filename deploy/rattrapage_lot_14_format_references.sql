-- MAAQ — rattrapage additif du lot 14 (format du conditionnement d'une référence, colonne « format » de l'import des références, US-166 RF2) pour une base qui a DÉJÀ reçu
-- lot_14_2_schema.sql (5298e454…), rattrapage_lot_14_references_sans_prix.sql (ebbb0218…) et rattrapage_lot_14_secondaire_et_agent.sql (9e3600f1…), dans cet ordre. Une base
-- neuve applique le lot_14_2_schema.sql régénéré (nouvelle empreinte) et n'a pas besoin de ce fichier. Une seule transaction, idempotent. Aucune ligne n'est touchée.
--  1. grocery_product_references.package_format varchar(80), facultatif (« 1 kg », « sachet de 250 g »). Le fichier d'import l'appelle « format » ; la colonne ne porte pas ce nom
--     (mot réservé au langage, déjà employé par des fonctions du schéma).
--  2. v_grocery_product_references : colonne package_format ajoutée à la fin.
--  3. grocery_list_for() : colonne package_format ajoutée à la fin (format de la référence retenue de l'article, visible de tous les profils, sans prix). Comme le type de
--     retour change, la fonction est supprimée puis recréée.

ALTER TABLE grocery_product_references ADD COLUMN IF NOT EXISTS package_format varchar(80) CHECK (package_format IS NULL OR btrim(package_format) <> '');
COMMENT ON COLUMN grocery_product_references.package_format IS $$Format du conditionnement de la référence (« 1 kg », « sachet de 250 g »), 80 caractères au plus, facultatif ; colonne « format » du fichier d'import des références. Visible de tous les profils du foyer, sans prix. [US-166 RF2, US-157 RF7]$$;

CREATE OR REPLACE VIEW v_grocery_product_references AS
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
       r.package_format
  FROM grocery_product_references r;
COMMENT ON VIEW v_grocery_product_references IS $$Références par enseigne avec leur ancienneté (fresh / aging / NULL au-delà de 12 mois ou sans prix ; has_price les distingue : sans prix, « N/A ») et leur conformité, recalculée à chaque lecture : non conforme si le statut déclaré est « aucun conforme trouvé » (none_found) ou si un additif correspond à un critère actif, quel que soit le statut (excluded_because liste alors les critères). Une référence non conforme n'est jamais proposée et sert à la rubrique « Ingrédients exclus des références proposées ». needs_label_check : référence proposée avec la mention « Composition à vérifier sur l'étiquette » (statut « à vérifier »). package_format : format du conditionnement, en dernière colonne. [US-157 RF1, RF8, US-166 RF3, US-167 RF2, CA 1.1, CR-36, CR-37]$$;

DROP FUNCTION IF EXISTS grocery_list_for(uuid);
CREATE FUNCTION grocery_list_for(p_viewer uuid)
RETURNS TABLE (id uuid, list_id uuid, state grocery_item_state, source text, label varchar, name_key text, product_id bigint, aisle_id integer, quantity smallint,
               added_by_user_id uuid, not_bought_last_time boolean, store_chain varchar, reference_name varchar, unit_price numeric, bought_at timestamptz,
               bought_by_user_id uuid, package_format varchar)
LANGUAGE sql STABLE AS $$
  SELECT i.id, i.list_id, i.state, i.source, i.label, i.name_key, i.product_id, i.aisle_id, i.quantity, i.added_by_user_id, i.not_bought_last_time,
         i.store_chain, i.reference_name, CASE WHEN grocery_access(p_viewer) = 'couple' THEN i.unit_price END, i.bought_at, i.bought_by_user_id,
         (SELECT r.package_format FROM grocery_product_references r
           WHERE r.product_id = i.product_id AND r.store_chain = i.store_chain AND r.reference_name = i.reference_name)
    FROM users v
    JOIN grocery_list_items i ON i.account_id = v.account_id
   WHERE v.id = p_viewer AND grocery_access(p_viewer) IS NOT NULL
$$;
COMMENT ON FUNCTION grocery_list_for(uuid) IS $$Articles de la liste de courses de la famille d'un profil, pour l'affichage : le prix estimé n'est rendu qu'au couple, l'invité secondaire ne voit aucun prix (il voit le magasin, la référence et le format du conditionnement, sans prix). L'application l'utilise pour lire la liste ; tant qu'elle se connecte avec un seul rôle, la protection effective des colonnes est cette fonction et le code (H150). [US-157 RF8, US-158, CR-10, CR-38]$$;
