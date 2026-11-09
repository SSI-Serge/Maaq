import { logAdminAction } from "@/server/admin/audit";
import { norm } from "../../engine";
import { courseError } from "../../household/settings";
import type { ConsoleObject, FormField } from "../types";
import { rangeText } from "./seasons";

/**
 * Plats de saison de la base commune (CR-61, US-178 RF2bis) : tous les plats obtenus de l'IA, anonymes, sans prix. L'administrateur voit le plat, sa cuisine, ses mois, ses étiquettes, le nombre de choix et le lundi d'entrée ;
 * il peut masquer un plat (il n'est plus proposé) ou corriger ses étiquettes de régime et ses mois de saison. Les corrections ne rappellent jamais l'IA.
 */

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const monthOptions = MONTHS.map((m, i) => ({ value: String(i + 1), label: m }));

function monthsBetween(from: number, to: number): number[] {
  const out: number[] = [];
  for (let m = from; ; m = m === 12 ? 1 : m + 1) {
    out.push(m);
    if (m === to || out.length === 12) break;
  }
  return out;
}

const weekText = (value: Date | string) => {
  const d = typeof value === "string" ? new Date(`${value.slice(0, 10)}T12:00:00`) : value;
  return `semaine du ${d.getDate()} ${SHORT[d.getMonth()]}`;
};

