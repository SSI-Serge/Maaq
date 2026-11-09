import { sql } from "kysely";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { Dish } from "../engine";
import { courseError, requireAccess, translateCourseError } from "../household/settings";
import { applyNeedsToItems } from "../menu-ia/needs";
import { seedListFromMenu } from "./service";
import { checkWeek, menuOfWeek } from "./weeks";

/**
 * Suppressions définitives (CR-54, US-156 RF14 et US-157 RF11), réservées au couple : la base le contrôle elle aussi (delete_meal_menu et delete_grocery_list lisent le profil dans
 * app.user_id, donc toujours appelées dans `asProfile`). Ni les tickets, ni les prix partagés, ni « Mes plats », ni le plafond de menus du jour ne sont touchés.
 *
 * - Supprimer le menu : le menu de la semaine et sa liste partent, produits achetés et ajoutés à la main compris.
 * - Supprimer la liste : le menu reste ; la liste est recalculée à partir de lui et attend d'être validée de nouveau. Les produits ajoutés à la main de cette semaine partent aussi.
 */

async function weekMenu(ctx: Ctx, accountId: string, week: string) {
  const checked = checkWeek(week, ctx.now);
  const menu = checked ? await menuOfWeek(ctx.db, accountId, checked) : null;
  if (!menu) throw courseError("no_menu", "Il n'y a pas de menu pour cette semaine.", 404);
  return menu;
}

export async function deleteWeekMenu(ctx: Ctx, session: SessionContext, week: string): Promise<{ deleted: true }> {
  const who = await requireAccess(ctx, session, "couple");
  const menu = await weekMenu(ctx, who.accountId, week);
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      await sql`select delete_meal_menu(${menu.id}::uuid)`.execute(trx);
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return { deleted: true };
}

export async function deleteWeekList(ctx: Ctx, session: SessionContext, week: string): Promise<{ deleted: true; recomputed: number }> {
  const who = await requireAccess(ctx, session, "couple");
  const menu = await weekMenu(ctx, who.accountId, week);
  let recomputed = 0;
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      await sql`select delete_grocery_list(${menu.id}::uuid)`.execute(trx);
      // la liste repart du menu enregistré : plats et ingrédients de ses lignes
      const entries = await trx.selectFrom("meal_menu_entries").select(["id", "dish_name"]).where("menu_id", "=", menu.id).orderBy("kind").orderBy("slot").execute();
      const lines = entries.length ? await trx.selectFrom("meal_menu_entry_ingredients").select(["entry_id", "label", "position"]).where("entry_id", "in", entries.map((e) => e.id)).orderBy("position").execute() : [];
      const dishes: Dish[] = entries.map((e) => ({ id: "", cuisine: "", name: e.dish_name, ing: lines.filter((l) => l.entry_id === e.id).map((l) => l.label).join(", "), recipe: "", health: "", batch: "", time: "", minutes: 0, tags: new Set() }));
      recomputed = await seedListFromMenu(trx, who.accountId, who.userId, menu.id, dishes, { repeat: true });
      await applyNeedsToItems(trx, who.accountId, menu.id);
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return { deleted: true, recomputed };
}
