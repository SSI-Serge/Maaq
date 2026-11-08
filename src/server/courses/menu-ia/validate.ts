import type { Ctx, SessionContext } from "@/server/auth/service";
import { asProfile } from "@/server/assistant/outings/profile";
import { nameKey } from "../catalog/seed";
import { allowed, type Dish } from "../engine";
import { courseError, loadSettings, requireAccess, translateCourseError } from "../household/settings";
import { seedListFromMenu } from "../list/service";
import { loadEngineData } from "../menu/data";
import { hasNewerCard, loadCard, markValidated } from "./cards";
import type { MenuProposal, ProposalDish } from "./proposal";

/**
 * « Valider le menu » (US-156 RF9 à RF12) : enregistre le menu de la carte, met ses ingrédients dans la liste de courses et rend la semaine pour ouvrir la page Liste de courses.
 * Un plat libre est gardé avec le menu (ingrédients, recette, durée, version allégée) et n'entre jamais dans le catalogue commun (CR-04).
 */

export interface ValidatedMenuCard {
  week: string;
  weekLabel: string;
  sessionMinutes: number;
  estimated: boolean;
  overCap: boolean;
  /** Produits mis dans la liste de courses. */
  listed: number;
  /** Plats à proposer pour « Ajouter ce plat à vos plats ? » (ceux qui ne sont pas déjà dans Mes plats). */
  addable: { slot: string; name: string }[];
}

const toDish = (d: ProposalDish): Dish => ({ id: d.engineId ?? "", cuisine: d.cuisine, name: d.name, ing: d.ingredients.join(", "), recipe: d.recipe, health: "", batch: "", time: "", minutes: d.minutes, tags: new Set() });

export async function validateMenuCard(ctx: Ctx, session: SessionContext, messageId: string): Promise<ValidatedMenuCard> {
  const who = await requireAccess(ctx, session, "couple");
  const card = await loadCard(ctx.db, session.user.id, messageId);
  if (!card) throw courseError("card_not_found", "Ce menu n'est plus disponible : demandez-en un nouveau.", 404);
  const { proposal } = card.envelope;
  if (card.envelope.validatedAt) throw courseError("already_validated", "Ce menu est déjà validé.", 409);
  if (!proposal.complete) throw courseError("menu_incomplete", "Ce menu est incomplet : demandez les dîners qui manquent.", 422);

  // un menu plus récent pour la même semaine remplace celui-ci : on ne valide pas l'ancien
  if (await hasNewerCard(ctx.db, card.conversationId, card.id, proposal.week)) throw courseError("menu_replaced", "Menu remplacé : validez le dernier menu proposé.", 409);

  // les réglages ont pu changer depuis la proposition : le conflit d'allergie est revérifié sur le moment
  const settings = await loadSettings(ctx.db, who.accountId);
  const data = await loadEngineData(ctx.db, who.accountId, settings, { all: true });
  const all = [...proposal.dinners, ...proposal.express];
  for (const d of all) {
    if (!d.engineId) continue;
    const known = data.dishes.find((k) => k.id === d.engineId);
    if (!known) throw courseError("dish_not_found", `Le plat « ${d.name} » n'existe plus : demandez un nouveau menu.`, 422);
    if (data.allergenBlocked.has(known.id) || !allowed(known, data.profile)) throw courseError("allergy_conflict", `Conflit d'allergie ou de régime sur « ${d.name} » : le menu ne peut pas être validé.`, 422);
  }

  const result = await writeMenu(ctx, who.accountId, who.userId, proposal, data);
  await markValidated(ctx.db, card.id, card.envelope, ctx.now);
  return result;
}

