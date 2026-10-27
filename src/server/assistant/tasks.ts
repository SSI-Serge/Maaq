import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { loadCalendarEventsByIds, type CalendarEvent, type EventType } from "./calendar";
import { open, openOptional, seal, sealOptional } from "./fields";
import { isParent } from "./family";
import { utcToLocal } from "./local-time";
import { loadMembers, type MemberChip } from "./member-chips";
import { familyTimeZone } from "./reminders";
import { addDays, expandOccurrences, ruleLabel, type SeriesRule } from "./series";
import type { Scope } from "./series-ops";
import {
  endOwnRuleBefore, loadTaskSeries, materializeOwnSeries, occurrencesBefore, rewriteOwnSeries, ruleFromTaskRepetition, shiftRule, splitOwnSeries, taskHorizon, taskRepetitionOf, taskRuleOf,
  type SeriesTaskEdit, type TaskRepetition, type TaskSeriesRow,
} from "./task-series";

/**
 * Tâches de la famille (US-110, US-96) : une tâche seule, une tâche qui revient, ou une tâche préparatoire (US-95, voir event-tasks.ts). Les règles de statut, de plafond et
 * de visibilité sont celles de la base (`change_family_task_status`, `family_tasks_visible_to`, déclencheurs) ; ici, la présentation et les droits d'écriture (AT-2, D26).
 */

export const MAX_TASK_TITLE = 100;
export const MAX_TASK_NOTE = 500;
/** Section « À venir » de l'écran Tâches : 14 jours (US-110 RF6). */
export const UPCOMING_DAYS = 14;
/** Section « Faites » : les 30 derniers jours (US-110 RF8). */
export const DONE_DAYS = 30;

export type TaskStatus = "proposed" | "todo" | "done" | "cancelled";
export type { TaskRepetition } from "./task-series";

export interface TaskView {
  id: string;
  title: string;
  note: string | null;
  status: TaskStatus;
  /** Jour local de la famille, « AAAA-MM-JJ », et heure facultative « HH:MM ». */
  due: string;
  dueTime: string | null;
  /** « En retard » est un affichage, pas un statut (AT-1) : à faire, échéance passée dans le fuseau de la famille. */
  overdue: boolean;
  assignee: MemberChip | null;
  /** RDV auquel la tâche prépare ; vide quand le profil ne voit pas ce RDV. */
  event: { id: string; title: string; start: string } | null;
  /** Écart au RDV conservé quand il est déplacé (US-95 RF9) ; vide pour une échéance choisie à la main. */
  daysBefore: number | null;
  recurring: boolean;
  /** « Chaque mardi » pour une tâche à règle propre ; vide pour une tâche qui suit une série de RDV. */
  rule: string | null;
  repetition: TaskRepetition | null;
  followsEventSeries: boolean;
  doneBy: string | null;
  doneAt: string | null;
  version: number;
  can: { check: boolean; manage: boolean };
}

export interface TaskLists {
  overdue: TaskView[];
  today: TaskView[];
  upcoming: TaskView[];
  done: TaskView[];
  /** Membres à qui une tâche peut être assignée par ce profil (US-96 RF2, RF3). */
  assignable: MemberChip[];
  viewer: { parent: boolean; memberId: string | null };
  todayDate: string;
}

export interface TaskViewer {
  accountId: string;
  userId: string;
  parent: boolean;
  /** Fiche « membre » du profil : l'invité secondaire n'assigne qu'à lui-même (US-96 RF3) et ne coche que ses tâches. */
  memberId: string | null;
  /** Fuseau de la famille : les échéances sont des jours de la famille (AF-2). */
  timeZone: string;
  today: string;
  nowLocal: string;
}

export const fail = (code: string, message: string, status = 409, details?: unknown) => new Rejection(code, message, status, details);
const NOT_FOUND = () => fail("not_found", "Cette tâche n'existe plus ou ne vous est pas accessible.", 404);

