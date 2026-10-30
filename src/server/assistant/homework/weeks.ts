import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB, HomeworkActivityCategory, HomeworkLevel } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { seal, open } from "../fields";
import { requireParent } from "../family";
import { addDays } from "../series";
import { taskViewer, type TaskViewer } from "../tasks";
import { ACTIVITY_CATEGORIES, activityContent, cardUrl, categoryLabel, exerciseStatement, LEVEL_LABEL } from "./catalog";
import { homeworkEnabled, levelForAge } from "./settings";

/**
 * Semaines de devoirs (US-119). Les règles de progression et la construction de la semaine sont appliquées ici, par le code, et non par le modèle (RT3) ;
 * la base les impose en plus (déclencheurs `homework_*`). Le parent décide : rien n'est placé sans son choix (RF3).
 *
 * Jours : 1 = lundi … 7 = dimanche (ISO). Un exercice est désigné par son manuel, son niveau et son numéro ; une activité par son identifiant de catalogue ;
 * une activité du parent par son titre libre, chiffré.
 */

type Db = Kysely<DB>;

export const MAX_CUSTOM_TITLE = 100;
/** Les exercices se proposent par blocs de 5 consécutifs (skill planning-devoirs-hebdo). */
export const BLOCK_SIZE = 5;
/** Une semaine ne dépasse pas ce nombre d'éléments par enfant : garde-fou contre une saisie démesurée. */
const MAX_ITEMS_PER_CHILD = 80;

const fail = (code: string, message: string, status = 422, details?: unknown) => new Rejection(code, message, status, details);

// ---------------------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------------------

const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/** 1 = lundi … 7 = dimanche. */
export const isoWeekday = (day: string): number => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
export const mondayOf = (day: string): string => addDays(day, 1 - isoWeekday(day));

