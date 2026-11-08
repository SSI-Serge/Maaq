import { fmtMin } from "@/server/courses/engine/text";
import type { MenuProposal } from "@/server/courses/menu-ia/proposal";

/** Textes de la carte de menu du tchat (CR-Tchat) : purs, donc testés sans écran. */

export const DAY_LABELS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

/** Texte de la séance de batch sous le menu : durée réelle d'une semaine type ou estimée par MAAQ (CR-47). */
export function sessionText(proposal: Pick<MenuProposal, "session" | "planTheme">): string {
  const { session, planTheme } = proposal;
  const head = !session.estimated && planTheme ? `Dimanche · ${fmtMin(session.minutes)} · semaine type « ${planTheme} »` : `Dimanche · environ ${fmtMin(session.minutes)} (durée estimée)`;
  return `${head}, pour les dîners du lundi au vendredi. Samedi et dimanche : hors séance.`;
}

/** « Recettes pour 4 : multipliez par 1,5 » quand le foyer compte plus de 4 personnes. */
export function servingsNote(size: number | null): string | null {
  if (!size || size <= 4) return null;
  return `Recettes pour 4 : multipliez par ${String(Math.round((size / 4) * 100) / 100).replace(".", ",")}.`;
}
