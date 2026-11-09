import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";

/**
 * Besoins du menu par produit (CR-50) : à la validation du menu, la vue `v_meal_menu_needs` additionne les quantités de tous les plats (express compris) par produit et par unité de base ;
 * chaque produit de la liste reçoit ici son besoin (« 900 g pour le menu »), la mention « Quantité à vérifier » quand la conversion est impossible, et l'état « placard » (décoché).
 * Un produit ajouté à la main ou de l'historique n'a pas de besoin : 1 par défaut.
 */

interface NeedRow {
  product_id: string | null;
  name_key: string | null;
  base_unit: "g" | "ml" | "piece" | null;
  total_quantity: string | null;
  needs_check: boolean;
  is_pantry: boolean;
}

export interface ProductNeed {
  /** Besoin en g, ml ou pièce ; vide quand il n'est pas calculable. */
  amount: number | null;
  unit: "g" | "ml" | "piece" | null;
  toCheck: boolean;
  pantry: boolean;
}

/** Regroupe les lignes de la vue d'un même produit : une seule unité de base et aucune quantité manquante = besoin exact ; sinon « à vérifier ». Cuillères et pincées seules = placard. */
export function foldNeed(rows: Pick<NeedRow, "base_unit" | "total_quantity" | "needs_check" | "is_pantry">[]): ProductNeed {
  const quantified = rows.filter((r) => r.base_unit !== null && r.total_quantity !== null);
  const units = new Set(quantified.map((r) => r.base_unit));
  const missing = rows.some((r) => r.needs_check);
  const pantry = rows.every((r) => r.is_pantry);
  if (units.size === 1 && !missing) {
    const row = quantified[0];
    return { amount: Number(row.total_quantity), unit: row.base_unit, toCheck: false, pantry };
  }
  // cuillères et pincées seules : le besoin n'est pas convertible, mais ce n'est pas une anomalie
  if (units.size === 0 && !missing) return { amount: null, unit: null, toCheck: false, pantry };
  return { amount: null, unit: null, toCheck: true, pantry };
}

export async function applyNeedsToItems(trx: Kysely<DB>, accountId: string, menuId: string): Promise<number> {
  const rows = (await sql<NeedRow>`select product_id::text as product_id, name_key, base_unit, total_quantity::text as total_quantity, coalesce(needs_check, false) as needs_check, coalesce(is_pantry, false) as is_pantry from v_meal_menu_needs where menu_id = ${menuId}::uuid`.execute(trx)).rows;
  if (!rows.length) return 0;
  const byProduct = new Map<string, NeedRow[]>();
  const byName = new Map<string, NeedRow[]>();
  for (const r of rows) {
    const bucket = r.product_id ? byProduct : byName;
    const key = r.product_id ?? r.name_key ?? "";
    bucket.set(key, [...(bucket.get(key) ?? []), r]);
  }
  const items = await trx.selectFrom("grocery_list_items").select(["id", "product_id", "name_key"]).where("account_id", "=", accountId).where("state", "=", "preparing").execute();
  let applied = 0;
  for (const item of items) {
    const found = (item.product_id !== null ? byProduct.get(String(item.product_id)) : undefined) ?? byName.get(item.name_key);
    if (!found) continue;
    const need = foldNeed(found);
    await trx
      .updateTable("grocery_list_items")
      .set({
        needed_amount: need.amount === null ? null : need.amount.toFixed(3),
        needed_unit: need.unit,
        quantity_to_check: need.toCheck,
        is_pantry: need.pantry,
        is_selected: !need.pantry,
      })
      .where("id", "=", item.id)
      .execute();
    applied += 1;
  }
  return applied;
}
