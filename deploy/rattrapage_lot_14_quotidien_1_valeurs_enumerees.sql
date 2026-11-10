-- MAAQ — rattrapage du lot 14 (produits du quotidien, CR-66 et CR-67), fichier 1/2 : valeur d'énumération. Une valeur ajoutée à un type existant ne peut pas servir dans la transaction qui l'ajoute :
-- elle est dans son propre fichier, à appliquer AVANT rattrapage_lot_14_quotidien_2_schema.sql. Idempotent.
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'daily_product_changed' AFTER 'seasonal_dish_changed';
