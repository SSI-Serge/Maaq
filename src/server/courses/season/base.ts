import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { buildRefProducts, findProd, norm, allowed, type Dish, type Profile, type QuantityUnit } from "../engine";
import { nameKey } from "../catalog/seed";
import type { SettingsView } from "../household/settings";
import { loadReferences } from "../list/data";
import { INPUT_OF_UNIT, resolveDish, type ProposalContext, type ProposalDish } from "../menu-ia/proposal";

/**
 * Base commune des plats de saison (CR-61, US-178 RF2bis) : tous les plats de saison obtenus de l'IA y entrent, sans doublon (nom normalisé), anonymes (aucun lien avec le foyer qui les a obtenus) et sans prix ;
 * MAAQ la consulte AVANT tout appel à l'IA. Elle est distincte du catalogue commun des plats. La seule porte d'écriture est la fonction `share_season_dish` de la base.
 */

/** Nom normalisé : minuscules, sans accents, espaces simples, pluriel simple (« courgettes » = « courgette »). */
export function seasonKey(name: string): string {
  return nameKey(name)
    .split(" ")
    .map((w) => (w.length > 3 && /[sx]$/.test(w) ? w.slice(0, -1) : w))
    .join(" ")
    .slice(0, 120);
}

export interface SeasonIngredient {
  label: string;
  quantity: number | null;
  unit: QuantityUnit | null;
}

export interface SeasonDishInput {
  name: string;
  cuisineId: number;
  /** Nombre de personnes pour lequel les quantités sont écrites. */
  servings: number;
  recipe: string;
  minutes: number;
  /** Mois de saison (1 à 12). */
  months: number[];
  tagIds: number[];
  ingredients: SeasonIngredient[];
}

/** Écrit des plats dans la base commune (sans doublon : si le nom existe déjà, le premier est gardé et rien n'est écrasé) ; rend l'identifiant de chaque plat, dans l'ordre. */
export async function shareSeasonDishes(db: Kysely<DB>, dishes: SeasonDishInput[]): Promise<string[]> {
  if (!dishes.length) return [];
  const prods = buildRefProducts((await loadReferences(db)).rows);
  const ids: string[] = [];
  for (const d of dishes) {
    const keys = d.ingredients.map((i) => nameKey(i.label).slice(0, 120));
    const productName = (label: string, key: string) => {
      const found = findProd(prods, label);
      return found ? nameKey(found).slice(0, 120) : key;
    };
    const lookup = [...new Set([...keys, ...d.ingredients.map((i, k) => productName(i.label, keys[k]))])];
    const products = lookup.length ? await db.selectFrom("grocery_products").select(["id", "name_key"]).where("name_key", "in", lookup).execute() : [];
    const byKey = new Map(products.map((p) => [p.name_key, p.id]));
    const seen = new Set<string>();
    const ingredients = d.ingredients
      .map((i, k) => ({ i, key: keys[k], k }))
      .filter(({ key }) => key && !seen.has(key) && !!seen.add(key))
      .map(({ i, key, k }, position) => ({ label: i.label.slice(0, 120), name_key: key, product_id: byKey.get(key) ?? byKey.get(productName(i.label, keys[k])) ?? null, quantity: i.quantity, unit: i.quantity === null ? null : i.unit, position: position + 1 }));
    const key = seasonKey(d.name);
    const row = await sql<{ id: string }>`select share_season_dish(${d.name.trim().slice(0, 120)}, ${key}, ${d.cuisineId}::integer, ${Math.min(Math.max(d.servings, 1), 30)}::integer, ${d.recipe || null}, ${Math.min(Math.max(Math.round(d.minutes), 1), 600)}::integer, ${d.months}::integer[], ${d.tagIds}::integer[], ${JSON.stringify(ingredients)}::jsonb)::text as id`.execute(db);
    ids.push(row.rows[0].id);
  }
  return ids;
}

export interface SeasonCandidate {
  id: string;
  name: string;
  cuisineId: number;
  cuisine: string;
  servings: number;
  recipe: string;
  minutes: number;
  chosen: number;
  months: number[];
  tags: string[];
  ingredients: SeasonIngredient[];
}

/** Plats de la sélection du mois du foyer et plats de saison déjà choisis dans ses menus validés : écartés d'une nouvelle recherche (pas de journal « déjà vu » sur plusieurs mois). */
export async function seenSeasonDishes(db: Kysely<DB>, accountId: string, month: string): Promise<{ selection: string[]; inMenus: string[] }> {
  const [sel, menus] = await Promise.all([
    db.selectFrom("meal_season_household_dishes").select("dish_id").where("account_id", "=", accountId).where("season_month", "=", month as never).execute(),
    db.selectFrom("meal_menu_entries").select("season_dish_id").where("account_id", "=", accountId).where("season_dish_id", "is not", null).execute(),
  ]);
  return { selection: sel.map((r) => String(r.dish_id)), inMenus: [...new Set(menus.map((r) => String(r.season_dish_id)))] };
}

