import type { Ctx, SessionContext } from "@/server/auth/service";
import { asProfile } from "@/server/assistant/outings/profile";
import { DAYS, estimateMinutes, fmtMin, isoDate, nextMonday, proposeMenu, type Dish, type MenuState } from "../engine";
import { courseError, loadSettings, requireAccess, translateCourseError, type SettingsView } from "../household/settings";
import { seedListFromMenu } from "../list/service";
import { loadEngineData, type EngineData } from "./data";
import { weekLabel } from "./weeks";

/**
 * Menu de la semaine (US-155, US-156) : choix de 1 ou 2 plats plaisir, proposition de 7 dîners appuyés sur une semaine type de batch, plats express de secours,
 * remplacements, validation. Le menu proposé n'est pas gardé : seule la validation écrit en base (un menu par semaine, la nouvelle validation remplace l'ancienne).
 */

export const MAX_PICKS = 2;
const EXPRESS_COUNT = 4;

export interface DishCard {
  id: string;
  name: string;
  minutes: number;
  time: string;
  cuisine: string;
  mine: boolean;
}

export interface MenuStart {
  week: string;
  weekLabel: string;
  maxPicks: number;
  groups: { name: string; dishes: { id: string; name: string }[] }[];
  /** Menu déjà validé pour cette semaine : on peut le revoir ou le refaire. */
  validated: { validatedAt: string } | null;
  missing: string[];
}

export interface ProposedDay {
  day: string;
  dish: DishCard;
  alternatives: DishCard[];
  /** Le plat vient de la séance de batch du dimanche (lundi à vendredi, non remplacé). */
  inSession: boolean;
  /** Nom du plat du planning quand le plat du catalogue est seulement proche (correspondance à confirmer, US-156 RF7). */
  confirmFrom: string;
}

export interface MenuProposal {
  week: string;
  weekLabel: string;
  picks: DishCard[];
  session: {
    source: "planning" | "estimation";
    minutes: number;
    label: string;
    theme: string;
    percentShared: number | null;
    overCap: boolean;
    capLabel: string;
    capMinutes: number;
    steps: string[];
  };
  days: ProposedDay[];
  express: DishCard[];
  expressShort: boolean;
  recipes: { id: string; name: string; text: string }[];
  /** « Recettes pour 4 : multipliez par 1,5 » quand le foyer compte plus de 4 personnes. */
  servingsNote: string | null;
}

export { weekLabel };

/** Séance au format de l'écran : « 1 h 50 » ; durée estimée : « environ 1 h 45 ». */
export function sessionLabel(minutes: number, estimated: boolean): string {
  return estimated ? `environ ${fmtMin(minutes)}` : fmtMin(minutes);
}

function mondayOf(date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}

/** Semaine préparée : le lundi qui vient par défaut ; le lundi de cette semaine et les trois suivants sont acceptés. */
export function resolveWeek(requested: string | undefined, now: Date): string {
  if (!requested) return nextMonday(now);
  const first = mondayOf(now);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested >= first && requested <= isoDate(new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, Number(first.slice(8)) + 21));
  const isMonday = valid && new Date(`${requested}T12:00:00`).getDay() === 1;
  if (!isMonday) throw courseError("invalid_week", "Choisissez un lundi de cette semaine ou des trois suivantes.", 422);
  return requested;
}

const card = (d: Dish): DishCard => ({ id: d.id, name: d.name, minutes: d.minutes, time: fmtMin(d.minutes), cuisine: d.cuisine, mine: !!d.mine });

async function prepare(ctx: Ctx, session: SessionContext): Promise<{ accountId: string; userId: string; settings: SettingsView; data: EngineData }> {
  const who = await requireAccess(ctx, session, "couple");
  const settings = await loadSettings(ctx.db, who.accountId);
  const data = await loadEngineData(ctx.db, who.accountId, settings);
  return { ...who, settings, data };
}

function requireSettings(settings: SettingsView) {
  if (settings.missing.length) throw courseError("settings_missing", "Complétez d'abord les réglages du foyer.", 409, { missing: settings.missing });
}

