/**
 * Prix au kilo (ou au litre) d'un produit au poids ou en vrac (CR-39) : calculé seulement quand l'information existe — le format de la référence (« 1 kg », « 500 g »,
 * « sachet de 250 g », « 3 x 600 g ») ou, plus tard, le poids lu sur le ticket. Sans information, le prix reste celui de l'unité. Jamais de poids moyen par pièce.
 */

export type MeasureUnit = "kg" | "l";

export interface PerUnitPrice {
  /** Prix pour un kilo ou un litre, arrondi au centime. */
  value: number;
  unit: MeasureUnit;
}

const FACTOR: Record<string, { unit: MeasureUnit; factor: number }> = {
  kg: { unit: "kg", factor: 1 },
  g: { unit: "kg", factor: 0.001 },
  l: { unit: "l", factor: 1 },
  cl: { unit: "l", factor: 0.01 },
  ml: { unit: "l", factor: 0.001 },
};

const MULTI = /(\d{1,3})\s*[x×*]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml)\b/i;
const SINGLE = /(\d+(?:[.,]\d+)?)\s*(kg|g|l|cl|ml)\b/i;

/** Contenu d'un conditionnement en kilos ou en litres ; null si le format n'est pas compris. */
export function packageContent(format: string | null | undefined): { amount: number; unit: MeasureUnit } | null {
  if (!format) return null;
  const text = format.toLowerCase().replace(/\s+/g, " ").trim();
  const multi = MULTI.exec(text);
  const single = multi ? null : SINGLE.exec(text);
  const count = multi ? Number(multi[1]) : 1;
  const raw = multi ?? single;
  if (!raw) return null;
  const n = Number((multi ? multi[2] : single![1]).replace(",", "."));
  const measure = FACTOR[(multi ? multi[3] : single![2]).toLowerCase()];
  const amount = count * n * measure.factor;
  return Number.isFinite(amount) && amount > 0 ? { amount, unit: measure.unit } : null;
}

/** Prix au kilo (ou au litre) d'une référence dont on connaît le prix et le format. */
export function perUnitPrice(price: number | null | undefined, format: string | null | undefined): PerUnitPrice | null {
  if (price === null || price === undefined || price <= 0) return null;
  const content = packageContent(format);
  return content ? { value: Math.round((price / content.amount) * 100) / 100, unit: content.unit } : null;
}

/** Prix au kilo d'une ligne de ticket au poids : prix de la ligne divisé par le poids lu (quantité exprimée en kilos). */
export function perKiloFromWeight(lineTotal: number, kilos: number): PerUnitPrice | null {
  return lineTotal > 0 && kilos > 0 ? { value: Math.round((lineTotal / kilos) * 100) / 100, unit: "kg" } : null;
}

export const unitLabel = (unit: MeasureUnit) => (unit === "kg" ? "kg" : "L");
