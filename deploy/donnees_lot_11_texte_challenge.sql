-- MAAQ — Contrats V2 : nouvelle version du texte de consentement au challenge (US-128 RF2). C'est une donnée, pas un changement de schéma.
-- Le texte affiché remplace [nom du contrat] par le nom du contrat et [nom du partenaire] par le courtier désigné dans la console ; la version la plus récente est celle qui
-- sert aux nouveaux consentements (la preuve garde la version acceptée). À appliquer une fois sur chaque base qui a déjà la version 1.0 (zone de test, base locale).
INSERT INTO legal_document_versions (document_type, version_label, content, published_at) VALUES
  ('contract_challenge_consent', '2.0', 'Les documents de [nom du contrat] seront transmis à [nom du partenaire], partenaire de MAAQ, pour challenger votre contrat.', now())
ON CONFLICT (document_type, version_label) DO NOTHING;
