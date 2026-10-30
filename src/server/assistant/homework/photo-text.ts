/** Textes de l'envoi d'une photo de devoirs, sans dépendance serveur : l'écran les affiche avant l'envoi (US-119 RF5, CA 5.1). */

/** Message montré au parent avant l'envoi : la photo ne sera pas conservée. */
export const photoWarning = (firstName: string): string => `La photo sera supprimée une fois les progrès de ${firstName} notés.`;

/** Confirmation après l'analyse (CA 5.2). */
export const photoDone = (firstName: string): string => `Progrès de ${firstName} notés. La photo a été supprimée.`;
