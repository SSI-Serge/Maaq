/**
 * Agenda lu par le marketplace silencieux (phase 2b). Le calendrier maître de MAAQ, prévu sur la branche
 * principale, se branchera ici ; en attendant, un agenda de démonstration (dev.ts) et un agenda vide.
 */

export interface CalendarEvent {
  /** Identifiant stable dans sa source : sert de clé de dédoublonnage, jamais le titre. */
  id: string;
  title: string;
  /** Jour de l'événement, AAAA-MM-JJ. */
  date: string;
  /** Heure HH:MM si l'événement n'est pas sur la journée. */
  time: string | null;
}

export interface CalendarSource {
  /** Événements d'un profil entre deux jours inclus (AAAA-MM-JJ). */
  listUpcoming(userId: string, from: string, to: string): Promise<CalendarEvent[]>;
}

/** Aucun agenda disponible : rien n'est jamais lu. */
export class NoCalendar implements CalendarSource {
  async listUpcoming(): Promise<CalendarEvent[]> {
    return [];
  }
}