export const seasonDishes: ConsoleObject = {
  async load(c, query) {
    const { db } = c.ctx;
    const [rows, cuisines, tags] = await Promise.all([
      db.selectFrom("v_meal_season_dishes").selectAll().orderBy("chosen_count", "desc").orderBy("dish_id", "desc").execute(),
      db.selectFrom("meal_cuisines").select(["id", "name"]).orderBy("name").execute(),
      db.selectFrom("meal_dish_tags").select(["id", "kind", "name"]).where("kind", "<>", "allergen").orderBy("name").execute(),
    ]);
    const cuisineName = new Map(cuisines.map((x) => [x.id, x.name]));
    const tagName = new Map(tags.map((t) => [t.id, t.name]));
    const wanted = (r: (typeof rows)[number]) =>
      (!query.q || norm(r.name ?? "").includes(norm(query.q))) &&
      (!query.filters.cuisine || String(r.cuisine_id) === query.filters.cuisine) &&
      (!query.filters.state || (query.filters.state === "hidden" ? r.is_hidden : !r.is_hidden)) &&
      (!query.filters.month || (r.months ?? []).map(Number).includes(Number(query.filters.month)));
    const shown = rows.filter(wanted);
    return {
      object: "plats-de-saison",
      title: "Plats de saison",
      intro: "Base commune et anonyme des plats de saison obtenus de l'IA, sans doublon. Masquez un plat pour ne plus le proposer, ou corrigez ses étiquettes de régime et ses mois de saison.",
      info: null,
      columns: [
        { key: "name", label: "Plat" },
        { key: "cuisine", label: "Cuisine" },
        { key: "months", label: "Mois de saison" },
        { key: "tags", label: "Étiquettes" },
        { key: "chosen", label: "Choix", align: "right" },
        { key: "entered", label: "Entré" },
        { key: "state", label: "État" },
      ],
      rows: shown.slice(0, 300).map((r) => {
        const months = (r.months ?? []).map(Number);
        const sorted = [...months].sort((a, b) => a - b);
        const start = sorted.find((m) => !months.includes(m === 1 ? 12 : m - 1)) ?? sorted[0] ?? 1;
        const end = [...sorted].reverse().find((m) => !months.includes(m === 12 ? 1 : m + 1)) ?? sorted[sorted.length - 1] ?? 12;
        const tagText = (r.tag_ids ?? []).map((t) => tagName.get(t)).filter(Boolean).join(", ");
        const edit: FormField[] = [
          { key: "from", label: "Saison : de (mois)", type: "select", value: String(start), options: monthOptions },
          { key: "to", label: "à (mois)", type: "select", value: String(end), options: monthOptions },
          { key: "tags", label: `Étiquettes de régime (séparées par des virgules ; parmi : ${tags.map((t) => t.name).join(", ")})`, type: "text", value: tagText },
        ];
        return {
          id: String(r.dish_id),
          tone: r.is_hidden ? ("muted" as const) : undefined,
          cells: { name: r.name, cuisine: cuisineName.get(r.cuisine_id ?? 0) ?? "", months: rangeText(months), tags: tagText || "—", chosen: Number(r.chosen_count ?? 0), entered: weekText(r.entered_week as Date | string), state: r.is_hidden ? "Masqué" : "Visible" },
          actions: [
            { key: "edit", label: "Corriger", fields: edit },
            r.is_hidden ? { key: "show", label: "Réafficher" } : { key: "hide", label: "Masquer", confirm: `Masquer « ${r.name} » ? Il ne sera plus proposé aux foyers (il reste dans les menus déjà validés).` },
          ],
        };
      }),
      filters: [
        { key: "cuisine", label: "Cuisine", value: query.filters.cuisine ?? "", options: cuisines.map((x) => ({ value: String(x.id), label: x.name })) },
        { key: "month", label: "Mois", value: query.filters.month ?? "", options: monthOptions },
        { key: "state", label: "État", value: query.filters.state ?? "", options: [{ value: "visible", label: "Visibles" }, { value: "hidden", label: "Masqués" }] },
      ],
      search: true,
      total: shown.length,
      footer: shown.length > 300 ? "Les 300 premiers plats sont affichés : affinez avec la recherche ou les filtres." : null,
      tools: {},
    };
  },

  async act(c, action, id, values) {
    const { db, now } = c.ctx;
    const dish = await db.selectFrom("meal_season_dishes").select(["id", "name"]).where("id", "=", id as never).executeTakeFirst();
    if (!dish) throw courseError("not_found", "Ce plat n'existe plus.", 404);
    if (action === "hide" || action === "show") {
      await db.updateTable("meal_season_dishes").set(action === "hide" ? { hidden_at: now, hidden_by_user_id: c.adminId as never } : { hidden_at: null, hidden_by_user_id: null }).where("id", "=", dish.id).execute();
    } else if (action === "edit") {
      const from = Number(values.from);
      const to = Number(values.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > 12 || to < 1 || to > 12) throw courseError("invalid_months", "Choisissez les mois de saison.", 422);
      const wanted = (values.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      const tags = await db.selectFrom("meal_dish_tags").select(["id", "name"]).where("kind", "<>", "allergen").execute();
      const ids: number[] = [];
      for (const name of wanted) {
        const found = tags.find((t) => norm(t.name) === norm(name));
        if (!found) throw courseError("unknown_tag", `Étiquette inconnue : « ${name.slice(0, 80)} ». Choisissez parmi la liste.`, 422);
        ids.push(found.id);
      }
      // un plat garde toujours au moins un mois : on ajoute les nouveaux mois avant de retirer les autres
      const months = monthsBetween(from, to);
      await db.insertInto("meal_season_dish_months").values(months.map((m) => ({ dish_id: dish.id, season_month: m }))).onConflict((oc) => oc.doNothing()).execute();
      await db.deleteFrom("meal_season_dish_months").where("dish_id", "=", dish.id).where("season_month", "not in", months).execute();
      await db.deleteFrom("meal_season_dish_tag_links").where("dish_id", "=", dish.id).execute();
      if (ids.length) await db.insertInto("meal_season_dish_tag_links").values([...new Set(ids)].map((t) => ({ dish_id: dish.id, tag_id: t }))).execute();
    } else {
      throw courseError("unknown_action", "Action inconnue.", 422);
    }
    await logAdminAction(db, { adminId: c.adminId, action: "seasonal_dish_changed", entityType: "meal_season_dish", entityId: String(dish.id), details: { action, name: dish.name, ...values }, now });
  },
};
