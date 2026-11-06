import { has, intersect, norm, tokens } from "./text";
import type { Dish, Profile, SeasonRange } from "./types";

/** Mots-clés de départ pour DÉDUIRE les étiquettes d'un plat à l'import initial (CR-30) ; ensuite les étiquettes sont des données de la console. */
export const MEAT_KEYWORDS: Record<string, string[]> = {
  poulet: ["poulet", "volaille", "dinde"],
  boeuf: ["boeuf", "bœuf", "viande hachee", "bolognaise"],
  porc: ["porc", "jambon", "chorizo", "lardons", "saucisse", "cotes fumees"],
  poisson: ["poisson", "thon", "saumon", "cabillaud", "morue", "sardine", "crevette", "capitaine", "tilapia"],
  veau: ["veau"],
  agneau: ["agneau", "mouton"],
};
export const GLUTEN_KEYWORDS = ["pate", "ble", "farine", "pain", "semoule", "lasagne", "couscous", "orge", "boulgour", "bechamel", "orzo", "orseau", "spaghetti", "penne", "tarte", "gnocchi", "chapelure"];

/** Calendrier de saison de départ (US-168) ; chargé ensuite depuis la console. */
export const DEFAULT_SEASONS: SeasonRange[] = [
  ["tomate", 6, 9], ["courgette", 6, 9], ["aubergine", 7, 9], ["poivron", 6, 9], ["concombre", 6, 9], ["haricots verts", 6, 9],
  ["petits pois", 5, 7], ["asperge", 4, 6], ["fraise", 5, 7], ["melon", 6, 8], ["potiron", 9, 12], ["courge", 9, 12], ["butternut", 9, 12],
  ["chou", 10, 3], ["poireau", 9, 4], ["epinard", 3, 6], ["brocoli", 10, 3], ["betterave", 10, 3], ["navet", 10, 3], ["endive", 11, 3],
  ["pomme", 9, 12], ["poire", 9, 12], ["orange", 11, 3], ["clementine", 11, 1], ["mandarine", 11, 2],
].map(([key, from, to]) => ({ key: key as string, from: from as number, to: to as number }));

/** Étiquettes déduites des mots du nom et des ingrédients (import initial des 60 plats). */
export function deriveDishTags(name: string, ing: string): Set<string> {
  const t = norm(`${name} ${ing}`);
  const tags = new Set<string>();
  if (norm(name).includes("salade")) tags.add("salade");
  for (const [kind, words] of Object.entries(MEAT_KEYWORDS)) {
    if (words.some((w) => has(norm(w), t))) tags.add(kind);
  }
  if (!Object.keys(MEAT_KEYWORDS).some((k) => tags.has(k))) tags.add("vegetarien");
  if (!GLUTEN_KEYWORDS.some((g) => has(g, t))) tags.add("sans gluten");
  return tags;
}

/** Nombre d'ingrédients de saison et hors saison du texte pour le mois donné (1 à 12). */
export function inSeason(text: string, month: number, seasons: SeasonRange[] = DEFAULT_SEASONS): { inSeason: number; outOfSeason: number } {
  const t = norm(text);
  let ok = 0;
  let bad = 0;
  for (const { key, from, to } of seasons) {
    if (!has(key, t)) continue;
    const inside = from <= to ? from <= month && month <= to : month >= from || month <= to;
    if (inside) ok += 1;
    else bad += 1;
  }
  return { inSeason: ok, outOfSeason: bad };
}

/** Filtrage INDICATIF des allergies et des régimes (US-153 RF4) ; fait par MAAQ, jamais par l'agent (CR-16). */
export function allowed(dish: Dish, profile: Pick<Profile, "allergies" | "regimes">, extraMeat?: string | null): boolean {
  const t = norm(`${dish.name} ${dish.ing}`);
  for (const allergy of profile.allergies) {
    const a = norm(allergy).trim();
    if (a && has(a, t)) return false;
  }
  const regimes = norm(profile.regimes.join(","));
  if (regimes.includes("vegetarien") && !dish.tags.has("vegetarien")) return false;
  if (regimes.includes("gluten") && !dish.tags.has("sans gluten")) return false;
  if (extraMeat && !dish.tags.has(extraMeat)) return false;
  return true;
}

export function dishTokens(dish: Dish): Set<string> {
  return tokens(dish.ing);
}

export { intersect };
