import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { describeError } from "@/server/safe-log";
import { parsePoint, type PlacePoint } from "./address";
import { loadCalendarEvent, loadCalendarEventsByIds, type CalendarEvent } from "./calendar";
import { requireFamilyProfile } from "./family";
import { open } from "./fields";
import { localToUtc, utcToLocal } from "./local-time";
import { getLocationConsent, readLastPositionOfUser, saveLastPosition } from "./location-consent";
import { CLAIM_TTL_SECONDS, dispatch, recipientsOf, type Recipient } from "./task-notices";
import { addDays } from "./series";
import { clockFr, durationLabel } from "./travel-format";
import { TravelServiceError, travelProvider, type TravelProvider } from "./travel-provider";

export { clockFr, durationLabel };

/**
 * Trajets (US-107 RF4 à RF13). Le suivi s'active RDV par RDV ou série par série, pour soi seul (D47) : seuls les profils qui l'ont activé sont notifiés, chacun avec sa propre
 * estimation (D55). Jamais pour un RDV médical, jamais sans l'adresse choisie (coordonnées connues). Aucune adresse de domicile : le point de départ est le lieu du RDV précédent
 * (s'il se termine dans les 30 minutes qui précèdent) ou la dernière position connue du téléphone (moins de 3 heures, application ouverte).
 * Le service de calcul est interchangeable (`travel-provider.ts`) ; sans service, rien n'est calculé ni notifié.
 */
const MINUTE = 60_000;
export const FIRST_LEAD_MINUTES = 90;
export const SECOND_LEAD_MINUTES = 15;
export const LEAVE_NOW_MINUTES = 15;
export const DENSER_MINUTES = 10;
export const ARRIVED_MINUTES = 5;
const WINDOW_MS = 36 * 3_600_000;
const SCREEN_OPEN_MS = 4 * MINUTE;
const PREVIOUS_EVENT_MS = 30 * MINUTE;
const FALLBACK_MINUTES = 45;

type Db = Kysely<DB>;
const fail = (code: string, message: string, status = 409) => new Rejection(code, message, status);

// ---------------------------------------------------------------------------------------------------------------------------
// Textes
// ---------------------------------------------------------------------------------------------------------------------------

export const travelBodies = {
  first: (title: string, departure: string) => `Ouvrez MAAQ pour suivre votre trajet vers ${title} : départ estimé vers ${clockFr(departure)}`,
  firstWithoutOrigin: (title: string) => `Ouvrez MAAQ pour suivre votre trajet vers ${title}`,
  leaveNow: (title: string, minutes: number) => `Partez maintenant pour ${title} : ${durationLabel(minutes)} de trajet`,
  evening: (departure: string) => `Départ conseillé demain vers ${clockFr(departure)}, trafic estimé : la prévision sera affinée.`,
  second: (title: string, departure: string, minutes: number, from: "previous_event" | "last_position") =>
    `Départ conseillé à ${clockFr(departure)} pour ${title} : ${durationLabel(minutes)} de trajet, trafic compris, estimé depuis ${from === "previous_event" ? "le lieu de votre RDV précédent" : "votre dernière position"}`,
  denser: (title: string, minutes: number) => `Trafic plus dense que prévu : partez dès maintenant pour ${title} (${durationLabel(minutes)} de trajet)`,
};

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture : ce que montre le détail d'un RDV
// ---------------------------------------------------------------------------------------------------------------------------

export interface TravelView {
  /** Le profil peut activer le suivi pour ce RDV. */
  available: boolean;
  unavailable: "medical" | "no_address" | "not_concerned" | "past" | null;
  /** Suivi actif pour ce profil (sur ce RDV, ou par sa série). */
  tracking: boolean;
  /** Le suivi vient du suivi de toute la série (une séance peut en être écartée). */
  viaSeries: boolean;
  /** Durée estimée sans trafic à l'activation, propre à ce profil (RF5, D55) ; vide tant qu'aucune estimation n'est possible. */
  estimatedMinutes: number | null;
}