export async function taskViewer(ctx: Ctx, session: SessionContext): Promise<TaskViewer> {
  const accountId = session.user.accountId;
  if (!accountId || session.user.role === "admin") throw fail("forbidden", "Les tâches sont réservées aux profils d'un foyer.", 403);
  const member = await ctx.db.selectFrom("family_members").select("id").where("account_id", "=", accountId).where("user_id", "=", session.user.id).executeTakeFirst();
  const timeZone = await familyTimeZone(ctx.db, accountId);
  const nowLocal = utcToLocal(ctx.now, timeZone);
  return { accountId, userId: session.user.id, parent: isParent(session), memberId: member?.id ?? null, timeZone, today: nowLocal.slice(0, 10), nowLocal };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------------

export const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export interface TaskFields {
  title: string;
  note?: string | null;
  due: string;
  dueTime?: string | null;
  assigneeId?: string | null;
}

export interface CheckedTask {
  title: string;
  note: string | null;
  due: string;
  dueTime: string | null;
  assigneeId: string | null;
}

/** Titre (obligatoire, 100 caractères), note (500), échéance et assignation. Un invité secondaire n'assigne qu'à lui-même (US-96 RF3). */
export function checkFields(v: TaskViewer, fields: TaskFields, members: Map<string, MemberChip>, options: { keepAssignee?: string | null } = {}): CheckedTask {
  const title = (fields.title ?? "").trim();
  if (!title) throw fail("invalid_title", "Le titre est obligatoire.", 422);
  if (title.length > MAX_TASK_TITLE) throw fail("invalid_title", `Le titre ne peut pas dépasser ${MAX_TASK_TITLE} caractères.`, 422);
  const note = fields.note?.trim() || null;
  if (note && note.length > MAX_TASK_NOTE) throw fail("invalid_notes", `La note ne peut pas dépasser ${MAX_TASK_NOTE} caractères.`, 422);
  if (!isDay(fields.due)) throw fail("invalid_date", "L'échéance est invalide.", 422);
  const dueTime = fields.dueTime || null;
  if (dueTime && !isTime(dueTime)) throw fail("invalid_time", "L'heure d'échéance est invalide.", 422);
  const assigneeId = fields.assigneeId || null;
  if (assigneeId && assigneeId !== options.keepAssignee) {
    const member = members.get(assigneeId);
    if (!member || member.removed) throw fail("invalid_assignee", "Une tâche ne peut être assignée qu'à un membre actif de la famille.", 422);
    if (!v.parent && assigneeId !== v.memberId) throw fail("forbidden", "Vous ne pouvez assigner une tâche qu'à vous-même.", 403);
  }
  return { title, note, due: fields.due, dueTime, assigneeId };
}

/** Messages de la base (plafonds, échéances, membres retirés) traduits en refus lisibles. */
export function translateDbError(error: unknown): unknown {
  const e = error as { code?: string; message?: string };
  if (e.code !== "23514" || !e.message) return error;
  const recurring = /Nombre maximal de tâches récurrentes atteint \((\d+)\)/.exec(e.message);
  if (recurring) return fail("limit_reached", `Nombre maximal de tâches récurrentes atteint (${recurring[1]}).`, 409);
  const perEvent = /Au plus (\d+) tâches préparatoires/.exec(e.message);
  if (perEvent) return fail("limit_reached", `Nombre maximal de tâches pour ce RDV atteint (${perEvent[1]}).`, 409);
  if (/échéance passée/.test(e.message)) return fail("due_past", "Cette échéance est déjà passée.", 422);
  if (/après le RDV/.test(e.message)) return fail("due_after_event", "L'échéance ne peut pas être après le RDV.", 422);
  if (/membre actif/.test(e.message)) return fail("invalid_assignee", "Une tâche ne peut être assignée qu'à un membre actif de la famille.", 422);
  if (/pas de membre/.test(e.message)) return fail("no_member", "Votre profil n'est pas relié à un membre de la famille : impossible de cocher cette tâche.", 409);
  return error;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------------------------------------------------------

export function selectTasks(db: Kysely<DB>) {
  return db
    .selectFrom("family_tasks as t")
    .select([
      "t.id", "t.account_id", "t.series_id", sql<string | null>`t.occurrence_date::text`.as("occurrence_date"), "t.event_id", "t.title", "t.note", "t.status", sql<string>`t.due_date::text`.as("due_date"),
      sql<string | null>`t.due_time::text`.as("due_time"), "t.days_before_event", "t.assigned_member_id", "t.done_by_member_id", "t.done_at", "t.created_by_user_id", "t.version",
    ]);
}
export type TaskRow = Awaited<ReturnType<ReturnType<typeof selectTasks>["execute"]>>[number];

/** Tâches que ce profil a le droit de voir (AT-2) : filtre de la base. */
export const visibleTo = (userId: string) => sql<boolean>`t.id in (select id from family_tasks_visible_to(${userId}::uuid))`;

const isOverdue = (v: TaskViewer, row: Pick<TaskRow, "status" | "due_date" | "due_time">) =>
  row.status === "todo" && `${row.due_date}T${(row.due_time ?? "23:59:59").slice(0, 8).padEnd(8, ":00")}` < `${v.nowLocal}:00`;

export const canManageTask = (v: TaskViewer, row: Pick<TaskRow, "created_by_user_id">) => v.parent || row.created_by_user_id === v.userId;
export const canCheckTask = (v: TaskViewer, row: Pick<TaskRow, "created_by_user_id" | "assigned_member_id">) => canManageTask(v, row) || (v.memberId !== null && row.assigned_member_id === v.memberId);

/** Le profil voit-il ce RDV ? (D26 : les parents voient tout ; un invité secondaire, ses demandes, les RDV de toute la famille et ceux où il figure.) */
const sees = (v: TaskViewer, e: CalendarEvent) => v.parent || e.createdByUserId === v.userId || e.allFamily || (v.memberId !== null && e.memberIds.includes(v.memberId));

export async function toTaskViews(db: Kysely<DB>, v: TaskViewer, rows: TaskRow[], members?: Map<string, MemberChip>): Promise<TaskView[]> {
  if (!rows.length) return [];
  const chips = members ?? (await loadMembers(db, v.accountId));
  const events = new Map<string, CalendarEvent>();
  const eventIds = [...new Set(rows.map((r) => r.event_id).filter((x): x is string => Boolean(x)))];
  for (const e of await loadCalendarEventsByIds(db, v.accountId, eventIds)) events.set(e.id, e);
  const seriesIds = [...new Set(rows.map((r) => r.series_id).filter((x): x is string => Boolean(x)))];
  const series = new Map<string, TaskSeriesRow>();
  for (const id of seriesIds) {
    const s = await loadTaskSeries(db, v.accountId, id);
    if (s) series.set(id, s);
  }
  return rows.map((r): TaskView => {
    const event = r.event_id ? events.get(r.event_id) : undefined;
    const s = r.series_id ? series.get(r.series_id) : undefined;
    const own: SeriesRule | null = s && !s.event_series_id ? taskRuleOf(s) : null;
    return {
      id: r.id, title: open(r.title), note: openOptional(r.note), status: r.status, due: r.due_date, dueTime: r.due_time ? r.due_time.slice(0, 5) : null, overdue: isOverdue(v, r),
      assignee: r.assigned_member_id ? (chips.get(r.assigned_member_id) ?? null) : null,
      event: event && sees(v, event) ? { id: event.id, title: event.title, start: utcToLocal(event.startsAt, v.timeZone) } : null,
      daysBefore: r.days_before_event, recurring: Boolean(r.series_id), rule: own ? ruleLabel(own) : null, repetition: own ? taskRepetitionOf(own) : null, followsEventSeries: Boolean(s?.event_series_id),
      doneBy: r.done_by_member_id ? (chips.get(r.done_by_member_id)?.firstName ?? null) : null, doneAt: r.done_at ? utcToLocal(r.done_at, v.timeZone) : null, version: r.version,
      can: { check: canCheckTask(v, r), manage: canManageTask(v, r) },
    };
  });
}

const byDue = (a: TaskView, b: TaskView) => a.due.localeCompare(b.due) || (a.dueTime ?? "99:99").localeCompare(b.dueTime ?? "99:99") || a.title.localeCompare(b.title, "fr");

/** Membres à qui ce profil peut assigner : tous les membres actifs pour un parent, lui-même pour un invité secondaire. */
export function assignableMembers(v: TaskViewer, members: Map<string, MemberChip>): MemberChip[] {
  return [...members.values()].filter((m) => !m.removed && (v.parent || m.id === v.memberId));
}

/**
 * L'écran « Tâches » (US-110 RF6 à RF8) : à faire en retard, aujourd'hui, à venir sur 14 jours, et faites sur 30 jours. « Mes tâches » ne garde que celles assignées au
 * membre de ce profil.
 */
export async function listTasks(ctx: Ctx, session: SessionContext, options: { mine?: boolean } = {}): Promise<TaskLists> {
  const v = await taskViewer(ctx, session);
  const members = await loadMembers(ctx.db, v.accountId);
  const horizon = addDays(v.today, UPCOMING_DAYS);
  const mine = options.mine ? (v.memberId ?? "00000000-0000-0000-0000-000000000000") : null;
  const open_ = await selectTasks(ctx.db)
    .where("t.account_id", "=", v.accountId)
    .where(visibleTo(v.userId))
    .where("t.status", "=", "todo")
    .where("t.due_date", "<=", sql<Date>`${horizon}::date`)
    .$if(Boolean(mine), (qb) => qb.where("t.assigned_member_id", "=", mine!))
    .execute();
  const finished = await selectTasks(ctx.db)
    .where("t.account_id", "=", v.accountId)
    .where(visibleTo(v.userId))
    .where("t.status", "=", "done")
    .where(sql<boolean>`t.done_at > now() - ${`${DONE_DAYS} days`}::interval`)
    .$if(Boolean(mine), (qb) => qb.where("t.assigned_member_id", "=", mine!))
    .orderBy("t.done_at", "desc")
    .limit(200)
    .execute();
  const views = (await toTaskViews(ctx.db, v, open_, members)).sort(byDue);
  return {
    overdue: views.filter((t) => t.overdue),
    today: views.filter((t) => !t.overdue && t.due <= v.today),
    upcoming: views.filter((t) => !t.overdue && t.due > v.today),
    done: await toTaskViews(ctx.db, v, finished, members),
    assignable: assignableMembers(v, members),
    viewer: { parent: v.parent, memberId: v.memberId },
    todayDate: v.today,
  };
}

/** Tâches à faire ou faites dont l'échéance tombe entre deux jours inclus : vue Jour (US-110 RF9) et nombre de tâches des vues Semaine et Mois (AT-5). */
export async function listTasksBetween(ctx: Ctx, session: SessionContext, range: { from: string; to: string }): Promise<TaskView[]> {
  const v = await taskViewer(ctx, session);
  if (!isDay(range.from) || !isDay(range.to) || range.to < range.from || Date.parse(range.to) - Date.parse(range.from) > 400 * 86_400_000) throw fail("invalid_range", "La période demandée est invalide.", 422);
  const rows = await selectTasks(ctx.db)
    .where("t.account_id", "=", v.accountId)
    .where(visibleTo(v.userId))
    .where("t.status", "in", ["todo", "done"])
    .where("t.due_date", ">=", sql<Date>`${range.from}::date`)
    .where("t.due_date", "<=", sql<Date>`${range.to}::date`)
    .execute();
  return (await toTaskViews(ctx.db, v, rows)).sort(byDue);
}

export async function getTask(ctx: Ctx, session: SessionContext, id: string): Promise<TaskView> {
  const v = await taskViewer(ctx, session);
  return viewOf(ctx.db, v, id);
}

async function viewOf(db: Kysely<DB>, v: TaskViewer, id: string): Promise<TaskView> {
  const row = await selectTasks(db).where("t.account_id", "=", v.accountId).where("t.id", "=", id).where(visibleTo(v.userId)).executeTakeFirst();
  if (!row) throw NOT_FOUND();
  return (await toTaskViews(db, v, [row]))[0];
}

// ---------------------------------------------------------------------------------------------------------------------------
// Création
// ---------------------------------------------------------------------------------------------------------------------------

export interface NewTask extends TaskFields {
  /** Répétition (US-110 RF3) : la tâche devient une règle dont les occurrences se cochent séparément. */
  repetition?: TaskRepetition | null;
}

/** Une tâche seule, ou une tâche qui revient (au plus 50 règles actives, RF11). Retourne la tâche créée, ou la première occurrence d'une règle. */
export async function createTask(ctx: Ctx, session: SessionContext, input: NewTask): Promise<TaskView> {
  const v = await taskViewer(ctx, session);
  const members = await loadMembers(ctx.db, v.accountId);
  const task = checkFields(v, input, members);
  try {
    const id = await ctx.db.transaction().execute(async (trx) => {
      if (!input.repetition) {
        const row = await trx
          .insertInto("family_tasks")
          .values({
            account_id: v.accountId, title: seal(task.title), note: sealOptional(task.note), status: "todo", due_date: task.due, due_time: task.dueTime, assigned_member_id: task.assigneeId,
            created_by_user_id: v.userId, source: "user",
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        return row.id;
      }
      const rule = ruleFromTaskRepetition(input.repetition, task.due);
      if (rule.end.kind === "date" && rule.end.date < task.due) throw fail("invalid_repetition", "La date de fin doit être après la première échéance.", 422);
      // Toute règle valide produit une occurrence dans l'année qui suit sa première date (un mois a toujours son 31 replié, son premier mardi…).
      if (!expandOccurrences(rule, task.due, addDays(task.due, 400)).length) throw fail("invalid_repetition", "La règle de répétition ne produit aucune occurrence.", 422);
      const series = await trx
        .insertInto("family_task_series")
        .values({
          account_id: v.accountId, title: seal(task.title), note: sealOptional(task.note), assigned_member_id: task.assigneeId, due_time: task.dueTime, first_date: task.due,
          repeat_unit: rule.unit, repeat_interval: rule.interval, weekdays: rule.weekdays ?? null, month_mode: rule.monthMode ?? null, month_day: rule.monthDay ?? null, month_nth: rule.monthNth ?? null,
          month_weekday: rule.monthWeekday ?? null, end_kind: rule.end.kind, until_date: rule.end.kind === "date" ? rule.end.date : null, occurrence_count: rule.end.kind === "count" ? rule.end.count : null,
          created_by_user_id: v.userId, source: "user",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const fresh = (await loadTaskSeries(trx, v.accountId, series.id))!;
      await materializeOwnSeries(trx, fresh, v.today, await taskHorizon(trx, v.today));
      const first = await trx.selectFrom("family_tasks").select("id").where("series_id", "=", series.id).orderBy("occurrence_date").limit(1).executeTakeFirst();
      // La première échéance est dans plus de 8 semaines : l'occurrence viendra avec le planificateur ; la règle, elle, est enregistrée.
      return first?.id ?? null;
    });
    if (!id) return { ...emptyView(task), recurring: true };
    return viewOf(ctx.db, v, id);
  } catch (error) {
    throw translateDbError(error);
  }
}

function emptyView(task: CheckedTask): TaskView {
  return {
    id: "", title: task.title, note: task.note, status: "todo", due: task.due, dueTime: task.dueTime, overdue: false, assignee: null, event: null, daysBefore: null, recurring: false, rule: null,
    repetition: null, followsEventSeries: false, doneBy: null, doneAt: null, version: 1, can: { check: true, manage: true },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Modification, assignation, annulation, cochage
// ---------------------------------------------------------------------------------------------------------------------------

async function lockTask(trx: Kysely<DB>, v: TaskViewer, id: string) {
  const row = await selectTasks(trx).where("t.account_id", "=", v.accountId).where("t.id", "=", id).where(visibleTo(v.userId)).forUpdate("t").executeTakeFirst();
  if (!row) throw NOT_FOUND();
  return row;
}

const staleVersion = (row: Pick<TaskRow, "version">) => fail("stale_version", "Cette tâche a été modifiée entre-temps.", 409, { version: row.version });
const settled = (row: Pick<TaskRow, "status" | "version">) => fail("already_handled", row.status === "done" ? "Cette tâche est déjà faite." : "Cette tâche n'est plus à faire.", 409, { status: row.status, version: row.version });

export type TaskChanges = TaskFields;

/**
 * Modifie une tâche à faire. Sur une tâche récurrente, la portée est « cette fois » (l'occurrence seule), « cette fois et les suivantes » ou « toutes » (US-110 RF5) : la
 * règle suit alors la date déplacée. Une occurrence qui suit une série de RDV ne se modifie que seule ; le modèle se règle depuis le RDV.
 */
export async function updateTask(ctx: Ctx, session: SessionContext, id: string, changes: TaskChanges, options: { expectedVersion: number; scope?: Scope }): Promise<TaskView> {
  const v = await taskViewer(ctx, session);
  const members = await loadMembers(ctx.db, v.accountId);
  let resultId = id;
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, v, id);
      if (!canManageTask(v, row)) throw fail("forbidden", "Vous ne pouvez pas modifier cette tâche.", 403);
      if (row.status !== "todo") throw settled(row);
      if (row.version !== options.expectedVersion) throw staleVersion(row);
      const task = checkFields(v, changes, members, { keepAssignee: row.assigned_member_id });
      const series = row.series_id ? await loadTaskSeries(trx, v.accountId, row.series_id, { forUpdate: true }) : undefined;
      const scope: Scope = options.scope ?? "this";
      if (series && !series.event_series_id && scope !== "this") {
        const anchor = row.occurrence_date!;
        const oldRule = taskRuleOf(series);
        const edit: SeriesTaskEdit = { title: task.title, note: task.note, assigneeId: task.assigneeId, dueTime: task.dueTime, rule: shiftRule(oldRule, row.due_date, task.due), by: v.userId };
        let target = series.id;
        // L'occurrence est la première de la règle : « cette fois et les suivantes » revient à « toutes ».
        if (scope === "all" || occurrencesBefore(oldRule, series.first_date!, anchor) === 0) await rewriteOwnSeries(trx, series, edit, v.today);
        else target = await splitOwnSeries(trx, series, anchor, addDays(anchor, Math.round((Date.parse(task.due) - Date.parse(row.due_date)) / 86_400_000)), edit, v.today);
        // Une occurrence déjà en retard n'est pas recréée : c'est elle qu'on rend. Sinon, la première occurrence à venir du modèle modifié.
        const next = row.due_date < v.today ? undefined : await trx.selectFrom("family_tasks").select("id").where("series_id", "=", target).where("status", "=", "todo").where("due_date", ">=", sql<Date>`${v.today}::date`).orderBy("due_date").limit(1).executeTakeFirst();
        resultId = next?.id ?? id;
        return;
      }
      if (series?.event_series_id && scope !== "this") throw fail("scope_not_allowed", "Cette tâche suit une série de RDV : modifiez-la depuis le RDV.", 422);
      // Une échéance déplacée à la main ne suit plus le RDV (US-95 RF9 : seul l'écart choisi est conservé).
      const moved = task.due !== row.due_date;
      await trx
        .updateTable("family_tasks")
        .set({ title: seal(task.title), note: sealOptional(task.note), due_date: task.due, due_time: task.dueTime, assigned_member_id: task.assigneeId, ...(moved && row.days_before_event !== null ? { days_before_event: null } : {}) })
        .where("id", "=", id)
        .execute();
    });
  } catch (error) {
    throw translateDbError(error);
  }
  return viewOf(ctx.db, v, resultId);
}

/** Réassigne une tâche à faire (US-96). Les deux parents réassignent toute tâche ; un invité secondaire, seulement celles qu'il a créées, à lui-même. */
export async function assignTask(ctx: Ctx, session: SessionContext, id: string, memberId: string | null, options: { expectedVersion?: number } = {}): Promise<TaskView> {
  const v = await taskViewer(ctx, session);
  const members = await loadMembers(ctx.db, v.accountId);
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, v, id);
      if (!canManageTask(v, row)) throw fail("forbidden", "Vous ne pouvez pas réassigner cette tâche.", 403);
      if (row.status !== "todo") throw settled(row);
      if (options.expectedVersion !== undefined && row.version !== options.expectedVersion) throw staleVersion(row);
      if (memberId) {
        const member = members.get(memberId);
        if (!member || member.removed) throw fail("invalid_assignee", "Une tâche ne peut être assignée qu'à un membre actif de la famille.", 422);
        if (!v.parent && memberId !== v.memberId) throw fail("forbidden", "Vous ne pouvez assigner une tâche qu'à vous-même.", 403);
      }
      await trx.updateTable("family_tasks").set({ assigned_member_id: memberId }).where("id", "=", id).execute();
    });
  } catch (error) {
    throw translateDbError(error);
  }
  return viewOf(ctx.db, v, id);
}

