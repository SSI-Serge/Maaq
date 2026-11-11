import type { WeekDomain } from "@/server/assistant/homework/weeks";

/** Étiquette de catégorie d'un élément de la semaine de devoirs (US-119 UX) : sa couleur est `--c-<domaine>` dans les feuilles de style de la semaine et de l'impression. */
export const DOMAIN_LABEL: Record<WeekDomain, string> = {
  maths: "Maths",
  nature: "Nature",
  philo: "Philo",
  stim: "STIM",
  art: "Art",
  imagination: "Imagination",
  projets: "Jeux et projets",
  perso: "Perso",
};

/** Jours de la semaine, du lundi (1) au dimanche (7) : forme longue pour les grands écrans et l'impression, forme courte pour les petits. */
export const DAY_LONG = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
export const DAY_SHORT = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

/** « 2/11 » pour le jour `iso` (1 à 7) d'une semaine qui commence le lundi `weekStart` (AAAA-MM-JJ). */
export function dayDate(weekStart: string, iso: number): string {
  const d = new Date(`${weekStart}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + iso - 1);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const parts = (iso: string) => ({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) - 1, d: Number(iso.slice(8, 10)) });

/** « Semaine du 2 novembre » */
export const weekTitle = (weekStart: string) => `Semaine du ${parts(weekStart).d === 1 ? "1er" : parts(weekStart).d} ${MONTHS[parts(weekStart).m]}`;

/** « du 2 au 8 novembre 2026 » (ou « du 29 octobre au 4 novembre 2026 » à cheval sur deux mois) */
export function weekRange(weekStart: string, weekEnd: string): string {
  const a = parts(weekStart);
  const b = parts(weekEnd);
  const first = a.d === 1 ? "1er" : String(a.d);
  return a.m === b.m ? `du ${first} au ${b.d} ${MONTHS[b.m]} ${b.y}` : `du ${first} ${MONTHS[a.m]} au ${b.d} ${MONTHS[b.m]} ${b.y}`;
}

/**
 * Adresse de l'écran « Semaine de devoirs », ouverte sur la page d'un enfant quand le lien le vise (US-119 RF4 : une page par enfant). Sans enfant, la semaine s'ouvre sur le premier.
 */
export const weekHref = (weekId: string, memberId?: string | null, fromHistory = false) => {
  const query = [memberId ? `enfant=${memberId}` : "", fromHistory ? "retour=historique" : ""].filter(Boolean).join("&");
  return `/assistant/devoirs/${weekId}${query ? `?${query}` : ""}`;
};

/** La page à montrer : celle de l'enfant demandé s'il a des éléments dans cette semaine, sinon celle du premier enfant. */
export function childOfWeek<T extends { memberId: string }>(children: T[], wanted: string | null | undefined): T | undefined {
  return children.find((c) => c.memberId === wanted) ?? children[0];
}
