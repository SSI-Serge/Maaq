import { logAdminAction } from "@/server/admin/audit";
import { listSettings, updateSettings } from "@/server/admin/settings";
import { nameKey } from "../../catalog/seed";
import { courseError } from "../../household/settings";
import type { ConsoleObject, FormField } from "../types";
import { text, whole } from "../util";

/**
 * Produits du quotidien (US-169 RF3, CR-66) : tenus en console, par rayon. Ils complètent « Produits de mon historique » sous « Pensez aussi à : » quand la rubrique compte moins de produits que le seuil,
 * réglé sur cette même page. Un produit peut être relié à un produit du catalogue pour avoir un prix. Un produit retiré est masqué, pas supprimé.
 */

export const THRESHOLD_KEY = "grocery_history_min_products";
const THRESHOLD_ROW = "seuil";

export const dailyProducts: ConsoleObject = {
  async load(c) {
    const { db } = c.ctx;
    const [list, aisles, settings] = await Promise.all([
      db
        .selectFrom("grocery_daily_products as d")
        .innerJoin("grocery_aisles as a", "a.id", "d.aisle_id")
        .leftJoin("grocery_products as p", "p.id", "d.product_id")
        .select(["d.id", "d.name", "d.aisle_id", "d.position", "d.retired_at", "a.name as aisle", "a.sort_order", "p.name as product"])
        .orderBy("a.sort_order")
        .orderBy("d.position")
        .orderBy("d.id")
        .execute(),
      db.selectFrom("grocery_aisles").select(["id", "name"]).orderBy("sort_order").orderBy("id").execute(),
      listSettings(c.ctx),
    ]);
    const threshold = settings.find((s) => s.key === THRESHOLD_KEY);
    const fields = (d?: (typeof list)[number]): FormField[] => [
      { key: "name", label: "Nom du produit", type: "text", value: d?.name ?? "", required: true },
      { key: "aisle", label: "Rayon", type: "select", value: d ? String(d.aisle_id) : String(aisles[0]?.id ?? ""), options: aisles.map((a) => ({ value: String(a.id), label: a.name })) },
      { key: "product", label: "Produit du catalogue (facultatif)", type: "text", value: d?.product ?? "", help: "Le nom exact d'un produit du catalogue : il donne le prix. Vide : pas de prix (N/A)." },
      { key: "position", label: "Ordre dans le rayon", type: "number", value: d?.position ?? 100, required: true },
    ];
    const active = list.filter((d) => !d.retired_at).length;
    return {
      object: "quotidien",
      title: "Produits du quotidien",
      intro: "Proposés aux foyers sous « Pensez aussi à : », dans « Produits de mon historique », quand la rubrique compte moins de produits que le seuil. Décochés, regroupés par rayon, sans ceux déjà dans l'historique, le menu ou les produits ajoutés.",
      info: `${active} produit${active > 1 ? "s" : ""} proposé${active > 1 ? "s" : ""} · seuil : ${threshold?.value ?? "10"} produits`,
      columns: [
        { key: "name", label: "Produit" },
        { key: "aisle", label: "Rayon" },
        { key: "product", label: "Produit du catalogue" },
        { key: "position", label: "Ordre", align: "right" },
        { key: "state", label: "État" },
      ],
      rows: [
        {
          id: THRESHOLD_ROW,
          tone: "info" as const,
          cells: { name: "Seuil de la rubrique « Produits de mon historique »", aisle: "", product: "", position: threshold ? Number(threshold.value) : 10, state: threshold ? `de ${threshold.min ?? 1} à ${threshold.max ?? 50}` : "" },
          actions: [{ key: "threshold", label: "Modifier le seuil", fields: [{ key: "value", label: "Nombre minimum de produits", type: "number" as const, value: threshold?.value ?? "10", required: true, help: "En dessous de ce nombre, la rubrique est complétée par les produits du quotidien." }] }],
        },
        ...list.map((d) => ({
          id: String(d.id),
          tone: d.retired_at ? ("muted" as const) : undefined,
          cells: { name: d.name, aisle: d.aisle, product: d.product ?? "—", position: d.position, state: d.retired_at ? "Retiré" : "Proposé" },
          actions: [{ key: "edit", label: "Modifier", fields: fields(d) }, d.retired_at ? { key: "restore", label: "Proposer de nouveau" } : { key: "retire", label: "Retirer", confirm: `Retirer « ${d.name} » ? Il ne sera plus proposé aux foyers.` }],
        })),
      ],
      filters: [],
      search: false,
      total: list.length,
      footer: null,
      tools: { add: { label: "Ajouter un produit", fields: fields() } },
    };
  },

  async act(c, action, id, values) {
    const { db, now } = c.ctx;
    if (action === "threshold") {
      if (id !== THRESHOLD_ROW) throw courseError("unknown_action", "Action inconnue.", 422);
      // les bornes (1 à 50) sont celles du réglage ; le changement est inscrit à l'historique des paramètres
      await updateSettings(c.ctx, c.adminId, { [THRESHOLD_KEY]: values.value ?? "" });
      return;
    }
    const read = async () => {
      const name = text(values, "name", "le nom du produit", 120);
      const aisle = whole(values, "aisle", "le rayon", 1, 1000000);
      const position = whole(values, "position", "l'ordre dans le rayon", 1, 30000);
      const wanted = (values.product ?? "").trim();
      let productId: string | null = null;
      if (wanted) {
        const product = await db.selectFrom("grocery_products").select("id").where("name_key", "=", nameKey(wanted)).executeTakeFirst();
        if (!product) throw courseError("unknown_product", `« ${wanted} » n'est pas un produit du catalogue : reprenez son nom exact, ou laissez vide.`, 422);
        productId = String(product.id);
      }
      return { name, name_key: nameKey(name), aisle_id: aisle, position, product_id: productId as never };
    };
    try {
      if (action === "add") {
        const row = await read();
        // un produit retiré de même nom revient au lieu d'un doublon
        const back = await db.updateTable("grocery_daily_products").set({ ...row, retired_at: null, updated_at: now }).where("name_key", "=", row.name_key).where("retired_at", "is not", null).executeTakeFirst();
        if (!back.numUpdatedRows) await db.insertInto("grocery_daily_products").values(row).execute();
      } else if (action === "edit") {
        const done = await db.updateTable("grocery_daily_products").set({ ...(await read()), updated_at: now }).where("id", "=", Number(id)).executeTakeFirst();
        if (!done.numUpdatedRows) throw courseError("not_found", "Ce produit n'existe plus.", 404);
      } else if (action === "retire" || action === "restore") {
        const done = await db.updateTable("grocery_daily_products").set({ retired_at: action === "retire" ? now : null, updated_at: now }).where("id", "=", Number(id)).executeTakeFirst();
        if (!done.numUpdatedRows) throw courseError("not_found", "Ce produit n'existe plus.", 404);
      } else {
        throw courseError("unknown_action", "Action inconnue.", 422);
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") throw courseError("duplicate", "Ce produit du quotidien existe déjà.", 409);
      if (code === "23503") throw courseError("unknown_aisle", "Ce rayon n'existe plus.", 422);
      throw error;
    }
    await logAdminAction(db, { adminId: c.adminId, action: "daily_product_changed", entityType: "grocery_daily_product", entityId: id || "nouveau", details: { action, ...values }, now });
  },
};