/** Candidats de la base pour un mois : plats non masqués, du mois, dans les cuisines du foyer, compatibles avec ses régimes et sans ingrédient qui correspond à ses allergies (mots-clés) ; les plus choisis d'abord. */
export async function findSeasonDishes(db: Kysely<DB>, settings: Pick<SettingsView, "cuisineIds">, profile: Pick<Profile, "allergies" | "regimes">, month: string, exclude: string[], limit: number, ids?: string[]): Promise<SeasonCandidate[]> {
  const cuisines = settings.cuisineIds.length ? settings.cuisineIds : null;
  const rows = (
    await sql<{ dish_id: string; name: string; cuisine_id: number; servings: number; recipe: string | null; duration_minutes: number | null; chosen_count: number; tag_ids: number[]; months: number[] }>`
      select dish_id::text, name, cuisine_id, servings, recipe, duration_minutes, chosen_count, tag_ids, months
        from search_season_dishes(${month}::date, ${cuisines}::integer[], null, null, ${exclude.length ? exclude : null}::bigint[], ${Math.max(limit * 4, 40)}::integer)`.execute(db)
  ).rows.filter((r) => !ids || ids.includes(r.dish_id));
  if (!rows.length) return [];
  const [ing, tags, cuisineRows] = await Promise.all([
    sql<{ dish_id: string; label: string; quantity: string | null; unit: QuantityUnit | null }>`select dish_id::text, label, quantity::text, unit from season_dish_ingredients_for(${rows.map((r) => r.dish_id)}::bigint[])`.execute(db),
    db.selectFrom("meal_dish_tags").select(["id", "kind", "name"]).execute(),
    db.selectFrom("meal_cuisines").select(["id", "name"]).execute(),
  ]);
  const tagName = new Map(tags.map((t) => [t.id, t]));
  const cuisineName = new Map(cuisineRows.map((c) => [c.id, c.name]));
  const out: SeasonCandidate[] = [];
  for (const r of rows) {
    const ingredients = ing.rows.filter((i) => i.dish_id === r.dish_id).map((i) => ({ label: i.label, quantity: i.quantity === null ? null : Number(i.quantity), unit: i.unit }));
    const tagNames = r.tag_ids.map((t) => tagName.get(t)).filter((t): t is NonNullable<typeof t> => !!t && t.kind !== "allergen").map((t) => t.name);
    const asDish: Dish = { id: "", cuisine: cuisineName.get(r.cuisine_id) ?? "", name: r.name, ing: ingredients.map((i) => i.label).join(", "), recipe: r.recipe ?? "", health: "", batch: "", time: "", minutes: r.duration_minutes ?? 30, tags: new Set(tagNames.map(norm)) };
    if (!ingredients.length || !allowed(asDish, profile)) continue;
    out.push({ id: r.dish_id, name: r.name, cuisineId: r.cuisine_id, cuisine: asDish.cuisine, servings: r.servings, recipe: r.recipe ?? "", minutes: r.duration_minutes ?? 30, chosen: r.chosen_count, months: r.months, tags: tagNames, ingredients });
    if (out.length >= limit) break;
  }
  return out;
}

/** Un plat de la base devient un plat du menu (origine « ai », avec son identifiant de base commune) : quantités ramenées au nombre de personnes du foyer ; contrôles de la carte (« Contient peut-être … ») refaits. */
export function seasonToProposalDish(c: SeasonCandidate, ctx: ProposalContext, week: string): ProposalDish | null {
  const factor = ctx.householdSize && c.servings ? ctx.householdSize / c.servings : 1;
  const scale = (q: number, unit: QuantityUnit) => (unit === "piece" ? Math.max(0.5, Math.round(q * factor * 2) / 2) : unit === "spoon" || unit === "pinch" ? Math.max(1, Math.round(q * factor)) : Math.round(q * factor * 100) / 100);
  const errors: string[] = [];
  const dish = resolveDish(
    {
      nom: c.name,
      cuisine: c.cuisine,
      duree_minutes: c.minutes,
      recette: c.recipe || "Recette à compléter.",
      ingredients: c.ingredients.map((i) => ({ nom: i.label, ...(i.quantity !== null && i.unit ? { quantite: scale(i.quantity, i.unit), unite: INPUT_OF_UNIT[i.unit] as never } : {}) })),
    },
    ctx,
    week,
    errors,
    "Plat de saison",
  );
  return dish ? { ...dish, seasonDishId: c.id } : null;
}

/** Contexte de proposition minimal pour convertir des plats de la base (les plats de saison ne passent pas par le moteur de plats connus). */
export const seasonContext = (data: ProposalContext["data"], cuisines: ProposalContext["cuisines"], householdSize: number | null, now: Date): ProposalContext => ({ data, cuisines, householdSize, now, newId: randomUUID });
