import { sql } from "kysely";
import { logAdminAction } from "@/server/admin/audit";
import { courseError } from "../../household/settings";
import { ROW_LIMIT, type ConsoleContext, type ConsoleObject, type ConsoleQuery } from "../types";
import { csv, euro, oneOf } from "../util";

/**
 * Produits à référencer (US-173) : les produits que les foyers utilisent sans référence conforme, regroupés par nom, du plus demandé au moins demandé. Aucune colonne ne
 * désigne un foyer ; la ville, la référence, le prix et le magasin ne viennent que des foyers qui partagent leurs prix.
 */

const STATES = ["to_reference", "referenced", "rejected"] as const;
const STATE_LABEL: Record<(typeof STATES)[number], string> = { to_reference: "À référencer", referenced: "Référencé", rejected: "Rejeté" };

async function list(c: ConsoleContext, query: ConsoleQuery) {
  const { db } = c.ctx;
  let q = db
    .selectFrom("v_grocery_unreferenced as u")
    .leftJoin("grocery_aisles as a", "a.id", "u.aisle_id")
    .select(["u.name_key", "u.kind", "u.occurrences", "u.state", "u.aisle_id", "a.name as aisle"])
    .select(
      sql<string | null>`(select e.seen_city from grocery_unreferenced_events e where e.name_key = u.name_key and e.seen_city is not null order by e.occurred_at desc limit 1)`.as("city"),
    )
    .select(
      sql<string | null>`(select e.seen_unit_price::text || ' | ' || e.seen_store_chain from grocery_unreferenced_events e where e.name_key = u.name_key and e.seen_unit_price is not null order by e.occurred_at desc limit 1)`.as("seen"),
    )
    .orderBy("u.occurrences", "desc")
    .orderBy("u.name_key");
  if (query.q) q = q.where("u.name_key", "ilike", `%${query.q}%`);
  if (query.filters.rayon) q = q.where("u.aisle_id", "=", Number(query.filters.rayon));
  if (query.filters.type) q = q.where("u.kind", "=", query.filters.type);
  const state = query.filters.statut ?? "to_reference";
  if (state !== "tous") q = q.where("u.state", "=", state as never);
  return q.execute();
}

export const unreferenced: ConsoleObject = {
  async load(c, query) {
    const aisles = await c.ctx.db.selectFrom("grocery_aisles").select(["id", "name"]).orderBy("sort_order").execute();
    const rows = await list(c, query);
    return {
      object: "a-referencer",
      title: "Produits à référencer",
      intro: "Notés automatiquement, sans rien demander aux foyers. Ville, référence, prix et magasin seulement pour les foyers qui partagent leurs prix. Jamais de prénom ni d'identifiant de foyer.",
      info: null,
      columns: [
        { key: "name", label: "Produit" },
        { key: "kind", label: "Type" },
        { key: "count", label: "Occurrences", align: "right" },
        { key: "city", label: "Ville" },
        { key: "seen", label: "Vu à" },
        { key: "state", label: "Statut" },
      ],
      rows: rows.slice(0, ROW_LIMIT).map((r) => ({
        id: r.name_key ?? "",
        tone: r.state === "to_reference" ? undefined : r.state === "referenced" ? ("ok" as const) : ("muted" as const),
        cells: {
          name: r.name_key ?? "",
          kind: r.kind === "unknown" ? "Inconnu" : "Sans référence",
          count: Number(r.occurrences ?? 0),
          city: r.city ?? "—",
          seen: r.seen ? `${euro(r.seen.split(" | ")[0])} — ${r.seen.split(" | ")[1]}` : "—",
          state: STATE_LABEL[(r.state ?? "to_reference") as (typeof STATES)[number]],
        },
        actions: r.state === "rejected" ? [{ key: "reopen", label: "Remettre à référencer" }] : r.state === "to_reference" ? [{ key: "reject", label: "Rejeter" }] : [],
      })),
      filters: [
        { key: "rayon", label: "Rayon", value: query.filters.rayon ?? "", options: [{ value: "", label: "Rayon : tous" }, ...aisles.map((a) => ({ value: String(a.id), label: a.name }))] },
        { key: "type", label: "Type", value: query.filters.type ?? "", options: [{ value: "", label: "Type : tous" }, { value: "unknown", label: "Inconnu" }, { value: "no_reference", label: "Sans référence" }] },
        { key: "statut", label: "Statut", value: query.filters.statut ?? "to_reference", options: [{ value: "to_reference", label: "À référencer" }, { value: "referenced", label: "Référencé" }, { value: "rejected", label: "Rejeté" }, { value: "tous", label: "Tous" }] },
      ],
      search: true,
      total: rows.length,
      footer: "Un produit passe à « référencé » dès qu'une référence est importée pour lui.",
      tools: { downloads: [{ key: "export", label: "Exporter" }] },
    };
  },

  async act(c, action, id) {
    const { db, now } = c.ctx;
    if (!id) throw courseError("not_found", "Cette ligne n'existe plus.", 404);
    const state = action === "reject" ? "rejected" : action === "reopen" ? "to_reference" : null;
    if (!state) throw courseError("unknown_action", "Action inconnue.", 422);
    oneOf({ s: state }, "s", STATES, "le statut");
    await db
      .insertInto("grocery_unreferenced_status")
      .values({ name_key: id, state, changed_at: now, changed_by_user_id: c.adminId })
      .onConflict((oc) => oc.column("name_key").doUpdateSet({ state, changed_at: now, changed_by_user_id: c.adminId }))
      .execute();
    await logAdminAction(db, { adminId: c.adminId, action: "grocery_catalog_changed", entityType: "grocery_unreferenced", entityId: id, details: { action }, now });
  },

  async download(c, _key, query) {
    const rows = await list(c, { ...query, filters: { ...query.filters, statut: query.filters.statut ?? "tous" } });
    return {
      file: "produits_a_referencer.csv",
      content: csv(["produit", "type", "occurrences", "rayon", "statut", "ville", "vu_a"], rows.map((r) => [r.name_key, r.kind, Number(r.occurrences ?? 0), r.aisle ?? "", r.state, r.city ?? "", r.seen ?? ""])),
    };
  },
};
