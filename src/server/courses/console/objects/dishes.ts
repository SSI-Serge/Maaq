import { sql } from "kysely";
import { logAdminAction } from "@/server/admin/audit";
import { fmtMin } from "../../engine";
import { courseError } from "../../household/settings";
import { ROW_LIMIT, type ConsoleContext, type ConsoleObject, type ConsoleQuery, type ConsoleTable } from "../types";
import { csv, text, whole } from "../util";

/** Plats du catalogue commun (US-164) : liste filtrable, retrait et rétablissement, modification des champs simples. Les plats personnels des foyers n'y figurent pas. */

const DURATIONS = [
  { value: "express", label: "Express (15 min au plus)" },
  { value: "30", label: "30 min au plus" },
  { value: "60", label: "1 h au plus" },
  { value: "long", label: "Plus d'1 h" },
];

async function rows(c: ConsoleContext, query: ConsoleQuery) {
  const { db } = c.ctx;
  let q = db
    .selectFrom("v_meal_dishes_console as v")
    .innerJoin("meal_cuisines as c", "c.id", "v.cuisine_id")
    .select(["v.dish_id", "v.code", "v.name", "v.duration_minutes", "v.is_express", "v.retired_at", "v.in_batch_week", "v.has_light_version", "c.name as cuisine", "v.cuisine_id"])
    .orderBy(sql`length(v.code)`)
    .orderBy("v.code");
  if (query.q) q = q.where((eb) => eb.or([eb("v.name", "ilike", `%${query.q}%`), eb("v.code", "ilike", `%${query.q}%`)]));
  if (query.filters.cuisine) q = q.where("v.cuisine_id", "=", Number(query.filters.cuisine));
  if (query.filters.categorie) q = q.where("v.dish_id", "in", db.selectFrom("meal_dish_category_links").select("dish_id").where("category_id", "=", Number(query.filters.categorie)));
  const d = query.filters.duree;
  if (d === "express") q = q.where("v.duration_minutes", "<=", 15);
  else if (d === "30") q = q.where("v.duration_minutes", "<=", 30);
  else if (d === "60") q = q.where("v.duration_minutes", "<=", 60);
  else if (d === "long") q = q.where("v.duration_minutes", ">", 60);
  if ((query.filters.etat ?? "actifs") === "actifs") q = q.where("v.retired_at", "is", null);
  else if (query.filters.etat === "retires") q = q.where("v.retired_at", "is not", null);
  return q.execute();
}

