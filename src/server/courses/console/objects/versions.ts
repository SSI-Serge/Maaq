import type { Kysely } from "kysely";
import { logAdminAction } from "@/server/admin/audit";
import type { DB } from "@/server/db/schema.generated";
import { nameKey } from "../../catalog/seed";
import { courseError } from "../../household/settings";
import { VERSIONS_SPEC, VERSIONS_TEMPLATE_HEADERS } from "../../imports/specs";
import { toCsv } from "../../imports/table";
import { importRefusal, readImport } from "../import";
import { ROW_LIMIT, type ConsoleObject } from "../types";
import { csv } from "../util";

/**
 * Versions allégées (US-172) : plat par plat, les produits à retirer et à ajouter (séparés par |) et le texte affiché aux foyers. Sans produit, le texte reste un conseil de
 * préparation. Un produit à retirer doit être au catalogue ; un produit à ajouter absent du catalogue est noté dans les produits à référencer (RF4).
 */

const split = (raw: string) => [...new Set(raw.split("|").map((x) => x.trim()).filter(Boolean))];

interface Version {
  remove: string[];
  add: string[];
  text: string;
}

async function saveVersion(trx: Kysely<DB>, dishId: string, version: Version, now: Date, report: (line: string) => void): Promise<void> {
  const products = await trx.selectFrom("grocery_products").select(["id", "name_key"]).execute();
  const byKey = new Map(products.map((p) => [p.name_key, p.id]));
  await trx.deleteFrom("meal_light_version_items").where("dish_id", "=", dishId).execute();
  await trx.deleteFrom("meal_light_versions").where("dish_id", "=", dishId).execute();
  if (!version.remove.length && !version.add.length && !version.text) return;
  await trx.insertInto("meal_light_versions").values({ dish_id: dishId, display_text: version.text || "Version allégée", updated_at: now }).execute();
  for (const name of version.remove) await trx.insertInto("meal_light_version_items").values({ dish_id: dishId, kind: "remove", name_key: nameKey(name).slice(0, 120), product_id: byKey.get(nameKey(name))! }).execute();
  for (const name of version.add) {
    const key = nameKey(name).slice(0, 120);
    const product = byKey.get(key) ?? null;
    await trx.insertInto("meal_light_version_items").values({ dish_id: dishId, kind: "add", name_key: key, product_id: product }).execute();
    if (!product) {
      await trx.insertInto("grocery_unreferenced_events").values({ name_key: name.toLowerCase().slice(0, 120), kind: "unknown", source: "menu" }).execute();
      report(`« ${name} » n'est pas au catalogue : noté dans les produits à référencer.`);
    }
  }
}

async function unknownRemovals(db: Kysely<DB>, remove: string[]): Promise<string[]> {
  if (!remove.length) return [];
  const known = new Set((await db.selectFrom("grocery_products").select("name_key").where("name_key", "in", remove.map(nameKey)).execute()).map((p) => p.name_key));
  return remove.filter((n) => !known.has(nameKey(n)));
}

