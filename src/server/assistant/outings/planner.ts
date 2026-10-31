import { sql, type Kysely } from "kysely";
import type { Ctx } from "@/server/auth/service";
import type { DB, OutingCategory, OutingDayPref, OutingFrequency } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { describeError } from "@/server/safe-log";
import { loadCalendarEvents } from "../calendar";
import { addDays } from "../series";
import { localDay, localToUtc, utcToLocal } from "../local-time";
import type { AssistantModel } from "../model";
import { claimDaily, dispatch, recipientsOf } from "../task-notices";
import { availableCategories } from "./criteria";
import { asProfile } from "./profile";
import { createProposal } from "./proposals";
import { findIdeas, outingModel, type SearchCategory } from "./search";

/**
 * Planificateur des idées de sorties (US-115 RF1, RF6, RF7, RF9, RF10). À chaque passage : pour chaque parent qui a activé ses critères, une proposition est préparée en arrière-plan
 * si sa fréquence le demande ; une proposition prête est annoncée par la notification générique « L'heure de penser à vous ». Tout est fermé tant que OUTINGS_MODE n'est pas « live ».
 */

type Db = Kysely<DB>;

/** Les propositions se préparent dans la journée, pas la nuit. */
const FIRST_HOUR = 9;
/** Délai minimal entre le jour de préparation et le jour visé (RF1). */
export const MIN_LEAD_DAYS = 4;
/** Recherche d'un jour visé : jusqu'à ce nombre de jours après le jour de préparation. */
const HORIZON_DAYS = 70;
/** Notification : pas entre 21 h et 8 h, elle part alors à 8 h (RF6). */
export const QUIET_FROM = 21;
export const QUIET_TO = 8;
export const NOTICE_TEXT = "L'heure de penser à vous";

export const isoWeekday = (day: string): number => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const WEEKDAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
export const weekdayName = (day: string): string => WEEKDAY_NAMES[isoWeekday(day) - 1];

const DAY_OF_PREF: Partial<Record<OutingDayPref, number>> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

/** Un jour convient-il aux jours préférés ? « Week-end » : samedi et dimanche ; « Soirs de semaine » : du lundi au vendredi ; ou un jour précis (S-15). */
export function matchesPreferences(day: string, prefs: OutingDayPref[]): boolean {
  const weekday = isoWeekday(day);
  return prefs.some((p) => (p === "weekend" ? weekday >= 6 : p === "weekday_evenings" ? weekday <= 5 : DAY_OF_PREF[p] === weekday));
}

/** Début de la période de la fréquence choisie : le mois ou la quinzaine. Une proposition par période (RF1). « Une par semaine » est retiré (D67) : une ancienne valeur vaut « deux par mois ». */
export function periodStart(today: string, frequency: OutingFrequency): string {
  if (frequency === "monthly") return `${today.slice(0, 7)}-01`;
  return `${today.slice(0, 7)}-${Number(today.slice(8, 10)) < 16 ? "01" : "16"}`;
}

/** Prochain jour préféré au moins 4 jours plus tard, sans RDV sur toute la journée, et sans proposition déjà faite ce jour-là (RF1, RF9). */
export async function pickTargetDay(db: Db, input: { accountId: string; userId: string; memberId: string | null; today: string; timeZone: string; prefs: OutingDayPref[] }): Promise<string | null> {
  const used = new Set(
    (await asProfile(db, input.userId, (trx) => trx.selectFrom("outing_proposals").select(sql<string>`target_date::text`.as("d")).where("user_id", "=", input.userId).execute())).map((r) => r.d),
  );
  const first = addDays(input.today, MIN_LEAD_DAYS);
  const last = addDays(input.today, HORIZON_DAYS);
  const events = await loadCalendarEvents(db, input.accountId, { from: localToUtc(first, input.timeZone), to: localToUtc(addDays(last, 1), input.timeZone) });
  const mine = events.filter((e) => e.allFamily || (input.memberId !== null && e.memberIds.includes(input.memberId)));
  for (let day = first; day <= last; day = addDays(day, 1)) {
    if (used.has(day) || !matchesPreferences(day, input.prefs)) continue;
    const from = localToUtc(day, input.timeZone);
    const to = localToUtc(addDays(day, 1), input.timeZone);
    // « Un RDV sur toute la journée » : un RDV « journée entière », ou qui couvre le jour de minuit à minuit (RF1).
    const busy = mine.some((e) => (e.allDay && e.startsAt < to && e.endsAt > from) || (e.startsAt <= from && e.endsAt >= to));
    if (!busy) return day;
  }
  return null;
}

export interface OutingsResult {
  prepared: number;
  empty: number;
  notified: number;
  failed: number;
}

interface Parent {
  userId: string;
  accountId: string;
  memberId: string | null;
}

