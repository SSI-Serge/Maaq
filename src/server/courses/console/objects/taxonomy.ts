import { logAdminAction } from "@/server/admin/audit";
import { courseError } from "../../household/settings";
import type { ConsoleObject } from "../types";
import { oneOf, text, whole } from "../util";

/** Cuisines et catégories (US-165) : un nom et un ordre. Une cuisine ou une catégorie utilisée ne se supprime pas, elle se masque. */

const KINDS = ["cuisine", "categorie"] as const;

function parse(id: string): { kind: (typeof KINDS)[number]; id: number } {
  const [kind, n] = id.split(":");
  if (!KINDS.includes(kind as never) || !Number.isInteger(Number(n))) throw courseError("not_found", "Cette ligne n'existe plus.", 404);
  return { kind: kind as (typeof KINDS)[number], id: Number(n) };
}

export const taxonomy: ConsoleObject = {
  async load(c) {
    const { db } = c.ctx;
    const [cuisines, categories, dishCuisine, dishCategory] = await Promise.all([
      db.selectFrom("meal_cuisines").selectAll().orderBy("sort_order").orderBy("id").execute(),
      db.selectFrom("meal_dish_categories").selectAll().orderBy("sort_order").orderBy("id").execute(),
      db.selectFrom("meal_dishes").select(["cuisine_id"]).where("retired_at", "is", null).execute(),
      db.selectFrom("meal_dish_category_links").select(["category_id"]).execute(),
    ]);
    const make = (kind: "cuisine" | "categorie", r: { id: number; name: string; sort_order: number; is_hidden: boolean }, count: number) => ({
      id: `${kind}:${r.id}`,
      tone: r.is_hidden ? ("muted" as const) : count === 0 ? ("info" as const) : undefined,
      cells: { type: kind === "cuisine" ? "Cuisine" : "Catégorie", name: r.name, order: r.sort_order, count, state: r.is_hidden ? "Masquée" : count === 0 ? "Nouvelle" : "Visible" },
      actions: [
        {
          key: "edit",
          label: "Modifier",
          fields: [
            { key: "name", label: "Nom", type: "text" as const, value: r.name, required: true },
            { key: "order", label: "Ordre d'affichage", type: "number" as const, value: r.sort_order },
          ],
        },
        r.is_hidden ? { key: "show", label: "Afficher" } : { key: "hide", label: "Masquer", confirm: `Masquer « ${r.name} » ? Elle ne sera plus choisissable ; les plats déjà classés la gardent.` },
      ],
    });
    return {
      object: "cuisines",
      title: "Cuisines et catégories",
      intro: "Une nouvelle cuisine devient choisissable dans les réglages des foyers. Une cuisine utilisée ne peut pas être supprimée, seulement masquée.",
      info: null,
      columns: [
        { key: "type", label: "Type" },
        { key: "name", label: "Nom" },
        { key: "order", label: "Ordre", align: "right" },
        { key: "count", label: "Plats", align: "right" },
        { key: "state", label: "État" },
      ],
      rows: [
        ...cuisines.map((r) => make("cuisine", r, dishCuisine.filter((d) => d.cuisine_id === r.id).length)),
        ...categories.map((r) => make("categorie", r, dishCategory.filter((d) => d.category_id === r.id).length)),
      ],
      filters: [],
      search: false,
      total: cuisines.length + categories.length,
      footer: null,
      tools: {
        add: {
          label: "Ajouter",
          fields: [
            { key: "kind", label: "Type", type: "select", value: "cuisine", options: [{ value: "cuisine", label: "Cuisine" }, { value: "categorie", label: "Catégorie" }] },
            { key: "name", label: "Nom", type: "text", required: true },
            { key: "order", label: "Ordre d'affichage", type: "number", value: 100 },
          ],
        },
      },
    };
  },

  async act(c, action, id, values) {
    const { db, now } = c.ctx;
    const table = (kind: "cuisine" | "categorie") => (kind === "cuisine" ? "meal_cuisines" : "meal_dish_categories");
    let label = "";
    try {
      if (action === "add") {
        const kind = oneOf(values, "kind", KINDS, "le type");
        const name = text(values, "name", "le nom", 60);
        const order = whole(values, "order", "l'ordre", 0, 10000);
        await db.insertInto(table(kind)).values({ name, sort_order: order }).execute();
        label = `${kind}:${name}`;
      } else {
        const row = parse(id);
        const t = table(row.kind);
        if (action === "edit") {
          await db.updateTable(t).set({ name: text(values, "name", "le nom", 60), sort_order: whole(values, "order", "l'ordre", 0, 10000), updated_at: now }).where("id", "=", row.id).execute();
        } else if (action === "hide" || action === "show") {
          await db.updateTable(t).set({ is_hidden: action === "hide", updated_at: now }).where("id", "=", row.id).execute();
        } else {
          throw courseError("unknown_action", "Action inconnue.", 422);
        }
        label = id;
      }
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw courseError("duplicate", "Ce nom existe déjà.", 409);
      throw error;
    }
    await logAdminAction(db, { adminId: c.adminId, action: "meal_catalog_changed", entityType: "meal_taxonomy", entityId: label, details: { action }, now });
  },
};
