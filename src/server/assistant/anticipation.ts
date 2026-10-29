import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { pushConfigured, sendPush } from "@/server/push/service";
import { describeError } from "@/server/safe-log";
import { seal } from "./fields";
import { requireParent } from "./family";
import { localDay } from "./local-time";
import { FORMER_MEMBER } from "./member-chips";
import { pendingConfirmations } from "./reminders";
import { addDays, isoWeekday } from "./series";
import { notifyTaskAssigned } from "./task-notices";

/**
 * Anticipation (US-102) : le catalogue d'échéances types devient, famille par famille, des questions à trois choix (AT-6) : « Oui, c'est fait ou prévu », « Non, l'ajouter à mes tâches » (une tâche
 * est créée) ou « Me le rappeler dans… ». La sélection suit des règles fixes, sans appel au modèle ni donnée envoyée à l'agent (RT2, D31). La base garde les règles qui comptent : la réponse
 * est atomique (`answer_anticipation_question`), au plus 5 questions par semaine (`pick_weekly_questions`, AT-7), rien quand le catalogue est désactivé. Réservé aux parents (D26).
 */

type Db = Kysely<DB>;

// ---------------------------------------------------------------------------------------------------------------------------
// Périodes
// ---------------------------------------------------------------------------------------------------------------------------

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");
const dateOf = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;

export interface Period {
  start: string;
  end: string;
}

/** La période de l'échéance qui commence l'année `year` ; elle peut déborder sur l'année suivante (novembre à février). */
export function periodOf(item: { periodStart: { month: number; day: number }; periodEnd: { month: number; day: number } }, year: number): Period {
  const startsFirst = item.periodEnd.month > item.periodStart.month || (item.periodEnd.month === item.periodStart.month && item.periodEnd.day >= item.periodStart.day);
  return { start: dateOf(year, item.periodStart.month, item.periodStart.day), end: dateOf(startsFirst ? year : year + 1, item.periodEnd.month, item.periodEnd.day) };
}

const addYears = (day: string, n: number) => dateOf(Number(day.slice(0, 4)) + n, Number(day.slice(5, 7)), Number(day.slice(8, 10)));
const lastDayOfMonth = (day: string) => dateOf(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 31);
/** Lundi de la semaine du jour donné. */
export const mondayOf = (day: string) => addDays(day, 1 - isoWeekday(day));

