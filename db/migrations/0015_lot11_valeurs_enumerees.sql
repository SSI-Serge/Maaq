-- MAAQ — lot 11 : Contrats V2 : catégories à champs de documents, contrats, documents chiffrés, anonymisation, analyse et challenge (US-122 à US-138) : valeurs ajoutées à des types énumérés existants.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute.
-- À appliquer AVANT lot_11_2_schema.sql.

ALTER TYPE legal_document_type ADD VALUE 'contract_analysis_consent' AFTER 'forwarded_mail_consent';
ALTER TYPE consent_trigger ADD VALUE 'contract_deleted' AFTER 'contract_details_deleted';
ALTER TYPE setting_value_type ADD VALUE 'free_text' AFTER 'timestamp';
ALTER TYPE audit_action ADD VALUE 'contract_document_field_changed' AFTER 'device_revoked_by_admin';
ALTER TYPE audit_action ADD VALUE 'contract_analysis_decided' AFTER 'contract_document_field_changed';
ALTER TYPE audit_action ADD VALUE 'contract_review_viewed' AFTER 'contract_analysis_decided';