/** Coche une tâche (« Faite par [prénom] ») ou annule le cochage (US-110 RF7). Le droit de cocher : les parents toutes, un invité secondaire les siennes (AT-2). */
export async function setTaskDone(ctx: Ctx, session: SessionContext, id: string, done: boolean, options: { expectedVersion?: number } = {}): Promise<TaskView> {
  const v = await taskViewer(ctx, session);
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, v, id);
      if (!canCheckTask(v, row)) throw fail("forbidden", "Vous ne pouvez pas cocher cette tâche.", 403);
      if (options.expectedVersion !== undefined && row.version !== options.expectedVersion) throw staleVersion(row);
      if (row.status === (done ? "done" : "todo")) return;
      const { rows } = await sql<{ ok: boolean }>`select change_family_task_status(${id}::uuid, ${done ? "done" : "todo"}::task_status, ${v.userId}::uuid, ${null}::integer) as ok`.execute(trx);
      if (!rows[0]?.ok) throw settled(row);
    });
  } catch (error) {
    throw translateDbError(error);
  }
  return viewOf(ctx.db, v, id);
}

/**
 * Annule une tâche (« Annuler la tâche »). Sur une tâche récurrente : « cette fois » annule l'occurrence, « cette fois et les suivantes » arrête la règle la veille, « toutes »
 * termine la tâche et annule ses occurrences à venir (US-110 RF5).
 */