async function writeMenu(ctx: Ctx, accountId: string, userId: string, proposal: MenuProposal, data: Awaited<ReturnType<typeof loadEngineData>>): Promise<ValidatedMenuCard> {
  const week = proposal.week;
  const batchWeekId = proposal.planId ? (data.weekIds.get(proposal.planId) ?? null) : null;
  const dishesForList: Dish[] = [];
  try {
    const listed = await asProfile(ctx.db, userId, async (trx) => {
      const repeat = !!(await trx.selectFrom("meal_menus").select("id").where("account_id", "=", accountId).where("week_start", "=", week as never).executeTakeFirst());
      await trx.deleteFrom("meal_menus").where("account_id", "=", accountId).where("week_start", "=", week as never).execute();
      const menu = await trx
        .insertInto("meal_menus")
        .values({
          account_id: accountId,
          week_start: week as never,
          validated_at: ctx.now,
          validated_by_user_id: userId,
          batch_week_id: batchWeekId as never,
          session_minutes: Math.min(Math.max(proposal.session.minutes, 1), 1000),
          session_is_estimated: proposal.session.estimated,
          session_over_cap: proposal.session.overCap,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const entryIds = new Map<string, string>();
      const rows = [
        ...proposal.dinners.map((d, i) => ({ kind: "dinner" as const, slot: i + 1, d })),
        ...proposal.express.map((d, i) => ({ kind: "express" as const, slot: i + 1, d })),
      ];
      for (const { kind, slot, d } of rows) {
        const ref = d.engineId ? data.refs.get(d.engineId) : undefined;
        const inserted = await trx
          .insertInto("meal_menu_entries")
          .values({
            menu_id: menu.id,
            account_id: accountId,
            kind,
            slot,
            dish_name: d.name.slice(0, 160),
            dish_origin: d.origin,
            dish_id: ref?.kind === "catalog" ? (ref.dishId as never) : null,
            household_dish_id: ref?.kind === "household" ? ref.dishId : null,
            cuisine_id: d.origin === "ai" ? d.cuisineId : null,
            recipe: d.origin === "ai" ? d.recipe : null,
            duration_minutes: d.origin === "ai" ? d.minutes : null,
            light_by_ai: !!d.light,
            light_text: d.light?.text ?? null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        entryIds.set(`${kind}:${slot}`, String(inserted.id));
        if (d.origin === "ai") {
          const keys = d.ingredients.map((i) => nameKey(i).slice(0, 120));
          const products = keys.length ? await trx.selectFrom("grocery_products").select(["id", "name_key"]).where("name_key", "in", keys).execute() : [];
          const byKey = new Map(products.map((p) => [p.name_key, p.id]));
          await trx
            .insertInto("meal_menu_entry_ingredients")
            .values(d.ingredients.map((label, position) => ({ entry_id: inserted.id, account_id: accountId, label: label.slice(0, 120), name_key: keys[position], product_id: byKey.get(keys[position]) ?? null, position: position + 1 })))
            .execute();
        }
        if (d.light && (d.light.remove.length || d.light.add.length)) {
          const items = [...d.light.remove.map((label) => ({ kind: "remove" as const, label })), ...d.light.add.map((label) => ({ kind: "add" as const, label }))];
          const unique = new Map(items.map((i) => [`${i.kind}:${nameKey(i.label)}`, i]));
          const keys = [...unique.values()].map((i) => nameKey(i.label).slice(0, 120));
          const products = await trx.selectFrom("grocery_products").select(["id", "name_key"]).where("name_key", "in", keys).execute();
          const byKey = new Map(products.map((p) => [p.name_key, p.id]));
          await trx
            .insertInto("meal_menu_entry_light_items")
            .values([...unique.values()].map((i) => ({ entry_id: inserted.id, account_id: accountId, kind: i.kind, label: i.label.slice(0, 120), name_key: nameKey(i.label).slice(0, 120), product_id: byKey.get(nameKey(i.label).slice(0, 120)) ?? null })))
            .execute();
        }
        dishesForList.push(toDish(d));
      }

      // déroulé de la séance rédigé par l'IA : seulement sans semaine type (avec elle, c'est celui du planning)
      if (!proposal.planId && proposal.steps.length) {
        const entryOf = (name: string | null): string | null => {
          if (!name) return null;
          const index = rows.findIndex((r) => r.d.name === name);
          return index < 0 ? null : (entryIds.get(`${rows[index].kind}:${rows[index].slot}`) ?? null);
        };
        await trx
          .insertInto("meal_menu_session_steps")
          .values(
            proposal.steps.map((s) => ({
              menu_id: menu.id,
              account_id: accountId,
              position: s.position,
              body: s.text,
              entry_id: entryOf(s.dish) as never,
              duration_minutes: s.minutes,
              overlaps_position: s.overlaps,
              storage_mode: s.storage,
              take_out_day: s.takeOutDay,
            })),
          )
          .execute();
      }

      return seedListFromMenu(trx, accountId, userId, [...new Map(dishesForList.map((d) => [nameKey(d.name), d])).values()], { repeat });
    });
    return {
      week,
      weekLabel: proposal.weekLabel,
      sessionMinutes: proposal.session.minutes,
      estimated: proposal.session.estimated,
      overCap: proposal.session.overCap,
      listed,
      addable: [...proposal.dinners.map((d, i) => ({ d, slot: `dinner:${i + 1}` })), ...proposal.express.map((d, i) => ({ d, slot: `express:${i + 1}` }))].filter(({ d }) => d.origin !== "household").map(({ d, slot }) => ({ slot, name: d.name })),
    };
  } catch (error) {
    throw translateCourseError(error);
  }
}
