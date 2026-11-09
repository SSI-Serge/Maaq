import type { BuyRow } from "../engine";
import { norm } from "../engine";

/**
 * Liste du mois (CR-56, US-157 RF9ter) : plusieurs semaines regroupées en une seule liste. Les besoins de chaque produit sont additionnés sur les semaines (paquet supérieur sur le total),
 * les produits d'un rayon frais des semaines après la première sont mis à part (« À acheter plus tard »), et chaque produit reste rattaché à sa semaine. Fonctions pures, essayées seules.
 */

/** Ligne de produit d'une semaine, telle que la lit la préparation de la liste. */
export interface GroupRow {
  label: string;
  name_key: string;
  quantity: number;
  source: string;
  first_name: string | null;
  needed_amount: string | null;
  needed_unit: "g" | "ml" | "piece" | null;
  quantity_to_check: boolean;
  is_pantry: boolean;
  is_selected: boolean;
  menu_id: string | null;
  aisle_id: number | null;
}

export const toBuyRow = (r: GroupRow): BuyRow => ({
  name: r.label,
  qty: r.quantity,
  by: r.first_name ?? "",
  source: r.source === "menu" ? "menu" : "manuel",
  status: "à acheter",
  notBoughtLastTime: false,
  needed: r.needed_amount !== null && r.needed_unit ? { amount: Number(r.needed_amount), unit: r.needed_unit } : null,
  toCheck: r.quantity_to_check,
  pantry: r.is_pantry,
  selected: r.is_selected,
});

/** Sépare les lignes des semaines regroupées : celles à compter dans le total, et les produits frais des semaines après la première (« À acheter plus tard »), rangés par menu. */
export function splitGroupRows(rows: GroupRow[], firstMenuId: string, freshAisles: Set<number>): { main: GroupRow[]; later: Map<string, GroupRow[]> } {
  const main: GroupRow[] = [];
  const later = new Map<string, GroupRow[]>();
  for (const r of rows) {
    if (r.menu_id !== null && r.menu_id !== firstMenuId && r.aisle_id !== null && freshAisles.has(r.aisle_id)) later.set(r.menu_id, [...(later.get(r.menu_id) ?? []), r]);
    else main.push(r);
  }
  return { main, later };
}

/**
 * Un produit présent sur plusieurs semaines devient une seule ligne : besoins additionnés quand l'unité est la même (sinon « Quantité à vérifier »), quantité saisie à la main additionnée,
 * placard seulement si toutes les lignes le sont, coché si une ligne l'est.
 */
export function mergeRows(rows: GroupRow[]): BuyRow[] {
  const byKey = new Map<string, GroupRow[]>();
  for (const r of rows) byKey.set(norm(r.label), [...(byKey.get(norm(r.label)) ?? []), r]);
  return [...byKey.values()].map((same) => {
    if (same.length === 1) return toBuyRow(same[0]);
    const first = same[0];
    const units = new Set(same.map((r) => r.needed_unit));
    const missing = same.some((r) => r.needed_amount === null || r.needed_unit === null);
    const comparable = !missing && units.size === 1;
    const manual = same.filter((r) => r.source !== "menu");
    const total = comparable ? same.reduce((s, r) => s + Number(r.needed_amount), 0) : null;
    return {
      name: first.label,
      qty: manual.length ? manual.reduce((s, r) => s + r.quantity, 0) : 1,
      by: same.find((r) => r.first_name)?.first_name ?? "",
      source: same.some((r) => r.source === "menu") ? "menu" : "manuel",
      status: "à acheter",
      notBoughtLastTime: false,
      needed: comparable && total !== null && first.needed_unit ? { amount: total, unit: first.needed_unit } : null,
      toCheck: same.some((r) => r.quantity_to_check) || (!comparable && same.some((r) => r.needed_amount !== null)),
      pantry: same.every((r) => r.is_pantry),
      selected: same.some((r) => r.is_selected),
    } satisfies BuyRow;
  });
}

/** Répartit `total` unités entre des semaines au prorata de leurs poids (plus fort reste) : la somme rendue est toujours `total`. */
export function allocate(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((s, w) => s + Math.max(w, 0), 0);
  const shares = weights.map((w) => (sum > 0 ? (Math.max(w, 0) / sum) * total : total / n));
  const base = shares.map((x) => Math.floor(x));
  let left = total - base.reduce((s, x) => s + x, 0);
  const order = shares.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    base[i] += 1;
    left -= 1;
  }
  return base;
}