async function enabledParents(db: Db, accountId?: string): Promise<(Parent & { timeZone: string })[]> {
  const rows = await db
    .selectFrom("outing_criteria as c")
    .innerJoin("users as u", "u.id", "c.user_id")
    .innerJoin("accounts as a", "a.id", "c.account_id")
    .leftJoin("family_members as m", "m.user_id", "u.id")
    .select(["c.user_id", "c.account_id", "m.id as member_id", "a.family_timezone"])
    .where("c.enabled", "=", true)
    .where("u.status", "in", ["active", "grace_period"])
    .where("a.status", "in", ["active", "grace_period"])
    .where((eb) => eb.or([eb("u.role", "=", "primary_user"), eb.and([eb("u.role", "=", "guest"), eb("u.guest_rank", "=", "core")])]))
    .$if(Boolean(accountId), (qb) => qb.where("c.account_id", "=", accountId!))
    .execute();
  return rows.map((r) => ({ userId: r.user_id, accountId: r.account_id, memberId: r.member_id, timeZone: r.family_timezone ?? "Europe/Paris" }));
}

/** Prépare la proposition d'un parent si sa fréquence la demande. Retourne « prepared », « empty » (rien trouvé : repère posé), ou rien. */
async function prepareFor(ctx: Ctx, parent: Parent & { timeZone: string }, model: AssistantModel): Promise<"prepared" | "empty" | null> {
  const today = localDay(ctx.now, parent.timeZone);
  const localNow = utcToLocal(ctx.now, parent.timeZone);
  if (Number(localNow.slice(11, 13)) < FIRST_HOUR) return null;
  const criteria = await asProfile(ctx.db, parent.userId, async (trx) => ({
    row: await trx.selectFrom("outing_criteria").select(["enabled", "budget_eur", "people_count", "departure_place", "mood", "frequency", sql<OutingDayPref[]>`preferred_days::text[]`.as("days")]).where("user_id", "=", parent.userId).executeTakeFirst(),
    themes: await trx.selectFrom("outing_criteria_themes as t").innerJoin("outing_themes as o", (j) => j.onRef("o.category", "=", "t.category").onRef("o.theme_key", "=", "t.theme_key")).select(["t.category", "t.theme_key", "o.label"]).where("t.user_id", "=", parent.userId).orderBy("o.sort_order").execute(),
  }));
  const c = criteria.row;
  if (!c?.enabled || c.budget_eur === null || c.people_count === null || !c.departure_place || !criteria.themes.length) return null;

  // Une tentative par jour et par parent au plus ; une seule proposition (avec idées) par période de la fréquence choisie. Une proposition écartée compte : l'écarter ne relance rien (US-116 RF3).
  const dayStart = localToUtc(today, parent.timeZone);
  const periodFrom = localToUtc(periodStart(today, c.frequency), parent.timeZone);
  const history = await asProfile(ctx.db, parent.userId, (trx) =>
    trx
      .selectFrom("outing_proposals as p")
      .select(["p.created_at", sql<boolean>`exists (select 1 from outing_proposal_ideas i where i.proposal_id = p.id)`.as("has_ideas")])
      .where("p.user_id", "=", parent.userId)
      .where("p.created_at", ">=", periodFrom)
      .execute(),
  );
  if (history.some((h) => h.has_ideas)) return null;
  if (history.some((h) => h.created_at >= dayStart)) return null;

  const target = await pickTargetDay(ctx.db, { accountId: parent.accountId, userId: parent.userId, memberId: parent.memberId, today, timeZone: parent.timeZone, prefs: c.days });
  if (!target) return null;

  // Une proposition compte comme une demande dans le plafond quotidien du profil (SG-5).
  const accepted = await sql<{ accepted: boolean }>`select register_agent_request(${parent.userId}::uuid, ${today}::date) as accepted`.execute(ctx.db);
  if (!accepted.rows[0]?.accepted) return null;
  const release = () => ctx.db.updateTable("daily_request_counters").set({ request_count: sql`greatest(request_count - 1, 0)` }).where("user_id", "=", parent.userId).where("request_date", "=", sql<Date>`${today}::date`).execute();

  const available = await availableCategories(ctx, parent.accountId);
  const categories: SearchCategory[] = [];
  for (const category of ["self", "couple", "kids", "teens"] as OutingCategory[]) {
    const picked = criteria.themes.filter((t) => t.category === category && available.has(category));
    if (picked.length) categories.push({ category, label: category, themes: picked.map((t) => ({ key: t.theme_key, label: t.label })) });
  }
  const base = { accountId: parent.accountId, userId: parent.userId, targetDate: target, budget: c.budget_eur, people: c.people_count, place: c.departure_place, now: ctx.now };
  try {
    const excluded = new Set((await sql<{ h: Buffer }>`select outing_excluded_offers as h from outing_excluded_offers(${parent.userId}::uuid)`.execute(ctx.db)).rows.map((r) => r.h.toString("hex")));
    const found = await findIdeas(model, { categories: categories.map((cat) => ({ ...cat, label: CATEGORY_NAME[cat.category] })), budget: c.budget_eur, people: c.people_count, targetDate: target, weekday: weekdayName(target), place: c.departure_place, mood: c.mood, today }, excluded);
    // Journal sans contenu : seulement le nombre d'idées, le coût estimé et le nombre de recherches (US-117 RT2).
    console.log(JSON.stringify({ event: "outing_proposal", ideas: found.ideas.length, searches: found.searches, costUsd: found.costUsd }));
    // Rien dans le budget : pas de proposition, pas de notification ; un repère pose la tentative de ce jour visé, et la suivante vise le jour préféré suivant (RF9).
    const inBudget = found.ideas.filter((i) => i.section === "in_budget");
    if (!inBudget.length) {
      await createProposal(ctx.db, { ...base, ideas: [] });
      return "empty";
    }
    await createProposal(ctx.db, { ...base, ideas: found.ideas });
    return "prepared";
  } catch (error) {
    // La recherche a échoué : la demande ne compte pas, un repère évite de réessayer toutes les 5 minutes, et la tentative suivante vise le jour préféré suivant.
    await release();
    await createProposal(ctx.db, { ...base, ideas: [] }).catch(() => undefined);
    throw error;
  }
}

