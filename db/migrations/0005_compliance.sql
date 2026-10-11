-- =====================================================================
-- Conformité (US-54 à US-59, US-68) : rappel avant suppression définitive et mémoire des demandes
-- d'anonymisation du carnet. Un seul rappel par délai de grâce (US-58 RF3) : sa date est conservée.
-- =====================================================================
ALTER TABLE accounts ADD COLUMN grace_reminder_sent_at timestamptz;
COMMENT ON COLUMN accounts.grace_reminder_sent_at IS $$Date d'envoi du rappel « suppression dans 7 jours » : un seul rappel par délai de grâce (US-58 RF3). Remis à vide quand le compte est repris$$;