/** Âge en mois à ce jour, d'après le mois et l'année de naissance (le jour n'est jamais connu, D54). */
export function ageInMonths(birthYear: number, birthMonth: number, today: string): number {
  return (Number(today.slice(0, 4)) - birthYear) * 12 + (Number(today.slice(5, 7)) - birthMonth);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Sélection des échéances (RF3)
// ---------------------------------------------------------------------------------------------------------------------------

interface Item {
  id: number;
  code: string;
  perMember: boolean;
  periodStart: { month: number; day: number };
  periodEnd: { month: number; day: number };
  leadDays: number;
  everyNYears: number;
  targetRole: "parent" | "child" | "other" | null;
  minAge: number | null;
  maxAge: number | null;
  situationKey: string | null;
  situationValue: boolean | null;
  isMedical: boolean;
}

async function activeItems(db: Db): Promise<Item[]> {
  const rows = await db.selectFrom("anticipation_catalog_items").selectAll().where("active", "=", true).execute();
  return rows.map((r) => ({
    id: r.id, code: r.code, perMember: r.per_member, periodStart: { month: r.period_start_month, day: r.period_start_day }, periodEnd: { month: r.period_end_month, day: r.period_end_day },
    leadDays: r.lead_days, everyNYears: r.every_n_years, targetRole: r.target_role, minAge: r.min_age_months, maxAge: r.max_age_months, situationKey: r.situation_key,
    situationValue: r.situation_required_value, isMedical: r.is_medical,
  }));
}

interface Member {
  id: string;
  firstName: string | null;
  role: "parent" | "child" | "other";
  birthYear: number | null;
  birthMonth: number | null;
}

async function activeMembers(db: Db, accountId: string): Promise<Member[]> {
  const rows = await db.selectFrom("family_members").select(["id", "first_name", "role", "birth_year", "birth_month"]).where("account_id", "=", accountId).where("archived_at", "is", null).where("anonymized_at", "is", null).orderBy("role").orderBy("alias_number").execute();
  return rows.map((r) => ({ id: r.id, firstName: r.first_name, role: r.role, birthYear: r.birth_year, birthMonth: r.birth_month }));
}

const ageConditioned = (i: Item) => i.minAge !== null || i.maxAge !== null;
const roleFits = (i: Item, m: Member) => i.targetRole === null || i.targetRole === m.role;

/**
 * Les échéances à poser à cette famille ce mois-ci : le délai d'anticipation est ouvert au 1er du mois (ou la période commence ce mois-ci) et la période n'est pas finie ; la situation de la famille et le membre
 * y correspondent ; une échéance qui revient tous les N ans n'est pas reposée avant. Une échéance liée à l'âge exige le mois et l'année de naissance (RF7).
 */
export async function dueQuestions(db: Db, accountId: string, today: string): Promise<{ item: Item; member: Member | null; period: Period }[]> {
  const items = await activeItems(db);
  if (!items.length) return [];
  const members = await activeMembers(db, accountId);
  const answers = new Map((await db.selectFrom("family_situation_answers").select(["situation_key", "answer"]).where("account_id", "=", accountId).execute()).map((a) => [a.situation_key, a.answer]));
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = lastDayOfMonth(today);
  const out: { item: Item; member: Member | null; period: Period }[] = [];
  const earlier = await db.selectFrom("anticipation_questions").select(["catalog_item_id", "member_id", sql<string>`period_start::text`.as("start")]).where("account_id", "=", accountId).execute();
  for (const item of items) {
    if (item.situationKey !== null && answers.get(item.situationKey) !== item.situationValue) continue;
    const year = Number(today.slice(0, 4));
    for (const y of [year - 1, year, year + 1]) {
      const period = periodOf(item, y);
      // Le 1er du mois (RF3) : le délai d'anticipation est ouvert, ou la période commence ce mois-ci (une échéance courte n'est ainsi jamais manquée).
      const opened = addDays(period.start, -item.leadDays) <= monthStart || (period.start >= monthStart && period.start <= monthEnd);
      if (!opened || period.end < today) continue;
      const targets: (Member | null)[] = item.perMember
        ? members.filter((m) => roleFits(item, m) && (!ageConditioned(item) || (m.birthYear !== null && m.birthMonth !== null && ageFits(item, ageInMonths(m.birthYear, m.birthMonth, today)))))
        : [null];
      for (const member of targets) {
        if (item.everyNYears > 1) {
          const since = addYears(period.start, -item.everyNYears);
          if (earlier.some((q) => q.catalog_item_id === item.id && q.member_id === (member?.id ?? null) && q.start > since && q.start < period.start)) continue;
        }
        out.push({ item, member, period });
      }
    }
  }
  return out;
}

const ageFits = (i: Item, months: number) => (i.minAge === null || months >= i.minAge) && (i.maxAge === null || months <= i.maxAge);

export interface SelectionResult {
  created: number;
  presented: number;
}

/**
 * Pose les questions dues (sans doublon : une par échéance, membre et période), puis laisse la base choisir celles de la semaine, 5 au plus (AT-7). Sans effet quand le catalogue est
 * désactivé pour la famille (la base refuse l'insertion et la sélection).
 */
export async function selectQuestions(ctx: Ctx, accountId: string, timeZone: string): Promise<SelectionResult> {
  const today = localDay(ctx.now, timeZone);
  let created = 0;
  for (const { item, member, period } of await dueQuestions(ctx.db, accountId, today)) {
    const row = await ctx.db
      .insertInto("anticipation_questions")
      .values({ account_id: accountId, origin: "catalog", catalog_item_id: item.id, member_id: member?.id ?? null, period_start: period.start, period_end: period.end })
      .onConflict((oc) => oc.columns(["account_id", "catalog_item_id", "member_id", "period_start"]).where(sql<boolean>`origin = 'catalog'`).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (row) created += 1;
  }
  const picked = await sql<{ pick_weekly_questions: string }>`select pick_weekly_questions(${accountId}::uuid, ${mondayOf(today)}::date)`.execute(ctx.db);
  return { created, presented: picked.rows.length };
}

export interface AnticipationResult {
  accounts: number;
  created: number;
  notified: number;
}

/** « 3 échéances à anticiper ce mois-ci » : une notification aux parents quand de nouvelles questions viennent d'être posées (RF3). */
export const monthlyBody = (n: number) => `${n} échéance${n > 1 ? "s" : ""} à anticiper ce mois-ci`;

/** Un passage du planificateur : sélection de chaque famille, puis avis aux parents des questions nouvellement posées. Sans danger à relancer. */
export async function runAnticipation(ctx: Ctx, options: { accountId?: string } = {}): Promise<AnticipationResult> {
  const totals: AnticipationResult = { accounts: 0, created: 0, notified: 0 };
  const accounts = await ctx.db
    .selectFrom("accounts")
    .select(["id", "family_timezone"])
    .where("status", "in", ["active", "grace_period"])
    .$if(Boolean(options.accountId), (qb) => qb.where("id", "=", options.accountId!))
    .execute();
  for (const account of accounts) {
    try {
      const { created } = await selectQuestions(ctx, account.id, account.family_timezone ?? "Europe/Paris");
      totals.accounts += 1;
      totals.created += created;
      if (created > 0 && pushConfigured()) {
        const parents = await ctx.db.selectFrom("users").select("id").where("account_id", "=", account.id).where("status", "in", ["active", "grace_period"]).where((eb) => eb.or([eb("role", "=", "primary_user"), eb.and([eb("role", "=", "guest"), eb("guest_rank", "=", "core")])])).execute();
        const badge = await pendingConfirmations(ctx.db, account.id, ctx.now);
        for (const p of parents) {
          const sent = await sendPush(ctx, p.id, { title: "Assistant Famille", body: monthlyBody(created), url: "/assistant#anticiper", tag: `anticipation-${localDay(ctx.now, account.family_timezone ?? "Europe/Paris").slice(0, 7)}`, badge });
          if (sent.delivered > 0) totals.notified += 1;
        }
      }
    } catch (error) {
      console.error(`Anticipation (foyer) : ${describeError(error)}`);
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture : la section « À anticiper »
// ---------------------------------------------------------------------------------------------------------------------------

export interface QuestionView {
  id: string;
  /** « Avez-vous prévu : Contrôle technique de la voiture ? » ; le prénom du membre est mis à l'affichage, jamais conservé dans la question (RT3). */
  text: string;
  medical: boolean;
  member: { id: string; firstName: string } | null;
  period: Period;
}

export interface SituationAnswer {
  key: string;
  label: string;
  answer: boolean | null;
}

export interface AnticipationView {
  enabled: boolean;
  questions: QuestionView[];
  /** Membres dont il manque le mois et l'année de naissance pour des rappels liés à l'âge (RF7). */
  birthCards: { memberId: string; firstName: string }[];
  situation: SituationAnswer[];
}

const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** Texte de la question : le libellé du catalogue gardé par la question, avec le prénom du membre remplacé au dernier moment. */
export function questionText(label: string, medical: boolean, firstName: string | null): string {
  const named = label.replace(/\{membre\}/g, firstName ?? "la personne concernée");
  return medical ? `Pensez-vous à : ${lowerFirst(named)} ?` : `Avez-vous prévu : ${lowerFirst(named)} ?`;
}

async function presented(db: Db, accountId: string, today: string): Promise<QuestionView[]> {
  const rows = await db
    .selectFrom("anticipation_questions as q")
    .innerJoin("anticipation_catalog_items as c", "c.id", "q.catalog_item_id")
    .leftJoin("family_members as m", "m.id", "q.member_id")
    .select(["q.id", "q.label_template", "c.is_medical", "m.id as member_id", "m.first_name", "m.anonymized_at", sql<string>`q.period_start::text`.as("start"), sql<string>`q.period_end::text`.as("end")])
    .where("q.account_id", "=", accountId)
    .where("q.status", "=", "pending")
    .where("q.presented_week", "=", sql<Date>`${mondayOf(today)}::date`)
    .orderBy("q.period_end")
    .orderBy("q.created_at")
    .execute();
  return rows.map((r) => ({
    id: r.id, text: questionText(r.label_template!, r.is_medical, r.member_id ? (r.first_name ?? FORMER_MEMBER) : null), medical: r.is_medical,
    member: r.member_id ? { id: r.member_id, firstName: r.first_name ?? FORMER_MEMBER } : null, period: { start: r.start, end: r.end },
  }));
}

/** Les questions présentées cette semaine, sans rien poser de nouveau (point de la semaine). */
export async function presentedQuestions(db: Db, accountId: string, timeZone: string, now: Date): Promise<QuestionView[]> {
  return presented(db, accountId, localDay(now, timeZone));
}

async function settingsOf(db: Db, accountId: string): Promise<{ enabled: boolean; situation: SituationAnswer[] }> {
  const row = await db.selectFrom("family_settings").select("anticipation_enabled").where("account_id", "=", accountId).executeTakeFirst();
  const answers = new Map((await db.selectFrom("family_situation_answers").select(["situation_key", "answer"]).where("account_id", "=", accountId).execute()).map((a) => [a.situation_key, a.answer]));
  const questions = await db.selectFrom("family_situation_questions").select(["situation_key", "label"]).orderBy("sort_order").execute();
  return { enabled: row?.anticipation_enabled ?? true, situation: questions.map((q) => ({ key: q.situation_key, label: q.label, answer: answers.get(q.situation_key) ?? null })) };
}

/**
 * La section « À anticiper » (parents seulement, RF8) : les questions de la semaine encore sans réponse (celle qu'un parent a traitée n'y est plus pour l'autre), les cartes « Indiquez le
 * mois et l'année de naissance » et le questionnaire de situation. La sélection est refaite à l'ouverture : elle ne pose jamais deux fois la même question.
 */
export async function getAnticipation(ctx: Ctx, session: SessionContext): Promise<AnticipationView> {
  const accountId = requireParent(session);
  const timeZone = (await ctx.db.selectFrom("accounts").select("family_timezone").where("id", "=", accountId).executeTakeFirst())?.family_timezone ?? "Europe/Paris";
  await selectQuestions(ctx, accountId, timeZone);
  const today = localDay(ctx.now, timeZone);
  const settings = await settingsOf(ctx.db, accountId);
  const items = settings.enabled ? (await activeItems(ctx.db)).filter((i) => i.perMember && ageConditioned(i)) : [];
  const birthCards = (await activeMembers(ctx.db, accountId))
    .filter((m) => (m.birthYear === null || m.birthMonth === null) && m.firstName && items.some((i) => roleFits(i, m)))
    .map((m) => ({ memberId: m.id, firstName: m.firstName! }));
  return { enabled: settings.enabled, questions: settings.enabled ? await presented(ctx.db, accountId, today) : [], birthCards, situation: settings.situation };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Réponse (RF6)
// ---------------------------------------------------------------------------------------------------------------------------

export interface AnswerInput {
  answer: "done_or_planned" | "todo" | "remind_later";
  /** 1, 3 ou 6 mois (« Me le rappeler dans… »), sans dépasser la fin de la période. */
  remindMonths?: number;
  /** « Non, l'ajouter à mes tâches » : la personne à qui confier la tâche créée (US-96), facultative. */
  assigneeId?: string | null;
}

/**
 * Enregistre la réponse d'un parent (la base fait tout en une transaction : réponse, état de la question, tâche créée, sans double création). « Non, l'ajouter à mes tâches » crée une tâche seule,
 * due à la fin de la période (jamais dans le passé). La réponse d'un parent vaut pour la famille : l'autre parent reçoit « déjà traitée ».
 */
export async function answerQuestion(ctx: Ctx, session: SessionContext, id: string, input: AnswerInput): Promise<{ taskId: string | null }> {
  const accountId = requireParent(session);
  if (!["done_or_planned", "todo", "remind_later"].includes(input.answer)) throw new Rejection("invalid_answer", "Cette réponse n'existe pas.", 422);
  if (input.answer === "remind_later" && ![1, 3, 6].includes(Number(input.remindMonths))) throw new Rejection("invalid_delay", "Choisissez 1, 3 ou 6 mois.", 422);
  const row = await ctx.db
    .selectFrom("anticipation_questions as q")
    .innerJoin("anticipation_catalog_items as c", "c.id", "q.catalog_item_id")
    .leftJoin("family_members as m", "m.id", "q.member_id")
    .select(["q.label_template", "q.status", "m.first_name", sql<string>`q.period_end::text`.as("end")])
    .where("q.id", "=", id)
    .where("q.account_id", "=", accountId)
    .executeTakeFirst();
  if (!row) throw new Rejection("not_found", "Cette question n'existe plus.", 404);
  if (!["pending", "snoozed"].includes(row.status)) throw new Rejection("already_handled", "Cette question a déjà reçu une réponse.", 409);
  const timeZone = (await ctx.db.selectFrom("accounts").select("family_timezone").where("id", "=", accountId).executeTakeFirst())?.family_timezone ?? "Europe/Paris";
  let title: Buffer | null = null;
  let due: string | null = null;
  if (input.answer === "todo") {
    const label = row.label_template!.replace(/\{membre\}/g, row.first_name ?? FORMER_MEMBER);
    title = seal(`À prévoir : ${lowerFirst(label)}`.slice(0, 100));
    const today = localDay(ctx.now, timeZone);
    due = row.end < today ? today : row.end;
    if (input.assigneeId) {
      const member = await ctx.db.selectFrom("family_members").select("id").where("id", "=", input.assigneeId).where("account_id", "=", accountId).where("archived_at", "is", null).executeTakeFirst();
      if (!member) throw new Rejection("invalid_assignee", "Une tâche ne peut être assignée qu'à un membre actif de la famille.", 422);
    }
  }
  try {
    const { rows } = await sql<{ applied: boolean; task_id: string | null }>`
      select * from answer_anticipation_question(${id}::uuid, ${input.answer}::question_answer, ${session.user.id}::uuid, ${input.answer === "remind_later" ? Number(input.remindMonths) : null}::smallint,
        ${title}::bytea, ${input.answer === "todo" ? (input.assigneeId ?? null) : null}::uuid, ${due}::date)`.execute(ctx.db);
    if (!rows[0]?.applied) throw new Rejection("already_handled", "Cette question a déjà reçu une réponse.", 409);
    const taskId = rows[0].task_id;
    if (taskId && input.assigneeId) await notifyTaskAssigned(ctx, taskId, session.user.id);
    return { taskId };
  } catch (error) {
    if (error instanceof Rejection) throw error;
    const e = error as { code?: string; message?: string };
    if (e.code === "23514") throw new Rejection("invalid_answer", e.message ?? "Réponse refusée.", 422);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Réglages (RF2, RF9)
// ---------------------------------------------------------------------------------------------------------------------------

/** Active ou désactive le catalogue pour la famille (chaque parent peut le faire). Désactivé, plus aucune question n'est posée et celles en attente ne s'affichent plus. */
export async function setAnticipationEnabled(ctx: Ctx, session: SessionContext, enabled: boolean): Promise<{ enabled: boolean }> {
  const accountId = requireParent(session);
  if (typeof enabled !== "boolean") throw new Rejection("invalid_setting", "Ce réglage est invalide.", 422);
  await ctx.db
    .insertInto("family_settings")
    .values({ account_id: accountId, anticipation_enabled: enabled, updated_by_user_id: session.user.id })
    .onConflict((oc) => oc.column("account_id").doUpdateSet({ anticipation_enabled: enabled, updated_by_user_id: session.user.id }))
    .execute();
  return { enabled };
}

/** Répond (ou efface la réponse) à une question du questionnaire « Situation de la famille » ; facultatif, sans réponse seules les échéances sans condition sont posées (RF2). */
export async function setSituationAnswer(ctx: Ctx, session: SessionContext, key: string, answer: boolean | null): Promise<SituationAnswer[]> {
  const accountId = requireParent(session);
  const known = await ctx.db.selectFrom("family_situation_questions").select("situation_key").where("situation_key", "=", key).executeTakeFirst();
  if (!known) throw new Rejection("invalid_setting", "Cette question n'existe pas.", 422);
  if (answer === null) await ctx.db.deleteFrom("family_situation_answers").where("account_id", "=", accountId).where("situation_key", "=", key).execute();
  else {
    await ctx.db
      .insertInto("family_situation_answers")
      .values({ account_id: accountId, situation_key: key, answer, answered_by_user_id: session.user.id })
      .onConflict((oc) => oc.columns(["account_id", "situation_key"]).doUpdateSet({ answer, answered_by_user_id: session.user.id, answered_at: ctx.now }))
      .execute();
  }
  return (await settingsOf(ctx.db, accountId)).situation;
}

