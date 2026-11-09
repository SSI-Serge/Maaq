import { sql } from "kysely";
import { logAdminAction } from "@/server/admin/audit";
import { courseError } from "../../household/settings";
import type { ConsoleObject } from "../types";
import { text, whole } from "../util";

/** Rayons (US-169) : les mêmes partout, pour les produits, les tickets et le budget. Un rayon utilisé ne se supprime pas : on le renomme ou on le fusionne. */

export const aisles: ConsoleObject = {
  async load(c) {
    const { db } = c.ctx;
    const [list, products, lines] = await Promise.all([
      db.selectFrom("grocery_aisles").selectAll().orderBy("sort_order").orderBy("id").execute(),
      db.selectFrom("grocery_products").select(["aisle_id"]).execute(),
      db.selectFrom("grocery_receipt_lines").select(["aisle_id"]).execute(),
    ]);
    return {
      object: "rayons",
      title: "Rayons",
      intro: "Les mêmes partout, pour les tickets et le budget. Un rayon utilisé ne peut pas être supprimé : renommez-le ou fusionnez-le. « Rayon frais » sert à la liste du mois : les produits de ces rayons des semaines suivantes sont à acheter plus tard.",
      info: null,
      columns: [
        { key: "name", label: "Rayon" },
        { key: "fresh", label: "Rayon frais" },
        { key: "products", label: "Produits", align: "right" },
        { key: "lines", label: "Lignes de tickets", align: "right" },
      ],
      rows: list.map((a) => ({
        id: String(a.id),
        tone: a.is_hidden ? ("muted" as const) : undefined,
        cells: { name: a.name, fresh: a.is_fresh ? "Oui" : "Non", products: products.filter((p) => p.aisle_id === a.id).length, lines: lines.filter((l) => l.aisle_id === a.id).length },
        actions: [
          { key: "fresh", label: a.is_fresh ? "Retirer des rayons frais" : "Marquer rayon frais" },
          { key: "rename", label: "Renommer", fields: [{ key: "name", label: "Nom du rayon", type: "text" as const, value: a.name, required: true }] },
          {
            key: "merge",
            label: "Fusionner",
            confirm: `Fusionner « ${a.name} » dans un autre rayon ? Les produits, les tickets et le budget passés seront rangés dans le rayon conservé.`,
            fields: [{ key: "into", label: "Fusionner dans", type: "select" as const, options: list.filter((o) => o.id !== a.id).map((o) => ({ value: String(o.id), label: o.name })) }],
          },
        ],
      })),
      filters: [],
      search: false,
      total: list.length,
      footer: null,
      tools: { add: { label: "Ajouter un rayon", fields: [{ key: "name", label: "Nom du rayon", type: "text", required: true }] } },
    };
  },

  async act(c, action, id, values) {
    const { db, now } = c.ctx;
    try {
      if (action === "add") {
        const max = await db.selectFrom("grocery_aisles").select(sql<number>`coalesce(max(sort_order), 0)`.as("m")).executeTakeFirstOrThrow();
        await db.insertInto("grocery_aisles").values({ name: text(values, "name", "le nom du rayon", 60), sort_order: Number(max.m) + 10 }).execute();
      } else if (action === "rename") {
        await db.updateTable("grocery_aisles").set({ name: text(values, "name", "le nom du rayon", 60), updated_at: now }).where("id", "=", Number(id)).execute();
      } else if (action === "fresh") {
        // « Rayon frais » (US-169 RF2bis) : dans la liste du mois, les produits de ces rayons des semaines suivantes sont « À acheter plus tard »
        const current = await db.selectFrom("grocery_aisles").select("is_fresh").where("id", "=", Number(id)).executeTakeFirst();
        if (!current) throw courseError("not_found", "Ce rayon n'existe plus.", 404);
        await db.updateTable("grocery_aisles").set({ is_fresh: !current.is_fresh, updated_at: now }).where("id", "=", Number(id)).execute();
      } else if (action === "merge") {
        const into = whole(values, "into", "le rayon conservé", 1, 1000000);
        await sql`select merge_grocery_aisles(${Number(id)}::integer, ${into}::integer)`.execute(db);
      } else {
        throw courseError("unknown_action", "Action inconnue.", 422);
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") throw courseError("duplicate", "Ce rayon existe déjà.", 409);
      if (code === "23514" || code === "P0002") throw courseError("invalid_merge", (error as Error).message, 422);
      throw error;
    }
    await logAdminAction(db, { adminId: c.adminId, action: "grocery_catalog_changed", entityType: "grocery_aisle", entityId: id || "nouveau", details: { action, ...values }, now });
  },
};
