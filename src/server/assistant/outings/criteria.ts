import { sql } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { OutingCategory, OutingDayPref, OutingFrequency, OutingMood } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { isParent, requireParent } from "../family";
import { localDay } from "../local-time";
import { familyTimeZone } from "../reminders";
import { asProfile } from "./profile";

/**
 * Critères de sorties d'un parent (US-114) : réglages PERSONNELS, jamais visibles par l'autre parent (US-117). Désactivés par défaut (SG-2). Le lieu de départ est une ville ou
 * un secteur, jamais une adresse (D47). Les catégories « enfants » et « ados » ne sont proposées que si la famille compte un membre de cet âge (RF3).
 */

import {
  BUDGET_MAX, BUDGET_MIN, CATEGORIES, CATEGORY_LABEL, DAY_LABEL, DAY_PREFS, FREQUENCIES, MOODS, PEOPLE_MAX, PEOPLE_MIN, PLACE_MAX, criteriaSummary, looksLikeAddress,
} from "./rules";

export { BUDGET_MAX, BUDGET_MIN, CATEGORY_LABEL, DAY_LABEL, DAY_PREFS, FREQUENCIES, MOODS, PEOPLE_MAX, PEOPLE_MIN, PLACE_MAX, looksLikeAddress };

/** Une ligne restée en « une par semaine » est lue comme « deux par mois » (D67) ; la base la refuse désormais, la lecture reste prudente. */
const limited = (frequency: OutingFrequency | undefined): OutingFrequency => (frequency === "monthly" ? "monthly" : frequency ? "twice_monthly" : "monthly");

const fail = (code: string, message: string, status = 422) => new Rejection(code, message, status);

export interface ThemeView {
  key: string;
  label: string;
  /** Sous-groupe d'affichage (par exemple « concerts », repliable sur l'écran) ; vide pour un thème ordinaire (D68). */
  group: string | null;
}
export interface CategoryView {
  category: OutingCategory;
  label: string;
  themes: ThemeView[];
}

export interface CriteriaView {
  enabled: boolean;
  /** Les idées de sorties sont ouvertes (OUTINGS_MODE=live) : sinon les critères s'enregistrent, mais aucune proposition n'est préparée. */
  open: boolean;
  /** Catégories proposées à ce parent, avec leurs thèmes. */
  categories: CategoryView[];
  /** Thèmes choisis, par catégorie. */
  selected: Partial<Record<OutingCategory, string[]>>;
  budget: number | null;
  people: number | null;
  place: string;
  mood: OutingMood;
  days: OutingDayPref[];
  frequency: OutingFrequency;
  /** Résumé de la ligne d'accès des réglages : « Activées · En couple · deux par mois » ou « Désactivées · touchez pour choisir vos critères ». */
  summary: string;
  /** Prénom de l'autre parent, pour « Ces critères restent privés : [prénom] ne les voit pas. » ; vide s'il n'y en a pas. */
  otherParent: string | null;
}

/** Âge en années d'un membre né à ce mois (le jour n'est pas connu, D54) ; rien si la naissance n'est pas connue. */
function ageOf(year: number | null, month: number | null, today: string): number | null {
  if (year === null || month === null) return null;
  const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  return ty - year - (tm < month ? 1 : 0);
}

/** Catégories proposées : « enfants » et « ados » seulement avec un enfant de cet âge ; un enfant sans date de naissance les laisse proposées (RF3). */
export async function availableCategories(ctx: Ctx, accountId: string): Promise<Set<OutingCategory>> {
  const today = localDay(ctx.now, await familyTimeZone(ctx.db, accountId));
  const children = await ctx.db.selectFrom("family_members").select(["birth_year", "birth_month"]).where("account_id", "=", accountId).where("role", "=", "child").where("archived_at", "is", null).execute();
  const ages = children.map((c) => ageOf(c.birth_year, c.birth_month, today));
  const out = new Set<OutingCategory>(["self", "couple"]);
  if (ages.some((a) => a === null || (a >= 3 && a <= 10))) out.add("kids");
  if (ages.some((a) => a === null || (a >= 11 && a <= 17))) out.add("teens");
  return out;
}

