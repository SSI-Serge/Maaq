-- Assistant Famille, étape 2 : membres retirés et effacés (US-93).
-- Retirer un membre ne le supprime pas : il est archivé pour conserver l'historique des rendez-vous (US-93 RT1).
-- L'effacement définitif anonymise la ligne (prénom « Ancien membre », sans date de naissance) et laisse ainsi une trace sans donnée personnelle (D34).

ALTER TABLE family_members
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN erased_at timestamptz;

COMMENT ON COLUMN family_members.archived_at IS $$Date de retrait : le membre n'est plus proposé ni reconnu par l'assistant, mais ses rendez-vous gardent son prénom. Définitif (pas de restauration). [US-93 RF6, RF8]$$;
COMMENT ON COLUMN family_members.erased_at IS $$Date d'effacement définitif : prénom et date de naissance effacés, rendez-vous du seul membre supprimés, rendez-vous partagés conservés sous « Ancien membre ». [US-93 RF13, D34]$$;

CREATE INDEX idx_family_members_active ON family_members (account_id) WHERE archived_at IS NULL;
