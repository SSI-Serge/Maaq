/**
 * Quantités des recettes dans les scénarios d'achat (CR-50, US-157 RF7bis). L'IA écrit pour chaque ingrédient une quantité et une unité pour le nombre de personnes du foyer ; MAAQ les
 * additionne par produit sur tout le menu, les convertit en kilos, litres ou pièces, puis les divise par le format de la référence choisie en arrondissant au paquet supérieur.
 * Fichier pur (aucun lien avec la base), exécuté aussi dans le navigateur pour recalculer le total à chaque changement de référence.
 */

/** Unités permises pour un ingrédient (codes de la base : spoon = cuillère, pinch = pincée). */
export const QUANTITY_UNITS = ["g", "kg", "ml", "cl", "l", "piece", "spoon", "pinch"] as const;
export type QuantityUnit = (typeof QUANTITY_UNITS)[number];

/** Unité de base après conversion : kilos, litres, pièces, cuillères, pincées. */
export type BaseUnit = "kg" | "l" | "piece" | "spoon" | "pinch";

export interface BaseQuantity {
  amount: number;
  unit: BaseUnit;
}

const TO_BASE: Record<QuantityUnit, { unit: BaseUnit; factor: number }> = {
  g: { unit: "kg", factor: 0.001 },
  kg: { unit: "kg", factor: 1 },
  ml: { unit: "l", factor: 0.001 },
  cl: { unit: "l", factor: 0.01 },
  l: { unit: "l", factor: 1 },
  piece: { unit: "piece", factor: 1 },
  spoon: { unit: "spoon", factor: 1 },
  pinch: { unit: "pinch", factor: 1 },
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** « 900 g » → 0,9 kg ; null si la quantité ou l'unité n'est pas valable. */
export function toBase(quantity: number, unit: string): BaseQuantity | null {
  const f = TO_BASE[unit as QuantityUnit];
  if (!f || !Number.isFinite(quantity) || quantity <= 0) return null;
  const amount = round3(quantity * f.factor);
  return amount > 0 ? { amount, unit: f.unit } : null;
}

/** Ce qu'il faut d'un produit pour tout le menu : une quantité par unité de base (un même produit peut être écrit en g dans un plat et en pièces dans un autre). */
export interface Need {
  kg: number;
  l: number;
  piece: number;
  spoon: number;
  pinch: number;
}

export const emptyNeed = (): Need => ({ kg: 0, l: 0, piece: 0, spoon: 0, pinch: 0 });

export function addNeed(need: Need, base: BaseQuantity): void {
  need[base.unit] = round3(need[base.unit] + base.amount);
}

/** Total par produit : `lines` = ingrédients de tous les plats du menu, plats express compris. Une ligne sans quantité valable est comptée dans `unknown` (à vérifier). */
export function sumNeeds(lines: { product: string; quantity: number | null; unit: string | null }[]): Map<string, { need: Need; unknown: boolean }> {
  const out = new Map<string, { need: Need; unknown: boolean }>();
  for (const line of lines) {
    const entry = out.get(line.product) ?? { need: emptyNeed(), unknown: false };
    const base = line.quantity !== null && line.unit !== null ? toBase(line.quantity, line.unit) : null;
    if (base) addNeed(entry.need, base);
    else entry.unknown = true;
    out.set(line.product, entry);
  }
  return out;
}

export interface Reference {
  /** Quantité du format en kilos ou en litres (package_amount). */
  amount: number;
  unit: "kg" | "l";
}

/** Mesure unique d'un besoin : kilos ou litres seuls, ou pièces seules ; null quand les unités se mélangent (conversion impossible). */
export function singleMeasure(need: Need): { amount: number; unit: "kg" | "l" | "piece" } | null {
  const kinds = (["kg", "l", "piece"] as const).filter((k) => need[k] > 0);
  return kinds.length === 1 ? { amount: need[kinds[0]], unit: kinds[0] } : null;
}

/** « Placard » : seulement des cuillères ou des pincées (sel, épices, huile) : décoché par défaut, « Vous en avez peut-être déjà » (CR-50). */
export function onlyPantryUnits(need: Need): boolean {
  return need.kg === 0 && need.l === 0 && need.piece === 0 && (need.spoon > 0 || need.pinch > 0);
}

export interface Packages {
  /** Nombre d'unités d'achat à prendre. */
  qty: number;
  /** « Quantité à vérifier » : conversion impossible (format inconnu, unité incompatible, besoin incohérent), 1 unité par défaut. */
  check: boolean;
}

/** Nombre de paquets d'une référence pour un besoin : arrondi au paquet supérieur ; 1 « à vérifier » quand la conversion est impossible. */
export function packagesFor(need: Need | null, unknown: boolean, reference: Reference | null): Packages {
  if (!need) return { qty: 1, check: false };
  const measure = singleMeasure(need);
  if (unknown || !measure || measure.unit === "piece" || !reference || reference.unit !== measure.unit || reference.amount <= 0) return { qty: 1, check: true };
  // 1e-9 : 900 g en paquets de 300 g font 3 paquets, pas 4 à cause d'un arrondi de flottants
  return { qty: Math.min(Math.max(Math.ceil(measure.amount / reference.amount - 1e-9), 1), 99), check: false };
}

/** Produit vendu au poids (prix au kilo ou au litre) dont le besoin est connu : montant = quantité × prix, compté dans le total (modifie CR-40). Null sinon. */
export function weighedTotal(need: Need | null, unknown: boolean, perUnitPrice: { value: number; unit: "kg" | "l" } | null): number | null {
  if (!need || unknown || !perUnitPrice) return null;
  const measure = singleMeasure(need);
  if (!measure || measure.unit !== perUnitPrice.unit) return null;
  return Math.round(measure.amount * perUnitPrice.value * 100) / 100;
}

/**
 * Bornes plausibles pour un ingrédient d'un plat, selon le nombre de personnes : une quantité hors bornes est signalée « à vérifier » plutôt que mise telle quelle dans le total.
 * Large exprès : le but est de repérer une faute d'unité (900 kg au lieu de 900 g), pas de juger une recette.
 */
export function plausible(quantity: number, unit: string, people: number): boolean {
  const base = toBase(quantity, unit);
  if (!base) return false;
  const n = Math.max(people, 1);
  switch (base.unit) {
    case "kg":
      return base.amount <= 0.8 * n + 1;
    case "l":
      return base.amount <= 1 * n + 1;
    case "piece":
      return base.amount <= 6 * n + 4;
    case "spoon":
      return base.amount <= 6 + n;
    case "pinch":
      return base.amount <= 10;
  }
}