/** Étape 1 : les plats que le foyer peut choisir (cuisines retenues et plats du foyer), regroupés par cuisine. */
export async function menuStart(ctx: Ctx, session: SessionContext, requestedWeek?: string): Promise<MenuStart> {
  const { accountId, settings, data } = await prepare(ctx, session);
  const week = resolveWeek(requestedWeek, ctx.now);
  const wanted = new Set(settings.cuisineIds);
  const cuisineNames = new Map(settings.options.cuisines.map((c) => [c.id, c.name]));
  const groups: MenuStart["groups"] = [];
  for (const cuisine of settings.options.cuisines) {
    if (wanted.size && !wanted.has(cuisine.id)) continue;
    const dishes = data.dishes.filter((d) => !d.mine && data.cuisineOf.get(d.id) === cuisine.id).map((d) => ({ id: d.id, name: d.name }));
    if (dishes.length) groups.push({ name: cuisineNames.get(cuisine.id) ?? cuisine.name, dishes: dishes.sort((a, b) => a.name.localeCompare(b.name, "fr")) });
  }
  const own = data.dishes.filter((d) => d.mine).map((d) => ({ id: d.id, name: d.name }));
  if (own.length) groups.push({ name: "Mes plats", dishes: own.sort((a, b) => a.name.localeCompare(b.name, "fr")) });
  const existing = await ctx.db.selectFrom("meal_menus").select("validated_at").where("account_id", "=", accountId).where("week_start", "=", week as never).executeTakeFirst();
  return { week, weekLabel: weekLabel(week), maxPicks: MAX_PICKS, groups, validated: existing ? { validatedAt: existing.validated_at.toISOString() } : null, missing: settings.missing };
}

function compute(data: EngineData, picks: string[], week: string, now: Date): MenuState {
  if (!picks.length || picks.length > MAX_PICKS || new Set(picks).size !== picks.length) throw courseError("invalid_picks", "Choisissez 1 ou 2 plats.", 422);
  // un menu déjà validé pour cette semaine ne compte pas dans la répétition de la même semaine
  const history = data.history.filter((h) => h.week !== week);
  try {
    return proposeMenu({ dishes: data.dishes, plans: data.plans, profile: data.profile, picks, week, history, today: now, expressCount: EXPRESS_COUNT });
  } catch (error) {
    if ((error as Error).message === "picks_not_found") throw courseError("dish_not_found", "Un des plats choisis n'existe plus.", 422);
    throw error;
  }
}

/** Étape 2 : le menu proposé autour des plats choisis. */
export async function menuPropose(ctx: Ctx, session: SessionContext, input: { picks: string[]; week?: string }): Promise<MenuProposal> {
  const { settings, data } = await prepare(ctx, session);
  requireSettings(settings);
  const week = resolveWeek(input.week, ctx.now);
  const state = compute(data, input.picks, week, ctx.now);
  const byId = new Map(data.dishes.map((d) => [d.id, d]));
  const get = (id: string) => byId.get(id)!;
  const estimated = state.batch.source === "estimation";
  const days: ProposedDay[] = state.menu.map((entry, i) => ({
    day: DAYS[i],
    dish: card(get(entry.id)),
    alternatives: entry.alts.map((id) => card(get(id))),
    inSession: i < 5 && (estimated || entry.batch),
    confirmFrom: entry.confirm,
  }));
  const size = settings.householdSize ?? 4;
  const factor = size / 4;
  return {
    week,
    weekLabel: weekLabel(week),
    picks: input.picks.map((id) => card(get(id))),
    session: {
      source: state.batch.source,
      minutes: state.batch.total,
      label: sessionLabel(state.batch.total, estimated),
      theme: state.batch.theme ?? "",
      percentShared: state.batch.pct ?? null,
      overCap: state.batch.total > state.batch.cap,
      capLabel: fmtMin(state.batch.cap),
      capMinutes: state.batch.cap,
      steps: state.batch.steps,
    },
    days,
    express: state.express.map((id) => card(get(id))),
    expressShort: state.expressShort,
    recipes: [...new Set([...state.menu.map((m) => m.id), ...state.express])].map((id) => get(id)).filter((d) => d.recipe).map((d) => ({ id: d.id, name: d.name, text: d.recipe })),
    servingsNote: size > 4 ? `Recettes pour 4 : multipliez par ${String(factor).replace(".", ",")}` : null,
  };
}

