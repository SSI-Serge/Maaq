import { sql, type Kysely } from "kysely";
import { messenger } from "@/server/adapters/messaging";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { pushConfigured, sendPush } from "@/server/push/service";
import { describeError } from "@/server/safe-log";
import { integerSetting } from "@/server/settings";
import { open } from "./fields";
import { localDay, localToUtc } from "./local-time";
import { pendingConfirmations } from "./reminders";
import { addDays } from "./series";

/**
 * Notifications des tâches (US-97, US-96 RF4, RF6). Elles passent par le registre `scheduled_notifications`, comme celles des RDV : une ligne par envoi, réservée avant
 * d'envoyer, ce qui empêche tout doublon (RT1). Le contenu est composé par MAAQ, sans appel à l'agent (RT2). Les heures sont celles du fuseau de la famille (AF-2).
 */

type Db = Kysely<DB>;

/** Une réservation restée sans résultat au-delà de ce délai (serveur arrêté en plein envoi) est reprise. */
export const CLAIM_TTL_SECONDS = 600;
const DAILY_HOUR = "08:00";
const DAILY_DEADLINE = "12:00";
const ONE_HOUR = 3_600_000;

export interface TaskNoticesResult {
  daily: number;
  dueSoon: number;
  abandoned: number;
  failed: number;
}

export interface Recipient {
  id: string;
  firstName: string;
  email: string;
  memberId: string | null;
  /** Utilisateur principal et invité 1 : ils suivent les tâches sans assigné ou assignées à un enfant (AT-3). */
  parent: boolean;
  dailyEnabled: boolean;
}