export const dishes: ConsoleObject = {
  async load(c, query) {
    const { db } = c.ctx;
    const [list, cuisines, categories, links, weeks, stats] = await Promise.all([
      rows(c, query),
      db.selectFrom("meal_cuisines").select(["id", "name"]).orderBy("sort_order").execute(),
      db.selectFrom("meal_dish_categories").select(["id", "name"]).orderBy("sort_order").execute(),
      db.selectFrom("meal_dish_category_links as l").innerJoin("meal_dish_categories as k", "k.id", "l.category_id").select(["l.dish_id", "k.name"]).execute(),
      db.selectFrom("meal_batch_week_days as d").innerJoin("meal_batch_weeks as w", "w.id", "d.week_id").select(["w.code", "d.dish_id", "d.suggested_dish_id"]).execute(),
      db.selectFrom("v_meal_dishes_console").select(["is_express", "in_batch_week", "retired_at"]).execute(),
    ]);
    const active = stats.filter((s) => !s.retired_at);
    const weekOf = (id: string) => [...new Set(weeks.filter((w) => String(w.dish_id) === id || String(w.suggested_dish_id) === id).map((w) => w.code))].join(", ");
    const out: ConsoleTable = {
      object: "plats",
      title: "Plats du catalogue commun",
      intro: "Communs à tous les foyers. Un plat retiré n'est plus proposé ; il reste dans l'historique des foyers. Les plats personnels des foyers n'apparaissent pas ici.",
      info: `${active.filter((s) => s.is_express).length} plats express (15 min au plus) · ${active.filter((s) => !s.in_batch_week).length} plats sans semaine type de batch`,
      columns: [
        { key: "code", label: "Id" },
        { key: "name", label: "Nom" },
        { key: "cuisine", label: "Cuisine" },
        { key: "categories", label: "Catégories" },
        { key: "duration", label: "Durée" },
        { key: "week", label: "Semaine type" },
      ],
      rows: list.slice(0, ROW_LIMIT).map((r) => ({
        id: String(r.dish_id),
        tone: r.retired_at ? ("muted" as const) : undefined,
        cells: {
          code: r.code ?? "",
          name: r.name ?? "",
          cuisine: r.cuisine,
          categories: links.filter((l) => String(l.dish_id) === String(r.dish_id)).map((l) => l.name).join(", "),
          duration: fmtMin(r.duration_minutes ?? 0),
          week: weekOf(String(r.dish_id)) || "—",
        },
        actions: [
          {
            key: "edit",
            label: "Modifier",
            fields: [
              { key: "name", label: "Nom", type: "text" as const, value: r.name, required: true },
              { key: "cuisine", label: "Cuisine", type: "select" as const, value: String(r.cuisine_id), options: cuisines.map((k) => ({ value: String(k.id), label: k.name })) },
              { key: "minutes", label: "Durée (min)", type: "number" as const, value: r.duration_minutes },
            ],
          },
          r.retired_at ? { key: "restore", label: "Rétablir" } : { key: "retire", label: "Retirer", confirm: `Retirer « ${r.name} » ? Il ne sera plus proposé ; il reste dans l'historique des foyers.` },
        ],
      })),
      filters: [
        { key: "cuisine", label: "Cuisine", value: query.filters.cuisine ?? "", options: [{ value: "", label: "Cuisine : toutes" }, ...cuisines.map((k) => ({ value: String(k.id), label: k.name }))] },
        { key: "categorie", label: "Catégorie", value: query.filters.categorie ?? "", options: [{ value: "", label: "Catégorie : toutes" }, ...categories.map((k) => ({ value: String(k.id), label: k.name }))] },
        { key: "duree", label: "Durée", value: query.filters.duree ?? "", options: [{ value: "", label: "Durée : toutes" }, ...DURATIONS] },
        { key: "etat", label: "État", value: query.filters.etat ?? "actifs", options: [{ value: "actifs", label: "Plats proposés" }, { value: "retires", label: "Plats retirés" }, { value: "tous", label: "Tous" }] },
      ],
      search: true,
      total: list.length,
      footer: "Les ingrédients, étiquettes et saisons d'un plat se règlent par l'import du catalogue.",
      tools: { downloads: [{ key: "export", label: "Exporter" }, { key: "hors-batch", label: "Télécharger « plats hors batch »" }] },
    };
    return out;
  },

  async act(c, action, id, values) {
    const { db, now } = c.ctx;
    const dish = await db.selectFrom("meal_dishes").select(["id", "code", "name"]).where("id", "=", id).executeTakeFirst();
    if (!dish) throw courseError("not_found", "Ce plat n'existe plus.", 404);
    if (action === "retire" || action === "restore") {
      await db.updateTable("meal_dishes").set({ retired_at: action === "retire" ? now : null, updated_at: now }).where("id", "=", dish.id).execute();
    } else if (action === "edit") {
      const name = text(values, "name", "le nom", 120);
      const cuisine = whole(values, "cuisine", "la cuisine", 1, 100000);
      const minutes = whole(values, "minutes", "la durée", 1, 600);
      await db.updateTable("meal_dishes").set({ name, cuisine_id: cuisine, duration_minutes: minutes, updated_at: now }).where("id", "=", dish.id).execute();
    } else {
      throw courseError("unknown_action", "Action inconnue.", 422);
    }
    await logAdminAction(db, { adminId: c.adminId, action: "meal_catalog_changed", entityType: "meal_dish", entityId: dish.code, details: { action, name: dish.name }, now });
  },

  async download(c, key, query) {
    const { db } = c.ctx;
    if (key === "hors-batch") {
      const unlinked = await db.selectFrom("v_meal_dishes_console").select(["code", "name"]).where("retired_at", "is", null).where("in_batch_week", "=", false).orderBy("code").execute();
      const weak = await db
        .selectFrom("v_meal_batch_week_days as d")
        .innerJoin("meal_batch_weeks as w", "w.id", "d.week_id")
        .select(["w.code", "d.weekday", "d.planning_dish_name", "d.match_pct", "d.match_status"])
        .where("d.match_status", "<>", "sure")
        .execute();
      return {
        file: "plats_hors_batch.csv",
        content: csv(
          ["type", "semaine", "jour", "id_plat", "plat", "pourcentage", "statut"],
          [
            ...unlinked.map((u) => ["plat sans semaine type", "", "", u.code, u.name, "", ""]),
            ...weak.map((w) => ["plat de planning non sûr", w.code, w.weekday, "", w.planning_dish_name, w.match_pct, w.match_status]),
          ],
        ),
      };
    }
    const list = await rows(c, { ...query, filters: { ...query.filters, etat: query.filters.etat ?? "tous" } });
    return { file: "plats.csv", content: csv(["id", "nom", "cuisine", "duree_min", "express", "retire"], list.map((r) => [r.code, r.name, r.cuisine, r.duration_minutes, r.is_express ? "oui" : "non", r.retired_at ? "oui" : "non"])) };
  },
};
