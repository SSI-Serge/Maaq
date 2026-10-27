import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { integerSetting } from "@/server/settings";
import { loadCalendarEvent, type CalendarEvent } from "./calendar";
import { open, openOptional, seal, sealOptional } from "./fields";
import { localDay } from "./local-time";
import { loadMembers, type MemberChip } from "./member-chips";
import { fold } from "./pseudonymize";
import { addDays, loadSeries } from "./series";
import { notifyTaskAssigned } from "./task-notices";
import { materializeEventTemplates } from "./task-series";
import { assignableMembers, checkFields, fail, isDay, selectTasks, taskViewer, translateDbError, type TaskViewer } from "./tasks";

/**
 * Tâches préparatoires d'un RDV (US-95) : proposées avec le RDV provisoire, retenues à sa confirmation, ajoutables ensuite. Une tâche proposée est enregistrée au
 * statut « proposée » ; la base la passe à « à faire » avec le RDV, en une seule opération (`change_family_event_status`, D48). Pour une série de RDV, ce sont des
 * modèles de tâche (`family_task_series`) dont chaque séance reçoit une occurrence une fois la série confirmée (RF12).
 */

/** Échéances relatives proposées par l'éditeur (validées par le PO le 26/10/2026) ; « Autre date… » est une date entre aujourd'hui et le jour du RDV. */
export const RELATIVE_DUES: { days: number; label: string }[] = [
  { days: 0, label: "Le jour même" },
  { days: 1, label: "La veille" },
  { days: 2, label: "2 jours avant" },
  { days: 3, label: "3 jours avant" },
  { days: 7, label: "1 semaine avant" },
];
export const relativeLabel = (days: number | null) => (days === null ? null : (RELATIVE_DUES.find((r) => r.days === days)?.label ?? `${days} jours avant`));

export interface EventTaskView {
  /** Identifiant de la tâche, ou du modèle pour une série de RDV. */
  id: string;
  kind: "task" | "template";
  title: string;
  note: string | null;
  status: "proposed" | "todo" | "done";
  /** Jour de l'échéance ; vide pour un modèle de série (l'échéance dépend de la séance). */
  due: string | null;
  dueTime: string | null;
  daysBefore: number | null;
  /** « La veille », « 2 jours avant »… ; vide pour une date choisie à la main. */
  relative: string | null;
  assignee: MemberChip | null;
}

export interface EventTasksView {
  items: EventTaskView[];
  limit: number;
  reached: boolean;
  /** Ce profil peut retirer, ajouter et modifier les tâches de ce RDV (US-95 RF15). */
  editable: boolean;
  /** Les tâches d'une série s'appliquent à chaque séance (RF12). */
  perSession: boolean;
  /** Personnes à qui ce profil peut assigner (US-96 RF3) : tous les membres actifs pour un parent, lui-même pour un invité secondaire. */
  assignable: MemberChip[];
}

const canActOn = (v: TaskViewer, e: CalendarEvent) => v.parent || e.createdByUserId === v.userId;
const sees = (v: TaskViewer, e: CalendarEvent) => v.parent || e.createdByUserId === v.userId || e.allFamily || (v.memberId !== null && e.memberIds.includes(v.memberId));

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------------------------------------------------------

