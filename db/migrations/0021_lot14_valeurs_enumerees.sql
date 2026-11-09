-- MAAQ — lot 14 : Courses et repas : agent natif, catalogue commun, base commune des prix anonyme, foyer, listes, tickets, retrait d’agent (US-152 à US-175) : valeurs ajoutées à des types énumérés existants.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute.
-- À appliquer AVANT lot_14_2_schema.sql.

ALTER TYPE legal_document_type ADD VALUE 'grocery_price_sharing_consent' AFTER 'contract_analysis_consent';
ALTER TYPE agent_status ADD VALUE 'retired' AFTER 'blocked';
ALTER TYPE audit_action ADD VALUE 'agent_retired' AFTER 'presentation_updated';
ALTER TYPE audit_action ADD VALUE 'agent_restored' AFTER 'agent_retired';
ALTER TYPE audit_action ADD VALUE 'meal_catalog_changed' AFTER 'agent_restored';
ALTER TYPE audit_action ADD VALUE 'meal_planning_changed' AFTER 'meal_catalog_changed';
ALTER TYPE audit_action ADD VALUE 'grocery_catalog_changed' AFTER 'meal_planning_changed';
ALTER TYPE audit_action ADD VALUE 'grocery_price_moderated' AFTER 'grocery_catalog_changed';
ALTER TYPE audit_action ADD VALUE 'seasonal_dish_changed' AFTER 'grocery_price_moderated';
