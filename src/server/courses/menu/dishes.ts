import { sql, type Kysely } from "kysely";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { dishTagLabels } from "../catalog/tags";
import { nameKey } from "../catalog/seed";
import { norm } from "../engine";
import { courseError, requireAccess, translateCourseError } from "../household/settings";
import { describeIssues, validateTable } from "../imports/spec";
import { HOUSEHOLD_DISHES_SPEC, HOUSEHOLD_DISHES_TEMPLATE_HEADERS } from "../imports/specs";
import { ImportFileError, readTable, toCsv } from "../imports/table";

/**
 * Plats du foyer (US-159, CR-04) : visibles de ce foyer seulement, jamais dans le catalogue commun. Un ingrédient connu du catalogue est relié à son produit ; un ingrédient
 * inconnu est noté, sans foyer, dans les produits à référencer (US-173). Les étiquettes (viande, régime, allergènes) sont déduites du nom et des ingrédients, comme pour le catalogue.
 */

const MAX_DISHES = 300;

export interface DishInput {
  name: string;
  cuisineId: number;
  ingredients: string[];
  minutes?: number | null;
  recipe?: string | null;
}

export interface OwnDish {
  id: string;
  name: string;
  cuisine: string;
  minutes: number | null;
  ingredients: string[];
}

export interface DishForm {
  cuisines: { id: number; name: string }[];
  dishes: OwnDish[];
}

export async function dishForm(ctx: Ctx, session: SessionContext): Promise<DishForm> {
  const who = await requireAccess(ctx, session, "couple");
  const [cuisines, dishes, ingredients] = await Promise.all([
    ctx.db.selectFrom("meal_cuisines").select(["id", "name"]).where("is_hidden", "=", false).orderBy("sort_order").orderBy("id").execute(),
    ctx.db
      .selectFrom("meal_household_dishes as d")
      .innerJoin("meal_cuisines as c", "c.id", "d.cuisine_id")
      .select(["d.id", "d.name", "d.duration_minutes", "c.name as cuisine"])
      .where("d.account_id", "=", who.accountId)
      .orderBy("d.created_at", "desc")
      .execute(),
    ctx.db.selectFrom("meal_household_dish_ingredients").select(["household_dish_id", "label"]).where("account_id", "=", who.accountId).orderBy("position").execute(),
  ]);
  return {
    cuisines,
    dishes: dishes.map((d) => ({ id: d.id, name: d.name, cuisine: d.cuisine, minutes: d.duration_minutes, ingredients: ingredients.filter((i) => i.household_dish_id === d.id).map((i) => i.label) })),
  };
}

export function cleanDish(input: DishInput) {
  const name = input.name.trim().replace(/\s+/g, " ");
  const seen = new Set<string>();
  const ingredients = input.ingredients
    .map((i) => i.trim().replace(/\s+/g, " "))
    .filter((i) => i && !seen.has(nameKey(i)) && seen.add(nameKey(i)));
  const missing: string[] = [];
  if (!name) missing.push("le nom");
  if (!input.cuisineId) missing.push("la cuisine");
  if (!ingredients.length) missing.push("au moins un ingrédient");
  if (missing.length) throw courseError("missing_fields", `Il manque ${missing.join(", ")}.`, 422, { missing });
  if (name.length > 80) throw courseError("invalid_name", "Le nom du plat compte 80 caractères au plus.", 422);
  if (ingredients.length > 40 || ingredients.some((i) => i.length > 120)) throw courseError("invalid_ingredients", "40 ingrédients au plus, 120 caractères chacun.", 422);
  const minutes = input.minutes ?? null;
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 600)) throw courseError("invalid_minutes", "La durée va de 1 à 600 minutes.", 422);
  const recipe = (input.recipe ?? "").trim().slice(0, 5000) || null;
  return { name, ingredients, minutes, recipe };
}

