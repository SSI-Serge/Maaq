import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import type { CommonPrice, HistoryPrice, LightVersion, PriceUnit, ReferenceRow } from "../engine";
import { displayPlace } from "../household/settings";

/** Lectures de base de la liste de courses : références du catalogue, historique des tickets, prix partagés, versions allégées. Le moteur n'en voit que des lignes simples. */

const isoDay = (value: Date | string) => (typeof value === "string" ? value.slice(0, 10) : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`);

const asPriceUnit = (value: string | null | undefined): PriceUnit => (value === "kg" || value === "l" ? value : "unit");

export interface ExcludedReference {
  product: string;
  store: string;
  reference: string;
  /** Critères d'additifs qui excluent la référence ; vide quand le catalogue d'origine n'a trouvé aucune référence conforme. */
  because: string[];
}

export interface References {
  rows: ReferenceRow[];
  /** Références écartées (additif d'un critère actif, ou « aucun conforme trouvé »), pour la rubrique « Ingrédients exclus ». */
  excluded: ExcludedReference[];
  /** Rayon de chaque produit du catalogue (nom du produit → rayon). */
  aisles: Map<string, string>;
}

export async function loadReferences(db: Kysely<DB>): Promise<References> {
  const rows = await db
    .selectFrom("v_grocery_product_references as r")
    .innerJoin("grocery_products as p", "p.id", "r.product_id")
    .innerJoin("grocery_aisles as a", "a.id", "p.aisle_id")
    .select(["p.name as product", "a.name as rayon", "r.store_chain", "r.reference_name", "r.unit_price", "r.price_date", "r.is_compliant", "r.needs_label_check", "r.excluded_because", "r.compliance_status", "r.package_format", "r.price_unit", "r.measure_unit", "r.price_per_measure"])
    .orderBy("p.name")
    .orderBy("r.store_chain")
    .execute();
  const aisles = new Map<string, string>();
  const refs: ReferenceRow[] = [];
  const excluded: ExcludedReference[] = [];
  for (const r of rows) {
    if (!r.product || !r.rayon || !r.store_chain || !r.reference_name) continue;
    aisles.set(r.product, r.rayon);
    if (r.is_compliant === false) {
      excluded.push({ product: r.product, store: displayPlace(r.store_chain), reference: r.reference_name, because: r.excluded_because ?? [] });
      continue;
    }
    refs.push({
      product: r.product,
      rayon: r.rayon,
      used: "",
      store: displayPlace(r.store_chain),
      ref: r.reference_name,
      price: r.unit_price === null ? null : Number(r.unit_price),
      priceDate: r.price_date ? isoDay(r.price_date as Date | string) : null,
      conform: true,
      labelCheck: !!r.needs_label_check,
      format: r.package_format,
      priceUnit: asPriceUnit(r.price_unit),
      perMeasure: r.price_per_measure !== null && (r.measure_unit === "kg" || r.measure_unit === "l") ? { value: Number(r.price_per_measure), unit: r.measure_unit } : null,
    });
  }
  return { rows: refs, excluded, aisles };
}

/** Prix des tickets du foyer (12 mois) : le « dernier acheté » du comparatif et le pense-bête des 3 derniers mois. */
export async function loadHistory(db: Kysely<DB>, accountId: string): Promise<HistoryPrice[]> {
  const rows = await db
    .selectFrom("grocery_receipt_lines as l")
    .innerJoin("grocery_receipts as r", (j) => j.onRef("r.id", "=", "l.receipt_id").onRef("r.account_id", "=", "l.account_id"))
    .select(["l.label", "l.reference_name", "l.line_total", "l.quantity", "l.measure_unit", "l.price_per_measure", "r.store_chain", "r.store_city", "r.purchased_on"])
    .where("l.account_id", "=", accountId)
    .where("l.line_total", ">", "0")
    .orderBy("r.purchased_on")
    .execute();
  return rows.map((r) => ({
    product: r.label,
    ref: r.reference_name ?? r.label,
    // ligne pesée : le prix au kilo ou au litre, jamais le poids ; sinon le prix d'un article
    unitPrice: r.measure_unit && r.price_per_measure !== null ? Number(r.price_per_measure) : Number((Number(r.line_total) / Number(r.quantity)).toFixed(2)),
    priceUnit: r.measure_unit && r.price_per_measure !== null ? asPriceUnit(r.measure_unit) : ("unit" as PriceUnit),
    store: displayPlace(r.store_chain),
    date: isoDay(r.purchased_on as Date | string),
    city: r.store_city ? displayPlace(r.store_city) : null,
  }));
}

/** Prix relevés par les autres foyers, lisibles seulement si le foyer partage les siens (réciprocité gérée par la base). */
export async function loadCommonPrices(db: Kysely<DB>, userId: string): Promise<CommonPrice[]> {
  const rows = await sql<{ name: string; reference_name: string; unit_price: string; store_chain: string; city: string; week_start: Date | string; price_unit: string; measure_unit: string | null; price_per_measure: string | null }>`
    select p.name, s.reference_name, s.unit_price, s.store_chain, s.city, s.week_start, s.price_unit, s.measure_unit, s.price_per_measure
      from grocery_shared_prices_for(${userId}::uuid) s join grocery_products p on p.id = s.product_id`.execute(db);
  return rows.rows.map((r) => ({
    product: r.name,
    ref: r.reference_name,
    price: Number(r.unit_price),
    store: displayPlace(r.store_chain),
    city: displayPlace(r.city),
    week: isoDay(r.week_start),
    priceUnit: asPriceUnit(r.price_unit),
    perMeasure: r.price_per_measure !== null && (r.measure_unit === "kg" || r.measure_unit === "l") ? { value: Number(r.price_per_measure), unit: r.measure_unit } : null,
  }));
}

/** Versions allégées des plats donnés (identifiants de base), sous la forme du moteur. */
export async function loadLightVersions(db: Kysely<DB>, dishIds: { dishId: string; code: string }[]): Promise<Map<string, LightVersion>> {
  const out = new Map<string, LightVersion>();
  if (!dishIds.length) return out;
  const ids = dishIds.map((d) => d.dishId);
  const [versions, items] = await Promise.all([
    db.selectFrom("meal_light_versions").select(["dish_id", "display_text"]).where("dish_id", "in", ids).execute(),
    db
      .selectFrom("meal_light_version_items as i")
      .leftJoin("grocery_products as p", "p.id", "i.product_id")
      .select(["i.dish_id", "i.kind", "i.name_key", "p.name as product"])
      .where("i.dish_id", "in", ids)
      .orderBy("i.id")
      .execute(),
  ]);
  const code = new Map(dishIds.map((d) => [d.dishId, d.code]));
  for (const v of versions) {
    const c = code.get(String(v.dish_id));
    if (c) out.set(c, { dishId: c, remove: [], add: [], text: v.display_text });
  }
  for (const i of items) {
    const entry = out.get(code.get(String(i.dish_id)) ?? "");
    if (!entry) continue;
    const name = i.product ?? i.name_key.charAt(0).toUpperCase() + i.name_key.slice(1);
    (i.kind === "remove" ? entry.remove : entry.add).push(name);
  }
  return out;
}
