import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { integerSetting } from "@/server/settings";
import { norm, type Dish, type Plan, type Profile } from "../engine";
import type { SettingsView } from "../household/settings";

/**
 * Données du moteur « Courses et repas » lues en base (catalogue, plats du foyer, semaines types, historique des menus validés). Le moteur est pur ;
 * ces fonctions lui fournissent ses entrées. Identifiant d'un plat dans le moteur : son code (« F4 ») pour le catalogue, « H:<uuid> » pour un plat du foyer.
 */

export const householdDishId = (uuid: string) => `H:${uuid}`;
export const isHouseholdDish = (id: string) => id.startsWith("H:");

export interface EngineData {
  dishes: Dish[];
  /** Identifiant du moteur → ligne de base (catalogue : bigint ; plat du foyer : uuid). */
  refs: Map<string, { kind: "catalog"; dishId: string } | { kind: "household"; dishId: string }>;
  /** Cuisine de chaque plat du catalogue, pour les groupes de l'écran. */
  cuisineOf: Map<string, number>;
  plans: Plan[];
  /** Semaine type du moteur (code) → identifiant de base. */
  weekIds: Map<string, string>;
  history: { week: string; dishName: string }[];
  profile: Profile;
  sessionCap: number;
}

/** Régimes et allergies du foyer tels que le moteur les attend ; les étiquettes d'allergène des plats servent à un filtre en plus de la recherche par mots. */
export function profileOf(settings: SettingsView, cuisineNames: Map<number, string>, defaultRepeat: number, cap: number): Profile {
  const objectives = [settings.goals.time ? "temps" : "", settings.goals.ownDishes ? "mes plats" : "", settings.goals.season ? "saison" : ""].filter(Boolean).join(",");
  const free = settings.allergyText
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const replacement = settings.replacementSource === "cuisine" && settings.replacementCuisineId ? [cuisineNames.get(settings.replacementCuisineId) ?? ""] : ["mes plats"];
  return {
    objectives,
    repetitionWeeks: settings.repeatWeeks ?? defaultRepeat,
    preferredCuisines: settings.cuisineIds.map((id) => cuisineNames.get(id) ?? "").filter(Boolean),
    replacementSource: replacement.filter(Boolean),
    batchMaxMinutes: cap,
    allergies: [...settings.allergens, ...free],
    regimes: settings.diets,
  };
}

const isoDay = (value: Date | string) => (typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10));