async function trackingOf(db: Db, userId: string, e: CalendarEvent): Promise<{ tracking: boolean; viaSeries: boolean }> {
  const rows = await db
    .selectFrom("travel_tracking")
    .select(["event_id", "series_id", "enabled"])
    .where("user_id", "=", userId)
    .where((eb) => (e.seriesId ? eb.or([eb("event_id", "=", e.id), eb("series_id", "=", e.seriesId)]) : eb("event_id", "=", e.id)))
    .execute();
  const own = rows.find((r) => r.event_id === e.id);
  const series = rows.find((r) => r.series_id !== null);
  if (own) return { tracking: own.enabled, viaSeries: false };
  return { tracking: Boolean(series?.enabled), viaSeries: Boolean(series?.enabled) };
}

/** Le suivi du trajet d'un RDV pour un profil ; `null` quand le service de calcul est fermé (le suivi n'est alors pas proposé). */
export async function travelView(db: Db, userId: string, memberId: string | null, e: CalendarEvent, now: Date, provider: TravelProvider | null = travelProvider()): Promise<TravelView | null> {
  if (!provider) return null;
  const concerned = e.allFamily || (memberId !== null && e.memberIds.includes(memberId));
  const unavailable = e.type === "medical" ? "medical" : e.locationPoint === null ? "no_address" : !concerned ? "not_concerned" : e.endsAt <= now ? "past" : null;
  const state = await trackingOf(db, userId, e);
  const advice = await db.selectFrom("event_travel_advice").select("estimated_duration_minutes").where("event_id", "=", e.id).where("user_id", "=", userId).executeTakeFirst();
  return { available: unavailable === null, unavailable, ...state, estimatedMinutes: advice?.estimated_duration_minutes ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Points de départ et d'arrivée
// ---------------------------------------------------------------------------------------------------------------------------

const pointOf = (sealed: Buffer | null): PlacePoint | null => (sealed ? parsePoint(JSON.parse(open(sealed))) : null);

export type OriginKind = "previous_event" | "last_position" | "live_screen";

interface Origin {
  kind: OriginKind;
  point: PlacePoint;
  eventId?: string;
}

/** Le lieu du RDV précédent de ce profil, s'il se termine dans les 30 minutes qui précèdent celui-ci (RF5). */
async function previousEventOrigin(db: Db, userId: string, e: CalendarEvent): Promise<Origin | null> {
  const { rows } = await sql<{ id: string; location_point: Buffer }>`
    select o.id, o.location_point from family_events o
     where o.account_id = ${e.accountId}::uuid and o.id <> ${e.id}::uuid and o.status = 'confirmed' and o.location_point is not null and not o.all_day
       and o.ends_at <= ${e.startsAt} and o.ends_at > ${new Date(e.startsAt.getTime() - PREVIOUS_EVENT_MS)}
       and (o.whole_family or exists (select 1 from family_event_members m join family_members fm on fm.id = m.member_id where m.event_id = o.id and fm.user_id = ${userId}::uuid))
     order by o.ends_at desc limit 1`.execute(db);
  const point = pointOf(rows[0]?.location_point ?? null);
  return point ? { kind: "previous_event", point, eventId: rows[0].id } : null;
}

/** Dans l'ordre de la spécification : le RDV précédent proche, puis la dernière position connue. */
async function pickOrigin(db: Db, userId: string, e: CalendarEvent, now: Date): Promise<Origin | null> {
  const previous = await previousEventOrigin(db, userId, e);
  if (previous) return previous;
  const position = await readLastPositionOfUser(db, userId, now);
  return position ? { kind: "last_position", point: position } : null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Activation du suivi
// ---------------------------------------------------------------------------------------------------------------------------

async function ensureAdvice(db: Db, e: CalendarEvent, userId: string): Promise<void> {
  await db.insertInto("event_travel_advice").values({ event_id: e.id, user_id: userId, account_id: e.accountId }).onConflict((oc) => oc.columns(["event_id", "user_id"]).doNothing()).execute();
}

/**
 * Durée sans trafic depuis la position que le téléphone vient de lire, enregistrée à l'activation du suivi (RF5) : seule la durée est gardée. Sans position autorisée à l'activation,
 * il n'y a pas d'estimation et le premier calcul a lieu 1 h 30 avant le RDV. Service muet : rien n'est estimé, sans erreur.
 */
async function estimateFromPosition(ctx: Ctx, e: CalendarEvent, userId: string, from: PlacePoint, provider: TravelProvider): Promise<void> {
  const to = pointOf(e.locationPoint);
  if (!to) return;
  try {
    const minutes = await provider.route({ from, to, departAt: e.startsAt, traffic: false });
    await ctx.db.updateTable("event_travel_advice").set({ estimated_duration_minutes: minutes, estimated_at: ctx.now }).where("event_id", "=", e.id).where("user_id", "=", userId).execute();
  } catch (error) {
    if (!(error instanceof TravelServiceError)) throw error;
    console.error(`Estimation du trajet : ${describeError(error)}`);
  }
}

const GUARD_MESSAGES: Record<string, string> = {
  "Pas de suivi de trajet pour un RDV médical": "medical",
  "Le suivi de trajet exige l'adresse du RDV": "no_address",
  "Ce RDV ne concerne pas ce profil": "not_concerned",
};

export interface TrackingChange {
  enabled: boolean;
  /** `series` : toutes les séances d'une série ; `event` : ce RDV seul (ou cette séance : écartée d'un suivi de série quand `enabled` est faux). */
  scope: "event" | "series";
  /** Position lue par le téléphone à l'activation, gardée comme dernière position si l'appareil l'autorise (RF5). */
  position?: unknown;
}

async function visibleEvent(ctx: Ctx, session: SessionContext, eventId: string): Promise<CalendarEvent> {
  const { accountId } = requireFamilyProfile(session);
  const { rows } = await sql<{ id: string }>`select id from family_events_visible_to(${session.user.id}::uuid) where id = ${eventId}::uuid`.execute(ctx.db);
  const e = rows[0] ? await loadCalendarEvent(ctx.db, accountId, eventId) : undefined;
  if (!e || (e.status !== "confirmed" && e.status !== "provisional")) throw fail("not_found", "Ce rendez-vous n'existe plus ou ne vous est pas accessible.", 404);
  return e;
}

/** « Suivre mon trajet » (RF4) : activé ou retiré pour soi seul, sur un RDV ou sur sa série. Les règles (médical, adresse, RDV concerné) sont celles de la base. */
export async function setTracking(ctx: Ctx, session: SessionContext, eventId: string, change: TrackingChange, provider: TravelProvider | null = travelProvider()): Promise<TravelView> {
  if (!provider) throw fail("travel_off", "Le suivi du trajet n'est pas ouvert.", 409);
  const e = await visibleEvent(ctx, session, eventId);
  const userId = session.user.id;
  if (change.scope === "series" && !e.seriesId) throw fail("not_recurring", "Ce rendez-vous ne fait pas partie d'une série.", 422);
  if (e.endsAt <= ctx.now) throw fail("event_past", "Ce rendez-vous est déjà passé.", 409);
  try {
    if (change.enabled) {
      if (change.scope === "series") {
        await ctx.db.insertInto("travel_tracking").values({ account_id: e.accountId, user_id: userId, series_id: e.seriesId, enabled: true }).onConflict((oc) => oc.columns(["user_id", "series_id"]).where(sql<boolean>`series_id is not null`).doUpdateSet({ enabled: true })).execute();
      } else {
        await ctx.db.insertInto("travel_tracking").values({ account_id: e.accountId, user_id: userId, event_id: e.id, enabled: true }).onConflict((oc) => oc.columns(["user_id", "event_id"]).where(sql<boolean>`event_id is not null`).doUpdateSet({ enabled: true })).execute();
      }
      await ensureAdvice(ctx.db, e, userId);
      const from = change.position !== undefined && (await getLocationConsent(ctx, session)).status === "active" ? parsePoint(change.position) : null;
      if (from) {
        await saveLastPosition(ctx, session, from, { eventId: e.id });
        await estimateFromPosition(ctx, e, userId, from, provider);
      }
    } else if (change.scope === "series") {
      await ctx.db.deleteFrom("travel_tracking").where("user_id", "=", userId).where("series_id", "=", e.seriesId!).execute();
      await ctx.db.deleteFrom("travel_tracking").where("user_id", "=", userId).where("event_id", "in", ctx.db.selectFrom("family_events").select("id").where("series_id", "=", e.seriesId!)).execute();
    } else if ((await trackingOf(ctx.db, userId, e)).viaSeries) {
      // Cette séance est écartée d'un suivi de série : la ligne « désactivée » la retire de ses notifications (D47).
      await ctx.db.insertInto("travel_tracking").values({ account_id: e.accountId, user_id: userId, event_id: e.id, enabled: false }).onConflict((oc) => oc.columns(["user_id", "event_id"]).where(sql<boolean>`event_id is not null`).doUpdateSet({ enabled: false })).execute();
    } else {
      await ctx.db.deleteFrom("travel_tracking").where("user_id", "=", userId).where("event_id", "=", e.id).execute();
    }
  } catch (error) {
    const known = Object.keys(GUARD_MESSAGES).find((m) => error instanceof Error && error.message.includes(m));
    if (known) throw fail(GUARD_MESSAGES[known], known + ".", 422);
    throw error;
  }
  const member = await ctx.db.selectFrom("family_members").select("id").where("user_id", "=", userId).executeTakeFirst();
  return (await travelView(ctx.db, userId, member?.id ?? null, e, ctx.now, provider))!;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Écran « Suivi du trajet » (RF6, RF9, RF13)
// ---------------------------------------------------------------------------------------------------------------------------

export interface TravelScreenView {
  eventId: string;
  title: string;
  place: string | null;
  /** Heure locale du début du RDV : « AAAA-MM-JJTHH:MM ». */
  start: string;
  /** Heure de départ conseillée (heure locale) et durée du trajet, trafic compris. */
  departure: string;
  durationMinutes: number;
  minutesBeforeDeparture: number;
  /** À moins de 5 minutes du lieu : « Vous êtes arrivé » (RF9). */
  arrived: boolean;
  origin: OriginKind;
  /** Heure du calcul (ISO). */
  computedAt: string;
  /** Le service n'a pas répondu : la dernière estimation reste affichée, avec son heure (RF13). */
  stale: boolean;
}

/**
 * Recalcule le trajet de ce profil, avec le trafic, depuis la position que l'écran vient de lire (toutes les 3 minutes tant qu'il est ouvert, RF6). La position est gardée comme
 * dernière position (accord de l'appareil requis). Sans position ni RDV précédent proche, rien à calculer : 409 `no_origin`. Service muet : dernière estimation, `stale`.
 */
export async function refreshTravel(ctx: Ctx, session: SessionContext, eventId: string, input: { position?: unknown }, provider: TravelProvider | null = travelProvider()): Promise<TravelScreenView> {
  if (!provider) throw fail("travel_off", "Le suivi du trajet n'est pas ouvert.", 409);
  const e = await visibleEvent(ctx, session, eventId);
  const userId = session.user.id;
  const to = pointOf(e.locationPoint);
  if (e.type === "medical" || !to) throw fail("no_address", "Le suivi de trajet exige l'adresse du RDV.", 422);
  if (e.endsAt <= ctx.now) throw fail("event_past", "Ce rendez-vous est déjà passé.", 409);
  await ensureAdvice(ctx.db, e, userId);
  const stored = await ctx.db.selectFrom("event_travel_advice").selectAll().where("event_id", "=", e.id).where("user_id", "=", userId).executeTakeFirstOrThrow();

  let origin: Origin | null = null;
  if (input.position !== undefined) {
    await saveLastPosition(ctx, session, input.position, { eventId: e.id });
    const point = parsePoint(input.position);
    if (point) origin = { kind: "live_screen", point };
  }
  origin ??= await pickOrigin(ctx.db, userId, e, ctx.now);

  const tz = session.device.timezone || "Europe/Paris";
  const known = stored.second_duration_minutes ?? stored.first_duration_minutes;
  if (!origin) {
    if (stored.advised_departure_at && known) return screenOf(e, tz, ctx.now, stored.advised_departure_at, known, stored.origin_kind as OriginKind, stored.updated_at, true);
    throw fail("no_origin", "Votre position n'est pas connue : autorisez la position pour suivre votre trajet.", 409);
  }
  try {
    const departAt = new Date(Math.max(ctx.now.getTime(), e.startsAt.getTime() - (known ?? stored.estimated_duration_minutes ?? FALLBACK_MINUTES) * MINUTE));
    const minutes = await provider.route({ from: origin.point, to, departAt, traffic: true });
    const departure = new Date(e.startsAt.getTime() - minutes * MINUTE);
    const first = stored.first_computed_at === null;
    await ctx.db
      .updateTable("event_travel_advice")
      .set({
        advised_departure_at: departure, origin_kind: origin.kind, origin_event_id: origin.eventId ?? null,
        ...(first ? { first_computed_at: ctx.now, first_duration_minutes: minutes } : { second_computed_at: ctx.now, second_duration_minutes: minutes }),
      })
      .where("event_id", "=", e.id)
      .where("user_id", "=", userId)
      .execute();
    return screenOf(e, tz, ctx.now, departure, minutes, origin.kind, ctx.now, false);
  } catch (error) {
    if (!(error instanceof TravelServiceError)) throw error;
    console.error(`Suivi du trajet : ${describeError(error)}`);
    if (stored.advised_departure_at && known) return screenOf(e, tz, ctx.now, stored.advised_departure_at, known, stored.origin_kind as OriginKind, stored.second_computed_at ?? stored.first_computed_at ?? stored.updated_at, true);
    throw fail("travel_unavailable", "Le calcul du trajet n'est pas disponible pour le moment.", 503);
  }
}

function screenOf(e: CalendarEvent, tz: string, now: Date, departure: Date, minutes: number, origin: OriginKind, computedAt: Date, stale: boolean): TravelScreenView {
  return {
    eventId: e.id, title: e.title, place: e.place, start: utcToLocal(e.startsAt, tz), departure: utcToLocal(departure, tz), durationMinutes: minutes,
    minutesBeforeDeparture: Math.round((departure.getTime() - now.getTime()) / MINUTE), arrived: minutes <= ARRIVED_MINUTES, origin, computedAt: computedAt.toISOString(), stale,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Planificateur : notifications de 1 h 30 avant et de 15 minutes avant le départ (RF5, RF7, RF8, RF10, RF13)
// ---------------------------------------------------------------------------------------------------------------------------

export interface TravelNoticesResult {
  first: number;
  second: number;
  skipped: number;
  failed: number;
}

/**
 * Premier calcul : la durée estimée à l'activation plus 1 h 30 avant le RDV (RF5). Quand il tombe avant 8 h, la notification part la veille à 21 h (D52).
 * Un premier calcul tard le soir (21 h et après) part à son heure : reculer de plusieurs heures n'aurait pas de sens pour un RDV du soir même.
 */
export function firstNoticeAt(start: Date, estimatedMinutes: number | null, tz: string): { at: Date; evening: boolean } {
  const calc = new Date(start.getTime() - ((estimatedMinutes ?? 0) + FIRST_LEAD_MINUTES) * MINUTE);
  const local = utcToLocal(calc, tz);
  if (Number(local.slice(11, 13)) < 8) return { at: localToUtc(`${addDays(local.slice(0, 10), -1)}T21:00`, tz), evening: true };
  return { at: calc, evening: false };
}

interface Pair {
  event_id: string;
  user_id: string;
  account_id: string;
}

/** Les suivis actifs de RDV confirmés qui commencent dans les 36 prochaines heures, avec leur adresse connue. Une séance écartée d'un suivi de série n'y figure pas. */
async function pairsToWatch(db: Db, now: Date, accountId?: string): Promise<Pair[]> {
  const { rows } = await sql<Pair>`
    select distinct e.id as event_id, t.user_id, e.account_id
      from family_events e
      join travel_tracking t on t.account_id = e.account_id and t.enabled and (t.event_id = e.id or (e.series_id is not null and t.series_id = e.series_id))
     where e.status = 'confirmed' and e.location_point is not null and e.starts_at > ${now} and e.starts_at <= ${new Date(now.getTime() + WINDOW_MS)}
       and not exists (select 1 from travel_tracking x where x.user_id = t.user_id and x.event_id = e.id and not x.enabled)
       ${accountId ? sql`and e.account_id = ${accountId}::uuid` : sql``}`.execute(db);
  return rows;
}

async function claimTravel(ctx: Ctx, kind: "travel_first" | "travel_second", eventId: string, userId: string, dueAt: Date, deadline: Date): Promise<boolean> {
  const row = await ctx.db
    .insertInto("scheduled_notifications")
    .values({ kind, event_id: eventId, due_at: dueAt, deadline_at: deadline, recipient_user_id: userId, status: "scheduled", attempts: 1 })
    .onConflict((oc) =>
      oc
        .columns(["event_id", "kind", "recipient_user_id"])
        .where(sql<boolean>`kind in ('travel_first', 'travel_second')`)
        .doUpdateSet({ attempts: sql<number>`scheduled_notifications.attempts + 1` })
        .where("scheduled_notifications.status", "=", "scheduled")
        .where(sql<boolean>`scheduled_notifications.updated_at < now() - ${sql.lit(`${CLAIM_TTL_SECONDS} seconds`)}::interval`),
    )
    .returning("id")
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * Un passage (toutes les 5 minutes) : premier calcul et notification à l'heure, puis second calcul 15 minutes avant l'heure de départ estimée. Chaque notification part au plus une fois
 * par profil et par RDV (RT4). Le service est interrogé avant la réservation : s'il ne répond pas, rien n'est réservé et le passage suivant réessaie, tant que le RDV n'a pas commencé (RF13).
 */
export async function runTravelNotices(ctx: Ctx, options: { accountId?: string; provider?: TravelProvider | null } = {}): Promise<TravelNoticesResult> {
  const totals: TravelNoticesResult = { first: 0, second: 0, skipped: 0, failed: 0 };
  const provider = options.provider === undefined ? travelProvider() : options.provider;
  if (!provider) return totals;
  const pairs = await pairsToWatch(ctx.db, ctx.now, options.accountId);
  if (!pairs.length) return totals;
  const byAccount = new Map<string, Pair[]>();
  for (const p of pairs) byAccount.set(p.account_id, [...(byAccount.get(p.account_id) ?? []), p]);
  for (const [accountId, list] of byAccount) {
    try {
      const tz = (await ctx.db.selectFrom("accounts").select("family_timezone").where("id", "=", accountId).executeTakeFirst())?.family_timezone ?? "Europe/Paris";
      const recipients = new Map((await recipientsOf(ctx.db, accountId)).map((r) => [r.id, r]));
      const loaded = new Map((await loadCalendarEventsByIds(ctx.db, accountId, [...new Set(list.map((p) => p.event_id))])).map((e) => [e.id, e]));
      for (const pair of list) {
        const e = loaded.get(pair.event_id);
        const to = e ? recipients.get(pair.user_id) : undefined;
        if (!e || !to) continue;
        try {
          await watch(ctx, provider, accountId, tz, e, to, totals);
        } catch (error) {
          console.error(`Notification de trajet : ${describeError(error)}`);
          totals.failed += 1;
        }
      }
    } catch (error) {
      console.error(`Notifications de trajet (foyer) : ${describeError(error)}`);
      totals.failed += 1;
    }
  }
  return totals;
}

async function watch(ctx: Ctx, provider: TravelProvider, accountId: string, tz: string, e: CalendarEvent, to: Recipient, totals: TravelNoticesResult): Promise<void> {
  const userId = to.id;
  const dest = pointOf(e.locationPoint);
  if (!dest) return;
  await ensureAdvice(ctx.db, e, userId);
  const advice = await ctx.db.selectFrom("event_travel_advice").selectAll().where("event_id", "=", e.id).where("user_id", "=", userId).executeTakeFirstOrThrow();
  const url = `/calendrier/rdv/${e.id}/trajet`;
  const message = (body: string) => ({ body, url, tag: `travel-${e.id}`, subject: body, lines: [body] });

  // --- Premier calcul : « Ouvrez MAAQ pour suivre votre trajet… » ---
  if (advice.status === "pending") {
    const { at, evening } = firstNoticeAt(e.startsAt, advice.estimated_duration_minutes, tz);
    if (ctx.now < at) return;
    const origin = await pickOrigin(ctx.db, userId, e, ctx.now);
    if (!origin) {
      // Aucune origine connue (RF10) : un simple appel à ouvrir MAAQ ; sans ouverture, aucun second calcul.
      if (!(await claimTravel(ctx, "travel_first", e.id, userId, at, e.startsAt))) return;
      const out = await dispatch(ctx, accountId, to, { kind: "travel_first", userId, eventId: e.id, dueAt: at }, message(travelBodies.firstWithoutOrigin(e.title)), false);
      if (out === "failed") return void (totals.failed += 1);
      await ctx.db.updateTable("event_travel_advice").set({ status: "skipped", origin_kind: "none", notified_first_at: out === "sent" ? ctx.now : null }).where("event_id", "=", e.id).where("user_id", "=", userId).execute();
      totals[out === "sent" ? "first" : "skipped"] += 1;
      return;
    }
    let minutes: number;
    try {
      minutes = await provider.route({ from: origin.point, to: dest, departAt: new Date(e.startsAt.getTime() - (advice.estimated_duration_minutes ?? FALLBACK_MINUTES) * MINUTE), traffic: true });
    } catch (error) {
      if (!(error instanceof TravelServiceError)) throw error;
      console.error(`Premier calcul du trajet : ${describeError(error)}`);
      totals.failed += 1;
      return; // rien n'est réservé : le passage suivant réessaie (RF13)
    }
    const departure = new Date(e.startsAt.getTime() - minutes * MINUTE);
    const local = utcToLocal(departure, tz);
    const body = departure.getTime() - ctx.now.getTime() <= LEAVE_NOW_MINUTES * MINUTE ? travelBodies.leaveNow(e.title, minutes) : evening ? travelBodies.evening(local) : travelBodies.first(e.title, local);
    if (!(await claimTravel(ctx, "travel_first", e.id, userId, at, e.startsAt))) return;
    const out = await dispatch(ctx, accountId, to, { kind: "travel_first", userId, eventId: e.id, dueAt: at }, message(body), false);
    if (out === "failed") return void (totals.failed += 1);
    await ctx.db
      .updateTable("event_travel_advice")
      .set({ status: "first_done", origin_kind: origin.kind, origin_event_id: origin.eventId ?? null, first_computed_at: ctx.now, first_duration_minutes: minutes, advised_departure_at: departure, notified_first_at: out === "sent" ? ctx.now : null })
      .where("event_id", "=", e.id)
      .where("user_id", "=", userId)
      .execute();
    totals[out === "sent" ? "first" : "skipped"] += 1;
    return;
  }

  // --- Second calcul, 15 minutes avant l'heure de départ estimée ---
  if (advice.status === "first_done" && advice.advised_departure_at && advice.first_duration_minutes !== null) {
    const secondAt = new Date(advice.advised_departure_at.getTime() - SECOND_LEAD_MINUTES * MINUTE);
    if (ctx.now < secondAt || ctx.now >= e.startsAt) return;
    // L'écran de suivi ouvert se met simplement à jour : aucune notification (RF7). « Ouvert » : il a calculé il y a moins de 4 minutes (un calcul toutes les 3 minutes).
    const lastCalc = advice.second_computed_at ?? advice.first_computed_at;
    if (advice.origin_kind === "live_screen" && lastCalc && ctx.now.getTime() - lastCalc.getTime() <= SCREEN_OPEN_MS) {
      await ctx.db.updateTable("event_travel_advice").set({ status: "second_done" }).where("event_id", "=", e.id).where("user_id", "=", userId).execute();
      return;
    }
    const origin = await pickOrigin(ctx.db, userId, e, ctx.now);
    if (!origin) {
      await ctx.db.updateTable("event_travel_advice").set({ status: "skipped" }).where("event_id", "=", e.id).where("user_id", "=", userId).execute();
      totals.skipped += 1;
      return;
    }
    let minutes: number;
    try {
      minutes = await provider.route({ from: origin.point, to: dest, departAt: new Date(Math.max(ctx.now.getTime(), advice.advised_departure_at.getTime())), traffic: true });
    } catch (error) {
      if (!(error instanceof TravelServiceError)) throw error;
      console.error(`Second calcul du trajet : ${describeError(error)}`);
      totals.failed += 1;
      return;
    }
    const departure = new Date(e.startsAt.getTime() - minutes * MINUTE);
    const denser = minutes - advice.first_duration_minutes > DENSER_MINUTES;
    const body = denser ? travelBodies.denser(e.title, minutes) : travelBodies.second(e.title, utcToLocal(departure, tz), minutes, origin.kind === "previous_event" ? "previous_event" : "last_position");
    if (!(await claimTravel(ctx, "travel_second", e.id, userId, secondAt, e.startsAt))) return;
    const out = await dispatch(ctx, accountId, to, { kind: "travel_second", userId, eventId: e.id, dueAt: secondAt }, message(body), false);
    if (out === "failed") return void (totals.failed += 1);
    await ctx.db
      .updateTable("event_travel_advice")
      .set({ status: "second_done", origin_kind: origin.kind, origin_event_id: origin.eventId ?? null, second_computed_at: ctx.now, second_duration_minutes: minutes, advised_departure_at: departure, notified_second_at: out === "sent" ? ctx.now : null })
      .where("event_id", "=", e.id)
      .where("user_id", "=", userId)
      .execute();
    totals[out === "sent" ? "second" : "skipped"] += 1;
  }
}
