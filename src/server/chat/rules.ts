/** Règles du tchat reprises des user stories. Fichier sans dépendance : l'écran et le serveur l'utilisent tous deux. */

/** Les messages de plus de 4 jours disparaissent, avec les cartes d'action non traitées (US-44 RF1). */
export const HISTORY_DAYS = 4;
/** US-38 RF1 : une demande fait 2000 caractères au maximum. */
export const MAX_REQUEST_LENGTH = 2000;
/** US-61 RF2 : commentaire d'un signalement. */
export const MAX_REPORT_COMMENT = 1000;
/** À partir de ce reste de demandes, un avertissement s'affiche (US-70 RF8). */
export const LOW_CAP_THRESHOLD = 5;
