/**
 * Titre de la tâche du foyer « Préparer les devoirs » (D71, S-44) : la tâche est reconnue par sa source `homework_prep`, et son titre est affiché d'après cette source,
 * jamais lu en base (une ancienne tâche « Préparer les devoirs de la semaine » prend donc ce titre sans être réécrite).
 */
export const HOMEWORK_PREP_TITLE = "Préparer les devoirs";
/** Heure proposée à la création de la tâche (US-119 RF1) ; le parent peut la changer, et elle est gardée quand les jours changent (S-44). */
export const HOMEWORK_PREP_TIME = "17:00";
/** Jours de devoirs d'un foyer qui n'a rien réglé : lundi, mardi, jeudi, vendredi (US-118 RF7). */
export const DEFAULT_HOMEWORK_DAYS = [1, 2, 4, 5];