/** La liste « À préparer » d'un RDV : tâches proposées, à faire et faites (annulées exclues) ; pour une série, ses modèles. */
export async function loadEventTasks(db: Kysely<DB>, v: TaskViewer, e: CalendarEvent, now: Date, members?: Map<string, MemberChip>): Promise<EventTasksView> {
  const chips = members ?? (await loadMembers(db, v.accountId));
  const limit = await integerSetting(db, "max_tasks_per_event", 10);
  let items: EventTaskView[];
  if (e.seriesId) {
    const templates = await db
      .selectFrom("family_task_series")
      .select(["id", "title", "note", sql<string | null>`due_time::text`.as("due_time"), "days_before_event", "assigned_member_id", "proposed", "created_at"])
      .where("event_series_id", "=", e.seriesId)
      .where("ended_at", "is", null)
      .orderBy("days_before_event", "desc")
      .orderBy("created_at")
      .execute();
    items = templates.map((t) => ({
      id: t.id, kind: "template", title: open(t.title), note: openOptional(t.note), status: t.proposed ? "proposed" : "todo", due: null, dueTime: t.due_time ? t.due_time.slice(0, 5) : null,
      daysBefore: t.days_before_event, relative: relativeLabel(t.days_before_event), assignee: t.assigned_member_id ? (chips.get(t.assigned_member_id) ?? null) : null,
    }));
  } else {
    const rows = await selectTasks(db).where("t.event_id", "=", e.id).where("t.series_id", "is", null).where("t.status", "in", ["proposed", "todo", "done"]).execute();
    items = rows
      .map((r): EventTaskView => ({
        id: r.id, kind: "task", title: open(r.title), note: openOptional(r.note), status: r.status as EventTaskView["status"], due: r.due_date, dueTime: r.due_time ? r.due_time.slice(0, 5) : null,
        daysBefore: r.days_before_event, relative: relativeLabel(r.days_before_event), assignee: r.assigned_member_id ? (chips.get(r.assigned_member_id) ?? null) : null,
      }))
      .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? "") || a.title.localeCompare(b.title, "fr"));
  }
  const open_ = e.status === "provisional" || e.status === "set_aside" || e.status === "confirmed";
  return {
    items, limit, reached: items.length >= limit, perSession: Boolean(e.seriesId), assignable: assignableMembers(v, chips), editable: canActOn(v, e) && open_ && e.startsAt.getTime() > now.getTime(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------------------------------------------------------

export interface EventTaskInput {
  title: string;
  note?: string | null;
  /** Échéance relative au RDV (écart conservé si le RDV est déplacé, RF9) ; sinon `due`, une date choisie à la main. */
  daysBefore?: number | null;
  due?: string | null;
  dueTime?: string | null;
  assigneeId?: string | null;
}

/** Ce qu'il faut savoir du contexte d'écriture ; commun aux écrans (profil connecté) et à l'agent (parent qui écrit). */
export interface WriteContext {
  accountId: string;
  userId: string;
  timeZone: string;
  now: Date;
  members: Map<string, MemberChip>;
  parent: boolean;
  memberId: string | null;
  source: "user" | "agent";
}

const viewerOf = (w: WriteContext): TaskViewer => ({ accountId: w.accountId, userId: w.userId, parent: w.parent, memberId: w.memberId, timeZone: w.timeZone, today: localDay(w.now, w.timeZone), nowLocal: "" });

/** Échéance d'une tâche de ce RDV : jamais passée, jamais après le jour du RDV (US-95 RF3 bis, D51). */
function dueFor(e: CalendarEvent, input: EventTaskInput, w: WriteContext): { due: string; daysBefore: number | null } {
  const today = localDay(w.now, w.timeZone);
  const eventDay = localDay(e.startsAt, w.timeZone);
  if (input.daysBefore !== undefined && input.daysBefore !== null) {
    if (!Number.isInteger(input.daysBefore) || input.daysBefore < 0 || input.daysBefore > 60) throw fail("invalid_date", "L'échéance est invalide.", 422);
    const due = addDays(eventDay, -input.daysBefore);
    if (due < today) throw fail("due_past", "Cette échéance est déjà passée.", 422);
    return { due, daysBefore: input.daysBefore };
  }
  if (!isDay(input.due)) throw fail("invalid_date", "Choisissez une échéance.", 422);
  if (input.due < today) throw fail("due_past", "Cette échéance est déjà passée.", 422);
  if (input.due > eventDay) throw fail("due_after_event", "L'échéance ne peut pas être après le RDV.", 422);
  return { due: input.due, daysBefore: null };
}

/**
 * Ajoute une tâche à un RDV : « proposée » tant que le RDV attend sa confirmation, « à faire » s'il est confirmé. Sur une série, ajoute un modèle (proposé tant que la
 * série ne l'est pas confirmée) ; une série confirmée reçoit tout de suite les occurrences de ses séances à venir. Retourne l'identifiant créé.
 */
export async function insertEventTask(db: Kysely<DB>, w: WriteContext, e: CalendarEvent, input: EventTaskInput): Promise<string> {
  if (e.startsAt.getTime() <= w.now.getTime()) throw fail("event_past", "Ce rendez-vous est déjà passé.", 409);
  if (e.status !== "provisional" && e.status !== "set_aside" && e.status !== "confirmed") throw fail("event_closed", "Ce rendez-vous n'accepte plus de tâche.", 409);
  const checked = checkFields(viewerOf(w), { ...input, due: localDay(w.now, w.timeZone) }, w.members);
  try {
    if (e.seriesId) {
      // Une tâche de série s'exprime en écart à la séance : une date choisie à la main n'a de sens que pour une séance.
      if (input.daysBefore === undefined || input.daysBefore === null) throw fail("invalid_date", "Pour une série, choisissez une échéance relative à la séance.", 422);
      if (!Number.isInteger(input.daysBefore) || input.daysBefore < 0 || input.daysBefore > 60) throw fail("invalid_date", "L'échéance est invalide.", 422);
      const series = await loadSeries(db, w.accountId, e.seriesId);
      if (!series || (series.status !== "provisional" && series.status !== "confirmed")) throw fail("event_closed", "Cette série n'accepte plus de tâche.", 409);
      const row = await db
        .insertInto("family_task_series")
        .values({
          account_id: w.accountId, event_series_id: e.seriesId, days_before_event: input.daysBefore, title: seal(checked.title), note: sealOptional(checked.note), assigned_member_id: checked.assigneeId,
          due_time: checked.dueTime, proposed: series.status === "provisional", created_by_user_id: w.userId, source: w.source,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (series.status === "confirmed") await materializeEventTemplates(db, e.seriesId, w.now, w.timeZone);
      return row.id;
    }
    const { due, daysBefore } = dueFor(e, input, w);
    const row = await db
      .insertInto("family_tasks")
      .values({
        account_id: w.accountId, event_id: e.id, title: seal(checked.title), note: sealOptional(checked.note), status: e.status === "confirmed" ? "todo" : "proposed", due_date: due, due_time: checked.dueTime,
        days_before_event: daysBefore, assigned_member_id: checked.assigneeId, created_by_user_id: w.userId, source: w.source,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  } catch (error) {
    throw translateDbError(error);
  }
}

async function writeContext(ctx: Ctx, v: TaskViewer): Promise<WriteContext> {
  return { accountId: v.accountId, userId: v.userId, timeZone: v.timeZone, now: ctx.now, members: await loadMembers(ctx.db, v.accountId), parent: v.parent, memberId: v.memberId, source: "user" };
}

async function targetEvent(ctx: Ctx, session: SessionContext, eventId: string): Promise<{ v: TaskViewer; e: CalendarEvent }> {
  const v = await taskViewer(ctx, session);
  const e = await loadCalendarEvent(ctx.db, v.accountId, eventId);
  if (!e || !sees(v, e)) throw fail("not_found", "Ce rendez-vous n'existe plus ou ne vous est pas accessible.", 404);
  if (!canActOn(v, e)) throw fail("forbidden", "Vous ne pouvez pas modifier les tâches de ce rendez-vous.", 403);
  return { v, e };
}

/** « + Tâche » d'un RDV (US-95 RF3, RF8) : au plus 10 tâches, vérifié par la base. `expectedVersion` refuse une carte périmée (RF5). */
export async function addEventTask(ctx: Ctx, session: SessionContext, eventId: string, input: EventTaskInput, options: { expectedVersion?: number } = {}): Promise<void> {
  const { v, e } = await targetEvent(ctx, session, eventId);
  if (options.expectedVersion !== undefined && options.expectedVersion !== e.version) throw fail("stale_version", "Ce rendez-vous a été modifié entre-temps.", 409, { version: e.version });
  const id = await insertEventTask(ctx.db, await writeContext(ctx, v), e, input);
  // Une tâche ajoutée « à faire » à un RDV confirmé et confiée à quelqu'un d'autre le prévient (US-96 RF4) ; une tâche proposée attend la confirmation.
  if (input.assigneeId && !e.seriesId && e.status === "confirmed") await notifyTaskAssigned(ctx, id, v.userId);
}

async function findTarget(db: Kysely<DB>, e: CalendarEvent, taskId: string) {
  if (e.seriesId) {
    const t = await db.selectFrom("family_task_series").select(["id", "proposed", "days_before_event", "assigned_member_id"]).where("id", "=", taskId).where("event_series_id", "=", e.seriesId).where("ended_at", "is", null).executeTakeFirst();
    if (t) return { kind: "template" as const, proposed: t.proposed, assigneeId: t.assigned_member_id, status: t.proposed ? "proposed" : "todo", days: t.days_before_event };
  }
  const t = await selectTasks(db).where("t.id", "=", taskId).where("t.event_id", "=", e.id).where("t.series_id", "is", null).executeTakeFirst();
  if (t && t.status !== "cancelled") return { kind: "task" as const, proposed: t.status === "proposed", assigneeId: t.assigned_member_id, status: t.status, days: t.days_before_event };
  throw fail("not_found", "Cette tâche n'existe plus.", 404);
}

/** Modifie une tâche du RDV (titre, échéance relative, personne). Une tâche faite ne se modifie plus. */
export async function updateEventTask(ctx: Ctx, session: SessionContext, eventId: string, taskId: string, input: EventTaskInput, options: { expectedVersion?: number } = {}): Promise<void> {
  const { v, e } = await targetEvent(ctx, session, eventId);
  if (options.expectedVersion !== undefined && options.expectedVersion !== e.version) throw fail("stale_version", "Ce rendez-vous a été modifié entre-temps.", 409, { version: e.version });
  const w = await writeContext(ctx, v);
  const target = await findTarget(ctx.db, e, taskId);
  if (target.status === "done") throw fail("already_handled", "Cette tâche est déjà faite.", 409);
  const checked = checkFields(viewerOf(w), { ...input, due: v.today }, w.members, { keepAssignee: target.assigneeId });
  try {
    await ctx.db.transaction().execute(async (trx) => {
      if (target.kind === "template") {
        if (input.daysBefore === undefined || input.daysBefore === null || !Number.isInteger(input.daysBefore) || input.daysBefore < 0 || input.daysBefore > 60) throw fail("invalid_date", "Pour une série, choisissez une échéance relative à la séance.", 422);
        await trx.updateTable("family_task_series").set({ title: seal(checked.title), note: sealOptional(checked.note), assigned_member_id: checked.assigneeId, due_time: checked.dueTime, days_before_event: input.daysBefore }).where("id", "=", taskId).execute();
        if (!target.proposed) {
          // Les occurrences à faire suivent le modèle : même titre, même personne, échéance recalculée sur chaque séance (jamais dans le passé).
          await sql`
            update family_tasks t
               set title = ${seal(checked.title)}, note = ${sealOptional(checked.note)}, assigned_member_id = ${checked.assigneeId}::uuid, due_time = ${checked.dueTime}::time, days_before_event = ${input.daysBefore}::smallint,
                   due_date = greatest(${v.today}::date, (e.starts_at at time zone ${v.timeZone})::date - ${input.daysBefore}::integer)
              from family_events e
             where t.series_id = ${taskId}::uuid and t.status = 'todo' and e.id = t.event_id`.execute(trx);
        }
        return;
      }
      const { due, daysBefore } = dueFor(e, input, w);
      await trx
        .updateTable("family_tasks")
        .set({ title: seal(checked.title), note: sealOptional(checked.note), due_date: due, due_time: checked.dueTime, days_before_event: daysBefore, assigned_member_id: checked.assigneeId })
        .where("id", "=", taskId)
        .execute();
    });
  } catch (error) {
    throw translateDbError(error);
  }
}

/** Retire une tâche du RDV : une tâche proposée est supprimée (D48), une tâche à faire est annulée, un modèle de série est supprimé ou terminé. */
export async function removeEventTask(ctx: Ctx, session: SessionContext, eventId: string, taskId: string, options: { expectedVersion?: number } = {}): Promise<void> {
  const { v, e } = await targetEvent(ctx, session, eventId);
  if (options.expectedVersion !== undefined && options.expectedVersion !== e.version) throw fail("stale_version", "Ce rendez-vous a été modifié entre-temps.", 409, { version: e.version });
  const target = await findTarget(ctx.db, e, taskId);
  if (target.status === "done") throw fail("already_handled", "Cette tâche est déjà faite.", 409);
  await ctx.db.transaction().execute(async (trx) => {
    if (target.kind === "template") {
      if (target.proposed) await trx.deleteFrom("family_task_series").where("id", "=", taskId).execute();
      else {
        await sql`select end_family_task_series(${taskId}::uuid, ${v.userId}::uuid)`.execute(trx);
        await trx.updateTable("family_tasks").set({ status: "cancelled", cancel_reason: "series_ended", status_changed_by_user_id: v.userId }).where("series_id", "=", taskId).where("status", "=", "todo").where("due_date", ">=", sql<Date>`${v.today}::date`).execute();
      }
      return;
    }
    if (target.proposed) await trx.deleteFrom("family_tasks").where("id", "=", taskId).execute();
    else {
      const { rows } = await sql<{ ok: boolean }>`select change_family_task_status(${taskId}::uuid, 'cancelled'::task_status, ${v.userId}::uuid, ${null}::integer, 'user'::task_cancel_reason) as ok`.execute(trx);
      if (!rows[0]?.ok) throw fail("already_handled", "Cette tâche n'est plus à faire.", 409);
    }
  });
}

/** « Confirmer sans les tâches » (US-95 RF4) : les tâches proposées sont abandonnées avant la confirmation. */
export async function dropProposedTasks(db: Kysely<DB>, e: CalendarEvent): Promise<void> {
  if (e.seriesId) await db.deleteFrom("family_task_series").where("event_series_id", "=", e.seriesId).where("proposed", "=", true).execute();
  else await db.deleteFrom("family_tasks").where("event_id", "=", e.id).where("status", "=", "proposed").execute();
}

/**
 * Un RDV provisoire devient une série (US-109 RF7) : ses tâches proposées deviennent des modèles de la nouvelle série, avant que le RDV d'origine ne soit remplacé par
 * les séances. L'écart à la séance est celui de la tâche proposée.
 */
export async function proposedTasksToTemplates(db: Kysely<DB>, e: CalendarEvent, newSeriesId: string, timeZone: string): Promise<number> {
  const rows = await selectTasks(db).where("t.event_id", "=", e.id).where("t.status", "=", "proposed").where("t.series_id", "is", null).execute();
  const eventDay = localDay(e.startsAt, timeZone);
  for (const r of rows) {
    const days = r.days_before_event ?? Math.max(0, Math.round((Date.parse(eventDay) - Date.parse(r.due_date)) / 86_400_000));
    await db
      .insertInto("family_task_series")
      .values({
        account_id: e.accountId, event_series_id: newSeriesId, days_before_event: days, title: r.title, note: r.note, assigned_member_id: r.assigned_member_id, due_time: r.due_time, proposed: true,
        created_by_user_id: r.created_by_user_id, source: "agent",
      })
      .execute();
  }
  return rows.length;
}

/** « Cette séance et les suivantes » : la nouvelle série reprend les modèles de tâche de l'ancienne (US-109 RF8, US-95 RF12). */
export async function copyTemplates(db: Kysely<DB>, fromSeriesId: string, toSeriesId: string, proposed: boolean): Promise<void> {
  const templates = await db.selectFrom("family_task_series").select(["account_id", "title", "note", "assigned_member_id", sql<string | null>`due_time::text`.as("due_time"), "days_before_event", "created_by_user_id", "source"]).where("event_series_id", "=", fromSeriesId).where("ended_at", "is", null).execute();
  for (const t of templates) {
    await db.insertInto("family_task_series").values({ ...t, event_series_id: toSeriesId, proposed }).execute();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Ajustements demandés à l'agent sur ses propres propositions (D61)
// ---------------------------------------------------------------------------------------------------------------------------

export interface ProposedTarget {
  id: string;
  kind: "task" | "template";
}

const normal = (text: string) => fold(text).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Retrouve, parmi les tâches d'un RDV, celles dont le titre correspond à ce que l'agent a écrit : le serveur compare, l'agent ne lit jamais un titre (AT-4). Seules les tâches
 * encore « proposées » peuvent être changées par l'agent ; le nombre de tâches déjà enregistrées qui correspondent est rendu pour qu'il renvoie le parent vers « Tâches ».
 */
export async function matchTasks(db: Kysely<DB>, e: CalendarEvent, wanted: string): Promise<{ proposed: ProposedTarget[]; registered: number }> {
  const needle = normal(wanted);
  const same = (title: string) => {
    const t = normal(title);
    return needle.length > 0 && (t === needle || t.includes(needle) || (t.length > 3 && needle.includes(t)));
  };
  const proposed: ProposedTarget[] = [];
  let registered = 0;
  if (e.seriesId) {
    const templates = await db.selectFrom("family_task_series").select(["id", "title", "proposed"]).where("event_series_id", "=", e.seriesId).where("ended_at", "is", null).execute();
    for (const t of templates) if (same(open(t.title))) (t.proposed ? proposed.push({ id: t.id, kind: "template" }) : registered++);
  } else {
    const rows = await selectTasks(db).where("t.event_id", "=", e.id).where("t.series_id", "is", null).where("t.status", "in", ["proposed", "todo", "done"]).execute();
    for (const r of rows) if (same(open(r.title))) (r.status === "proposed" ? proposed.push({ id: r.id, kind: "task" }) : registered++);
  }
  return { proposed, registered };
}

/** Change une tâche proposée : titre, échéance relative, personne. Une erreur de la base (échéance passée…) est traduite en refus lisible. */
export async function changeProposedTask(db: Kysely<DB>, w: WriteContext, e: CalendarEvent, target: ProposedTarget, input: { title?: string; daysBefore?: number; assigneeId?: string | null }): Promise<void> {
  try {
    if (target.kind === "template") {
      const patch: { title?: Buffer; days_before_event?: number; assigned_member_id?: string | null } = {};
      if (input.title) patch.title = seal(input.title);
      if (input.daysBefore !== undefined) patch.days_before_event = input.daysBefore;
      if (input.assigneeId !== undefined) patch.assigned_member_id = input.assigneeId;
      await db.updateTable("family_task_series").set(patch).where("id", "=", target.id).execute();
      return;
    }
    const row = await selectTasks(db).where("t.id", "=", target.id).executeTakeFirstOrThrow();
    const due = dueFor(e, input.daysBefore !== undefined ? { title: "", daysBefore: input.daysBefore } : row.days_before_event !== null ? { title: "", daysBefore: row.days_before_event } : { title: "", due: row.due_date }, w);
    await db
      .updateTable("family_tasks")
      .set({ title: seal(input.title ?? open(row.title)), due_date: due.due, days_before_event: due.daysBefore, assigned_member_id: input.assigneeId !== undefined ? input.assigneeId : row.assigned_member_id })
      .where("id", "=", target.id)
      .execute();
  } catch (error) {
    throw translateDbError(error);
  }
}

/** Retire une tâche proposée par l'agent (elle n'a jamais été enregistrée : suppression, comme avec la croix de la carte). */
export async function dropProposedTask(db: Kysely<DB>, target: ProposedTarget): Promise<void> {
  if (target.kind === "template") await db.deleteFrom("family_task_series").where("id", "=", target.id).where("proposed", "=", true).execute();
  else await db.deleteFrom("family_tasks").where("id", "=", target.id).where("status", "=", "proposed").execute();
}
