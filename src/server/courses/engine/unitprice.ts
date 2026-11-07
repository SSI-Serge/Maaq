/**
 * Prix au kilo (ou au litre) des produits au poids ou en vrac (CR-39, CR-40). La base porte les données : unité du prix d'une référence (par article, au kilo, au litre),
 * quantité de son format en kg ou en litres, poids mesuré d'une ligne de ticket, prix au kilo lu ou calculé. Ce fichier ne fait que les rassembler pour le comparatif.
 * Jamais de poids moyen par pièce : sans information, le prix reste celui de l'article.
 */

export type MeasureUnit = "kg" | "l";
/** Unité dans laquelle un prix est exprimé : par article, au kilo ou au litre. */
export type PriceUnit = "unit" | MeasureUnit;

export interface PerUnitPrice {
  /** Prix pour un kilo ou un litre, arrondi au centime. */
  value: number;
  unit: MeasureUnit;
}

/** Prix au kilo ou au litre d'un choix : le prix lui-même quand il est déjà au kilo ou au litre, sinon celui que la base a déduit du format (peut être vide). */
export function perUnitOf(price: number | null | undefined, priceUnit: PriceUnit | undefined, perMeasure: PerUnitPrice | null | undefined): PerUnitPrice | null {
  if (price === null || price === undefined || price <= 0) return null;
  if (priceUnit === "kg" || priceUnit === "l") return { value: price, unit: priceUnit };
  return perMeasure ?? null;
}

/** Un prix qui n'est pas par article n'entre pas dans le total estimé de la liste (décision du PO, CR-40). */
export const isTotaled = (priceUnit: PriceUnit | undefined | null): boolean => !priceUnit || priceUnit === "unit";

const FACTOR: Record<string, { unit: MeasureUnit; factor: number }> = {
  kg: { unit: "kg", factor: 1 },
  g: { unit: "kg", factor: 0.001 },
  gr: { unit: "kg", factor: 0.001 },
  l: { unit: "l", factor: 1 },
  cl: { unit: "l", factor: 0.01 },
  ml: { unit: "l", factor: 0.001 },
};

/** Un poids ou un volume saisi (« 1234 g », « 33 cl ») converti en kilos ou en litres avant l'écriture ; null si l'unité n'est pas comprise ou la valeur absurde. */
export function toMeasure(value: number, unit: string): { amount: number; unit: MeasureUnit } | null {
  const f = FACTOR[unit.trim().toLowerCase()];
  const amount = Math.round(value * (f?.factor ?? NaN) * 1000) / 1000;
  return f && Number.isFinite(amount) && amount > 0 && amount < 1_000_000 ? { amount, unit: f.unit } : null;
}

/** Prix au kilo d'une ligne de ticket pesée : lu sur le ticket, sinon prix de la ligne divisé par le poids (même arrondi que la base). */
export function pricePerMeasure(read: number | null | undefined, lineTotal: number, measured: number | null | undefined): number | null {
  if (read && read > 0) return Math.round(read * 100) / 100;
  return measured && measured > 0 && lineTotal > 0 ? Math.round((lineTotal / measured) * 100) / 100 : null;
}

export const unitLabel = (unit: MeasureUnit) => (unit === "kg" ? "kg" : "L");