/** Les lundis à venir proposés au parent : la semaine en cours, puis les quatre suivantes (RF2). */
export function upcomingMondays(today: string, count = 5): string[] {
  const first = mondayOf(today);
  return Array.from({ length: count }, (_, i) => addDays(first, 7 * i));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Progression d'un enfant
// ---------------------------------------------------------------------------------------------------------------------------

interface ChildRow {
  memberId: string;
  firstName: string;
  age: number;
  level: HomeworkLevel;
}

async function loadChildren(db: Db, accountId: string, memberIds?: string[]): Promise<ChildRow[]> {
  const rows = await db
    .selectFrom("homework_children as h")
    .innerJoin("family_members as m", "m.id", "h.member_id")
    .select(["h.member_id", "m.first_name", "h.homework_age"])
    .where("h.account_id", "=", accountId)
    .where("m.archived_at", "is", null)
    .$if(Boolean(memberIds), (qb) => qb.where("h.member_id", "in", memberIds!))
    .orderBy("m.alias_number")
    .execute();
  return rows.map((r) => ({ memberId: r.member_id, firstName: r.first_name ?? "", age: r.homework_age, level: levelForAge(r.homework_age) }));
}

export interface Progress {
  total: number;
  validated: number;
  /** La moitié du niveau est validée sur photos : un manuel étranger est débloqué (RF7). */
  foreignUnlocked: boolean;
  /** Tous les exercices France du niveau sont validés : plusieurs manuels étrangers sont possibles dans une semaine, et l'aide propose d'augmenter l'âge des devoirs. */
  franceDone: boolean;
}

export async function progressOf(db: Db, memberId: string, level: HomeworkLevel): Promise<Progress> {
  const { rows } = await sql<{ total: number; validated: number; unlocked: boolean; done: boolean }>`
    select p.total, p.validated, homework_foreign_unlocked(${memberId}::uuid, ${level}::homework_level) as unlocked, homework_france_level_done(${memberId}::uuid, ${level}::homework_level) as done
      from homework_level_progress(${memberId}::uuid, ${level}::homework_level) p`.execute(db);
  const r = rows[0];
  return { total: r?.total ?? 0, validated: r?.validated ?? 0, foreignUnlocked: Boolean(r?.unlocked), franceDone: Boolean(r?.done) };
}

/** Manuel étranger déjà proposé à cet enfant pour cette semaine, s'il y en a un. */
async function foreignOfWeek(db: Db, weekId: string | null, memberId: string): Promise<string[]> {
  if (!weekId) return [];
  const rows = await db.selectFrom("homework_week_foreign_books").select("textbook_key").where("week_id", "=", weekId).where("member_id", "=", memberId).execute();
  return rows.map((r) => r.textbook_key);
}

/**
 * Manuel étranger proposé pour la semaine : un seul (une « surprise »), le moins utilisé par l'enfant jusqu'ici ; tous si les exercices France du niveau sont validés.
 * Vide tant que la moitié du niveau n'est pas validée sur photos : rien n'en est alors dit ni montré (RF7).
 */
async function foreignProposal(db: Db, member: ChildRow, progress: Progress, weekId: string | null): Promise<string[]> {
  if (!progress.foreignUnlocked) return [];
  const already = await foreignOfWeek(db, weekId, member.memberId);
  if (already.length && !progress.franceDone) return already;
  const books = await db.selectFrom("homework_textbooks").select("textbook_key").where("is_foreign", "=", true).orderBy("sort_order").execute();
  if (progress.franceDone) return books.map((b) => b.textbook_key);
  const usage = await db
    .selectFrom("homework_week_items as i")
    .innerJoin("homework_exercises as e", "e.id", "i.exercise_id")
    .select(["e.textbook_key", sql<number>`count(*)::int`.as("n")])
    .where("i.member_id", "=", member.memberId)
    .groupBy("e.textbook_key")
    .execute();
  const used = new Map(usage.map((u) => [u.textbook_key, u.n]));
  const best = [...books].sort((a, b) => (used.get(a.textbook_key) ?? 0) - (used.get(b.textbook_key) ?? 0))[0];
  return best ? [best.textbook_key] : [];
}

// ---------------------------------------------------------------------------------------------------------------------------
// Options proposées au parent (RF2)
// ---------------------------------------------------------------------------------------------------------------------------

export type ElementState = "free" | "planned" | "done" | "validated";

export interface MathsBlock {
  textbook: string;
  textbookLabel: string;
  /** Un manuel étranger est présenté comme une nouveauté, jamais avant d'être proposé. */
  novelty: boolean;
  numbers: number[];
  from: number;
  to: number;
  themes: string;
  /** « validé 3/5 », « prévu 2/5 » : l'avancement du bloc, sans jugement (AT-9). */
  state: ElementState;
  counts: { validated: number; done: number; planned: number };
}

export interface ActivityOption {
  activityId: string;
  title: string;
  ageLabel: string;
  needsAdult: boolean;
  description: string;
  state: ElementState;
  card: string | null;
}

export interface ChildOptions {
  memberId: string;
  firstName: string;
  homeworkAge: number;
  level: HomeworkLevel;
  levelLabel: string;
  progress: Progress;
  blocks: MathsBlock[];
  /** Proposition d'augmenter l'âge des devoirs d'un an (RF7) : tous les exercices France du niveau sont validés sur photos. L'âge ne change que si le parent le décide. */
  suggestOlderAge: boolean;
}

async function elementStates(db: Db, memberId: string): Promise<{ validated: Set<string>; done: Set<string>; planned: Set<string>; activitiesDone: Set<string>; activitiesPlanned: Set<string> }> {
  const validated = await db.selectFrom("homework_exercise_validations").select("exercise_id").where("member_id", "=", memberId).execute();
  const items = await db.selectFrom("homework_week_items").select(["exercise_id", "activity_id", "checked_at"]).where("member_id", "=", memberId).execute();
  const set = (values: (string | null)[]) => new Set(values.filter((x): x is string => x !== null).map(String));
  return {
    validated: set(validated.map((v) => v.exercise_id)),
    done: set(items.filter((i) => i.checked_at).map((i) => i.exercise_id)),
    planned: set(items.map((i) => i.exercise_id)),
    activitiesDone: set(items.filter((i) => i.checked_at).map((i) => i.activity_id)),
    activitiesPlanned: set(items.map((i) => i.activity_id)),
  };
}

const stateOf = (counts: { validated: number; done: number; planned: number }, size: number): ElementState =>
  counts.validated === size ? "validated" : counts.done === size ? "done" : counts.planned === size ? "planned" : counts.validated + counts.done + counts.planned > 0 ? "planned" : "free";

/** Blocs d'exercices du niveau de l'enfant : France toujours, et un manuel étranger seulement s'il est débloqué (RF2, RF7). */
export async function childOptions(db: Db, accountId: string, memberId: string, weekStart: string | null = null): Promise<ChildOptions> {
  const [member] = await loadChildren(db, accountId, [memberId]);
  if (!member) throw fail("not_found", "Cet enfant n'est pas suivi par l'aide Devoirs : indiquez son âge des devoirs dans les réglages.", 404);
  const week = weekStart ? await db.selectFrom("homework_weeks").select("id").where("account_id", "=", accountId).where(sql<boolean>`week_start = ${weekStart}::date`).executeTakeFirst() : undefined;
  const progress = await progressOf(db, memberId, member.level);
  const books = ["france", ...(await foreignProposal(db, member, progress, week?.id ?? null))];
  const states = await elementStates(db, memberId);
  const labels = new Map((await db.selectFrom("homework_textbooks").select(["textbook_key", "label"]).execute()).map((b) => [b.textbook_key, b.label]));
  const blocks: MathsBlock[] = [];
  for (const book of books) {
    const exercises = await db.selectFrom("homework_exercises").select(["id", "number", "theme"]).where("textbook_key", "=", book).where("level", "=", member.level).orderBy("number").execute();
    for (let i = 0; i < exercises.length; i += BLOCK_SIZE) {
      const chunk = exercises.slice(i, i + BLOCK_SIZE);
      const counts = {
        validated: chunk.filter((x) => states.validated.has(String(x.id))).length,
        done: chunk.filter((x) => states.done.has(String(x.id))).length,
        planned: chunk.filter((x) => states.planned.has(String(x.id))).length,
      };
      blocks.push({
        textbook: book,
        textbookLabel: labels.get(book) ?? book,
        novelty: book !== "france",
        numbers: chunk.map((x) => x.number),
        from: chunk[0].number,
        to: chunk[chunk.length - 1].number,
        themes: [...new Set(chunk.map((x) => x.theme))].join(" ; "),
        state: stateOf(counts, chunk.length),
        counts,
      });
    }
  }
  return { memberId, firstName: member.firstName, homeworkAge: member.age, level: member.level, levelLabel: LEVEL_LABEL[member.level], progress, blocks, suggestOlderAge: progress.franceDone && member.age < 12 };
}

/** Activités d'une catégorie à l'âge des devoirs, à un an près : les non faites d'abord, puis les plus proches de l'âge (RF2). */
export async function activityOptions(db: Db, accountId: string, memberId: string, category: HomeworkActivityCategory, limit = 4): Promise<ActivityOption[]> {
  const [member] = await loadChildren(db, accountId, [memberId]);
  if (!member) throw fail("not_found", "Cet enfant n'est pas suivi par l'aide Devoirs.", 404);
  const rows = await db
    .selectFrom("homework_activities")
    .select(["id", "title", "age", "needs_adult", "card_ref"])
    .where("category", "=", category)
    .where("age", ">=", member.age - 1)
    .where("age", "<=", member.age + 1)
    .execute();
  const states = await elementStates(db, memberId);
  const byTitle = new Map<string, (typeof rows)[number] & { ages: number[] }>();
  for (const r of rows) {
    const known = byTitle.get(r.title);
    if (known) known.ages.push(r.age);
    else byTitle.set(r.title, { ...r, ages: [r.age] });
  }
  const options = [...byTitle.values()].map((r): ActivityOption & { distance: number } => {
    const content = activityContent(category, r.title);
    const state: ElementState = states.activitiesDone.has(String(r.id)) ? "done" : states.activitiesPlanned.has(String(r.id)) ? "planned" : "free";
    const ages = content ? undefined : r.ages;
    return {
      activityId: String(r.id), title: r.title, ageLabel: ages ? `${Math.min(...ages)} ans` : "", needsAdult: r.needs_adult, description: content?.description ?? "", state, card: cardUrl(r.card_ref),
      distance: Math.abs(r.age - member.age),
    };
  });
  options.sort((a, b) => Number(a.state !== "free") - Number(b.state !== "free") || a.distance - b.distance || a.title.localeCompare(b.title, "fr"));
  return options.slice(0, limit).map((o) => ({ activityId: o.activityId, title: o.title, ageLabel: o.ageLabel, needsAdult: o.needsAdult, description: o.description, state: o.state, card: o.card }));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Préparer une semaine (RF4)
// ---------------------------------------------------------------------------------------------------------------------------

export type ItemInput =
  | { kind: "exercises"; textbook: string; numbers: number[]; days: number[] }
  | { kind: "activity"; activityId: string; days: number[] }
  | { kind: "custom"; title: string; days: number[] };

export interface WeekInput {
  weekStart: string;
  workDays: number[];
  children: { memberId: string; items: ItemInput[] }[];
}

const validDays = (days: unknown): days is number[] => Array.isArray(days) && days.length > 0 && days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) && new Set(days).size === days.length;

async function viewerOf(ctx: Ctx, session: SessionContext): Promise<TaskViewer> {
  requireParent(session);
  const v = await taskViewer(ctx, session);
  if (!(await homeworkEnabled(ctx, v.accountId))) throw fail("homework_disabled", "L'aide Devoirs n'est pas activée pour la famille.", 409);
  return v;
}

interface PlannedItem {
  memberId: string;
  day: string;
  exerciseId?: string;
  activityId?: string;
  customTitle?: string;
}

/** Les éléments à enregistrer, contrôlés : jours de travail de la semaine, niveau de l'enfant, manuels permis, aucun doublon. Les manuels étrangers choisis sont rendus à part. */
async function planItems(db: Db, accountId: string, weekStart: string, workDays: number[], input: { memberId: string; items: ItemInput[] }, weekId: string | null): Promise<{ items: PlannedItem[]; foreign: string[] }> {
  const [member] = await loadChildren(db, accountId, [input.memberId]);
  if (!member) throw fail("not_found", "Un enfant de la semaine n'est pas suivi par l'aide Devoirs.", 404);
  const progress = await progressOf(db, member.memberId, member.level);
  const permitted = new Set(["france", ...(await foreignProposal(db, member, progress, weekId))]);
  const items: PlannedItem[] = [];
  const seen = new Set<string>();
  const foreign = new Set<string>();
  const push = (item: PlannedItem, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  for (const item of input.items) {
    if (!validDays(item.days) || item.days.some((d) => !workDays.includes(d))) throw fail("invalid_day", "Chaque élément se place sur un jour de travail de la semaine.");
    const dayOf = (iso: number) => addDays(weekStart, iso - 1);
    if (item.kind === "exercises") {
      if (!permitted.has(item.textbook)) throw fail("book_not_allowed", "Ce manuel n'est pas proposé à cet enfant cette semaine.");
      if (item.textbook !== "france") foreign.add(item.textbook);
      const numbers = [...new Set(item.numbers)];
      const found = numbers.length ? await db.selectFrom("homework_exercises").select(["id", "number"]).where("textbook_key", "=", item.textbook).where("level", "=", member.level).where("number", "in", numbers).execute() : [];
      if (found.length !== numbers.length) throw fail("invalid_exercise", "Un exercice choisi n'est pas du niveau de cet enfant.");
      for (const e of found) for (const d of item.days) push({ memberId: member.memberId, day: dayOf(d), exerciseId: String(e.id) }, `e${e.id}:${d}`);
    } else if (item.kind === "activity") {
      const activity = await db.selectFrom("homework_activities").select(["id", "title", "category", "age"]).where("id", "=", item.activityId).executeTakeFirst();
      if (!activity || Math.abs(activity.age - member.age) > 1) throw fail("invalid_activity", "Une activité choisie ne convient pas à l'âge des devoirs de cet enfant.");
      for (const d of item.days) push({ memberId: member.memberId, day: dayOf(d), activityId: String(activity.id) }, `a${activity.id}:${d}`);
    } else {
      const title = item.title.trim();
      if (!title || title.length > MAX_CUSTOM_TITLE) throw fail("invalid_title", `Le titre d'une activité va de 1 à ${MAX_CUSTOM_TITLE} caractères.`);
      for (const d of item.days) push({ memberId: member.memberId, day: dayOf(d), customTitle: title }, `c${title.toLowerCase()}:${d}`);
    }
  }
  // Au plus deux manuels par semaine : France et un seul manuel étranger, sauf si tous les exercices France du niveau sont validés (RF7).
  if (foreign.size > 1 && !progress.franceDone) throw fail("too_many_books", "Une semaine compte au plus deux manuels : France et un seul manuel étranger.");
  return { items, foreign: [...foreign] };
}

async function insertItems(trx: Db, accountId: string, weekId: string, planned: PlannedItem[]): Promise<void> {
  for (const item of planned) {
    await trx
      .insertInto("homework_week_items")
      .values({
        week_id: weekId, account_id: accountId, member_id: item.memberId, day: item.day,
        exercise_id: item.exerciseId ?? null, activity_id: item.activityId ?? null, custom_title: item.customTitle ? seal(item.customTitle) : null,
      })
      .execute();
  }
}

const itemsLabel = (n: number) => `${n} ${n > 1 ? "éléments" : "élément"}`;

/** Une tâche « Devoirs — [prénom] (N éléments) » par enfant et par jour de travail ayant des éléments, assignée à l'enfant et liée à la semaine (RF4). */
export async function syncHomeworkTasks(trx: Db, accountId: string, weekId: string, createdBy: string | null): Promise<void> {
  const groups = await trx
    .selectFrom("homework_week_items as i")
    .innerJoin("family_members as m", "m.id", "i.member_id")
    .select(["i.member_id", sql<string>`i.day::text`.as("day"), "m.first_name", sql<number>`count(*)::int`.as("n")])
    .where("i.week_id", "=", weekId)
    .groupBy(["i.member_id", "i.day", "m.first_name"])
    .execute();
  const tasks = await trx.selectFrom("family_tasks").select(["id", "assigned_member_id", sql<string>`due_date::text`.as("due"), "status", "title"]).where("homework_week_id", "=", weekId).execute();
  const taskOf = new Map(tasks.map((t) => [`${t.assigned_member_id}|${t.due}`, t]));
  const wanted = new Set<string>();
  for (const g of groups) {
    const key = `${g.member_id}|${g.day}`;
    wanted.add(key);
    const title = `Devoirs — ${g.first_name ?? "Enfant"} (${itemsLabel(g.n)})`;
    const task = taskOf.get(key);
    if (!task) {
      await trx
        .insertInto("family_tasks")
        .values({ account_id: accountId, title: seal(title), status: "todo", due_date: g.day, assigned_member_id: g.member_id, created_by_user_id: createdBy, source: "homework", homework_week_id: weekId })
        .execute();
    } else if (open(task.title) !== title) {
      await trx.updateTable("family_tasks").set({ title: seal(title) }).where("id", "=", task.id).execute();
    }
  }
  // Un jour sans élément n'a plus de tâche, sauf si elle est déjà faite (on ne retire pas ce qui a été coché).
  for (const t of tasks) if (!wanted.has(`${t.assigned_member_id}|${t.due}`) && t.status !== "done") await trx.deleteFrom("family_tasks").where("id", "=", t.id).execute();
}

function translate(error: unknown): unknown {
  const code = (error as { code?: string }).code;
  if (code === "23505") return fail("week_exists", "Une semaine de devoirs est déjà préparée pour cette semaine.", 409);
  if (code === "23514") return fail("invalid_choice", (error as Error).message, 422);
  return error;
}

export interface PreparedWeek {
  weekId: string;
}

/** Enregistre la semaine choisie : semaine, manuels étrangers proposés, éléments et tâches, en une seule transaction (RF10 : rien d'enregistré en cas d'échec). */
export async function prepareWeek(ctx: Ctx, session: SessionContext, input: WeekInput): Promise<PreparedWeek> {
  const v = await viewerOf(ctx, session);
  if (!isDay(input.weekStart) || isoWeekday(input.weekStart) !== 1) throw fail("invalid_week", "Choisissez un lundi pour la semaine de devoirs.");
  if (input.weekStart < mondayOf(v.today)) throw fail("past_week", "Cette semaine est passée : choisissez la semaine en cours ou une suivante.");
  if (!validDays(input.workDays)) throw fail("invalid_days", "Choisissez au moins un jour de travail.");
  if (!input.children.length) throw fail("no_child", "Choisissez au moins un enfant.");
  if (new Set(input.children.map((c) => c.memberId)).size !== input.children.length) throw fail("duplicate_child", "Un enfant ne figure qu'une fois dans la semaine.");
  const existing = await ctx.db.selectFrom("homework_weeks").select("id").where("account_id", "=", v.accountId).where(sql<boolean>`week_start = ${input.weekStart}::date`).executeTakeFirst();
  if (existing) throw fail("week_exists", "Une semaine de devoirs est déjà préparée pour cette semaine.", 409, { weekId: existing.id });
  const planned: { memberId: string; items: PlannedItem[]; foreign: string[] }[] = [];
  for (const c of input.children) {
    const result = await planItems(ctx.db, v.accountId, input.weekStart, input.workDays, c, null);
    if (result.items.length > MAX_ITEMS_PER_CHILD) throw fail("too_many_items", `Une semaine compte au plus ${MAX_ITEMS_PER_CHILD} éléments par enfant.`);
    planned.push({ memberId: c.memberId, ...result });
  }
  if (!planned.some((p) => p.items.length)) throw fail("empty_week", "Placez au moins un élément dans la semaine.");
  try {
    const weekId = await ctx.db.transaction().execute(async (trx) => {
      const week = await trx
        .insertInto("homework_weeks")
        .values({ account_id: v.accountId, week_start: input.weekStart, work_days: input.workDays, prepared_by_user_id: v.userId })
        .returning("id")
        .executeTakeFirstOrThrow();
      for (const p of planned) {
        for (const book of p.foreign) await trx.insertInto("homework_week_foreign_books").values({ week_id: week.id, account_id: v.accountId, member_id: p.memberId, textbook_key: book }).execute();
        await insertItems(trx, v.accountId, week.id, p.items);
      }
      await syncHomeworkTasks(trx, v.accountId, week.id, v.userId);
      return week.id;
    });
    return { weekId };
  } catch (error) {
    throw translate(error);
  }
}

/** La carte « Préparer la semaine de devoirs » n'apparaît pas si une semaine est déjà préparée pour la semaine de l'échéance (RF1, CA 1.2). */
export async function weekPreparedFor(db: Db, accountId: string, day: string): Promise<boolean> {
  const row = await db.selectFrom("homework_weeks").select("id").where("account_id", "=", accountId).where(sql<boolean>`week_start = ${mondayOf(day)}::date`).executeTakeFirst();
  return Boolean(row);
}

/** Le titre d'une tâche contient « devoir » ou « devoirs », sans tenir compte des majuscules ni des accents (RF1, RT1) : la détection est faite ici, pas par l'agent. */
export function titleMentionsHomework(title: string): boolean {
  const plain = title.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return /\bdevoirs?\b/.test(plain);
}

/**
 * L'aide apparaît sous le formulaire quand le parent crée une tâche dont le titre parle de devoirs, que l'aide est activée pour le foyer et qu'aucune semaine
 * n'est déjà préparée pour la semaine de l'échéance (RF1). La tâche est enregistrée dans tous les cas.
 */
export async function shouldOfferHomework(ctx: Ctx, session: SessionContext, task: { title: string; due: string }): Promise<boolean> {
  const accountId = session.user.accountId;
  if (!accountId || !titleMentionsHomework(task.title)) return false;
  if (!(await homeworkEnabled(ctx, accountId))) return false;
  const [children, prepared] = [await loadChildren(ctx.db, accountId), await weekPreparedFor(ctx.db, accountId, task.due)];
  return children.length > 0 && !prepared;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Écran « Semaine de devoirs » (RF4)
// ---------------------------------------------------------------------------------------------------------------------------

export interface WeekItemView {
  id: string;
  /** Jour ISO 1 à 7. */
  day: number;
  kind: "exercise" | "activity" | "custom";
  title: string;
  /** « Manuel France CE1 · Ex 26 », « Fiche Nature · avec un adulte »… ; jamais le nom d'un manuel étranger avant qu'il soit proposé : un élément n'existe que s'il l'est. */
  source: string;
  statement: string | null;
  answer: string | null;
  steps: string[];
  materials: string | null;
  needsAdult: boolean;
  card: string | null;
  checked: boolean;
}

export interface WeekChildView {
  memberId: string;
  firstName: string;
  levelLabel: string;
  items: WeekItemView[];
  /** Pour ajouter un élément depuis l'écran : le catalogue de l'enfant. */
  suggestOlderAge: boolean;
}

export interface WeekView {
  id: string;
  weekStart: string;
  weekEnd: string;
  workDays: number[];
  children: WeekChildView[];
}

export async function getWeek(ctx: Ctx, session: SessionContext, weekId: string): Promise<WeekView> {
  const v = await taskViewer(ctx, session);
  if (!v.parent) throw fail("forbidden", "Seuls les parents du foyer ont accès aux semaines de devoirs.", 403);
  const week = await ctx.db.selectFrom("homework_weeks").select(["id", sql<string>`week_start::text`.as("start"), "work_days"]).where("id", "=", weekId).where("account_id", "=", v.accountId).executeTakeFirst();
  if (!week) throw fail("not_found", "Cette semaine n'existe plus ou ne vous est pas accessible.", 404);
  const rows = await ctx.db
    .selectFrom("homework_week_items as i")
    .leftJoin("homework_exercises as e", "e.id", "i.exercise_id")
    .leftJoin("homework_activities as a", "a.id", "i.activity_id")
    .select([
      "i.id", "i.member_id", sql<string>`i.day::text`.as("day"), "i.checked_at", "i.custom_title", "e.textbook_key", "e.level", "e.number", "e.theme", "e.answer",
      "a.category", "a.title as activity_title", "a.needs_adult", "a.card_ref",
    ])
    .where("i.week_id", "=", weekId)
    .orderBy("i.day")
    .orderBy("i.id")
    .execute();
  const labels = new Map((await ctx.db.selectFrom("homework_textbooks").select(["textbook_key", "label"]).execute()).map((b) => [b.textbook_key, b.label]));
  const kids = await loadChildren(ctx.db, v.accountId);
  const memberIds = [...new Set(rows.map((r) => r.member_id))];
  const children: WeekChildView[] = [];
  for (const memberId of memberIds) {
    const kid = kids.find((k) => k.memberId === memberId);
    const name = kid?.firstName ?? (await ctx.db.selectFrom("family_members").select("first_name").where("id", "=", memberId).executeTakeFirst())?.first_name ?? "";
    const progress = kid ? await progressOf(ctx.db, memberId, kid.level) : null;
    children.push({
      memberId, firstName: name, levelLabel: kid ? LEVEL_LABEL[kid.level] : "", suggestOlderAge: Boolean(kid && progress?.franceDone && kid.age < 12),
      items: rows
        .filter((r) => r.member_id === memberId)
        .map((r): WeekItemView => {
          const day = isoWeekday(r.day);
          if (r.number !== null && r.textbook_key && r.level) {
            return {
              id: String(r.id), day, kind: "exercise", title: r.theme ?? "", source: `${labels.get(r.textbook_key) ?? r.textbook_key} ${LEVEL_LABEL[r.level]} · Ex ${r.number}`,
              statement: exerciseStatement(r.textbook_key, r.level, r.number) || null, answer: r.answer, steps: [], materials: null, needsAdult: false, card: null, checked: r.checked_at !== null,
            };
          }
          if (r.activity_title && r.category) {
            const content = activityContent(r.category, r.activity_title);
            return {
              id: String(r.id), day, kind: "activity", title: r.activity_title, source: `Fiche ${categoryLabel(r.category)}${r.needs_adult ? " · avec un adulte" : ""}`, statement: content?.description || null,
              answer: null, steps: content?.steps ?? [], materials: content?.materials || null, needsAdult: Boolean(r.needs_adult), card: cardUrl(r.card_ref), checked: r.checked_at !== null,
            };
          }
          return { id: String(r.id), day, kind: "custom", title: r.custom_title ? open(r.custom_title) : "", source: "Activité du parent", statement: null, answer: null, steps: [], materials: null, needsAdult: false, card: null, checked: r.checked_at !== null };
        }),
    });
  }
  return { id: week.id, weekStart: week.start, weekEnd: addDays(week.start, 6), workDays: week.work_days, children };
}

export interface WeekSummary {
  id: string;
  weekStart: string;
  weekEnd: string;
  children: string[];
  items: number;
}

/** Semaines préparées, les plus récentes d'abord (écran « Semaines de devoirs »). */
export async function listWeeks(ctx: Ctx, session: SessionContext): Promise<{ weeks: WeekSummary[]; today: string; mondays: { weekStart: string; prepared: boolean }[] }> {
  const v = await taskViewer(ctx, session);
  if (!v.parent) throw fail("forbidden", "Seuls les parents du foyer ont accès aux semaines de devoirs.", 403);
  const rows = await ctx.db.selectFrom("homework_weeks").select(["id", sql<string>`week_start::text`.as("start")]).where("account_id", "=", v.accountId).orderBy("week_start", "desc").limit(60).execute();
  const items = rows.length
    ? await ctx.db.selectFrom("homework_week_items as i").innerJoin("family_members as m", "m.id", "i.member_id").select(["i.week_id", "m.first_name", sql<number>`count(*)::int`.as("n")]).where("i.week_id", "in", rows.map((r) => r.id)).groupBy(["i.week_id", "m.first_name"]).execute()
    : [];
  const weeks = rows.map((r) => {
    const mine = items.filter((i) => i.week_id === r.id);
    return { id: r.id, weekStart: r.start, weekEnd: addDays(r.start, 6), children: mine.map((i) => i.first_name ?? "").sort(), items: mine.reduce((sum, i) => sum + i.n, 0) };
  });
  const prepared = new Set(rows.map((r) => r.start));
  return { weeks, today: v.today, mondays: upcomingMondays(v.today).map((weekStart) => ({ weekStart, prepared: prepared.has(weekStart) })) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Modifier la semaine : cocher, déplacer, retirer, ajouter (RF4, RF6)
// ---------------------------------------------------------------------------------------------------------------------------

async function lockItem(trx: Db, accountId: string, itemId: string) {
  if (!/^\d+$/.test(itemId)) throw fail("not_found", "Cet élément n'existe plus.", 404);
  const row = await trx
    .selectFrom("homework_week_items as i")
    .innerJoin("homework_weeks as w", "w.id", "i.week_id")
    .select(["i.id", "i.week_id", sql<string>`i.day::text`.as("day"), "w.work_days", sql<string>`w.week_start::text`.as("week_start")])
    .where("i.id", "=", itemId)
    .where("i.account_id", "=", accountId)
    .forUpdate("i")
    .executeTakeFirst();
  if (!row) throw fail("not_found", "Cet élément n'existe plus.", 404);
  return row;
}

/** Case cochée : « fait », sans valider (seules les photos valident, RF6). */
export async function setItemChecked(ctx: Ctx, session: SessionContext, itemId: string, checked: boolean): Promise<void> {
  const v = await viewerOf(ctx, session);
  await ctx.db.transaction().execute(async (trx) => {
    await lockItem(trx, v.accountId, itemId);
    await trx.updateTable("homework_week_items").set({ checked_at: checked ? ctx.now : null }).where("id", "=", itemId).execute();
  });
}

/** Déplace un élément vers un autre jour de travail de la semaine. */
export async function moveItem(ctx: Ctx, session: SessionContext, itemId: string, day: number): Promise<void> {
  const v = await viewerOf(ctx, session);
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const item = await lockItem(trx, v.accountId, itemId);
      if (!Number.isInteger(day) || !item.work_days.includes(day)) throw fail("invalid_day", "Choisissez un jour de travail de la semaine.");
      await trx.updateTable("homework_week_items").set({ day: addDays(item.week_start, day - 1) }).where("id", "=", itemId).execute();
      await syncHomeworkTasks(trx, v.accountId, item.week_id, v.userId);
    });
  } catch (error) {
    throw translateItem(error);
  }
}

export async function removeItem(ctx: Ctx, session: SessionContext, itemId: string): Promise<void> {
  const v = await viewerOf(ctx, session);
  await ctx.db.transaction().execute(async (trx) => {
    const item = await lockItem(trx, v.accountId, itemId);
    await trx.deleteFrom("homework_week_items").where("id", "=", itemId).execute();
    await syncHomeworkTasks(trx, v.accountId, item.week_id, v.userId);
  });
}

/** Ajoute un élément à une semaine déjà préparée : mêmes contrôles que pour la préparation (niveau, manuels permis, jours de travail). */
export async function addItem(ctx: Ctx, session: SessionContext, weekId: string, memberId: string, item: ItemInput): Promise<void> {
  const v = await viewerOf(ctx, session);
  const week = await ctx.db.selectFrom("homework_weeks").select(["id", sql<string>`week_start::text`.as("start"), "work_days"]).where("id", "=", weekId).where("account_id", "=", v.accountId).executeTakeFirst();
  if (!week) throw fail("not_found", "Cette semaine n'existe plus ou ne vous est pas accessible.", 404);
  const { items, foreign } = await planItems(ctx.db, v.accountId, week.start, week.work_days, { memberId, items: [item] }, week.id);
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const already = new Set((await trx.selectFrom("homework_week_foreign_books").select("textbook_key").where("week_id", "=", week.id).where("member_id", "=", memberId).execute()).map((b) => b.textbook_key));
      for (const book of foreign) if (!already.has(book)) await trx.insertInto("homework_week_foreign_books").values({ week_id: week.id, account_id: v.accountId, member_id: memberId, textbook_key: book }).execute();
      await insertItems(trx, v.accountId, week.id, items);
      await syncHomeworkTasks(trx, v.accountId, week.id, v.userId);
    });
  } catch (error) {
    throw translateItem(error);
  }
}

function translateItem(error: unknown): unknown {
  const code = (error as { code?: string }).code;
  if (code === "23505") return fail("duplicate_item", "Cet élément est déjà prévu ce jour-là.", 409);
  if (code === "23514") return fail("invalid_choice", (error as Error).message, 422);
  return error;
}

export { ACTIVITY_CATEGORIES };

export interface HomeworkOptions extends ChildOptions {
  activities: { category: HomeworkActivityCategory; label: string; options: ActivityOption[] }[];
}

/** Tout ce que l'aide propose pour un enfant dans une semaine : maths puis les six catégories d'activités (RF2). */
export async function homeworkOptionsFor(ctx: Ctx, session: SessionContext, memberId: string, weekStart: string | null): Promise<HomeworkOptions> {
  const v = await viewerOf(ctx, session);
  const maths = await childOptions(ctx.db, v.accountId, memberId, weekStart);
  const activities = [];
  for (const c of ACTIVITY_CATEGORIES) activities.push({ category: c.key, label: c.label, options: await activityOptions(ctx.db, v.accountId, memberId, c.key) });
  return { ...maths, activities };
}
