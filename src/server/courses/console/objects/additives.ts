import { sql } from "kysely";
import { logAdminAction } from "@/server/admin/audit";
import { courseError } from "../../household/settings";
import type { ConsoleObject } from "../types";
import { text } from "../util";

/** Additifs à éviter (US-167) : affichés aux foyers dans « Critères additifs appliqués ». La conformité des références se recalcule à chaque lecture. */

export const additives: ConsoleObject = {
  async load(c) {
    const { db } = c.ctx;
    const list = await db
      .selectFrom("grocery_additive_criteria as k")
      .select([
        "k.id",
        "k.label",
        "k.reason",
        sql<string>`(select count(*) from grocery_product_references r where exists (select 1 from unnest(r.additives) a where grocery_norm(a) = grocery_norm(k.label)))`.as("excluded"),
      ])
      .where("k.is_active", "=", true)
      .orderBy("k.label")
      .execute();
    return {
      object: "additifs",
      title: "Additifs à éviter",
      intro: "Affichés aux foyers dans « Critères additifs appliqués ». Une modification recalcule la conformité des références.",
      info: null,
      columns: [
        { key: "label", label: "Code ou nom" },
        { key: "reason", label: "Raison" },
        { key: "excluded", label: "Références exclues", align: "right" },
      ],
      rows: list.map((k) => ({
        id: String(k.id),
        cells: { label: k.label, reason: k.reason, excluded: Number(k.excluded) },
        actions: [
          {
            key: "edit",
            label: "Modifier",
            fields: [
              { key: "label", label: "Code ou nom", type: "text" as const, value: k.label, required: true },
              { key: "reason", label: "Raison courte", type: "text" as const, value: k.reason, required: true },
            ],
          },
          { key: "remove", label: "Retirer", confirm: `Retirer « ${k.label} » des critères ? Les références qui le contiennent redeviennent proposées.` },
        ],
      })),
      filters: [],
      search: false,
      total: list.length,
      footer: null,
      tools: {
        add: {
          label: "Ajouter un additif",
          fields: [
            { key: "label", label: "Code ou nom", type: "text", required: true },
            { key: "reason", label: "Raison courte", type: "text", required: true },
          ],
        },
      },
    };
  },

  async act(c, action, id, values) {
    const { db, now } = c.ctx;
    try {
      if (action === "add") {
        const label = text(values, "label", "le code ou le nom", 80);
        const reason = text(values, "reason", "la raison", 200);
        // un additif retiré puis ajouté de nouveau est réactivé
        const back = await db.updateTable("grocery_additive_criteria").set({ is_active: true, label, reason, updated_at: now }).where(sql`grocery_norm(label)`, "=", sql`grocery_norm(${label})`).where("is_active", "=", false).executeTakeFirst();
        if (!back.numUpdatedRows) await db.insertInto("grocery_additive_criteria").values({ label, reason }).execute();
      } else if (action === "edit") {
        await db.updateTable("grocery_additive_criteria").set({ label: text(values, "label", "le code ou le nom", 80), reason: text(values, "reason", "la raison", 200), updated_at: now }).where("id", "=", Number(id)).execute();
      } else if (action === "remove") {
        await db.updateTable("grocery_additive_criteria").set({ is_active: false, updated_at: now }).where("id", "=", Number(id)).execute();
      } else {
        throw courseError("unknown_action", "Action inconnue.", 422);
      }
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw courseError("duplicate", "Cet additif est déjà dans la liste.", 409);
      throw error;
    }
    await logAdminAction(db, { adminId: c.adminId, action: "grocery_catalog_changed", entityType: "grocery_additive", entityId: id || "nouveau", details: { action, ...values }, now });
  },
};
