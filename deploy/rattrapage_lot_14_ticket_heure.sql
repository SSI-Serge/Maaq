-- MAAQ — rattrapage additif du lot 14 (doublon de ticket de caisse : heure exacte, décision CR-41 / US-161 RT2) pour une base qui a DÉJÀ reçu lot_14_2_schema.sql (5298e454…),
-- rattrapage_lot_14_references_sans_prix.sql (ebbb0218…), rattrapage_lot_14_secondaire_et_agent.sql (9e3600f1…), rattrapage_lot_14_format_references.sql (deeeda5e…) et
-- rattrapage_lot_14_prix_au_kilo.sql (0c296b9f…), dans cet ordre. Une base neuve applique le lot_14_2_schema.sql régénéré (nouvelle empreinte) et n'a pas besoin de ce fichier.
-- Une seule transaction, idempotent. Aucune ligne n'est touchée : les tickets déjà enregistrés n'ont pas d'heure et restent contrôlés comme avant.
--  1. grocery_receipts.purchased_time time(0), facultative (heure locale du magasin, secondes à 00 quand elles ne sont pas lues).
--  2. La contrainte d'unicité uq_grocery_receipts_duplicate (compte, enseigne, date, total) est REMPLACÉE par deux index uniques partiels :
--     avec une heure, (compte, date, heure, total) : le magasin n'entre pas en compte ; sans heure, (compte, enseigne, date, total) comme avant.
--     L'index sans heure est créé avant la suppression de la contrainte : le contrôle n'est jamais interrompu.

ALTER TABLE grocery_receipts ADD COLUMN IF NOT EXISTS purchased_time time(0);
CREATE UNIQUE INDEX IF NOT EXISTS ux_grocery_receipts_duplicate_no_time ON grocery_receipts (account_id, store_chain, purchased_on, total_amount) WHERE purchased_time IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_grocery_receipts_duplicate_time ON grocery_receipts (account_id, purchased_on, purchased_time, total_amount) WHERE purchased_time IS NOT NULL;
ALTER TABLE grocery_receipts DROP CONSTRAINT IF EXISTS uq_grocery_receipts_duplicate;
COMMENT ON TABLE grocery_receipts IS $$Ticket de caisse enregistré : magasin, ville, date, heure, total, profil. Aucune photo ni image (supprimée dès la lecture, confirmée ou non), le nom et la carte de fidélité sont masqués avant que l'agent ne reçoive le texte. Un doublon est refusé en entier par la base : même date, même heure exacte et même total (le magasin n'entre pas en compte) ; sans heure (anciens tickets), même magasin, même date et même total. Source du budget par rayon. Conservé 3 ans (année en cours et deux précédentes, réglable). [US-161, US-163, CR-05, CR-08, CR-23, CR-41]$$;
COMMENT ON COLUMN grocery_receipts.purchased_time IS $$Heure du ticket (heures, minutes et secondes si elles sont lues, sinon secondes à 00), heure locale du magasin. Lue sur le ticket ou saisie par l'utilisateur quand elle n'est pas lue. Vide pour les tickets enregistrés avant CR-41 : leur contrôle de doublon reste magasin, date et total. [CR-41, US-161 RT2]$$;
