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

/** « Pour 6 personnes » : les recettes et les quantités sont écrites pour le foyer (CR-49) ; vide pour un menu validé avant. */
export function servingsText(size: number | null): string | null {
  return size ? `Pour ${size} personne${size > 1 ? "s" : ""}` : null;
}