/** `all` : aussi les plats retirés du catalogue et ceux que le foyer écarte (pour relire un menu déjà validé, qui garde ses plats). */
export async function loadEngineData(db: Kysely<DB>, accountId: string, settings: SettingsView, options: { all?: boolean } = {}): Promise<EngineData> {
  const [cuisines, tags, dishRows, ingredientRows, tagLinks, own, ownIngredients, ownTags, weeks, days, history, repeat, cap] = await Promise.all([
    db.selectFrom("meal_cuisines").select(["id", "name"]).execute(),
    db.selectFrom("meal_dish_tags").select(["id", "kind", "name"]).execute(),
    db.selectFrom("meal_dishes").select(["id", "code", "name", "cuisine_id", "duration_minutes", "recipe"]).$if(!options.all, (q) => q.where("retired_at", "is", null)).orderBy("id").execute(),
    db
      .selectFrom("meal_dish_ingredients as i")
      .innerJoin("grocery_products as p", "p.id", "i.product_id")
      .select(["i.dish_id", "p.name"])
      .orderBy("i.dish_id")
      .orderBy("i.position")
      .execute(),
    db.selectFrom("meal_dish_tag_links").select(["dish_id", "tag_id"]).execute(),
    db.selectFrom("meal_household_dishes").select(["id", "name", "cuisine_id", "duration_minutes", "recipe"]).where("account_id", "=", accountId).orderBy("created_at").execute(),
    db.selectFrom("meal_household_dish_ingredients").select(["household_dish_id", "label"]).where("account_id", "=", accountId).orderBy("household_dish_id").orderBy("position").execute(),
    db.selectFrom("meal_household_dish_tags").select(["household_dish_id", "tag_id"]).where("account_id", "=", accountId).execute(),
    db.selectFrom("meal_batch_weeks").select(["id", "code", "cuisine_id", "theme", "session_minutes", "session_text", "shared_ingredients_pct"]).orderBy("code").execute(),
    db.selectFrom("meal_batch_week_days").select(["week_id", "weekday", "planning_dish_name", "dish_id"]).orderBy("week_id").orderBy("weekday").execute(),
    db
      .selectFrom("meal_menu_entries as e")
      .innerJoin("meal_menus as m", "m.id", "e.menu_id")
      .select(["m.week_start", "e.dish_name"])
      .where("e.account_id", "=", accountId)
      .where("e.kind", "in", ["dinner", "pleasure"])
      .execute(),
    integerSetting(db, "meal_repeat_weeks_default", 2),
    integerSetting(db, "meal_session_cap_minutes", 120),
  ]);
  const cuisineName = new Map(cuisines.map((c) => [c.id, c.name]));
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const engineTags = (ids: number[]): Set<string> => new Set(ids.map((id) => tagById.get(id)).filter((t) => t && t.kind !== "allergen").map((t) => norm(t!.name)));
  const allergenOf = (ids: number[]) => ids.map((id) => tagById.get(id)).filter((t) => t?.kind === "allergen").map((t) => norm(t!.name));

  const group = <T, K extends string>(rows: T[], key: (r: T) => K): Map<K, T[]> => {
    const m = new Map<K, T[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const ingByDish = group(ingredientRows, (r) => String(r.dish_id));
  const tagsByDish = group(tagLinks, (r) => String(r.dish_id));
  const ownIngByDish = group(ownIngredients, (r) => r.household_dish_id);
  const ownTagsByDish = group(ownTags, (r) => r.household_dish_id);
  const forbidden = new Set(options.all ? [] : settings.allergens.map(norm));

  const dishes: Dish[] = [];
  const refs: EngineData["refs"] = new Map();
  const cuisineOf = new Map<string, number>();
  for (const d of dishRows) {
    const ids = (tagsByDish.get(String(d.id)) ?? []).map((l) => l.tag_id);
    // un plat qui contient un allergène du foyer n'est jamais proposé (filtre indicatif, US-153 RF4)
    if (allergenOf(ids).some((a) => forbidden.has(a))) continue;
    dishes.push({
      id: d.code,
      cuisine: cuisineName.get(d.cuisine_id) ?? "",
      name: d.name,
      ing: (ingByDish.get(String(d.id)) ?? []).map((r) => r.name).join(", "),
      recipe: d.recipe ?? "",
      health: "",
      batch: "",
      time: "",
      minutes: d.duration_minutes,
      tags: engineTags(ids),
    });
    refs.set(d.code, { kind: "catalog", dishId: String(d.id) });
    cuisineOf.set(d.code, d.cuisine_id);
  }
  for (const d of own) {
    const ids = (ownTagsByDish.get(d.id) ?? []).map((l) => l.tag_id);
    if (allergenOf(ids).some((a) => forbidden.has(a))) continue;
    const id = householdDishId(d.id);
    dishes.push({
      id,
      cuisine: cuisineName.get(d.cuisine_id) ?? "",
      name: d.name,
      ing: (ownIngByDish.get(d.id) ?? []).map((r) => r.label).join(", "),
      recipe: d.recipe ?? "",
      health: "",
      batch: "",
      time: "",
      minutes: d.duration_minutes ?? 30,
      tags: engineTags(ids),
      mine: true,
    });
    refs.set(id, { kind: "household", dishId: d.id });
    cuisineOf.set(id, d.cuisine_id);
  }

  const codeById = new Map(dishRows.map((d) => [String(d.id), d.code]));
  const daysByWeek = group(days, (r) => String(r.week_id));
  const plans: Plan[] = [];
  const weekIds = new Map<string, string>();
  for (const w of weeks) {
    const wd = daysByWeek.get(String(w.id)) ?? [];
    if (wd.length !== 5) continue;
    plans.push({
      id: w.code,
      cuisine: cuisineName.get(w.cuisine_id) ?? "",
      theme: w.theme ?? "",
      days: wd.map((r) => r.planning_dish_name),
      ids: wd.map((r) => (r.dish_id ? (codeById.get(String(r.dish_id)) ?? "") : "")),
      steps: w.session_text.split("\n").map((s) => s.trim()).filter(Boolean),
      total: w.session_minutes,
      pct: w.shared_ingredients_pct,
    });
    weekIds.set(w.code, String(w.id));
  }

  return {
    dishes,
    refs,
    cuisineOf,
    plans,
    weekIds,
    history: history.map((h) => ({ week: isoDay(h.week_start as Date | string), dishName: h.dish_name })),
    profile: profileOf(settings, cuisineName, repeat, cap),
    sessionCap: cap,
  };
}
