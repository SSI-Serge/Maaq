import type { Kysely } from "kysely";
import { messenger, type OutgoingEmail } from "@/server/adapters/messaging";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { EVENT_TYPES, loadCalendarEvent, type CalendarEvent, type EventType } from "./calendar";
import { requireParent } from "./family";
import { localToUtc, utcToLocal } from "./local-time";
import { nudgeEmail, reminderEmail, type NotifiedEvent, type NudgeKind, type ReminderKind } from "./reminder-text";

/**
 * Rappels (US-81), délais par type (US-82) et relances (US-83), envoyés par email. Les échéances ne sont pas enregistrées : elles sont recalculées
 * à chaque passage du planificateur à partir du rendez-vous et des réglages, donc une modification d'horaire ou de réglage s'applique d'elle-même.
 * Seuls les envois sont enregistrés (`family_notifications`), avec une clé unique par rendez-vous, échéance et destinataire.
 */

type Db = Kysely<DB>;

export type { NudgeKind, ReminderKind };
export const REMINDER_KINDS: ReminderKind[] = ["d7", "d1", "d0"];
export const REMINDER_LABEL: Record<ReminderKind, string> = { d7: "J-7", d1: "J-1", d0: "Jour J" };
const NUDGE_KINDS: NudgeKind[] = ["nudge24", "nudge48"];
const NUDGE_HOURS: Record<NudgeKind, number> = { nudge24: 24, nudge48: 48 };

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