export async function insertDish(trx: Kysely<DB>, accountId: string, userId: string, input: ReturnType<typeof cleanDish> & { cuisineId: number }, now: Date): Promise<string> {
  const exists = await trx.selectFrom("meal_household_dishes").select("id").where("account_id", "=", accountId).where(sql`lower(name)`, "=", input.name.toLowerCase()).executeTakeFirst();
  if (exists) throw courseError("dish_exists", `« ${input.name} » est déjà dans vos plats.`, 409);
  const count = await trx.selectFrom("meal_household_dishes").select((eb) => eb.fn.countAll<string>().as("n")).where("account_id", "=", accountId).executeTakeFirstOrThrow();
  if (Number(count.n) >= MAX_DISHES) throw courseError("too_many_dishes", `Au plus ${MAX_DISHES} plats.`, 409);
  const dish = await trx
    .insertInto("meal_household_dishes")
    .values({ account_id: accountId, name: input.name, cuisine_id: input.cuisineId, recipe: input.recipe, duration_minutes: input.minutes, created_by_user_id: userId, created_at: now, updated_at: now })
    .returning("id")
    .executeTakeFirstOrThrow();
  const keys = input.ingredients.map(nameKey);
  const products = await trx.selectFrom("grocery_products").select(["id", "name_key", "aisle_id"]).where("name_key", "in", keys).execute();
  const byKey = new Map(products.map((p) => [p.name_key, p]));
  await trx
    .insertInto("meal_household_dish_ingredients")
    .values(input.ingredients.map((label, i) => ({ household_dish_id: dish.id, account_id: accountId, label, name_key: keys[i].slice(0, 120), product_id: byKey.get(keys[i])?.id ?? null, position: i + 1 })))
    .execute();
  for (const [i, label] of input.ingredients.entries()) {
    if (!byKey.has(keys[i])) await sql`select note_grocery_unreferenced(${accountId}::uuid, ${label}, 'unknown'::grocery_unreferenced_kind, 'menu'::grocery_unreferenced_source)`.execute(trx);
  }
  const labels = dishTagLabels(input.name, input.ingredients.join(", "));
  if (labels.length) {
    const tags = await trx.selectFrom("meal_dish_tags").select(["id", "name"]).where("name", "in", labels).execute();
    if (tags.length) await trx.insertInto("meal_household_dish_tags").values(tags.map((t) => ({ household_dish_id: dish.id, account_id: accountId, tag_id: t.id }))).execute();
  }
  return dish.id;
}

/** Ajoute un plat du foyer. */
export async function createDish(ctx: Ctx, session: SessionContext, input: DishInput): Promise<{ id: string; name: string }> {
  const who = await requireAccess(ctx, session, "couple");
  const data = cleanDish(input);
  let id = "";
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      id = await insertDish(trx, who.accountId, who.userId, { ...data, cuisineId: input.cuisineId }, ctx.now);
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return { id, name: data.name };
}

/** Le modèle à remplir pour ajouter plusieurs plats d'un coup. */
export function dishTemplate(): { file: string; content: string } {
  return { file: HOUSEHOLD_DISHES_SPEC.templateFile, content: toCsv(HOUSEHOLD_DISHES_TEMPLATE_HEADERS, [["Poulet yassa", "Afro", "Poulet | Oignons | Citrons"]]) };
}

/** Importe plusieurs plats : tout le fichier est vérifié avant la moindre écriture, une seule ligne invalide le refuse en entier (règles communes des imports). */
export async function importDishes(ctx: Ctx, session: SessionContext, file: { name: string; content: Buffer }): Promise<{ count: number }> {
  const who = await requireAccess(ctx, session, "couple");
  const cuisines = await ctx.db.selectFrom("meal_cuisines").select(["id", "name"]).where("is_hidden", "=", false).execute();
  const byName = new Map(cuisines.map((c) => [norm(c.name), c.id]));
  let table;
  try {
    table = await readTable(file);
  } catch (error) {
    if (error instanceof ImportFileError) throw courseError("invalid_import", error.message, 422);
    throw error;
  }
  const outcome = validateTable(HOUSEHOLD_DISHES_SPEC, table, { cuisines: new Set(byName.keys()) });
  if (outcome.issues.length) throw courseError("invalid_import", "Le fichier n'a pas été importé : aucun plat n'a été ajouté.", 422, { issues: describeIssues(outcome.issues) });
  if (!outcome.rows.length) throw courseError("invalid_import", "Le fichier ne contient aucun plat.", 422);
  const rows = outcome.rows.map((r) => ({ name: String(r.values.plat), cuisineId: byName.get(norm(String(r.values.cuisine)))!, ingredients: r.values.ingredients as string[] }));
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      for (const r of rows) await insertDish(trx, who.accountId, who.userId, { ...cleanDish({ ...r }), cuisineId: r.cuisineId }, ctx.now);
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return { count: rows.length };
}