export async function getCriteria(ctx: Ctx, session: SessionContext): Promise<CriteriaView> {
  const accountId = requireParent(session);
  const userId = session.user.id;
  const available = await availableCategories(ctx, accountId);
  const themes = await ctx.db.selectFrom("outing_themes").select(["category", "theme_key", "label", "theme_group"]).orderBy("category").orderBy("sort_order").execute();
  const categories = CATEGORIES.filter((c) => available.has(c))
    .map((category): CategoryView => ({ category, label: CATEGORY_LABEL[category], themes: themes.filter((t) => t.category === category).map((t) => ({ key: t.theme_key, label: t.label, group: t.theme_group })) }));
  const { row, picked } = await asProfile(ctx.db, userId, async (trx) => ({
    // Les jours préférés sont lus en texte : le pilote ne sait pas lire un tableau de valeurs énumérées.
    row: await trx.selectFrom("outing_criteria").select(["enabled", "budget_eur", "people_count", "departure_place", "mood", "frequency", sql<OutingDayPref[]>`preferred_days::text[]`.as("days")]).where("user_id", "=", userId).executeTakeFirst(),
    picked: await trx.selectFrom("outing_criteria_themes").select(["category", "theme_key"]).where("user_id", "=", userId).execute(),
  }));
  const selected: Partial<Record<OutingCategory, string[]>> = {};
  for (const p of picked) (selected[p.category] ??= []).push(p.theme_key);
  const other = await ctx.db
    .selectFrom("users")
    .select("first_name")
    .where("account_id", "=", accountId)
    .where("id", "<>", userId)
    .where("status", "in", ["active", "grace_period"])
    .where((eb) => eb.or([eb("role", "=", "primary_user"), eb.and([eb("role", "=", "guest"), eb("guest_rank", "=", "core")])]))
    .executeTakeFirst();
  return {
    enabled: row?.enabled ?? false,
    open: env().OUTINGS_MODE === "live",
    categories,
    selected,
    budget: row?.budget_eur ?? null,
    people: row?.people_count ?? null,
    place: row?.departure_place ?? "",
    mood: row?.mood ?? "both",
    days: row?.days ?? ["weekend"],
    frequency: limited(row?.frequency),
    summary: criteriaSummary({ enabled: row?.enabled ?? false, categories: Object.keys(selected) as OutingCategory[], frequency: limited(row?.frequency) }),
    otherParent: other?.first_name ?? null,
  };
}

export interface CriteriaInput {
  enabled: boolean;
  selected: Partial<Record<OutingCategory, string[]>>;
  budget: number | null;
  people: number | null;
  place: string;
  mood: OutingMood;
  days: OutingDayPref[];
  frequency: OutingFrequency;
}

/** Enregistre les critères du profil. Activés, ils exigent une catégorie et un thème, un budget, un nombre de personnes et un lieu de départ (RF6). */
export async function saveCriteria(ctx: Ctx, session: SessionContext, input: CriteriaInput): Promise<CriteriaView> {
  const accountId = requireParent(session);
  const userId = session.user.id;
  const available = await availableCategories(ctx, accountId);
  const valid = await ctx.db.selectFrom("outing_themes").select(["category", "theme_key"]).execute();
  const picks: { category: OutingCategory; theme: string }[] = [];
  for (const [category, keys] of Object.entries(input.selected) as [OutingCategory, string[]][]) {
    for (const key of new Set(keys ?? [])) {
      if (!valid.some((v) => v.category === category && v.theme_key === key)) throw fail("invalid_theme", "Un thème choisi n'existe pas.");
      if (!available.has(category)) throw fail("invalid_category", "Cette catégorie n'est pas proposée à votre famille.");
      picks.push({ category, theme: key });
    }
  }
  const place = input.place.trim();
  if (input.budget !== null && (!Number.isInteger(input.budget) || input.budget < BUDGET_MIN || input.budget > BUDGET_MAX)) throw fail("invalid_budget", "Indiquez un budget entre 10 € et 2 000 €.");
  if (input.people !== null && (!Number.isInteger(input.people) || input.people < PEOPLE_MIN || input.people > PEOPLE_MAX)) throw fail("invalid_people", "Indiquez un nombre de personnes entre 1 et 10.");
  if (place && (place.length < 2 || place.length > PLACE_MAX)) throw fail("invalid_place", `Indiquez une ville ou un secteur de 2 à ${PLACE_MAX} caractères.`);
  if (place && looksLikeAddress(place)) throw fail("address_refused", "Indiquez une ville ou un secteur, pas une adresse.");
  if (!MOODS.includes(input.mood) || !FREQUENCIES.includes(input.frequency)) throw fail("invalid_choice", "Un choix de critère n'existe pas.");
  const days = [...new Set(input.days)];
  if (days.length < 1 || days.some((d) => !DAY_PREFS.includes(d))) throw fail("invalid_days", "Choisissez au moins un jour préféré.");
  if (input.enabled && (!picks.length || input.budget === null || input.people === null || !place)) {
    throw fail("incomplete", "Pour recevoir des idées de sorties, choisissez au moins une catégorie et un thème, un budget, un nombre de personnes et un lieu de départ.");
  }
  try {
    await asProfile(ctx.db, userId, async (trx) => {
      await trx
        .insertInto("outing_criteria")
        .values({ user_id: userId, account_id: accountId, enabled: input.enabled, budget_eur: input.budget, people_count: input.people, departure_place: place || null, mood: input.mood, preferred_days: sql`${days}::outing_day_pref[]`, frequency: input.frequency })
        .onConflict((oc) => oc.column("user_id").doUpdateSet({ enabled: input.enabled, budget_eur: input.budget, people_count: input.people, departure_place: place || null, mood: input.mood, preferred_days: sql`${days}::outing_day_pref[]`, frequency: input.frequency }))
        .execute();
      await trx.deleteFrom("outing_criteria_themes").where("user_id", "=", userId).execute();
      for (const p of picks) await trx.insertInto("outing_criteria_themes").values({ user_id: userId, category: p.category, theme_key: p.theme }).execute();
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23514") throw fail("invalid_choice", (error as Error).message);
    throw error;
  }
  return getCriteria(ctx, session);
}

/** Un parent peut-il avoir des idées de sorties ? Les invités secondaires n'en ont pas (S-02). */
export const canHaveOutings = (session: SessionContext): boolean => isParent(session);