export const versions: ConsoleObject = {
  async load(c, query) {
    const { db } = c.ctx;
    let q = db
      .selectFrom("meal_dishes as d")
      .leftJoin("meal_light_versions as v", "v.dish_id", "d.id")
      .select(["d.id", "d.code", "d.name", "v.display_text", "v.dish_id as has"])
      .where("d.retired_at", "is", null)
      .orderBy("d.code");
    if (query.q) q = q.where((eb) => eb.or([eb("d.name", "ilike", `%${query.q}%`), eb("d.code", "ilike", `%${query.q}%`)]));
    if (query.filters.etat === "sans") q = q.where("v.dish_id", "is", null);
    else q = q.where((eb) => (query.filters.etat === "avec" ? eb("v.dish_id", "is not", null) : eb.val(true)));
    const [dishes, items, products] = await Promise.all([q.execute(), db.selectFrom("meal_light_version_items").select(["dish_id", "kind", "name_key", "product_id"]).execute(), db.selectFrom("grocery_products").select(["id", "name"]).execute()]);
    const name = new Map(products.map((p) => [String(p.id), p.name]));
    const label = (i: { product_id: string | null; name_key: string }) => (i.product_id ? name.get(String(i.product_id)) : undefined) ?? i.name_key;
    const itemsOf = (id: string, kind: string) => items.filter((i) => String(i.dish_id) === id && i.kind === kind).map(label);
    return {
      object: "versions",
      title: "Versions allégées",
      intro: "Produits à retirer et à ajouter, plat par plat (séparés par |). Sans produit, le texte reste un conseil de préparation. Un identifiant de plat inconnu refuse tout l'import.",
      info: null,
      columns: [
        { key: "dish", label: "Plat" },
        { key: "remove", label: "Retire" },
        { key: "add", label: "Ajoute" },
        { key: "text", label: "Texte affiché" },
      ],
      rows: dishes.slice(0, ROW_LIMIT).map((d) => {
        const remove = itemsOf(String(d.id), "remove");
        const add = itemsOf(String(d.id), "add");
        return {
          id: String(d.id),
          cells: { dish: `${d.code} ${d.name}`, remove: remove.join(" | ") || "—", add: add.join(" | ") || "—", text: d.display_text ?? "—" },
          actions: [
            {
              key: "edit",
              label: "Modifier",
              fields: [
                { key: "remove", label: "Produits à retirer (séparés par |)", type: "text" as const, value: remove.join(" | ") },
                { key: "add", label: "Produits à ajouter (séparés par |)", type: "text" as const, value: add.join(" | ") },
                { key: "text", label: "Texte affiché aux foyers", type: "textarea" as const, value: d.display_text ?? "" },
              ],
            },
          ],
        };
      }),
      filters: [{ key: "etat", label: "Version", value: query.filters.etat ?? "", options: [{ value: "", label: "Tous les plats" }, { value: "avec", label: "Avec version allégée" }, { value: "sans", label: "Sans version allégée" }] }],
      search: true,
      total: dishes.length,
      footer: null,
      tools: { downloads: [{ key: "template", label: "Télécharger le modèle" }, { key: "export", label: "Exporter" }, { key: "sans", label: "Télécharger les plats sans substitution" }], import: { replaceAll: false } },
    };
  },

  async act(c, action, id, values) {
    const { db, now } = c.ctx;
    if (action !== "edit") throw courseError("unknown_action", "Action inconnue.", 422);
    const dish = await db.selectFrom("meal_dishes").select(["id", "code"]).where("id", "=", id).executeTakeFirst();
    if (!dish) throw courseError("not_found", "Ce plat n'existe plus.", 404);
    const version = { remove: split(values.remove ?? ""), add: split(values.add ?? ""), text: (values.text ?? "").trim().slice(0, 600) };
    const unknown = await unknownRemovals(db, version.remove);
    if (unknown.length) throw courseError("unknown_product", `Produit à retirer inconnu du catalogue : ${unknown.join(", ")}.`, 422);
    await db.transaction().execute((trx) => saveVersion(trx, id, version, now, () => undefined));
    await logAdminAction(db, { adminId: c.adminId, action: "meal_catalog_changed", entityType: "meal_dish", entityId: dish.code, details: { action: "light_version" }, now });
  },

  async download(c, key) {
    const { db } = c.ctx;
    const [dishes, versionRows, items, products] = await Promise.all([
      db.selectFrom("meal_dishes").select(["id", "code", "name"]).where("retired_at", "is", null).orderBy("code").execute(),
      db.selectFrom("meal_light_versions").select(["dish_id", "display_text"]).execute(),
      db.selectFrom("meal_light_version_items").select(["dish_id", "kind", "name_key", "product_id"]).execute(),
      db.selectFrom("grocery_products").select(["id", "name"]).execute(),
    ]);
    if (key === "template") return { file: VERSIONS_SPEC.templateFile, content: toCsv(VERSIONS_TEMPLATE_HEADERS, [["I3", "Lasagnes", "Pâtes à lasagne | Crème fraîche", "Pâtes semi-complètes", "Pâtes semi-complètes, béchamel sans crème."]]) };
    const has = new Set(versionRows.map((v) => String(v.dish_id)));
    if (key === "sans") return { file: "plats_sans_version_allegee.csv", content: csv(["id_plat", "plat"], dishes.filter((d) => !has.has(String(d.id))).map((d) => [d.code, d.name])) };
    const name = new Map(products.map((p) => [String(p.id), p.name]));
    const label = (i: { product_id: string | null; name_key: string }) => (i.product_id ? name.get(String(i.product_id)) : undefined) ?? i.name_key;
    return {
      file: "versions_allegees.csv",
      content: csv(
        VERSIONS_TEMPLATE_HEADERS,
        dishes
          .filter((d) => has.has(String(d.id)))
          .map((d) => [d.code, d.name, items.filter((i) => String(i.dish_id) === String(d.id) && i.kind === "remove").map(label).join("|"), items.filter((i) => String(i.dish_id) === String(d.id) && i.kind === "add").map(label).join("|"), versionRows.find((v) => String(v.dish_id) === String(d.id))?.display_text ?? ""]),
      ),
    };
  },

  async import(c, file, options) {
    const { db, now } = c.ctx;
    const dishes = await db.selectFrom("meal_dishes").select(["id", "code"]).execute();
    const idOf = new Map(dishes.map((d) => [d.code, String(d.id)]));
    const outcome = await readImport(VERSIONS_SPEC, file, { knownDishIds: new Set(idOf.keys()) });
    const issues: { line: number; column: string; message: string }[] = [];
    const rows = outcome.rows.map((r) => ({ line: r.line, code: String(r.values.id_plat), version: { remove: (r.values.retirer as string[] | null) ?? [], add: (r.values.ajouter as string[] | null) ?? [], text: ((r.values.texte_source as string | null) ?? "").slice(0, 600) } }));
    for (const r of rows) {
      const unknown = await unknownRemovals(db, r.version.remove);
      for (const n of unknown) issues.push({ line: r.line, column: "retirer", message: `le produit « ${n} » est inconnu du catalogue.` });
    }
    if (issues.length) importRefusal(issues);
    const notes: string[] = [];
    if (options.dryRun) return { count: rows.length, lines: [`Fichier vérifié : ${rows.length} plat${rows.length > 1 ? "s" : ""}. Rien n'a été importé.`] };
    await db.transaction().execute(async (trx) => {
      for (const r of rows) await saveVersion(trx, idOf.get(r.code)!, r.version, now, (l) => notes.push(`${r.code} : ${l}`));
    });
    await logAdminAction(db, { adminId: c.adminId, action: "meal_catalog_changed", entityType: "meal_dish", entityId: "versions", details: { lines: rows.length }, now });
    return { count: rows.length, lines: notes.slice(0, 50) };
  },
};