const CATEGORY_NAME: Record<OutingCategory, string> = { self: "sortie perso", couple: "sortie couple", kids: "enfants de 3 à 10 ans", teens: "ados de 11 à 17 ans" };

/** Annonce les propositions prêtes qui n'ont pas encore été annoncées : texte générique, au seul parent concerné, jamais d'email, pas la nuit (RF6, D63). */
export async function sendOutingNotices(ctx: Ctx, options: { accountId?: string } = {}): Promise<{ notified: number; failed: number }> {
  const totals = { notified: 0, failed: 0 };
  const parents = await enabledParentsWithProposals(ctx.db, options.accountId);
  for (const parent of parents) {
    const hour = Number(utcToLocal(ctx.now, parent.timeZone).slice(11, 13));
    if (hour >= QUIET_FROM || hour < QUIET_TO) continue;
    const today = localDay(ctx.now, parent.timeZone);
    const recipient = (await recipientsOf(ctx.db, parent.accountId)).find((r) => r.id === parent.userId);
    if (!recipient) continue;
    const dueAt = ctx.now;
    const deadline = localToUtc(addDays(parent.targetDate, 1), parent.timeZone);
    if (ctx.now >= deadline || parent.targetDate < today) continue;
    if (!(await claimDaily(ctx, "outing_proposal", parent.userId, parent.targetDate, dueAt, deadline))) continue;
    const out = await dispatch(ctx, parent.accountId, recipient, { kind: "outing_proposal", userId: parent.userId, day: parent.targetDate, dueAt }, { body: NOTICE_TEXT, url: "/assistant", tag: "outing-proposal", subject: NOTICE_TEXT, lines: [NOTICE_TEXT] }, false);
    if (out === "sent") totals.notified += 1;
    else if (out === "failed") totals.failed += 1;
  }
  return totals;
}

/** Propositions prêtes (avec une idée à voir) dont la notification n'est ni réservée ni envoyée. */
async function enabledParentsWithProposals(db: Db, accountId?: string): Promise<(Parent & { timeZone: string; targetDate: string })[]> {
  const rows = await db
    .selectFrom("outing_proposals as p")
    .innerJoin("accounts as a", "a.id", "p.account_id")
    .select(["p.user_id", "p.account_id", sql<string>`p.target_date::text`.as("target"), "a.family_timezone"])
    .where("p.status", "=", "ready")
    .where(sql<boolean>`exists (select 1 from outing_proposal_ideas i where i.proposal_id = p.id and i.status = 'proposed')`)
    .where(sql<boolean>`not exists (select 1 from scheduled_notifications n where n.kind = 'outing_proposal' and n.recipient_user_id = p.user_id and n.subject_date = p.target_date)`)
    .$if(Boolean(accountId), (qb) => qb.where("p.account_id", "=", accountId!))
    .execute();
  return rows.map((r) => ({ userId: r.user_id, accountId: r.account_id, memberId: null, timeZone: r.family_timezone ?? "Europe/Paris", targetDate: r.target }));
}

/**
 * Un passage du planificateur (toutes les 5 minutes) : prépare les propositions dues, puis annonce les prêtes. Fermé tant que OUTINGS_MODE n'est pas « live ». Le modèle peut être
 * donné (essais) ; sinon c'est celui de l'assistant.
 */
export async function runOutings(ctx: Ctx, options: { accountId?: string; model?: AssistantModel | null } = {}): Promise<OutingsResult> {
  const totals: OutingsResult = { prepared: 0, empty: 0, notified: 0, failed: 0 };
  if (env().OUTINGS_MODE !== "live") return totals;
  const model = options.model === undefined ? outingModel() : options.model;
  if (model) {
    for (const parent of await enabledParents(ctx.db, options.accountId)) {
      try {
        const done = await prepareFor(ctx, parent, model);
        if (done === "prepared") totals.prepared += 1;
        else if (done === "empty") totals.empty += 1;
      } catch (error) {
        console.error(`Idées de sorties non préparées : ${describeError(error)}`);
        totals.failed += 1;
      }
    }
  }
  const sent = await sendOutingNotices(ctx, { accountId: options.accountId });
  return { ...totals, notified: sent.notified, failed: totals.failed + sent.failed };
}
