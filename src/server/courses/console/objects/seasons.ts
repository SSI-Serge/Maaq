import { logAdminAction } from "@/server/admin/audit";
import { nameKey } from "../../catalog/seed";
import { courseError } from "../../household/settings";
import type { ConsoleObject, FormField } from "../types";
import { text, whole } from "../util";

/** Calendrier de saison (US-168) : les mois de saison de chaque produit. Avec l'objectif « saison », les plats aux ingrédients de saison passent devant. */

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const monthOptions = MONTHS.map((m, i) => ({ value: String(i + 1), label: m }));

/** « septembre → février », « toute l'année » ; une série de mois à cheval sur deux années est lue d'un seul tenant. */
export function rangeText(months: number[]): string {
  const set = new Set(months);
  if (set.size === 12) return "toute l'année";
  if (!set.size) return "—";
  const start = [...set].find((m) => !set.has(m === 1 ? 12 : m - 1)) ?? [...set][0];
  const parts: string[] = [];
  let m = start;
  let last = start;
  while (set.has(m) && parts.length < 12) {
    parts.push(MONTHS[m - 1]);
    last = m;
    m = m === 12 ? 1 : m + 1;
  }
  if (parts.length !== set.size) return [...set].sort((a, b) => a - b).map((x) => MONTHS[x - 1]).join(", ");
  return parts.length === 1 ? MONTHS[last - 1] : `${parts[0]} → ${parts[parts.length - 1]}`;
}

function monthsBetween(from: number, to: number): number[] {
  const out: number[] = [];
  for (let m = from; ; m = m === 12 ? 1 : m + 1) {
    out.push(m);
    if (m === to || out.length === 12) break;
  }
  return out;
}

const fields = (from: number, to: number): FormField[] => [
  { key: "from", label: "De (mois)", type: "select", value: String(from), options: monthOptions },
  { key: "to", label: "À (mois)", type: "select", value: String(to), options: monthOptions },
];

export const seasons: ConsoleObject = {
  async load(c, query) {
    const { db } = c.ctx;
    let q = db.selectFrom("grocery_product_seasons as s").innerJoin("grocery_products as p", "p.id", "s.product_id").select(["p.id", "p.name", "s.season_month"]).orderBy("p.name");
    if (query.q) q = q.where("p.name", "ilike", `%${query.q}%`);
    const rows = await q.execute();
    const byProduct = new Map<string, { name: string; months: number[] }>();
    for (const r of rows) {
      const e = byProduct.get(String(r.id)) ?? { name: r.name, months: [] };
      e.months.push(r.season_month);
      byProduct.set(String(r.id), e);
    }
    return {
      object: "saisons",
      title: "Calendrier de saison",
      intro: "Avec l'objectif « saison », les plats aux ingrédients de saison passent devant.",
      info: null,
      columns: [
        { key: "name", label: "Produit" },
        { key: "months", label: "Mois de saison" },
      ],
      rows: [...byProduct].map(([id, e]) => {
        const sorted = [...e.months].sort((a, b) => a - b);
        const start = sorted.find((m) => !e.months.includes(m === 1 ? 12 : m - 1)) ?? sorted[0];
        const end = [...sorted].reverse().find((m) => !e.months.includes(m === 12 ? 1 : m + 1)) ?? sorted[sorted.length - 1];
        return { id, cells: { name: e.name, months: rangeText(e.months) }, actions: [{ key: "edit", label: "Modifier", fields: fields(start, end) }, { key: "clear", label: "Retirer", confirm: `Retirer le calendrier de « ${e.name} » ?` }] };
      }),
      filters: [],
      search: true,
      total: byProduct.size,
      footer: null,
      tools: { add: { label: "Ajouter un produit de saison", fields: [{ key: "product", label: "Produit (nom exact du catalogue)", type: "text", required: true }, ...fields(6, 9)] } },
    };
  },

  async act(c, action, id, values) {
    const { db, now } = c.ctx;
    let productId = id;
    if (action === "add") {
      const name = text(values, "product", "le produit", 120);
      const p = await db.selectFrom("grocery_products").select("id").where("name_key", "=", nameKey(name)).executeTakeFirst();
      if (!p) throw courseError("unknown_product", `Le produit « ${name} » n'existe pas dans le catalogue.`, 422);
      productId = String(p.id);
    }
    if (action === "add" || action === "edit") {
      const months = monthsBetween(whole(values, "from", "le mois de début", 1, 12), whole(values, "to", "le mois de fin", 1, 12));
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom("grocery_product_seasons").where("product_id", "=", productId).execute();
        await trx.insertInto("grocery_product_seasons").values(months.map((m) => ({ product_id: productId, season_month: m }))).execute();
      });
    } else if (action === "clear") {
      await db.deleteFrom("grocery_product_seasons").where("product_id", "=", productId).execute();
    } else {
      throw courseError("unknown_action", "Action inconnue.", 422);
    }
    await logAdminAction(db, { adminId: c.adminId, action: "grocery_catalog_changed", entityType: "grocery_season", entityId: productId, details: { action }, now });
  },
};
