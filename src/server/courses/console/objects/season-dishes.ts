import { logAdminAction } from "@/server/admin/audit";
import { ingredientText, norm } from "../../engine";
import { courseError } from "../../household/settings";
import type { ConsoleObject, FormField } from "../types";

/**
 * Plats de saison de la base commune (CR-61, US-178 RF2bis) : tous les plats obtenus de l'IA, anonymes, sans prix, visibles tout de suite par les foyers. L'administrateur voit le plat, sa cuisine, ses mois, ses
 * étiquettes, le nombre de choix et le lundi d'entrée ; il consulte ses ingrédients et sa recette en lecture seule (« Voir »), corrige ses étiquettes de régime et ses mois par pastilles (« Corriger ») ou le masque.
 * Les corrections ne rappellent jamais l'IA.
 */

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const SHORT = ["janv.", "févr.", "mars", "avril", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const monthOptions = SHORT.map((m, i) => ({ value: String(i + 1), label: m }));
const monthFilter = MONTHS.map((m, i) => ({ value: String(i + 1), label: m }));

/** « oct. → janv. », « mars », « toute l'année » ; des mois qui ne se suivent pas sont listés. */
export function monthsText(months: number[]): string {
  const set = new Set(months);
  if (!set.size) return "—";
  if (set.size === 12) return "toute l'année";
  const start = [...set].find((m) => !set.has(m === 1 ? 12 : m - 1)) ?? [...set][0];
  const run: number[] = [];
  let m = start;
  while (set.has(m) && run.length < 12) {
    run.push(m);
    m = m === 12 ? 1 : m + 1;
  }
  if (run.length !== set.size) return [...set].sort((a, b) => a - b).map((x) => SHORT[x - 1]).join(", ");
  return run.length === 1 ? SHORT[run[0] - 1] : `${SHORT[run[0] - 1]} → ${SHORT[run[run.length - 1] - 1]}`;
}

const dateText = (value: Date | string) => {
  const d = typeof value === "string" ? new Date(`${value.slice(0, 10)}T12:00:00`) : value;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

const CHOICE_FILTER = [
  { value: "none", label: "Jamais choisi" },
  { value: "few", label: "Choisi 1 à 9 fois" },
  { value: "many", label: "Choisi 10 fois ou plus" },
];

export const seasonDishes: ConsoleObject = {
  async load(c, query) {
    const { db, now } = c.ctx;
    const [rows, cuisines, tags] = await Promise.all([
      db.selectFrom("v_meal_season_dishes").selectAll().orderBy("chosen_count", "desc").orderBy("dish_id", "desc").execute(),
      db.selectFrom("meal_cuisines").select(["id", "name"]).orderBy("name").execute(),
      db.selectFrom("meal_dish_tags").select(["id", "kind", "name"]).where("kind", "<>", "allergen").orderBy("name").execute(),
    ]);
    const cuisineName = new Map(cuisines.map((x) => [x.id, x.name]));
    const tagName = new Map(tags.map((t) => [t.id, t.name]));
    const wanted = (r: (typeof rows)[number]) => {
      const n = Number(r.chosen_count ?? 0);
      return (
        (!query.q || norm(r.name ?? "").includes(norm(query.q))) &&
        (!query.filters.cuisine || String(r.cuisine_id) === query.filters.cuisine) &&
        (!query.filters.state || (query.filters.state === "hidden" ? r.is_hidden : !r.is_hidden)) &&
        (!query.filters.month || (r.months ?? []).map(Number).includes(Number(query.filters.month))) &&
        (!query.filters.choices || (query.filters.choices === "none" ? n === 0 : query.filters.choices === "few" ? n >= 1 && n < 10 : n >= 10))
      );
    };
    const shown = rows.filter(wanted).slice(0, 300);
    // ingrédients (pour 4 personnes) et recette des plats affichés : « Voir », en lecture seule
    const ids = shown.map((r) => r.dish_id);
    const [ing, recipes] = ids.length
      ? await Promise.all([
          db.selectFrom("meal_season_dish_ingredients").select(["dish_id", "label", "quantity", "unit"]).where("dish_id", "in", ids as never[]).orderBy("dish_id").orderBy("position").execute(),
          db.selectFrom("meal_season_dishes").select(["id", "recipe", "servings"]).where("id", "in", ids as never[]).execute(),
        ])
      : [[], []];
    const recipeOf = new Map(recipes.map((r) => [String(r.id), r]));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = rows.filter((r) => new Date(`${String(r.entered_week).slice(0, 10)}T12:00:00`) >= monthStart || (r.entered_week instanceof Date && r.entered_week >= monthStart)).length;
    const hidden = rows.filter((r) => r.is_hidden).length;
    return {
      object: "plats-de-saison",
      title: "Plats de saison",
      intro: "Base commune et anonyme des plats de saison obtenus de l'IA : aucun lien avec un foyer, aucun prix. Visibles tout de suite par les foyers. Vous pouvez masquer un plat, ou corriger ses étiquettes de régime et ses mois de saison. La recette est en lecture seule.",
      info: `${rows.length} plat${rows.length > 1 ? "s" : ""} · ${thisMonth} entré${thisMonth > 1 ? "s" : ""} ce mois-ci · ${hidden} masqué${hidden > 1 ? "s" : ""}`,
      columns: [
        { key: "name", label: "Plat" },
        { key: "cuisine", label: "Cuisine" },
        { key: "months", label: "Mois de saison" },
        { key: "tags", label: "Étiquettes" },
        { key: "chosen", label: "Choisi", align: "right" },
        { key: "entered", label: "Entré la semaine du" },
        { key: "state", label: "État" },
      ],
      rows: shown.map((r) => {
        const months = (r.months ?? []).map(Number);
        const tagIds = (r.tag_ids ?? []).map(Number);
        const tagText = tagIds.map((t) => tagName.get(t)).filter(Boolean).join(", ");
        const meta = recipeOf.get(String(r.dish_id));
        const factor = meta?.servings ? 4 / Number(meta.servings) : 1;
        const lines = ing
          .filter((i) => String(i.dish_id) === String(r.dish_id))
          .map((i) => ingredientText({ label: i.label, quantity: i.quantity === null ? null : Math.round(Number(i.quantity) * factor * 100) / 100, unit: i.unit }));
        const view: FormField[] = [
          { key: "ingredients", label: "Ingrédients pour 4 personnes", type: "info", value: lines.join("\n") || "—" },
          { key: "recipe", label: "Recette", type: "info", value: meta?.recipe?.trim() || "Recette non renseignée." },
        ];
        const edit: FormField[] = [
          { key: "tags", label: "Étiquettes de régime", type: "chips", value: tagIds.join(","), options: tags.map((t) => ({ value: String(t.id), label: t.name })) },
          { key: "months", label: "Mois de saison", type: "chips", value: months.join(","), options: monthOptions },
        ];
        return {
          id: String(r.dish_id),
          tone: r.is_hidden ? ("muted" as const) : ("ok" as const),
          cells: { name: r.name, cuisine: cuisineName.get(r.cuisine_id ?? 0) ?? "", months: monthsText(months), tags: tagText || "—", chosen: Number(r.chosen_count ?? 0), entered: dateText(r.entered_week as Date | string), state: r.is_hidden ? "Masqué" : "Visible" },
          actions: [
            { key: "view", label: "Voir", readOnly: true, confirm: "Lecture seule : pour un plat inexact, masquez-le.", fields: view },
            { key: "edit", label: "Corriger", fields: edit },
            r.is_hidden ? { key: "show", label: "Réafficher" } : { key: "hide", label: "Masquer", confirm: `Masquer « ${r.name} » ? Il ne sera plus proposé aux foyers (il reste dans les menus déjà validés).` },
          ],
        };
      }),
      filters: [
        { key: "month", label: "Mois", value: query.filters.month ?? "", options: monthFilter },
        { key: "cuisine", label: "Cuisine", value: query.filters.cuisine ?? "", options: cuisines.map((x) => ({ value: String(x.id), label: x.name })) },
        { key: "state", label: "Masqués", value: query.filters.state ?? "", options: [{ value: "visible", label: "Visibles" }, { value: "hidden", label: "Masqués" }] },
        { key: "choices", label: "Nombre de choix", value: query.filters.choices ?? "", options: CHOICE_FILTER },
      ],
      search: true,
      total: rows.filter(wanted).length,
      footer: rows.filter(wanted).length > 300 ? "Les 300 premiers plats sont affichés : affinez avec la recherche ou les filtres." : null,
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
      const months = [...new Set((values.months ?? "").split(",").map((m) => Number(m.trim())).filter((m) => Number.isInteger(m)))];
      if (!months.length || months.some((m) => m < 1 || m > 12)) throw courseError("invalid_months", "Choisissez au moins un mois de saison.", 422);
      const wanted = [...new Set((values.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean))];
      const tags = await db.selectFrom("meal_dish_tags").select(["id", "name"]).where("kind", "<>", "allergen").execute();
      const ids: number[] = [];
      for (const raw of wanted) {
        const found = tags.find((t) => String(t.id) === raw || norm(t.name) === norm(raw));
        if (!found) throw courseError("unknown_tag", `Étiquette inconnue : « ${raw.slice(0, 80)} ». Choisissez parmi la liste.`, 422);
        ids.push(found.id);
      }
      // un plat garde toujours au moins un mois : on ajoute les nouveaux mois avant de retirer les autres
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
