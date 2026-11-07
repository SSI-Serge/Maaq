import type { ApiError } from "@/client/api";

/** Messages affichés à chaque étape de l'enregistrement d'un ticket (US-161 RF5bis) : l'utilisateur n'est jamais laissé sans réponse. */

/** Pendant la lecture (CC-1). */
export const READING_MESSAGE = "Lecture du ticket en cours…";
/** Pendant la confirmation (CC-1). */
export const SAVING_MESSAGE = "Enregistrement du ticket en cours…";
/** Ticket déjà enregistré : même magasin, même date, même total. */
export const DUPLICATE_MESSAGE = "Ce ticket est déjà enregistré : rien n'a été ajouté.";
/** L'heure n'a pas été lue : elle est obligatoire (CR-41), elle sert à reconnaître un ticket déjà enregistré. */
export const TIME_MISSING_MESSAGE = "L'heure du ticket n'a pas été lue : saisissez-la (elle est imprimée près de la date) avant de confirmer.";
/** Ticket illisible. */
export const UNREADABLE_MESSAGE = "Ticket illisible : reprenez une photo plus nette.";
/** La photo n'a pas pu être lue par l'appareil. */
export const EMPTY_PHOTO_MESSAGE = "La photo n'a pas pu être lue par votre appareil : reprenez-la.";

/** Durée accordée à la lecture (lecture du texte puis mise en forme) avant le message de connexion lente (CC-3). */
export const READ_TIMEOUT_MS = 110_000;

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const frenchDate = (iso: string) => iso.split("-").reverse().join("/");
const euros = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;

/** « Ticket enregistré : [magasin], [date], [N] lignes, [total] €. [M] produits cochés dans votre liste. » */
export function savedMessage(input: { store: string; date: string; lines: number; total: number; ticked: number }): string {
  return `Ticket enregistré : ${input.store}, ${frenchDate(input.date)}, ${plural(input.lines, "ligne", "lignes")}, ${euros(input.total)}. ${plural(input.ticked, "produit coché", "produits cochés")} dans votre liste.`;
}

export interface Failure {
  message: string;
  /** « Réessayer » a du sens : réseau, serveur ou délai dépassé (CC-2, CC-3). Sinon c'est un refus à corriger. */
  retry: boolean;
}

/** Message d'erreur à montrer : standard pour le réseau, le serveur et le délai dépassé, avec « Réessayer » ; le refus du serveur est dit tel quel. */
export function failureOf(error: Pick<ApiError, "message" | "retryable">): Failure {
  return { message: error.message, retry: error.retryable };
}
