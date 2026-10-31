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

export const BUDGET_MIN = 10;
export const BUDGET_MAX = 2000;
export const PEOPLE_MIN = 1;
export const PEOPLE_MAX = 10;
export const PLACE_MAX = 80;

export const CATEGORY_LABEL: Record<OutingCategory, string> = { self: "Pour moi", couple: "En couple", kids: "Avec les enfants de 3 à 10 ans", teens: "Avec les ados de 11 à 17 ans" };
export const DAY_LABEL: Record<OutingDayPref, string> = {
  weekend: "Week-end", weekday_evenings: "Soirs de semaine", monday: "Lundi", tuesday: "Mardi", wednesday: "Mercredi", thursday: "Jeudi", friday: "Vendredi", saturday: "Samedi", sunday: "Dimanche",
};
export const MOODS: OutingMood[] = ["calm", "playful", "both"];
/** « Une par semaine » est retiré (D67, coût : une proposition coûte environ 0,28 $) ; la valeur existe encore dans le schéma, mais n'est ni proposée ni acceptée. */
export const FREQUENCIES: OutingFrequency[] = ["monthly", "twice_monthly"];

/** Une ligne restée en « une par semaine » est lue comme « deux par mois » (D67). */
const limited = (frequency: OutingFrequency | undefined): OutingFrequency => (frequency === "monthly" ? "monthly" : frequency ? "twice_monthly" : "monthly");
export const DAY_PREFS = Object.keys(DAY_LABEL) as OutingDayPref[];

const fail = (code: string, message: string, status = 422) => new Rejection(code, message, status);

const ADDRESS_NUMBER = /^\s*[0-9]+\s*(bis|ter|quater)?\s*,?\s+\S/i;
const ADDRESS_WORD = /(^|[\s,;])(rue|avenue|av\.?|boulevard|bd|chemin|impasse|allée|allee|route|quai|passage|square|esplanade|ruelle|sentier|lotissement|résidence|residence|hameau|lieu-dit)([\s,;]|$)/i;

/** Même contrôle que `looks_like_address` de la base : un numéro de voie en tête, ou un mot de type de voie. « place » et « cours » ne comptent pas (noms de communes et de quartiers). */
export function looksLikeAddress(text: string): boolean {
  return ADDRESS_NUMBER.test(text) || ADDRESS_WORD.test(text);
}

export interface ThemeView {
  key: string;
  label: string;
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
  const themes = await ctx.db.selectFrom("outing_themes").select(["category", "theme_key", "label"]).orderBy("category").orderBy("sort_order").execute();
  const categories = (Object.keys(CATEGORY_LABEL) as OutingCategory[])
    .filter((c) => available.has(c))
    .map((category): CategoryView => ({ category, label: CATEGORY_LABEL[category], themes: themes.filter((t) => t.category === category).map((t) => ({ key: t.theme_key, label: t.label })) }));
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
