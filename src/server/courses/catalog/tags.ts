import { deriveDishTags, has, norm } from "../engine";
import { ALLERGENS, DIET_LABEL, MEAT_LABEL } from "./seed";

/** Étiquettes d'un plat déduites de son nom et de ses ingrédients, comme au chargement du catalogue (viande, régime, allergènes) : indicatif, à vérifier par le foyer. */
export function dishTagLabels(name: string, ingredients: string): string[] {
  const tags = deriveDishTags(name, ingredients);
  const labels = new Set<string>();
  for (const t of tags) {
    const label = MEAT_LABEL[t] ?? DIET_LABEL[t];
    if (label) labels.add(label);
  }
  const text = norm(`${name} ${ingredients}`);
  for (const [label, words] of Object.entries(ALLERGENS)) if (words.some((w) => has(w, text))) labels.add(label);
  return [...labels];
}
