import { describeError } from "@/server/safe-log";
import { sql, type Kysely } from "kysely";
import { messenger, type OutgoingEmail } from "@/server/adapters/messaging";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { EVENT_TYPES, TYPE_CODE, eventTypeIds, loadCalendarEvent, typeOfCode, type CalendarEvent, type EventType } from "./calendar";
import { requireFamilyProfile, requireParent } from "./family";
import { localToUtc, utcToLocal } from "./local-time";
import { AUTO_CONFIRM_WARNING, nudgeEmail, nudgeHeadline, reminderEmail, reminderPushBody, type NotifiedEvent, type NudgeKind, type ReminderKind } from "./reminder-text";
import { pushConfigured, sendPush, type PushPayload } from "@/server/push/service";

/**
 * Rappels (US-81), délais par type (US-82) et relances (US-83), envoyés par email. Les échéances ne sont pas enregistrées : elles sont recalculées
 * à chaque passage du planificateur à partir du rendez-vous et des réglages, donc une modification d'horaire ou de réglage s'applique d'elle-même.
 * Seuls les envois sont enregistrés (`scheduled_notifications`), avec une clé unique par rendez-vous, type, destinataire et échéance : un rendez-vous
 * déplacé a de nouvelles échéances, donc de nouveaux rappels.
 */

type Db = Kysely<DB>;

export type { NudgeKind, ReminderKind };
export const REMINDER_KINDS: ReminderKind[] = ["d7", "d1", "d0"];
export const REMINDER_LABEL: Record<ReminderKind, string> = { d7: "J-7", d1: "J-1", d0: "Jour J" };
const NUDGE_KINDS: NudgeKind[] = ["nudge24", "nudge48"];
const NUDGE_HOURS: Record<NudgeKind, number> = { nudge24: 24, nudge48: 48 };
/** Valeur de `notification_kind` de chaque rappel et relance. */
const KIND_CODE = { d7: "reminder_d7", d1: "reminder_d1", d0: "reminder_day_of", nudge24: "follow_up_24h", nudge48: "follow_up_48h" } as const;
type KindCode = (typeof KIND_CODE)[ReminderKind | NudgeKind];
/** Colonne du réglage de chaque rappel. */
const SETTING_COLUMN = { d7: "remind_d7", d1: "remind_d1", d0: "remind_day_of" } as const;

const HOUR = 3_600_000;
/** Une réservation d'envoi restée sans résultat (serveur arrêté en plein envoi) est reprise au bout de ce délai. */
const CLAIM_TTL = 10 * 60_000;
/** Les échéances de rappel sont à J-7 au plus : inutile de regarder plus loin. */
const REMINDER_HORIZON_DAYS = 9;

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------------------
// Échéances
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Échéance d'un rappel, dans le fuseau du foyer (US-81 RF2) : J-7 à 9 h, J-1 à 18 h, le jour J à 7 h 30, ou 2 heures avant le début si le
 * rendez-vous commence avant 9 h 30. Un rendez-vous sur la journée entière n'a pas d'heure de début : son rappel du jour part à 7 h 30.
 */
export function reminderDueAt(kind: ReminderKind, event: { startsAt: Date; allDay: boolean }, timeZone: string): Date {
  const local = utcToLocal(event.startsAt, timeZone);
  const day = local.slice(0, 10);
  if (kind === "d7") return localToUtc(`${addDays(day, -7)}T09:00`, timeZone);
  if (kind === "d1") return localToUtc(`${addDays(day, -1)}T18:00`, timeZone);
  return !event.allDay && local.slice(11) < "09:30" ? new Date(event.startsAt.getTime() - 2 * HOUR) : localToUtc(`${day}T07:30`, timeZone);
}

/** Échéance d'une relance : 24 h ou 48 h après la création, décalée à 8 h si elle tombe entre 21 h et 8 h (US-83 RF1, RF4). */
export function nudgeDueAt(kind: NudgeKind, createdAt: Date, timeZone: string): Date {
  const raw = new Date(createdAt.getTime() + NUDGE_HOURS[kind] * HOUR);
  const local = utcToLocal(raw, timeZone);
  const hour = Number(local.slice(11, 13));
  if (hour >= 21) return localToUtc(`${addDays(local.slice(0, 10), 1)}T08:00`, timeZone);
  if (hour < 8) return localToUtc(`${local.slice(0, 10)}T08:00`, timeZone);
  return raw;
}

