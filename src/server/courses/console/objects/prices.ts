import { logAdminAction } from "@/server/admin/audit";
import { courseError } from "../../household/settings";
import { ROW_LIMIT, type ConsoleContext, type ConsoleObject, type ConsoleQuery } from "../types";
import { csv, euro, isoWeek } from "../util";

/**
 * Base commune des prix (US-175) : les lignes partagées anonymement par les foyers. Aucune colonne ne retrouve le foyer ; la date est la semaine. Un prix très éloigné des
 * autres prix du même produit dans la même enseigne est signalé « à vérifier » (la vue de la base applique les seuils de la console). Une ligne retirée n'est plus utilisée.
 */

async function list(c: ConsoleContext, query: ConsoleQuery) {
  const { db } = c.ctx;
  let q = db
    .selectFrom("v_grocery_shared_prices_moderation as m")
    .innerJoin("grocery_products as p", "p.id", "m.product_id")
    .select(["m.price_id", "m.reference_name", "m.unit_price", "m.store_chain", "m.city", "m.week_start", "m.needs_check", "m.removed_at", "p.name as product"])
    .orderBy("m.needs_check", "desc")
    .orderBy("m.week_start", "desc")
    .orderBy("m.price_id", "desc");
  if (query.q) q = q.where("p.name", "ilike", `%${query.q}%`);
  if (query.filters.ville) q = q.where("m.city", "=", query.filters.ville);
  if (query.filters.enseigne) q = q.where("m.store_chain", "=", query.filters.enseigne);
  const state = query.filters.controle ?? "actives";
  if (state === "verifier") q = q.where("m.needs_check", "=", true).where("m.removed_at", "is", null);
  else if (state === "retirees") q = q.where("m.removed_at", "is not", null);
  else if (state === "actives") q = q.where("m.removed_at", "is", null);
  return q.execute();
}

const cap = (s: string | null) => (s ? s.replace(/(^|[\s'-])(\p{L})/gu, (_, a: string, b: string) => `${a}${b.toUpperCase()}`) : "");

export const prices: ConsoleObject = {
  async load(c, query) {
    const { db } = c.ctx;
    const [rows, cities, stores, all] = await Promise.all([
      list(c, query),
      db.selectFrom("grocery_shared_prices").select("city").distinct().orderBy("city").execute(),
      db.selectFrom("grocery_shared_prices").select("store_chain").distinct().orderBy("store_chain").execute(),
      db.selectFrom("v_grocery_shared_prices_moderation").select(["needs_check", "removed_at"]).execute(),
    ]);
    return {
      object: "base-commune",
      title: "Base commune des prix",
      intro: "Lignes partagées anonymement par les foyers : jamais de foyer, date à la semaine. Une ville n'est affichée aux foyers qu'à partir de 2 foyers qui y partagent.",
      info: `${all.filter((a) => a.needs_check && !a.removed_at).length} prix à vérifier · ${all.filter((a) => !a.removed_at).length} lignes actives`,
      columns: [
        { key: "product", label: "Produit" },
        { key: "ref", label: "Référence" },
        { key: "price", label: "Prix", align: "right" },
        { key: "store", label: "Enseigne" },
        { key: "city", label: "Ville" },
        { key: "week", label: "Semaine" },
        { key: "check", label: "Contrôle" },
      ],
      rows: rows.slice(0, ROW_LIMIT).map((r) => ({
        id: String(r.price_id),
        tone: r.removed_at ? ("muted" as const) : r.needs_check ? ("warn" as const) : undefined,
        cells: {
          product: r.product,
          ref: cap(r.reference_name),
          price: euro(r.unit_price),
          store: cap(r.store_chain),
          city: cap(r.city),
          week: r.week_start ? isoWeek(r.week_start as Date | string) : "",
          check: r.removed_at ? "Retirée" : r.needs_check ? "À vérifier" : "OK",
        },
        actions: r.removed_at ? [{ key: "restore", label: "Rétablir" }] : [{ key: "remove", label: "Retirer", confirm: `Retirer ce prix de ${euro(r.unit_price)} ? Il ne sera plus utilisé dans les comparatifs.` }],
      })),
      filters: [
        { key: "ville", label: "Ville", value: query.filters.ville ?? "", options: [{ value: "", label: "Ville : toutes" }, ...cities.map((v) => ({ value: v.city, label: cap(v.city) }))] },
        { key: "enseigne", label: "Enseigne", value: query.filters.enseigne ?? "", options: [{ value: "", label: "Enseigne : toutes" }, ...stores.map((v) => ({ value: v.store_chain, label: cap(v.store_chain) }))] },
        { key: "controle", label: "Contrôle", value: query.filters.controle ?? "actives", options: [{ value: "actives", label: "Lignes actives" }, { value: "verifier", label: "À vérifier" }, { value: "retirees", label: "Retirées" }, { value: "toutes", label: "Toutes" }] },
      ],
      search: true,
      total: rows.length,
      footer: null,
      tools: { downloads: [{ key: "export", label: "Exporter" }] },
    };
  },

  async act(c, action, id) {
    const { db, now } = c.ctx;
    if (action !== "remove" && action !== "restore") throw courseError("unknown_action", "Action inconnue.", 422);
    const done = await db
      .updateTable("grocery_shared_prices")
      .set(action === "remove" ? { removed_at: now, removed_by_user_id: c.adminId } : { removed_at: null, removed_by_user_id: null })
      .where("id", "=", id)
      .executeTakeFirst();
    if (!done.numUpdatedRows) throw courseError("not_found", "Cette ligne n'existe plus.", 404);
    await logAdminAction(db, { adminId: c.adminId, action: "grocery_price_moderated", entityType: "grocery_shared_price", entityId: id, details: { action }, now });
  },

  async download(c, _key, query) {
    const rows = await list(c, { ...query, filters: { ...query.filters, controle: query.filters.controle ?? "toutes" } });
    return {
      file: "base_commune_prix.csv",
      content: csv(["produit", "reference", "prix", "enseigne", "ville", "semaine", "controle"], rows.map((r) => [r.product, r.reference_name, r.unit_price, r.store_chain, r.city, r.week_start ? isoWeek(r.week_start as Date | string) : "", r.removed_at ? "retiree" : r.needs_check ? "a verifier" : "ok"])),
    };
  },
};
