import { sql } from "kysely";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { courseError, requireAccess, translateCourseError } from "../household/settings";
import { cleanDish, insertDish } from "../menu/dishes";
import { loadCard, markAddAnswered } from "./cards";

/**
 * « Ajouter ce plat à vos plats ? » (US-156 RF10, CR-45) : après la validation du menu, le foyer peut copier un plat dans « Mes plats », qu'il vienne de l'IA ou du catalogue. La copie
 * reprend le nom, la cuisine, la recette, la durée et les ingrédients ; la ligne de menu garde le lien vers la copie. Un plat libre n'entre jamais dans le catalogue commun (CR-04).
 */

export interface AddedToMine {
  added: string[];
  /** Déjà dans Mes plats (le lien est refait) ou impossible à copier. */
  skipped: { name: string; reason: string }[];
}

export async function addMenuDishesToMine(ctx: Ctx, session: SessionContext, input: { week: string; slots: string[]; messageId?: string }): Promise<AddedToMine> {
  const who = await requireAccess(ctx, session, "couple");
  // la question est répondue (même par « Non merci », sans plat) : elle ne revient plus
  const answered = async () => {
    const card = input.messageId ? await loadCard(ctx.db, session.user.id, input.messageId) : null;
    if (card) await markAddAnswered(ctx.db, card.id, card.envelope);
  };
  if (!input.slots.length) {
    await answered();
    return { added: [], skipped: [] };
  }
  const menu = await ctx.db.selectFrom("meal_menus").select("id").where("account_id", "=", who.accountId).where("week_start", "=", input.week as never).executeTakeFirst();
  if (!menu) throw courseError("no_menu", "Ce menu n'est pas validé.", 404);
  const wanted = new Set(input.slots);
  const entries = (await ctx.db.selectFrom("meal_menu_entries").select(["id", "kind", "slot", "dish_name", "dish_origin", "dish_id", "household_dish_id", "cuisine_id", "recipe", "duration_minutes"]).where("menu_id", "=", menu.id).execute()).filter((e) => wanted.has(`${e.kind}:${e.slot}`));
  const result: AddedToMine = { added: [], skipped: [] };
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      for (const e of entries) {
        if (e.household_dish_id) {
          result.skipped.push({ name: e.dish_name, reason: "déjà dans vos plats" });
          continue;
        }
        let cuisineId = e.cuisine_id;
        let recipe = e.recipe;
        let minutes = e.duration_minutes;
        let ingredients: string[] = [];
        if (e.dish_origin === "ai") {
          ingredients = (await trx.selectFrom("meal_menu_entry_ingredients").select("label").where("entry_id", "=", e.id).orderBy("position").execute()).map((i) => i.label);
        } else if (e.dish_id !== null) {
          const dish = await trx.selectFrom("meal_dishes").select(["cuisine_id", "recipe", "duration_minutes"]).where("id", "=", e.dish_id).executeTakeFirst();
          cuisineId = dish?.cuisine_id ?? null;
          recipe = dish?.recipe ?? null;
          minutes = dish?.duration_minutes ?? null;
          ingredients = (
            await trx
              .selectFrom("meal_dish_ingredients as i")
              .innerJoin("grocery_products as p", "p.id", "i.product_id")
              .select("p.name")
              .where("i.dish_id", "=", e.dish_id)
              .orderBy("i.position")
              .execute()
          ).map((i) => i.name);
        }
        if (!cuisineId || !ingredients.length) {
          result.skipped.push({ name: e.dish_name, reason: "ce plat n'a pas assez d'informations pour être copié" });
          continue;
        }
        const same = await trx.selectFrom("meal_household_dishes").select("id").where("account_id", "=", who.accountId).where(sql`lower(name)`, "=", e.dish_name.trim().toLowerCase()).executeTakeFirst();
        if (same) {
          await trx.updateTable("meal_menu_entries").set({ household_dish_id: same.id }).where("id", "=", e.id).execute();
          result.skipped.push({ name: e.dish_name, reason: "déjà dans vos plats" });
          continue;
        }
        const data = cleanDish({ name: e.dish_name.slice(0, 80), cuisineId, ingredients, minutes, recipe });
        const id = await insertDish(trx, who.accountId, who.userId, { ...data, cuisineId }, ctx.now);
        await trx.updateTable("meal_menu_entries").set({ household_dish_id: id }).where("id", "=", e.id).execute();
        result.added.push(e.dish_name);
      }
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  await answered();
  return result;
}