/** Instant où un rendez-vous écarté disparaît : à la relance suivante prévue, sinon 24 heures après (US-77 RF3). */
export function setAsideExpiry(createdAt: Date, setAsideAt: Date, timeZone: string): Date {
  const next = NUDGE_KINDS.map((k) => nudgeDueAt(k, createdAt, timeZone)).find((due) => due > setAsideAt);
  return next ?? new Date(setAsideAt.getTime() + 24 * HOUR);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Foyer : fuseau, destinataires, réglages
// ---------------------------------------------------------------------------------------------------------------------------

/** Fuseau du foyer (AF-2) : celui de l'appareil de l'utilisateur principal à sa dernière connexion, tenu dans le compte. */
export async function familyTimeZone(db: Db, accountId: string): Promise<string> {
  const row = await db.selectFrom("accounts").select("family_timezone").where("id", "=", accountId).executeTakeFirst();
  return row?.family_timezone ?? "Europe/Paris";
}

interface Recipient {
  id: string;
  firstName: string;
  email: string;
}

/** Les deux parents (utilisateur principal et invité 1) reçoivent tous les rappels et relances (D28, US-81 RF3). */
async function parents(db: Db, accountId: string): Promise<Recipient[]> {
  const rows = await db
    .selectFrom("users")
    .select(["id", "first_name", "email"])
    .where("account_id", "=", accountId)
    .where("status", "in", ["active", "grace_period"])
    .where((eb) => eb.or([eb("role", "=", "primary_user"), eb.and([eb("role", "=", "guest"), eb("guest_rank", "=", "core")])]))
    .execute();
  return rows.filter((r) => r.email).map((r) => ({ id: r.id, firstName: r.first_name, email: r.email }));
}

export interface ReminderSetting {
  type: EventType;
  d7: boolean;
  d1: boolean;
  d0: boolean;
  /** Dernier changement de ce type : les rappels qui le précèdent ne sont plus rattrapés. */
  updatedAt: Date | null;
}

async function loadSettings(db: Db, accountId: string): Promise<Map<EventType, ReminderSetting>> {
  const rows = await db
    .selectFrom("family_reminder_settings as s")
    .innerJoin("event_types as t", "t.id", "s.event_type_id")
    .select(["t.code", "s.remind_d7", "s.remind_d1", "s.remind_day_of", "s.updated_at"])
    .where("s.account_id", "=", accountId)
    .execute();
  const byType = new Map(rows.map((r) => [typeOfCode(r.code), r]));
  return new Map(
    EVENT_TYPES.map((type) => {
      const r = byType.get(type);
      return [type, { type, d7: r?.remind_d7 ?? true, d1: r?.remind_d1 ?? true, d0: r?.remind_day_of ?? true, updatedAt: r ? new Date(r.updated_at) : null }];
    }),
  );
}

/** US-82 : les six types avec leurs trois interrupteurs. Valeurs par défaut : tout actif. */
export async function getReminderSettings(ctx: Ctx, session: SessionContext): Promise<{ settings: Omit<ReminderSetting, "updatedAt">[]; canEdit: boolean }> {
  // Lisibles par tout profil de la famille, modifiables par les seuls parents (D58, US-113 RT6).
  const { accountId, parent } = requireFamilyProfile(session);
  const settings = await loadSettings(ctx.db, accountId);
  return { settings: [...settings.values()].map(({ type, d7, d1, d0 }) => ({ type, d7, d1, d0 })), canEdit: parent };
}

/** US-82 RF5, RF6 : un interrupteur est enregistré dès qu'il est touché ; il s'applique aux rappels non encore envoyés. */
export async function setReminderSetting(ctx: Ctx, session: SessionContext, input: { type: string; kind: string; enabled: boolean }): Promise<Omit<ReminderSetting, "updatedAt">> {
  const accountId = requireParent(session);
  if (!EVENT_TYPES.includes(input.type as EventType)) throw new Rejection("invalid_type", "Ce type de rendez-vous est inconnu.", 422);
  if (!REMINDER_KINDS.includes(input.kind as ReminderKind)) throw new Rejection("invalid_kind", "Ce rappel est inconnu.", 422);
  const type = input.type as EventType;
  const kind = input.kind as ReminderKind;
  const column = SETTING_COLUMN[kind];
  const typeId = (await eventTypeIds(ctx.db)).get(TYPE_CODE[type])!;
  await ctx.db
    .insertInto("family_reminder_settings")
    .values({ account_id: accountId, event_type_id: typeId, [column]: input.enabled, updated_by_user_id: session.user.id })
    .onConflict((oc) => oc.columns(["account_id", "event_type_id"]).doUpdateSet({ [column]: input.enabled, updated_by_user_id: session.user.id }))
    .execute();
  const { d7, d1, d0 } = (await loadSettings(ctx.db, accountId)).get(type)!;
  return { type, d7, d1, d0 };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Détail d'un rendez-vous (US-79, US-81 RF5/RF10, US-83 RF8)
// ---------------------------------------------------------------------------------------------------------------------------

export interface ReminderView {
  kind: ReminderKind;
  label: string;
  /** Envoyé, prévu, non applicable (échéance déjà passée à la confirmation) ou désactivé dans les réglages. */
  state: "sent" | "planned" | "not_applicable" | "off";
  /** Échéance, en heure locale du profil : « AAAA-MM-JJTHH:MM ». */
  at: string;
}

export interface NudgeView {
  kind: NudgeKind;
  sentAt: string;
}

/** Instant à partir duquel les rappels d'un rendez-vous s'appliquent : sa dernière modification (confirmation ou changement d'horaire comprises), et le dernier réglage du type. */
function cutoff(event: { updatedAt: Date }, setting: ReminderSetting): number {
  return Math.max(event.updatedAt.getTime(), setting.updatedAt?.getTime() ?? 0);
}

/** Rappels dus à cet instant, du plus ancien au plus récent : seul le dernier est envoyé (après un long incident, J-7 n'a plus de sens si J-1 est arrivé). */
function dueKinds(event: { startsAt: Date; allDay: boolean; updatedAt: Date }, setting: ReminderSetting, timeZone: string, now: Date): ReminderKind[] {
  if (now >= event.startsAt) return [];
  return REMINDER_KINDS.filter((k) => setting[k])
    .map((k) => ({ k, due: reminderDueAt(k, event, timeZone) }))
    .filter(({ due }) => due <= now && due.getTime() >= cutoff(event, setting))
    .sort((a, b) => a.due.getTime() - b.due.getTime())
    .map(({ k }) => k);
}

export async function reminderDetails(db: Db, accountId: string, event: CalendarEvent, viewerTimeZone: string, now: Date): Promise<{ reminders: ReminderView[]; nudge: NudgeView | null }> {
  const timeZone = await familyTimeZone(db, accountId);
  const sent = await db
    .selectFrom("scheduled_notifications")
    .select(["kind", "due_at", sql<Date>`coalesce(email_sent_at, push_sent_at)`.as("sent_at")])
    .where("event_id", "=", event.id)
    .where("status", "=", "sent")
    .orderBy("updated_at", "desc")
    .execute();
  const lastNudge = sent.find((n) => n.kind === KIND_CODE.nudge24 || n.kind === KIND_CODE.nudge48);
  const nudge = event.status === "provisional" && lastNudge?.sent_at ? { kind: lastNudge.kind === KIND_CODE.nudge48 ? ("nudge48" as const) : ("nudge24" as const), sentAt: new Date(lastNudge.sent_at).toISOString() } : null;
  if (event.status !== "confirmed") return { reminders: [], nudge };

  const timing = { startsAt: event.startsAt, allDay: event.allDay, updatedAt: event.updatedAt };
  const setting = (await loadSettings(db, accountId)).get(event.type)!;
  const pending = dueKinds(timing, setting, timeZone, now);
  const reminders = REMINDER_KINDS.map((kind): ReminderView => {
    const due = reminderDueAt(kind, event, timeZone);
    const at = utcToLocal(due, viewerTimeZone);
    const label = REMINDER_LABEL[kind];
    if (!setting[kind]) return { kind, label, state: "off", at };
    // Un rappel envoyé pour une ancienne date d'un rendez-vous déplacé ne compte pas : l'échéance doit être la même.
    if (sent.some((n) => n.kind === KIND_CODE[kind] && new Date(n.due_at).getTime() === due.getTime())) return { kind, label, state: "sent", at };
    if (due.getTime() < cutoff(timing, setting)) return { kind, label, state: "not_applicable", at };
    if (due > now) return { kind, label, state: "planned", at };
    // Échéance passée sans envoi : le rappel part au prochain passage s'il est le plus récent dû, sinon il est dépassé.
    return { kind, label, state: pending[pending.length - 1] === kind ? "planned" : "not_applicable", at };
  });
  return { reminders, nudge };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Planificateur
// ---------------------------------------------------------------------------------------------------------------------------

export interface RemindersResult {
  sent: number;
  failed: number;
  /** Rendez-vous passés au statut Ignoré. */
  ignored: number;
}

interface Family {
  timeZone: string;
  recipients: Recipient[];
  settings: Map<EventType, ReminderSetting>;
}

/**
 * Réserve un envoi : un seul passage (ou serveur) l'obtient, ce qui empêche tout doublon (US-81 RT2). Une réservation restée sans résultat
 * au-delà de `CLAIM_TTL` (serveur arrêté en plein envoi) est reprise ; l'horloge est celle de la base, qui date aussi la réservation.
 */
async function claim(ctx: Ctx, eventId: string, kind: KindCode, dueAt: Date, userId: string): Promise<boolean> {
  const row = await ctx.db
    .insertInto("scheduled_notifications")
    .values({ event_id: eventId, kind, due_at: dueAt, recipient_user_id: userId, status: "scheduled", attempts: 1 })
    .onConflict((oc) =>
      oc
        .columns(["event_id", "kind", "recipient_user_id", "due_at"])
        .where(sql<boolean>`event_id is not null`)
        .doUpdateSet({ attempts: sql<number>`scheduled_notifications.attempts + 1` })
        .where("scheduled_notifications.status", "=", "scheduled")
        .where(sql<boolean>`scheduled_notifications.updated_at < now() - ${sql.lit(`${CLAIM_TTL / 1000} seconds`)}::interval`),
    )
    .returning("id")
    .executeTakeFirst();
  return Boolean(row);
}

/** Les envois en cours d'un rendez-vous ne servent plus quand il est déplacé, annulé ou confirmé : ils passent à « annulé » (même transaction). */
export async function cancelPendingNotices(db: Db, eventId: string, kinds: KindCode[]): Promise<void> {
  await db.updateTable("scheduled_notifications").set({ status: "cancelled" }).where("event_id", "=", eventId).where("status", "=", "scheduled").where("kind", "in", kinds).execute();
}

interface Message {
  email: OutgoingEmail;
  push: Omit<PushPayload, "badge" | "tag">;
}

/** Confirmations en attente d'un foyer : le nombre porté par chaque notification pour le badge de l'icône (US-84 RF1, RT2). */
export async function pendingConfirmations(db: Db, accountId: string, now: Date): Promise<number> {
  const row = await db
    .selectFrom("family_events")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("account_id", "=", accountId)
    .where("status", "=", "provisional")
    .where("starts_at", ">", now)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/**
 * Envoie à chaque destinataire : par notification sur ses appareils autorisés, par email à défaut ou si la notification n'est pas partie (US-81 RF6,
 * RF11). Le rappel J-1 est toujours doublé par un email (AF-3). Après un envoi réussi par notification, un email en échec ne fait pas rejouer la
 * notification : la réservation est conservée.
 */
async function deliver(ctx: Ctx, accountId: string, eventId: string, kind: ReminderKind | NudgeKind, dueAt: Date, recipients: Recipient[], build: (to: Recipient) => Message, totals: RemindersResult): Promise<void> {
  const badge = pushConfigured() ? await pendingConfirmations(ctx.db, accountId, ctx.now) : 0;
  for (const to of recipients) {
    if (!(await claim(ctx, eventId, KIND_CODE[kind], dueAt, to.id))) continue;
    const message = build(to);
    let pushed = 0;
    try {
      pushed = (await sendPush(ctx, to.id, { ...message.push, tag: `${kind}-${eventId}`, badge })).delivered;
      const email = pushed === 0 || kind === "d1";
      if (email) await messenger().sendEmail(message.email);
      await markSent(ctx, eventId, kind, dueAt, to.id, { push: pushed > 0, email });
      totals.sent += 1;
    } catch (error) {
      console.error(`Rappel non envoyé : ${describeError(error)}`);
      if (pushed > 0) {
        // La notification est partie : on garde l'envoi pour ne pas la rejouer ; seul l'email de J-1 manque.
        await markSent(ctx, eventId, kind, dueAt, to.id, { push: true, email: false });
        totals.sent += 1;
        continue;
      }
      // Rien n'est parti : on libère la réservation, et le passage suivant réessaie tant que le rendez-vous n'a pas commencé (US-81 RF8).
      await ctx.db.deleteFrom("scheduled_notifications").where("event_id", "=", eventId).where("kind", "=", KIND_CODE[kind]).where("due_at", "=", dueAt).where("recipient_user_id", "=", to.id).where("status", "=", "scheduled").execute();
      totals.failed += 1;
    }
  }
}

async function markSent(ctx: Ctx, eventId: string, kind: ReminderKind | NudgeKind, dueAt: Date, userId: string, via: { push: boolean; email: boolean }): Promise<void> {
  await ctx.db
    .updateTable("scheduled_notifications")
    .set({ status: "sent", push_sent_at: via.push ? ctx.now : null, email_sent_at: via.email ? ctx.now : null })
    .where("event_id", "=", eventId)
    .where("kind", "=", KIND_CODE[kind])
    .where("due_at", "=", dueAt)
    .where("recipient_user_id", "=", userId)
    .execute();
}

async function notified(db: Db, accountId: string, id: string): Promise<NotifiedEvent | undefined> {
  const e = await loadCalendarEvent(db, accountId, id);
  return e && { id: e.id, title: e.title, type: e.type, place: e.place, startsAt: e.startsAt, allDay: e.allDay };
}

/** Un rendez-vous jamais confirmé disparaît à son début ; un rendez-vous écarté à la relance suivante prévue (US-83 RF6, US-77 RF3). */
async function ignoreExpired(ctx: Ctx, family: (accountId: string) => Promise<Family>, totals: RemindersResult, accountId: string | undefined): Promise<void> {
  const rows = await ctx.db
    .selectFrom("family_events")
    .select(["id", "account_id", "status", "starts_at", "created_at", "status_changed_at"])
    .where((eb) => eb.or([eb.and([eb("status", "=", "provisional"), eb("starts_at", "<=", ctx.now)]), eb("status", "=", "set_aside")]))
    .$if(Boolean(accountId), (qb) => qb.where("account_id", "=", accountId!))
    .execute();
  for (const row of rows) {
    const expired =
      row.status === "provisional" || row.starts_at <= ctx.now || setAsideExpiry(new Date(row.created_at), new Date(row.status_changed_at), (await family(row.account_id)).timeZone) <= ctx.now;
    if (!expired) continue;
    await ctx.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom("family_events").select(["status"]).where("id", "=", row.id).forUpdate().executeTakeFirst();
      if (!current || current.status !== row.status) return; // un parent est passé entre-temps
      // Par le système (aucun auteur) : « l'heure est venue » pour un provisoire, « sans réponse » pour un écarté.
      const reason = row.status === "provisional" ? "event_started" : "no_response";
      const done = await sql<{ ok: boolean }>`select change_family_event_status(${row.id}::uuid, 'dismissed'::event_status, ${null}::uuid, ${null}::integer, ${reason}::event_change_reason) as ok`.execute(trx);
      if (done.rows[0]?.ok) totals.ignored += 1;
    });
  }
}

/**
 * Un passage du planificateur : rendez-vous sans réponse passés à « Ignoré », rappels dus des rendez-vous confirmés, relances dues des rendez-vous
 * provisoires. Sans danger à relancer : un envoi déjà fait ou réservé n'est jamais refait. `accountId` limite le passage à un foyer (tests).
 */
export async function runReminders(ctx: Ctx, options: { accountId?: string } = {}): Promise<RemindersResult> {
  const totals: RemindersResult = { sent: 0, failed: 0, ignored: 0 };
  const families = new Map<string, Promise<Family>>();
  const family = (accountId: string) => {
    let known = families.get(accountId);
    if (!known) {
      known = Promise.all([familyTimeZone(ctx.db, accountId), parents(ctx.db, accountId), loadSettings(ctx.db, accountId)]).then(([timeZone, recipients, settings]) => ({ timeZone, recipients, settings }));
      families.set(accountId, known);
    }
    return known;
  };

  await ignoreExpired(ctx, family, totals, options.accountId);

  const appUrl = env().APP_URL.replace(/\/$/, "");
  const horizon = new Date(ctx.now.getTime() + REMINDER_HORIZON_DAYS * 86_400_000);

  // Rappels : rendez-vous confirmés à venir (US-81).
  const confirmed = await ctx.db
    .selectFrom("family_events as e")
    .innerJoin("event_types as t", "t.id", "e.event_type_id")
    .select(["e.id", "e.account_id", "t.code", "e.starts_at", "e.all_day", "e.updated_at"])
    .where("e.status", "=", "confirmed")
    .where("e.starts_at", ">", ctx.now)
    .where("e.starts_at", "<", horizon)
    .$if(Boolean(options.accountId), (qb) => qb.where("e.account_id", "=", options.accountId!))
    .execute();
  for (const row of confirmed) {
    const { timeZone, recipients, settings } = await family(row.account_id);
    const timing = { startsAt: new Date(row.starts_at), allDay: row.all_day, updatedAt: new Date(row.updated_at) };
    const due = dueKinds(timing, settings.get(typeOfCode(row.code))!, timeZone, ctx.now);
    const kind = due[due.length - 1];
    if (!kind) continue;
    const event = await notified(ctx.db, row.account_id, row.id);
    if (!event) continue;
    await deliver(ctx, row.account_id, row.id, kind, reminderDueAt(kind, timing, timeZone), recipients, (to) => ({
      email: reminderEmail({ firstName: to.firstName, to: to.email, event, timeZone, now: ctx.now, appUrl }),
      push: { title: "Assistant Famille", body: reminderPushBody(event, timeZone, ctx.now), url: `/calendrier/rdv/${event.id}` },
    }), totals);
  }

  // Relances : rendez-vous provisoires restés sans réponse (US-83).
  const provisional = await ctx.db
    .selectFrom("family_events")
    .select(["id", "account_id", "starts_at", "created_at", "auto_confirm_at"])
    .where("status", "=", "provisional")
    .where("starts_at", ">", ctx.now)
    .where("created_at", "<=", new Date(ctx.now.getTime() - NUDGE_HOURS.nudge24 * HOUR))
    .$if(Boolean(options.accountId), (qb) => qb.where("account_id", "=", options.accountId!))
    .execute();
  for (const row of provisional) {
    const { timeZone, recipients } = await family(row.account_id);
    const startsAt = new Date(row.starts_at);
    const dues = NUDGE_KINDS.map((k) => ({ k, due: nudgeDueAt(k, new Date(row.created_at), timeZone) }))
      .filter(({ due }) => due <= ctx.now && due < startsAt)
      .sort((a, b) => a.due.getTime() - b.due.getTime());
    const latest = dues[dues.length - 1];
    if (!latest) continue;
    // Un parent qui a modifié le rendez-vous sans le confirmer ne reçoit plus de relance (US-83 RF5).
    const modified = await ctx.db.selectFrom("family_event_history").select("id").where("event_id", "=", row.id).where("action", "=", "modified").limit(1).executeTakeFirst();
    if (modified) continue;
    const event = await notified(ctx.db, row.account_id, row.id);
    if (!event) continue;
    // La seconde relance annonce l'enregistrement sans réponse quand il est en service pour ce RDV (AT-8).
    const warn = latest.k === "nudge48" && env().AUTO_CONFIRM_MODE === "on" && row.auto_confirm_at !== null;
    await deliver(ctx, row.account_id, row.id, latest.k, latest.due, recipients, (to) => ({
      email: nudgeEmail({ firstName: to.firstName, to: to.email, event, timeZone, now: ctx.now, appUrl, autoConfirmWarning: warn }),
      push: { title: "Assistant Famille", body: `${nudgeHeadline(event, timeZone, ctx.now)}${warn ? `\n${AUTO_CONFIRM_WARNING}` : ""}`, url: `/calendrier/rdv/${event.id}` },
    }), totals);
  }
  return totals;
}