/** Fuseau du foyer : celui de l'appareil de l'utilisateur principal à sa dernière connexion (AF-2). */
export async function familyTimeZone(db: Db, accountId: string): Promise<string> {
  const row = await db
    .selectFrom("devices as d")
    .innerJoin("users as u", "u.id", "d.user_id")
    .select("d.timezone")
    .where("u.account_id", "=", accountId)
    .where("u.role", "=", "primary_user")
    .where("d.revoked_at", "is", null)
    .orderBy("d.last_activity_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.timezone ?? "Europe/Paris";
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
  const rows = await db.selectFrom("family_reminder_settings").select(["event_type", "d7", "d1", "d0", "updated_at"]).where("account_id", "=", accountId).execute();
  const byType = new Map(rows.map((r) => [r.event_type, r]));
  return new Map(
    EVENT_TYPES.map((type) => {
      const r = byType.get(type);
      return [type, { type, d7: r?.d7 ?? true, d1: r?.d1 ?? true, d0: r?.d0 ?? true, updatedAt: r ? new Date(r.updated_at) : null }];
    }),
  );
}

/** US-82 : les six types avec leurs trois interrupteurs. Valeurs par défaut : tout actif. */
export async function getReminderSettings(ctx: Ctx, session: SessionContext): Promise<{ settings: Omit<ReminderSetting, "updatedAt">[]; canEdit: boolean }> {
  const accountId = requireParent(session);
  const settings = await loadSettings(ctx.db, accountId);
  return { settings: [...settings.values()].map(({ type, d7, d1, d0 }) => ({ type, d7, d1, d0 })), canEdit: true };
}

/** US-82 RF5, RF6 : un interrupteur est enregistré dès qu'il est touché ; il s'applique aux rappels non encore envoyés. */
export async function setReminderSetting(ctx: Ctx, session: SessionContext, input: { type: string; kind: string; enabled: boolean }): Promise<Omit<ReminderSetting, "updatedAt">> {
  const accountId = requireParent(session);
  if (!EVENT_TYPES.includes(input.type as EventType)) throw new Rejection("invalid_type", "Ce type de rendez-vous est inconnu.", 422);
  if (!REMINDER_KINDS.includes(input.kind as ReminderKind)) throw new Rejection("invalid_kind", "Ce rappel est inconnu.", 422);
  const type = input.type as EventType;
  const kind = input.kind as ReminderKind;
  await ctx.db
    .insertInto("family_reminder_settings")
    .values({ account_id: accountId, event_type: type, [kind]: input.enabled, updated_by_user_id: session.user.id, updated_at: ctx.now })
    .onConflict((oc) => oc.columns(["account_id", "event_type"]).doUpdateSet({ [kind]: input.enabled, updated_by_user_id: session.user.id, updated_at: ctx.now }))
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

/** Instant à partir duquel les rappels d'un rendez-vous s'appliquent : confirmation ou dernier changement d'horaire, et dernier réglage du type. */
function cutoff(event: { remindersFrom: Date | null; statusChangedAt: Date }, setting: ReminderSetting): number {
  return Math.max((event.remindersFrom ?? event.statusChangedAt).getTime(), setting.updatedAt?.getTime() ?? 0);
}

/** Rappels dus à cet instant, du plus ancien au plus récent : seul le dernier est envoyé (après un long incident, J-7 n'a plus de sens si J-1 est arrivé). */
function dueKinds(event: { startsAt: Date; allDay: boolean; remindersFrom: Date | null; statusChangedAt: Date }, setting: ReminderSetting, timeZone: string, now: Date): ReminderKind[] {
  if (now >= event.startsAt) return [];
  return REMINDER_KINDS.filter((k) => setting[k])
    .map((k) => ({ k, due: reminderDueAt(k, event, timeZone) }))
    .filter(({ due }) => due <= now && due.getTime() >= cutoff(event, setting))
    .sort((a, b) => a.due.getTime() - b.due.getTime())
    .map(({ k }) => k);
}

export async function reminderDetails(db: Db, accountId: string, event: CalendarEvent, viewerTimeZone: string, now: Date): Promise<{ reminders: ReminderView[]; nudge: NudgeView | null }> {
  const timeZone = await familyTimeZone(db, accountId);
  const sent = await db.selectFrom("family_notifications").select(["kind", "sent_at"]).where("event_id", "=", event.id).where("status", "=", "sent").orderBy("sent_at", "desc").execute();
  const lastNudge = sent.find((n) => NUDGE_KINDS.includes(n.kind as NudgeKind));
  const nudge = event.status === "provisional" && lastNudge?.sent_at ? { kind: lastNudge.kind as NudgeKind, sentAt: new Date(lastNudge.sent_at).toISOString() } : null;
  if (event.status !== "confirmed") return { reminders: [], nudge };

  const row = await db.selectFrom("family_events").select("reminders_from").where("id", "=", event.id).executeTakeFirstOrThrow();
  const timing = { startsAt: event.startsAt, allDay: event.allDay, remindersFrom: row.reminders_from ? new Date(row.reminders_from) : null, statusChangedAt: event.statusChangedAt };
  const setting = (await loadSettings(db, accountId)).get(event.type)!;
  const pending = dueKinds(timing, setting, timeZone, now);
  const reminders = REMINDER_KINDS.map((kind): ReminderView => {
    const due = reminderDueAt(kind, event, timeZone);
    const at = utcToLocal(due, viewerTimeZone);
    const label = REMINDER_LABEL[kind];
    if (!setting[kind]) return { kind, label, state: "off", at };
    if (sent.some((n) => n.kind === kind)) return { kind, label, state: "sent", at };
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

/** Réserve un envoi : un seul passage (ou serveur) l'obtient, ce qui empêche tout doublon (US-81 RT2). */
async function claim(ctx: Ctx, accountId: string, eventId: string, kind: string, userId: string): Promise<boolean> {
  const row = await ctx.db
    .insertInto("family_notifications")
    .values({ account_id: accountId, event_id: eventId, kind, recipient_user_id: userId, claimed_at: ctx.now })
    .onConflict((oc) =>
      oc
        .columns(["event_id", "kind", "recipient_user_id"])
        .doUpdateSet({ claimed_at: ctx.now })
        .where("family_notifications.status", "=", "claimed")
        .where("family_notifications.claimed_at", "<", new Date(ctx.now.getTime() - CLAIM_TTL)),
    )
    .returning("id")
    .executeTakeFirst();
  return Boolean(row);
}

async function deliver(ctx: Ctx, accountId: string, eventId: string, kind: ReminderKind | NudgeKind, recipients: Recipient[], build: (to: Recipient) => OutgoingEmail, totals: RemindersResult): Promise<void> {
  for (const to of recipients) {
    if (!(await claim(ctx, accountId, eventId, kind, to.id))) continue;
    try {
      await messenger().sendEmail(build(to));
      await ctx.db.updateTable("family_notifications").set({ status: "sent", sent_at: ctx.now }).where("event_id", "=", eventId).where("kind", "=", kind).where("recipient_user_id", "=", to.id).execute();
      totals.sent += 1;
    } catch (error) {
      // L'envoi n'a pas abouti : on libère la réservation, et le passage suivant réessaie tant que le rendez-vous n'a pas commencé (US-81 RF8).
      await ctx.db.deleteFrom("family_notifications").where("event_id", "=", eventId).where("kind", "=", kind).where("recipient_user_id", "=", to.id).where("status", "=", "claimed").execute();
      console.error("Rappel non envoyé :", error);
      totals.failed += 1;
    }
  }
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
      const current = await trx.selectFrom("family_events").select(["status", "version"]).where("id", "=", row.id).forUpdate().executeTakeFirst();
      if (!current || current.status !== row.status) return; // un parent est passé entre-temps
      await trx.updateTable("family_events").set({ status: "ignored", version: current.version + 1, status_changed_at: ctx.now, status_changed_by_user_id: null, updated_at: ctx.now }).where("id", "=", row.id).execute();
      await trx
        .insertInto("family_event_history")
        .values({ account_id: row.account_id, event_id: row.id, action: "ignored", from_status: row.status, to_status: "ignored", by_user_id: null, reason: "sans réponse", created_at: ctx.now })
        .execute();
      totals.ignored += 1;
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
    .selectFrom("family_events")
    .select(["id", "account_id", "event_type", "starts_at", "all_day", "reminders_from", "status_changed_at"])
    .where("status", "=", "confirmed")
    .where("starts_at", ">", ctx.now)
    .where("starts_at", "<", horizon)
    .$if(Boolean(options.accountId), (qb) => qb.where("account_id", "=", options.accountId!))
    .execute();
  for (const row of confirmed) {
    const { timeZone, recipients, settings } = await family(row.account_id);
    const timing = { startsAt: new Date(row.starts_at), allDay: row.all_day, remindersFrom: row.reminders_from ? new Date(row.reminders_from) : null, statusChangedAt: new Date(row.status_changed_at) };
    const due = dueKinds(timing, settings.get(row.event_type)!, timeZone, ctx.now);
    const kind = due[due.length - 1];
    if (!kind) continue;
    const event = await notified(ctx.db, row.account_id, row.id);
    if (!event) continue;
    await deliver(ctx, row.account_id, row.id, kind, recipients, (to) => reminderEmail({ firstName: to.firstName, to: to.email, event, timeZone, now: ctx.now, appUrl }), totals);
  }

  // Relances : rendez-vous provisoires restés sans réponse (US-83).
  const provisional = await ctx.db
    .selectFrom("family_events")
    .select(["id", "account_id", "starts_at", "created_at"])
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
    await deliver(ctx, row.account_id, row.id, latest.k, recipients, (to) => nudgeEmail({ firstName: to.firstName, to: to.email, event, timeZone, now: ctx.now, appUrl }), totals);
  }
  return totals;
}