export async function recipientsOf(db: Db, accountId: string): Promise<Recipient[]> {
  const rows = await db
    .selectFrom("users as u")
    .leftJoin("family_members as m", "m.user_id", "u.id")
    .leftJoin("user_assistant_settings as s", "s.user_id", "u.id")
    .select(["u.id", "u.first_name", "u.email", "u.role", "u.guest_rank", "m.id as member_id", "s.task_daily_reminder_enabled as daily"])
    .where("u.account_id", "=", accountId)
    .where("u.status", "in", ["active", "grace_period"])
    .where((eb) => eb.or([eb("u.role", "=", "primary_user"), eb("u.role", "=", "guest")]))
    .execute();
  return rows
    .filter((r) => r.email)
    .map((r) => ({ id: r.id, firstName: r.first_name, email: r.email, memberId: r.member_id, parent: r.role === "primary_user" || r.guest_rank === "core", dailyEnabled: r.daily ?? true }));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Textes
// ---------------------------------------------------------------------------------------------------------------------------

const clock = (time: string) => `${Number(time.slice(0, 2))}h${time.slice(3, 5)}`;
const frShort = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

function join(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

export interface NoticedTask {
  title: string;
  due: string;
  /** Personne assignée, quand ce n'est pas le destinataire : « Mia ». */
  other: string | null;
}

/**
 * « Aujourd'hui : 2 tâches — Sortir les poubelles et Payer la cantine (prévue le 23/10), si vous avez un moment. » (US-97 RF1). Jamais le mot « retard » (AT-9) ;
 * au plus trois titres, puis « et N autres ».
 */
export function taskDailyBody(tasks: NoticedTask[], today: string): string {
  const items = tasks.map((t) => `${t.title}${t.due < today ? ` (prévue le ${frShort(t.due)})` : ""}${t.other ? ` — ${t.other}` : ""}`);
  const shown = items.slice(0, 3);
  const rest = items.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} et ${rest} autre${rest > 1 ? "s" : ""}` : join(shown);
  const dueToday = tasks.some((t) => t.due >= today);
  const late = tasks.some((t) => t.due < today);
  return `${dueToday ? "Aujourd'hui" : "Quand vous avez un moment"} : ${tasks.length} tâche${tasks.length > 1 ? "s" : ""} — ${list}${late && dueToday ? ", si vous avez un moment" : ""}.`;
}

/** « Dans 1 h : Préparer le sac de piscine — Mia » (US-97 RF4) ; plus près de l'heure, le délai exact en minutes. */
export function taskSoonBody(title: string, other: string | null, minutes: number): string {
  return `Dans ${minutes >= 55 ? "1 h" : `${Math.max(1, minutes)} min`} : ${title}${other ? ` — ${other}` : ""}`;
}

/** « Camille vous a confié : Acheter un cadeau, avant jeudi » (US-96 RF4). */
export function taskAssignedBody(by: string, title: string, due: string, today: string, timeZone: string, time: string | null): string {
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const label = days <= 0 ? "aujourd'hui" : days === 1 ? "demain" : days < 7 ? new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", weekday: "long" }).format(new Date(`${due}T00:00:00Z`)) : frShort(due);
  return `${by} vous a confié : ${title}, avant ${label}${time ? ` ${clock(time)}` : ""}`;
}

const SIGNATURE = "\n\nL'équipe MAAQ";

function email(to: Recipient, subject: string, lines: string[], path: string): { to: string; subject: string; text: string } {
  return { to: to.email, subject, text: `Bonjour ${to.firstName},\n\n${lines.join("\n")}\n\nOuvrir : ${env().APP_URL.replace(/\/$/, "")}${path}\n\nVous recevez ce message de l'Assistant Famille. Il se règle dans Assistant Famille, Réglages.${SIGNATURE}` };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Réservation et envoi
// ---------------------------------------------------------------------------------------------------------------------------

type Kind = "task_daily" | "task_due_1h" | "task_assigned" | "weekly_digest" | "travel_first" | "travel_second" | "place_search_ready" | "outing_proposal";

/** Réserve une notification du jour ou de la semaine : un seul passage l'obtient (US-97 RF9). Une réservation sans résultat depuis 10 minutes est reprise. */
export async function claimDaily(ctx: Ctx, kind: "task_daily" | "weekly_digest" | "outing_proposal", userId: string, day: string, dueAt: Date, deadline: Date): Promise<boolean> {
  const row = await ctx.db
    .insertInto("scheduled_notifications")
    .values({ kind, subject_date: day, due_at: dueAt, deadline_at: deadline, recipient_user_id: userId, status: "scheduled", attempts: 1 })
    .onConflict((oc) =>
      oc
        .columns(["kind", "recipient_user_id", "subject_date"])
        .where(sql<boolean>`subject_date is not null`)
        .doUpdateSet({ attempts: sql<number>`scheduled_notifications.attempts + 1` })
        .where("scheduled_notifications.status", "=", "scheduled")
        .where(sql<boolean>`scheduled_notifications.updated_at < now() - ${sql.lit(`${CLAIM_TTL_SECONDS} seconds`)}::interval`),
    )
    .returning("id")
    .executeTakeFirst();
  return Boolean(row);
}

async function claimTask(ctx: Ctx, kind: "task_due_1h" | "task_assigned", taskId: string, userId: string, dueAt: Date, deadline: Date): Promise<boolean> {
  const row = await ctx.db
    .insertInto("scheduled_notifications")
    .values({ kind, task_id: taskId, due_at: dueAt, deadline_at: deadline, recipient_user_id: userId, status: "scheduled", attempts: 1 })
    .onConflict((oc) =>
      oc
        .columns(["task_id", "kind", "recipient_user_id", "due_at"])
        .where(sql<boolean>`task_id is not null`)
        .doUpdateSet({ attempts: sql<number>`scheduled_notifications.attempts + 1` })
        .where("scheduled_notifications.status", "=", "scheduled")
        .where(sql<boolean>`scheduled_notifications.updated_at < now() - ${sql.lit(`${CLAIM_TTL_SECONDS} seconds`)}::interval`),
    )
    .returning("id")
    .executeTakeFirst();
  return Boolean(row);
}

export interface Slot {
  kind: Kind;
  userId: string;
  day?: string;
  taskId?: string;
  /** Notification de trajet : liée à un RDV, une seule ligne par profil et par RDV (US-107 RT4). */
  eventId?: string;
  dueAt: Date;
}

async function finish(ctx: Ctx, slot: Slot, patch: { status: "sent" | "abandoned" | "not_applicable"; push?: boolean; email?: boolean }): Promise<void> {
  let q = ctx.db
    .updateTable("scheduled_notifications")
    .set({ status: patch.status, push_sent_at: patch.push ? ctx.now : null, email_sent_at: patch.email ? ctx.now : null })
    .where("kind", "=", slot.kind)
    .where("recipient_user_id", "=", slot.userId)
    .where("status", "=", "scheduled");
  q = slot.day ? q.where("subject_date", "=", sql<Date>`${slot.day}::date`) : slot.eventId ? q.where("event_id", "=", slot.eventId) : q.where("task_id", "=", slot.taskId!).where("due_at", "=", slot.dueAt);
  await q.execute();
}

async function release(ctx: Ctx, slot: Slot): Promise<void> {
  let q = ctx.db.deleteFrom("scheduled_notifications").where("kind", "=", slot.kind).where("recipient_user_id", "=", slot.userId).where("status", "=", "scheduled");
  q = slot.day ? q.where("subject_date", "=", sql<Date>`${slot.day}::date`) : slot.eventId ? q.where("event_id", "=", slot.eventId) : q.where("task_id", "=", slot.taskId!).where("due_at", "=", slot.dueAt);
  await q.execute();
}

/**
 * Envoie une notification réservée : sur les appareils autorisés, par email à défaut quand `emailFallback` (le rappel quotidien et l'assignation ; jamais le rappel d'une
 * heure avant, qui n'a plus de sens par email). Rien n'étant parti, la réservation est libérée et le passage suivant réessaie jusqu'à l'échéance (RF9).
 */
export async function dispatch(ctx: Ctx, accountId: string, to: Recipient, slot: Slot, message: { body: string; url: string; tag: string; subject: string; lines: string[] }, emailFallback: boolean): Promise<"sent" | "skipped" | "failed"> {
  let pushed = 0;
  try {
    const badge = pushConfigured() ? await pendingConfirmations(ctx.db, accountId, ctx.now) : 0;
    pushed = (await sendPush(ctx, to.id, { title: "Assistant Famille", body: message.body, url: message.url, tag: message.tag, badge })).delivered;
    let emailed = false;
    if (pushed === 0 && emailFallback) {
      await messenger().sendEmail(email(to, message.subject, message.lines, message.url));
      emailed = true;
    }
    if (pushed === 0 && !emailed) {
      await finish(ctx, slot, { status: "not_applicable" });
      return "skipped";
    }
    await finish(ctx, slot, { status: "sent", push: pushed > 0, email: emailed });
    return "sent";
  } catch (error) {
    console.error(`Notification non envoyée : ${describeError(error)}`);
    if (pushed > 0) {
      await finish(ctx, slot, { status: "sent", push: true });
      return "sent";
    }
    await release(ctx, slot);
    return "failed";
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Planificateur
// ---------------------------------------------------------------------------------------------------------------------------

interface OpenTask {
  id: string;
  title: Buffer;
  due: string;
  dueTime: string | null;
  assignedMemberId: string | null;
  assignedUserId: string | null;
}

async function loadOpenTasks(db: Db, accountId: string, from: string, to: string): Promise<OpenTask[]> {
  const rows = await db
    .selectFrom("family_tasks as t")
    .leftJoin("family_members as m", "m.id", "t.assigned_member_id")
    .select(["t.id", "t.title", sql<string>`t.due_date::text`.as("due"), sql<string | null>`t.due_time::text`.as("due_time"), "t.assigned_member_id", "m.user_id as assigned_user"])
    .where("t.account_id", "=", accountId)
    .where("t.status", "=", "todo")
    .where("t.due_date", ">=", sql<Date>`${from}::date`)
    .where("t.due_date", "<=", sql<Date>`${to}::date`)
    .execute();
  return rows.map((r) => ({ id: r.id, title: r.title, due: r.due, dueTime: r.due_time, assignedMemberId: r.assigned_member_id, assignedUserId: r.assigned_user }));
}

/** Les tâches comptées pour un profil : celles de son membre ; pour les deux parents, aussi celles sans assigné ou assignées à un membre sans compte (US-97 RF2, AT-3). */
const countsFor = (r: Recipient, t: OpenTask) => (r.memberId !== null && t.assignedMemberId === r.memberId) || (r.parent && (t.assignedMemberId === null || t.assignedUserId === null));

/**
 * Un passage : rappel quotidien de 8 h (une notification par profil, rien s'il n'a aucune tâche, abandonné après midi) et rappel d'une heure avant les tâches qui ont une
 * heure d'échéance. Sans danger à relancer : un envoi déjà fait ou réservé n'est jamais refait.
 */
export async function runTaskNotices(ctx: Ctx, options: { accountId?: string } = {}): Promise<TaskNoticesResult> {
  const totals: TaskNoticesResult = { daily: 0, dueSoon: 0, abandoned: 0, failed: 0 };
  const overdueDays = await integerSetting(ctx.db, "overdue_task_reminder_days", 7);
  const accounts = await ctx.db
    .selectFrom("accounts")
    .select(["id", "family_timezone"])
    .where("status", "in", ["active", "grace_period"])
    .$if(Boolean(options.accountId), (qb) => qb.where("id", "=", options.accountId!))
    .execute();
  for (const account of accounts) {
    try {
      const timeZone = account.family_timezone ?? "Europe/Paris";
      const today = localDay(ctx.now, timeZone);
      const recipients = await recipientsOf(ctx.db, account.id);
      if (!recipients.length) continue;
      const members = new Map((await ctx.db.selectFrom("family_members").select(["id", "first_name"]).where("account_id", "=", account.id).execute()).map((m) => [m.id, m.first_name ?? ""]));
      const tasks = await loadOpenTasks(ctx.db, account.id, addDays(today, -overdueDays), addDays(today, 1));

      // --- Rappel quotidien de 8 h -----------------------------------------------------------------------------------------
      const dueAt = localToUtc(`${today}T${DAILY_HOUR}`, timeZone);
      const deadline = localToUtc(`${today}T${DAILY_DEADLINE}`, timeZone);
      if (ctx.now >= dueAt) {
        for (const r of recipients) {
          if (!r.dailyEnabled) continue;
          const mine = tasks.filter((t) => t.due <= today && countsFor(r, t)).sort((a, b) => a.due.localeCompare(b.due) || (a.dueTime ?? "").localeCompare(b.dueTime ?? ""));
          if (!mine.length) continue;
          if (ctx.now > deadline) {
            // Trop tard : le rappel du jour est abandonné, et ne sera pas retenté (RF9).
            const gone = await ctx.db.insertInto("scheduled_notifications").values({ kind: "task_daily", subject_date: today, due_at: dueAt, deadline_at: deadline, recipient_user_id: r.id, status: "abandoned" }).onConflict((oc) => oc.columns(["kind", "recipient_user_id", "subject_date"]).where(sql<boolean>`subject_date is not null`).doNothing()).returning("id").executeTakeFirst();
            if (gone) totals.abandoned += 1;
            continue;
          }
          if (!(await claimDaily(ctx, "task_daily", r.id, today, dueAt, deadline))) continue;
          const noticed = mine.map((t): NoticedTask => ({ title: open(t.title), due: t.due, other: t.assignedMemberId && t.assignedMemberId !== r.memberId ? (members.get(t.assignedMemberId) ?? null) : null }));
          const body = taskDailyBody(noticed, today);
          const out = await dispatch(ctx, account.id, r, { kind: "task_daily", userId: r.id, day: today, dueAt }, { body, url: "/assistant/taches#aujourdhui", tag: `task-daily-${today}`, subject: body, lines: [body, "", ...noticed.map((t) => `• ${t.title}${t.due < today ? ` (prévue le ${frShort(t.due)})` : ""}`)] }, true);
          if (out === "sent") totals.daily += 1;
          else if (out === "failed") totals.failed += 1;
        }
      }

      // --- Une heure avant l'heure d'échéance ------------------------------------------------------------------------------
      for (const t of tasks.filter((x) => x.dueTime && x.due >= today)) {
        const instant = localToUtc(`${t.due}T${t.dueTime!.slice(0, 5)}`, timeZone);
        const remindAt = new Date(instant.getTime() - ONE_HOUR);
        if (!(remindAt <= ctx.now && ctx.now < instant)) continue;
        // La personne assignée, si elle a un compte ; sinon les deux parents (AT-3).
        const to = t.assignedUserId ? recipients.filter((r) => r.id === t.assignedUserId) : recipients.filter((r) => r.parent);
        for (const r of to) {
          if (!(await claimTask(ctx, "task_due_1h", t.id, r.id, remindAt, instant))) continue;
          const other = t.assignedMemberId && t.assignedMemberId !== r.memberId ? (members.get(t.assignedMemberId) ?? null) : null;
          const body = taskSoonBody(open(t.title), other, Math.round((instant.getTime() - ctx.now.getTime()) / 60_000));
          const out = await dispatch(ctx, account.id, r, { kind: "task_due_1h", userId: r.id, taskId: t.id, dueAt: remindAt }, { body, url: "/assistant/taches#aujourdhui", tag: `task-soon-${t.id}`, subject: body, lines: [body] }, false);
          if (out === "sent") totals.dueSoon += 1;
          else if (out === "failed") totals.failed += 1;
        }
      }
    } catch (error) {
      console.error(`Rappels de tâches (foyer) : ${describeError(error)}`);
      totals.failed += 1;
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Assignation (US-96 RF4, RF6)
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * « [Prénom] vous a confié : [titre], avant [échéance] » : le membre assigné, s'il a un compte et n'est pas celui qui assigne, est prévenu tout de suite. L'ancien membre n'est
 * pas prévenu (RF6). Une erreur ne fait jamais échouer l'assignation elle-même.
 */
export async function notifyTaskAssigned(ctx: Ctx, taskId: string, byUserId: string): Promise<void> {
  try {
    const row = await ctx.db
      .selectFrom("family_tasks as t")
      .innerJoin("family_members as m", "m.id", "t.assigned_member_id")
      .innerJoin("accounts as a", "a.id", "t.account_id")
      .select(["t.account_id", "t.title", sql<string>`t.due_date::text`.as("due"), sql<string | null>`t.due_time::text`.as("due_time"), "m.user_id", "a.family_timezone"])
      .where("t.id", "=", taskId)
      .where("t.status", "=", "todo")
      .executeTakeFirst();
    if (!row?.user_id || row.user_id === byUserId) return;
    const [recipient] = (await recipientsOf(ctx.db, row.account_id)).filter((r) => r.id === row.user_id);
    const by = await ctx.db.selectFrom("users").select("first_name").where("id", "=", byUserId).executeTakeFirst();
    if (!recipient || !by) return;
    const timeZone = row.family_timezone ?? "Europe/Paris";
    const slot: Slot = { kind: "task_assigned", userId: recipient.id, taskId, dueAt: ctx.now };
    if (!(await claimTask(ctx, "task_assigned", taskId, recipient.id, ctx.now, new Date(ctx.now.getTime() + 24 * ONE_HOUR)))) return;
    const body = taskAssignedBody(by.first_name, open(row.title), row.due, localDay(ctx.now, timeZone), timeZone, row.due_time);
    await dispatch(ctx, row.account_id, recipient, slot, { body, url: "/assistant/taches", tag: `task-assigned-${taskId}`, subject: body, lines: [body] }, true);
  } catch (error) {
    console.error(`Notification d'assignation non envoyée : ${describeError(error)}`);
  }
}

