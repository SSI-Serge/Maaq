-- MAAQ — rattrapage du lot 14, fichier 1/2 : valeur d'énumération du regroupé CR-56 à CR-63 (menu sur quatre semaines, liste du mois, coût réel, budget, plats de saison). Une valeur ajoutée à un type
-- existant ne peut pas servir dans la transaction qui l'ajoute : elle est dans son propre fichier, à appliquer AVANT rattrapage_lot_14_mois_2_schema.sql. Idempotent.
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'seasonal_dish_changed' AFTER 'grocery_price_moderated';