export async function cancelTask(ctx: Ctx, session: SessionContext, id: string, options: { expectedVersion?: number; scope?: Scope } = {}): Promise<{ id: string; status: "cancelled"; cancelled: number }> {
  const v = await taskViewer(ctx, session);
  let cancelled = 0;
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, v, id);
      if (!canManageTask(v, row)) throw fail("forbidden", "Vous ne pouvez pas annuler cette tâche.", 403);
      if (row.status !== "todo") throw settled(row);
      if (options.expectedVersion !== undefined && row.version !== options.expectedVersion) throw staleVersion(row);
      const series = row.series_id ? await loadTaskSeries(trx, v.accountId, row.series_id, { forUpdate: true }) : undefined;
      const scope: Scope = options.scope ?? "this";
      if (series && !series.event_series_id && scope !== "this") {
        if (scope === "all" || occurrencesBefore(taskRuleOf(series), series.first_date!, row.occurrence_date!) === 0) {
          const { rows } = await sql<{ n: number | null }>`select end_family_task_series(${series.id}::uuid, ${v.userId}::uuid) as n`.execute(trx);
          cancelled = Number(rows[0]?.n ?? 0);
          // Les occurrences à faire échues avant aujourd'hui (date de la base) restent : on termine aussi celles qui précèdent le jour de la famille.
          const rest = await trx
            .updateTable("family_tasks")
            .set({ status: "cancelled", cancel_reason: "series_ended", status_changed_by_user_id: v.userId })
            .where("series_id", "=", series.id)
            .where("status", "=", "todo")
            .where("due_date", ">=", sql<Date>`${v.today}::date`)
            .executeTakeFirst();
          cancelled += Number(rest.numUpdatedRows);
        } else {
          await endOwnRuleBefore(trx, series.id, row.occurrence_date!);
          const rest = await trx
            .updateTable("family_tasks")
            .set({ status: "cancelled", cancel_reason: "series_ended", status_changed_by_user_id: v.userId })
            .where("series_id", "=", series.id)
            .where("status", "=", "todo")
            .where("occurrence_date", ">=", sql<Date>`${row.occurrence_date!}::date`)
            .executeTakeFirst();
          cancelled = Number(rest.numUpdatedRows);
        }
        return;
      }
      if (series?.event_series_id && scope !== "this") throw fail("scope_not_allowed", "Cette tâche suit une série de RDV : retirez-la depuis le RDV.", 422);
      const { rows } = await sql<{ ok: boolean }>`select change_family_task_status(${id}::uuid, 'cancelled'::task_status, ${v.userId}::uuid, ${null}::integer, 'user'::task_cancel_reason) as ok`.execute(trx);
      if (!rows[0]?.ok) throw settled(row);
      cancelled = 1;
    });
  } catch (error) {
    throw translateDbError(error);
  }
  return { id, status: "cancelled", cancelled };
}

