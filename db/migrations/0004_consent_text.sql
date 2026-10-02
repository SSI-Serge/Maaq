-- =====================================================================
-- Texte de consentement au challenge d'un contrat (US-36 RF2, RT1). Le nom du partenaire n'est pas
-- encore connu (à fournir par le PM) : une nouvelle version publiée le remplacera, et chaque consentement
-- reste rattaché à la version exacte qui a été acceptée.
-- =====================================================================
INSERT INTO legal_document_versions (document_type, version_label, content, published_at)
VALUES (
  'contract_challenge_consent',
  '1.0',
  'L''entreprise [nom du partenaire], partenaire de MAAQ, pourra utiliser les informations de votre contrat pour le challenger.',
  now()
)
ON CONFLICT (document_type, version_label) DO NOTHING;
