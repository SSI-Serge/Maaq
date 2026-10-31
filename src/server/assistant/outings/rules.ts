import type { OutingCategory, OutingDayPref, OutingFrequency, OutingMood } from "@/server/db/schema.generated";

/**
 * Règles et libellés des critères de sorties, sans aucune dépendance serveur : l'écran des critères (navigateur) et le serveur lisent le même fichier, pour que les messages
 * et les bornes soient identiques des deux côtés (US-114). Le serveur et la base restent juges : l'écran ne fait que prévenir tôt.
 */

export const BUDGET_MIN = 10;
export const BUDGET_MAX = 2000;
export const PEOPLE_MIN = 1;
export const PEOPLE_MAX = 10;
export const PLACE_MAX = 80;

export const CATEGORIES: OutingCategory[] = ["self", "couple", "kids", "teens"];
export const CATEGORY_LABEL: Record<OutingCategory, string> = { self: "Pour moi", couple: "En couple", kids: "Enfants de 3 à 10 ans", teens: "Ados de 11 à 17 ans" };
/** Sous-groupes d'affichage des thèmes (colonne `theme_group`) : le libellé est porté par l'écran (D68). */
export const GROUP_LABEL: Record<string, string> = { concerts: "Concerts" };

export const DAY_LABEL: Record<OutingDayPref, string> = {
  weekend: "Week-end", weekday_evenings: "Soirs de semaine", monday: "Lundi", tuesday: "Mardi", wednesday: "Mercredi", thursday: "Jeudi", friday: "Vendredi", saturday: "Samedi", sunday: "Dimanche",
};
export const DAY_PREFS = Object.keys(DAY_LABEL) as OutingDayPref[];
/** Les sept jours précis, dans l'ordre de la semaine. */
export const SPECIFIC_DAYS: OutingDayPref[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
export const DAY_INITIAL: Record<string, string> = { monday: "L", tuesday: "M", wednesday: "Me", thursday: "J", friday: "V", saturday: "S", sunday: "D" };

export const MOODS: OutingMood[] = ["calm", "playful", "both"];
export const MOOD_LABEL: Record<OutingMood, string> = { calm: "Calme", playful: "Ludique", both: "Les deux" };
/** « Une par semaine » est retiré (D67, coût : une proposition coûte environ 0,28 $) ; la valeur existe encore dans le schéma, mais n'est ni proposée ni acceptée. */
export const FREQUENCIES: OutingFrequency[] = ["monthly", "twice_monthly"];
export const FREQUENCY_LABEL: Record<string, string> = { monthly: "Une par mois", twice_monthly: "Deux par mois" };

export const MSG_BUDGET = "Indiquez un budget entre 10 € et 2 000 €.";
export const MSG_ADDRESS = "Indiquez une ville ou un secteur, pas une adresse.";
export const MSG_STORE_ERROR = "Le service est momentanément indisponible. Veuillez réessayer dans quelques instants.";

const ADDRESS_NUMBER = /^\s*[0-9]+\s*(bis|ter|quater)?\s*,?\s+\S/i;
const ADDRESS_WORD = /(^|[\s,;])(rue|avenue|av\.?|boulevard|bd|chemin|impasse|allée|allee|route|quai|passage|square|esplanade|ruelle|sentier|lotissement|résidence|residence|hameau|lieu-dit)([\s,;]|$)/i;

/** Même contrôle que `looks_like_address` de la base : un numéro de voie en tête, ou un mot de type de voie. « place » et « cours » ne comptent pas (noms de communes et de quartiers). */
export function looksLikeAddress(text: string): boolean {
  return ADDRESS_NUMBER.test(text) || ADDRESS_WORD.test(text);
}

export const budgetValid = (value: string): boolean => /^\d+$/.test(value.trim()) && Number(value) >= BUDGET_MIN && Number(value) <= BUDGET_MAX;

/** Résumé de la ligne d'accès des réglages : « Activées · Pour moi, En couple · deux par mois » ou « Désactivées · touchez pour choisir vos critères ». */
export function criteriaSummary(input: { enabled: boolean; categories: OutingCategory[]; frequency: OutingFrequency }): string {
  if (!input.enabled) return "Désactivées · touchez pour choisir vos critères";
  const names = CATEGORIES.filter((c) => input.categories.includes(c)).map((c) => CATEGORY_LABEL[c]);
  return ["Activées", names.join(", "), (FREQUENCY_LABEL[input.frequency] ?? FREQUENCY_LABEL.twice_monthly).toLowerCase()].filter(Boolean).join(" · ");
}
