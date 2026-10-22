import type { EligibleStorefront, Introduction, ServiceRequest } from "./match-store";
import { departementOf } from "./model";

/**
 * Mise en relation : le texte que l'acheteur approuve sur la carte et que le fournisseur reçoit tel quel.
 * Il ne contient que le besoin, le moment et la zone approximatifs, et le prénom de l'acheteur : jamais son nom,
 * son email ni son numéro (US-12). Le contact du fournisseur, lui, n'est révélé qu'après son accord (phase 3).
 */

export interface SharedTextInput {
  firstName: string;
  request: Pick<ServiceRequest, "text" | "timingText" | "postcode" | "remoteOk">;
  /** Précisions ajoutées par l'acheteur avant validation, avec ses mots. */
  precisions?: string | null;
}

export function draftSharedText(input: SharedTextInput): string {
  const who = input.firstName.trim() || "Un membre MAAQ";
  const dep = input.request.postcode ? departementOf(input.request.postcode) : null;
  const where = input.request.postcode ? `code postal ${input.request.postcode}${dep ? ` (département ${dep})` : ""}` : input.request.remoteOk ? "à distance" : "non précisé";
  const lines = [`${who}, membre de MAAQ, cherche : ${input.request.text.trim()}`, `Quand : ${input.request.timingText?.trim() || "à convenir"}`, `Où : ${where}`];
  if (input.precisions?.trim()) lines.push(`Précisions : ${input.precisions.trim()}`);
  lines.push("Si cela vous intéresse, répondez à MAAQ : accepter, refuser ou poser une question. Vos coordonnées ne sont transmises qu'après votre accord.");
  return lines.join("\n");
}

/** Message déposé dans le tchat vitrine du fournisseur quand l'acheteur a validé la carte. */
export function supplierNotice(introduction: Introduction, storefront: Pick<EligibleStorefront, "displayName">): string {
  return [
    `Nouvelle demande de mise en relation pour votre vitrine « ${storefront.displayName ?? "Sans nom"} » (réf. ${introduction.id.slice(0, 8)}).`,
    "",
    introduction.sharedText,
    "",
    "Vous pourrez répondre ici même (accepter, refuser, poser une question) ; rien n'est transmis au membre sans votre accord.",
  ].join("\n");
}

/** Résumé de la carte « Valider / Refuser » : ce qui serait envoyé, mot pour mot. */
export function proposalSummary(storefrontName: string, sharedText: string): string {
  return `Envoyer cette présentation à ${storefrontName} ?\n\n« ${sharedText} »`;
}