export interface ValidateInput {
  week?: string;
  picks: string[];
  /** Les 7 dîners choisis, du lundi au dimanche (le plat proposé ou son remplaçant). */
  dinners: string[];
  express: string[];
}

export interface ValidatedMenu {
  week: string;
  weekLabel: string;
  sessionMinutes: number;
  estimated: boolean;
  overCap: boolean;
}

/** Valide le menu : un menu par semaine, la nouvelle validation remplace l'ancienne. Les plats viennent du catalogue ou du foyer ; rien d'autre n'est accepté. */
export async function menuValidate(ctx: Ctx, session: SessionContext, input: ValidateInput): Promise<ValidatedMenu> {
  const { accountId, userId, settings, data } = await prepare(ctx, session);
  requireSettings(settings);
  const week = resolveWeek(input.week, ctx.now);
  if (input.dinners.length !== 7) throw courseError("invalid_menu", "Un menu compte 7 dîners.", 422);
  if (input.express.length > EXPRESS_COUNT) throw courseError("invalid_menu", `Au plus ${EXPRESS_COUNT} plats express.`, 422);
  const state = compute(data, input.picks, week, ctx.now);
  const byId = new Map(data.dishes.map((d) => [d.id, d]));
  const all = [...input.picks, ...input.dinners, ...input.express];
  if (all.some((id) => !byId.has(id))) throw courseError("dish_not_found", "Un des plats n'existe plus.", 422);

  const planned = state.batch.source === "planning";
  const sameAsProposed = input.dinners.map((id, i) => i < 5 && id === state.menu[i]?.id);
  const finalDishes = input.dinners.map((id) => byId.get(id)!);
  // Un plat qui sort de la séance par un remplacement la raccourcit : la durée est alors recalculée comme une durée estimée (CR-38, US-156 RF8)
  const wasInSession = (i: number) => i < 5 && (!planned || !!state.menu[i]?.batch);
  const replacedOut = input.dinners.some((_, i) => wasInSession(i) && !sameAsProposed[i]);
  const estimated = !planned || replacedOut;
  const remaining = finalDishes.filter((_, i) => wasInSession(i) && sameAsProposed[i]);
  const minutes = estimated ? Math.round(estimateMinutes(remaining)) : state.batch.total;
  const overCap = minutes > state.batch.cap;
  const batchWeekId = planned && !replacedOut && state.batch.id ? (data.weekIds.get(state.batch.id) ?? null) : null;
  const ref = (id: string) => {
    const r = data.refs.get(id)!;
    return r.kind === "catalog" ? { dish_id: r.dishId, household_dish_id: null } : { dish_id: null, household_dish_id: r.dishId };
  };
  const entry = (kind: "pleasure" | "dinner" | "express", slot: number, id: string, extra: { offBatch?: boolean; confirm?: boolean } = {}) => ({
    kind,
    slot,
    dish_name: byId.get(id)!.name.slice(0, 160),
    dish_origin: data.refs.get(id)!.kind,
    is_off_batch: extra.offBatch ?? false,
    planning_match_to_confirm: extra.confirm ?? false,
    ...ref(id),
  });

  try {
    await asProfile(ctx.db, userId, async (trx) => {
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
          session_minutes: minutes >= 1 ? Math.min(minutes, 1000) : null,
          session_is_estimated: estimated,
          session_over_cap: overCap,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const rows = [
        ...input.picks.map((id, i) => entry("pleasure", i + 1, id)),
        ...input.dinners.map((id, i) => entry("dinner", i + 1, id, { offBatch: !sameAsProposed[i] || !wasInSession(i), confirm: sameAsProposed[i] && !!state.menu[i]?.confirm })),
        ...input.express.map((id, i) => entry("express", i + 1, id)),
      ];
      await trx.insertInto("meal_menu_entries").values(rows.map((r) => ({ ...r, menu_id: menu.id, account_id: accountId }))).execute();
      // les ingrédients du menu entrent dans la liste de courses (US-156 RF12)
      await seedListFromMenu(trx, accountId, userId, [...new Map(finalDishes.map((d) => [d.id, d])).values()], { repeat });
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return { week, weekLabel: weekLabel(week), sessionMinutes: minutes, estimated, overCap };
}
