import { logAdminAction } from "@/server/admin/audit";
import { listSettings, updateSettings } from "@/server/admin/settings";
import { nameKey } from "../../catalog/seed";
import { courseError } from "../../household/settings";
import type { ConsoleObject, RowAction } from "../types";
import { text, whole } from "../util";

/**
 * Produits du quotidien (US-169 RF3, CR-66, CR-67) : tenus en console, par rayon. Ils complètent « Produits de mon historique » sous « Pensez aussi à : » quand la rubrique compte moins de produits que le seuil,
 * réglé sur cette même page. Un produit peut être relié à un produit du catalogue pour avoir un prix ; sinon il s'affiche N/A, hors total. Un produit retiré est masqué, pas supprimé.
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
        .orderBy("d.aisle_id")
        .orderBy("d.position")
        .orderBy("d.id")
        .execute(),
      // tous les rayons de la console sont proposés (US-169 RF1 et RF3)
      db.selectFrom("grocery_aisles").select(["id", "name"]).orderBy("sort_order").orderBy("id").execute(),
      listSettings(c.ctx),
    ]);
    const threshold = settings.find((s) => s.key === THRESHOLD_KEY);
    const active = list.filter((d) => !d.retired_at);
    return {
      object: "quotidien",
      title: "Produits du quotidien",
      intro: "Proposés aux foyers sous « Pensez aussi à : », dans « Produits de mon historique », quand la rubrique compte moins de produits que le seuil. Décochés, regroupés par rayon, sans ceux déjà dans l'historique, le menu ou les produits ajoutés.",
      info: `${active.length} produit${active.length > 1 ? "s" : ""} proposé${active.length > 1 ? "s" : ""} · l'historique d'un foyer est complété quand il compte moins de ${threshold?.value ?? "10"} produits`,
      columns: [
        { key: "aisle", label: "Rayon" },
        { key: "name", label: "Produit" },
        { key: "link", label: "Produit du catalogue" },
        { key: "state", label: "État" },
      ],
      rows: [
        {
          id: THRESHOLD_ROW,
          tone: "info" as const,
          cells: { aisle: "Seuil", name: `Compléter l'historique d'un foyer quand il compte moins de ${threshold?.value ?? "10"} produits`, link: "", state: threshold ? `de ${threshold.min ?? 1} à ${threshold.max ?? 50}` : "" },
          actions: [{ key: "threshold", label: "Modifier le seuil", fields: [{ key: "value", label: "Nombre minimum de produits", type: "number" as const, value: threshold?.value ?? "10", required: true, help: "En dessous de ce nombre, la rubrique est complétée par les produits du quotidien." }] }],
        },
        ...list.map((d) => {
          const actions: RowAction[] = d.retired_at
            ? [{ key: "restore", label: "Proposer de nouveau" }]
            : [
                { key: "up", label: "↑" },
                { key: "down", label: "↓" },
                { key: "rename", label: "Renommer", fields: [{ key: "name", label: "Nom du produit", type: "text" as const, value: d.name, required: true }] },
                d.product
                  ? { key: "unlink", label: "Délier", confirm: `Délier « ${d.name} » de « ${d.product} » ? Il s'affichera N/A, hors total.` }
                  : { key: "link", label: "Relier…", fields: [{ key: "product", label: "Produit du catalogue", type: "text" as const, value: "", required: true, help: "Le nom exact d'un produit du catalogue : il donne le prix." }] },
                { key: "retire", label: "Retirer", confirm: `Retirer « ${d.name} » ? Il ne sera plus proposé aux foyers.` },
              ];
          return {
            id: String(d.id),
            tone: d.retired_at ? ("muted" as const) : undefined,
            cells: { aisle: d.aisle, name: d.name, link: d.product ? `Relié : ${d.product}` : "Non relié : affiché N/A, hors total", state: d.retired_at ? "Retiré" : "Proposé" },
            actions,
          };
        }),
      ],
      filters: [],
      search: false,
      total: list.length,
      footer: null,
      tools: {
        add: {
          label: "Ajouter un produit",
          fields: [
            { key: "name", label: "Nom du produit", type: "text", required: true },
            { key: "aisle", label: "Rayon", type: "select", value: String(aisles[0]?.id ?? ""), options: aisles.map((a) => ({ value: String(a.id), label: a.name })) },
          ],
        },
      },
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
    const current = async () => {
      const row = await db.selectFrom("grocery_daily_products").select(["id", "aisle_id", "position", "retired_at"]).where("id", "=", Number(id)).executeTakeFirst();
      if (!row) throw courseError("not_found", "Ce produit n'existe plus.", 404);
      return row;
    };
    try {
      if (action === "add") {
        const name = text(values, "name", "le nom du produit", 120);
        const aisle = whole(values, "aisle", "le rayon", 1, 1000000);
        const key = nameKey(name);
        const last = await db.selectFrom("grocery_daily_products").select((eb) => eb.fn.max("position").as("m")).where("aisle_id", "=", aisle).where("retired_at", "is", null).executeTakeFirst();
        const position = Math.min(Number(last?.m ?? 0) + 1, 30000);
        // un produit du catalogue de même clé est relié d'office ; un produit retiré de même nom revient au lieu d'un doublon
        const product = await db.selectFrom("grocery_products").select("id").where("name_key", "=", key).executeTakeFirst();
        const back = await db.updateTable("grocery_daily_products").set({ name, aisle_id: aisle, position, retired_at: null, updated_at: now }).where("name_key", "=", key).where("retired_at", "is not", null).executeTakeFirst();
        if (!back.numUpdatedRows) await db.insertInto("grocery_daily_products").values({ name, name_key: key, aisle_id: aisle, position, product_id: (product?.id ?? null) as never }).execute();
      } else if (action === "rename") {
        await current();
        const name = text(values, "name", "le nom du produit", 120);
        await db.updateTable("grocery_daily_products").set({ name, name_key: nameKey(name), updated_at: now }).where("id", "=", Number(id)).execute();
      } else if (action === "link") {
        await current();
        const wanted = text(values, "product", "le produit du catalogue", 120);
        const product = await db.selectFrom("grocery_products").select("id").where("name_key", "=", nameKey(wanted)).executeTakeFirst();
        if (!product) throw courseError("unknown_product", `« ${wanted} » n'est pas un produit du catalogue : reprenez son nom exact.`, 422);
        await db.updateTable("grocery_daily_products").set({ product_id: product.id as never, updated_at: now }).where("id", "=", Number(id)).execute();
      } else if (action === "unlink") {
        await current();
        await db.updateTable("grocery_daily_products").set({ product_id: null, updated_at: now }).where("id", "=", Number(id)).execute();
      } else if (action === "up" || action === "down") {
        // ↑ et ↓ : échange de place avec le voisin du même rayon (les positions sont renumérotées de 1 à n)
        const row = await current();
        const siblings = await db.selectFrom("grocery_daily_products").select(["id"]).where("aisle_id", "=", row.aisle_id).where("retired_at", "is", null).orderBy("position").orderBy("id").execute();
        const index = siblings.findIndex((s) => s.id === row.id);
        const target = action === "up" ? index - 1 : index + 1;
        if (index >= 0 && target >= 0 && target < siblings.length) {
          [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
          await db.transaction().execute(async (trx) => {
            for (const [i, s] of siblings.entries()) await trx.updateTable("grocery_daily_products").set({ position: i + 1, updated_at: now }).where("id", "=", s.id).execute();
          });
        }
      } else if (action === "retire" || action === "restore") {
        await current();
        await db.updateTable("grocery_daily_products").set({ retired_at: action === "retire" ? now : null, updated_at: now }).where("id", "=", Number(id)).execute();
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
