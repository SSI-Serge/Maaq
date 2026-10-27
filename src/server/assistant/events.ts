import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { EVENT_TYPES, MEDICAL_TITLE, STATUS_CODE, TYPE_CODE, eventTypeIds, findConflicts, fingerprintOf, loadCalendarEvent, loadCalendarEvents, type CalendarEvent, type EventSource, type EventStatus, type EventType } from "./calendar";
import { parsePoint, sealPoint, type PlacePoint } from "./address";
import { seal, sealOptional } from "./fields";
import { isParent } from "./family";
import { loadMembers, type MemberChip } from "./member-chips";
import { isLocalDateTime, localMs, localToUtc, utcToLocal } from "./local-time";
import { env } from "@/server/env";
import { integerSetting } from "@/server/settings";
import { notifyAfterConfirmation } from "./notices";
import { cancelPendingNotices, reminderDetails, type NudgeView, type ReminderView } from "./reminders";
import { dropProposedTasks, loadEventTasks, type EventTasksView } from "./event-tasks";
import { materializeEventSeriesTasks } from "./task-series";
import { travelView, type TravelView } from "./travel";
import { SCOPES, cancelSeries, conflictingSessions, confirmSeries, rewriteSeries, seriesView, splitSeries, transformToSeries, type RepetitionInput, type Scope, type SeriesEdit, type SeriesView } from "./series-ops";

/**
 * Cycle de vie des rendez-vous du calendrier familial (US-74 à US-80) : consulter, confirmer, modifier, écarter, annuler.
 * Le calendrier est une donnée du foyer, pas de l'agent (D25). Les droits suivent D26 : les deux parents voient et gèrent tout ;
 * un invité secondaire ne voit que ses rendez-vous et ne gère que ceux de ses propres demandes.
 */

export const MAX_EVENT_TITLE = 100;
export const MAX_EVENT_PLACE = 200;
export const MAX_EVENT_NOTES = 500;
const DEFAULT_MINUTES = 60;
const VISIBLE: EventStatus[] = ["provisional", "confirmed", "set_aside"];

export { FALLBACK_COLOR, FORMER_MEMBER, loadMembers, type MemberChip } from "./member-chips";

export interface ConflictView {
  id: string;
  /** Vide quand le profil n'a pas le droit de voir ce rendez-vous (US-74 RF10). */
  title: string | null;
  start: string;
  end: string;
}

/**
 * Un autre rendez-vous d'un membre commun qui se termine peu avant celui-ci (`before`) ou commence peu après sa fin (`after`), sans le chevaucher (US-107 RF1) : « pensez au trajet ».
 * L'écart se règle (`travel_gap_alert_minutes`, 30 par défaut). Vaut aussi pour un rendez-vous médical ; ne demande ni adresse ni position.
 */
export interface NearbyView {
  id: string;
  side: "before" | "after";
  /** Heure locale où l'autre rendez-vous se termine (`before`) ou commence (`after`) : « AAAA-MM-JJTHH:MM ». */
  at: string;
  minutes: number;
}

export interface EventActions {
  confirm: boolean;
  modify: boolean;
  setAside: boolean;
  cancel: boolean;
}

export interface EventView {
  id: string;
  title: string;
  type: EventType;
  status: EventStatus;
  /** Heure locale du foyer : « AAAA-MM-JJTHH:MM ». */
  start: string;
  end: string;
  allDay: boolean;
  place: string | null;
  /** Les coordonnées du lieu sont connues (adresse choisie dans les suggestions) : condition du suivi de trajet (US-107 RF4). Les coordonnées elles-mêmes ne sortent jamais du serveur. */
  placeKnown: boolean;
  notes: string | null;
  allFamily: boolean;
  members: MemberChip[];
  source: EventSource;
  requestedBy: string | null;
  version: number;
  past: boolean;
  /** Dernier changement de statut : « Confirmé par Julien le 24/10 à 9 h 12 ». */
  /** `auto` : confirmé d'office, au nom de « MAAQ (sans réponse) » (AT-8). */
  statusChange: { byFirstName: string | null; at: string; auto: boolean } | null;
  /** Pour un RDV provisoire, quand l'enregistrement sans réponse est en service : l'échéance (heure locale), ou « jamais » (US-95, UX). */
  autoConfirm: { at: string } | { never: true } | null;
  /** Séance d'une série (US-109) : la règle, la mention « Modifiée », les séances en conflit. Rempli dans le détail seulement ; `recurring` partout. */
  recurring: boolean;
  series: SeriesView | null;
  can: EventActions;
  /** Autres rendez-vous en conflit avec celui-ci (provisoires, confirmés ; écartés et annulés ne comptent pas). */
  conflicts: ConflictView[];
  /** Rendez-vous rapprochés, sans chevauchement (US-107 RF1). Rempli dans le détail seulement. */
  nearby: NearbyView[];
  /** Créneaux libres proches, quand il y a un conflit (US-74 RF6). */
  alternatives: { start: string; end: string }[];
  /** Rappels J-7, J-1 et Jour J d'un rendez-vous confirmé, avec leur état (US-81). Remplis dans le détail seulement. */
  reminders: ReminderView[];
  /** Dernière relance envoyée pour un rendez-vous provisoire (US-83 RF8). Rempli dans le détail seulement. */
  nudge: NudgeView | null;
  /** Liste « À préparer » : tâches proposées, à faire et faites du rendez-vous (US-95). Remplie dans le détail seulement. */
  tasks: EventTasksView | null;
  /** Suivi du trajet de ce profil (US-107) ; vide tant que le service de calcul est fermé. Rempli dans le détail seulement. */
  travel: TravelView | null;
}

interface Viewer {
  accountId: string;
  userId: string;
  parent: boolean;
  /** Fiche « membre » du profil, s'il en a une : un invité secondaire voit les rendez-vous où il figure. */
  memberId: string | null;
  timeZone: string;
}

const fail = (code: string, message: string, status = 409, details?: unknown) => new Rejection(code, message, status, details);
const NOT_FOUND = () => fail("not_found", "Ce rendez-vous n'existe plus ou ne vous est pas accessible.", 404);

async function viewerOf(ctx: Ctx, session: SessionContext): Promise<Viewer> {
  const accountId = session.user.accountId;
  if (!accountId || session.user.role === "admin") throw fail("forbidden", "Le calendrier familial est réservé aux profils d'un foyer.", 403);
  const member = await ctx.db.selectFrom("family_members").select("id").where("account_id", "=", accountId).where("user_id", "=", session.user.id).executeTakeFirst();
  return { accountId, userId: session.user.id, parent: isParent(session), memberId: member?.id ?? null, timeZone: session.device.timezone || "Europe/Paris" };
}

/** D26 : voir. */
const canSee = (v: Viewer, e: CalendarEvent) => v.parent || e.createdByUserId === v.userId || e.allFamily || (v.memberId !== null && e.memberIds.includes(v.memberId));
/** D26 : confirmer, modifier, ignorer ou annuler. */
const canAct = (v: Viewer, e: CalendarEvent) => v.parent || e.createdByUserId === v.userId;

/** Un provisoire (ou écarté) est passé à son heure de début (US-83) ; un confirmé quand il est terminé (US-79 RF8). */
function isPast(e: CalendarEvent, now: Date): boolean {
  return e.status === "provisional" || e.status === "set_aside" ? e.startsAt <= now : e.endsAt < now;
}

function actionsFor(v: Viewer, e: CalendarEvent, now: Date): EventActions {
  const allowed = canAct(v, e);
  const past = isPast(e, now);
  return {
    confirm: allowed && !past && (e.status === "provisional" || e.status === "set_aside"),
    modify: allowed && !past && (e.status === "provisional" || e.status === "confirmed"),
    setAside: allowed && e.status === "provisional",
    cancel: allowed && !past && e.status === "confirmed",
  };
}

async function firstNames(db: Kysely<DB>, userIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
  if (!ids.length) return new Map();
  return new Map((await db.selectFrom("users").select(["id", "first_name"]).where("id", "in", ids).execute()).map((u) => [u.id, u.first_name]));
}

/** Un RDV provisoire sera ajouté sans réponse à son échéance, sauf conflit ou autre exception (AT-8) ; sans échéance, il ne le sera jamais. */
function autoConfirmOf(v: Viewer, e: CalendarEvent): EventView["autoConfirm"] {
  if (env().AUTO_CONFIRM_MODE !== "on" || e.status !== "provisional") return null;
  return e.autoConfirmAt ? { at: utcToLocal(e.autoConfirmAt, v.timeZone) } : { never: true };
}

function toView(v: Viewer, e: CalendarEvent, members: Map<string, MemberChip>, names: Map<string, string>, now: Date): EventView {
  const chips = e.allFamily ? [...members.values()].filter((m) => !m.removed) : e.memberIds.map((id) => members.get(id)).filter((m): m is MemberChip => Boolean(m));
  return {
    id: e.id, title: e.title, type: e.type, status: e.status, start: utcToLocal(e.startsAt, v.timeZone), end: utcToLocal(e.endsAt, v.timeZone), allDay: e.allDay,
    place: e.place, placeKnown: e.locationPoint !== null, notes: e.notes, allFamily: e.allFamily, members: chips, source: e.source, requestedBy: e.createdByUserId ? (names.get(e.createdByUserId) ?? null) : null,
    version: e.version, past: isPast(e, now), statusChange: { byFirstName: e.statusChangedByUserId ? (names.get(e.statusChangedByUserId) ?? null) : null, at: e.statusChangedAt.toISOString(), auto: e.autoConfirmed },
    autoConfirm: autoConfirmOf(v, e),
    recurring: Boolean(e.seriesId),
    series: null,
    can: actionsFor(v, e, now), conflicts: [], nearby: [], alternatives: [], reminders: [], nudge: null, tasks: null, travel: null,
  };
}

/** US-107 RF1 : les rendez-vous d'un membre commun qui se terminent moins de 30 minutes avant celui-ci, ou commencent moins de 30 minutes après sa fin. */
async function nearbyOf(db: Kysely<DB>, v: Viewer, e: CalendarEvent): Promise<NearbyView[]> {
  if (e.allDay) return [];
  const gap = (await integerSetting(db, "travel_gap_alert_minutes", 30)) * 60_000;
  const end = overlapEnd(e);
  const around = await loadCalendarEvents(db, v.accountId, { from: new Date(e.startsAt.getTime() - gap), to: new Date(end.getTime() + gap) }, ["provisional", "confirmed"]);
  const who = new Set(e.memberIds);
  const found: NearbyView[] = [];
  for (const o of around) {
    if (o.id === e.id || o.allDay || !(e.allFamily || o.allFamily || o.memberIds.some((m) => who.has(m)))) continue;
    const before = e.startsAt.getTime() - o.endsAt.getTime();
    const after = o.startsAt.getTime() - end.getTime();
    if (before >= 0 && before < gap) found.push({ id: o.id, side: "before", at: utcToLocal(o.endsAt, v.timeZone), minutes: Math.round(before / 60_000) });
    else if (after >= 0 && after < gap) found.push({ id: o.id, side: "after", at: utcToLocal(o.startsAt, v.timeZone), minutes: Math.round(after / 60_000) });
  }
  return found.sort((a, b) => a.at.localeCompare(b.at));
}

const overlapEnd = (e: CalendarEvent) => (e.endsAt > e.startsAt ? e.endsAt : new Date(e.startsAt.getTime() + 60_000));

async function conflictsOf(db: Kysely<DB>, v: Viewer, e: CalendarEvent): Promise<{ events: CalendarEvent[]; views: ConflictView[] }> {
  const events = await findConflicts(db, v.accountId, { from: e.startsAt, to: overlapEnd(e), memberIds: e.memberIds, allFamily: e.allFamily, excludeId: e.id });
  return {
    events,
    views: events.map((c) => ({ id: c.id, title: canSee(v, c) ? c.title : null, start: utcToLocal(c.startsAt, v.timeZone), end: utcToLocal(c.endsAt, v.timeZone) })),
  };
}

/** US-74 RF6 : 3 créneaux libres au plus, les plus proches du créneau demandé, entre 8 h et 20 h. */
async function nearestSlots(db: Kysely<DB>, v: Viewer, e: CalendarEvent, now: Date): Promise<{ start: string; end: string }[]> {
  if (e.allDay) return [];
  const minutes = Math.max(15, Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 60_000));
  const requested = localMs(e.startsAt, v.timeZone);
  const windowFrom = new Date(e.startsAt.getTime() - 8 * 86_400_000);
  const windowTo = new Date(e.startsAt.getTime() + 9 * 86_400_000);
  const who = new Set(e.memberIds);
  const busy = (await loadCalendarEvents(db, v.accountId, { from: windowFrom, to: windowTo }))
    .filter((o) => o.id !== e.id && (e.allFamily || o.allFamily || o.memberIds.some((m) => who.has(m))))
    .map((o) => [localMs(o.startsAt, v.timeZone), localMs(o.endsAt, v.timeZone)] as const);
  const nowLocal = localMs(now, v.timeZone);
  const day0 = Math.floor(requested / 86_400_000) * 86_400_000;
  const candidates: number[] = [];
  for (let d = -7; d <= 7; d++) {
    for (let minute = 8 * 60; minute + minutes <= 20 * 60; minute += 30) {
      const start = day0 + d * 86_400_000 + minute * 60_000;
      if (start <= nowLocal || start === requested) continue;
      if (busy.some(([s, en]) => s < start + minutes * 60_000 && en > start)) continue;
      candidates.push(start);
    }
  }
  candidates.sort((a, b) => Math.abs(a - requested) - Math.abs(b - requested) || a - b);
  return candidates.slice(0, 3).map((s) => ({ start: new Date(s).toISOString().slice(0, 16), end: new Date(s + minutes * 60_000).toISOString().slice(0, 16) }));
}

async function withConflicts(db: Kysely<DB>, v: Viewer, view: EventView, e: CalendarEvent, now: Date): Promise<EventView> {
  if (e.status !== "provisional" && e.status !== "set_aside" && e.status !== "confirmed") return view;
  const { views } = await conflictsOf(db, v, e);
  const nearby = view.past ? [] : await nearbyOf(db, v, e);
  // Un RDV en conflit n'est jamais enregistré sans réponse : il reste à confirmer par une personne (AT-8).
  return { ...view, conflicts: views, nearby, alternatives: views.length && e.status !== "confirmed" ? await nearestSlots(db, v, e, now) : [], autoConfirm: views.length && view.autoConfirm ? { never: true } : view.autoConfirm };
}

/** Les changements de statut sont écrits dans l'historique par la base ; les modifications, ici (US-75 RT4). */
async function recordModified(db: Kysely<DB>, eventId: string, status: EventStatus, userId: string | null, at: Date) {
  await db.insertInto("family_event_history").values({ event_id: eventId, user_id: userId, action: "modified", from_status: STATUS_CODE[status], to_status: STATUS_CODE[status], occurred_at: at }).execute();
}

/** Changement de statut par la base : transition permise, historique, auteur et date de confirmation (`change_family_event_status`). */
async function changeStatus(trx: Kysely<DB>, e: CalendarEvent, to: EventStatus, userId: string): Promise<void> {
  const { rows } = await sql<{ ok: boolean }>`select change_family_event_status(${e.id}::uuid, ${STATUS_CODE[to]}::event_status, ${userId}::uuid, ${null}::integer, 'user_request'::event_change_reason) as ok`.execute(trx);
  if (!rows[0]?.ok) throw await already(trx, e);
}

/** Deux rendez-vous actifs ne peuvent pas avoir le même créneau, le même type et les mêmes membres (US-89 RT3). */
const isDuplicate = (error: unknown) => (error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === "ux_family_events_active_fingerprint";

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------------------------------------------------------

export interface CalendarListItem extends EventView {
  /** Identifiants des autres rendez-vous visibles qui sont en conflit avec celui-ci (alerte de la vue Jour, US-78 RF9). */
  conflictsWith: string[];
}

/** US-78 : rendez-vous visibles par ce profil entre deux dates locales incluses. Seule la période demandée est chargée. */
export async function listEvents(ctx: Ctx, session: SessionContext, range: { from: string; to: string }): Promise<CalendarListItem[]> {
  const v = await viewerOf(ctx, session);
  if (!isLocalDateTime(range.from) || !isLocalDateTime(range.to)) throw fail("invalid_range", "La période demandée est invalide.", 422);
  const from = localToUtc(range.from.slice(0, 10), v.timeZone);
  const to = localToUtc(`${range.to.slice(0, 10)}T23:59`, v.timeZone);
  if (to < from || to.getTime() - from.getTime() > 400 * 86_400_000) throw fail("invalid_range", "La période demandée est invalide.", 422);
  const events = (await loadCalendarEvents(ctx.db, v.accountId, { from, to }, VISIBLE)).filter((e) => canSee(v, e));
  const members = await loadMembers(ctx.db, v.accountId);
  const names = await firstNames(ctx.db, events.flatMap((e) => [e.createdByUserId, e.statusChangedByUserId]));
  const active = events.filter((e) => e.status !== "set_aside");
  return events.map((e) => {
    const clash = e.status === "set_aside"
      ? []
      : active.filter((o) => o.id !== e.id && o.startsAt < overlapEnd(e) && overlapEnd(o) > e.startsAt && (e.allFamily || o.allFamily || o.memberIds.some((m) => e.memberIds.includes(m)))).map((o) => o.id);
    return { ...toView(v, e, members, names, ctx.now), conflictsWith: clash };
  });
}

/** US-75 RF4, US-79 : le détail d'un rendez-vous, avec ses conflits et créneaux alternatifs. */
export async function getEvent(ctx: Ctx, session: SessionContext, id: string): Promise<EventView> {
  const v = await viewerOf(ctx, session);
  const e = await loadCalendarEvent(ctx.db, v.accountId, id);
  // Un rendez-vous annulé ou ignoré, ou que ce profil ne peut pas voir, n'existe pas pour lui (US-79 RF6).
  if (!e || !VISIBLE.includes(e.status) || !canSee(v, e)) {
    if (e && canSee(v, e) && (e.status === "ignored" || e.status === "canceled")) throw fail("gone", "Ce rendez-vous n'existe plus ou ne vous est pas accessible.", 404, { status: e.status });
    throw NOT_FOUND();
  }
  const members = await loadMembers(ctx.db, v.accountId);
  const names = await firstNames(ctx.db, [e.createdByUserId, e.statusChangedByUserId]);
  const view = await withConflicts(ctx.db, v, toView(v, e, members, names, ctx.now), e, ctx.now);
  const taskViewer = { accountId: v.accountId, userId: v.userId, parent: v.parent, memberId: v.memberId, timeZone: v.timeZone, today: utcToLocal(ctx.now, v.timeZone).slice(0, 10), nowLocal: utcToLocal(ctx.now, v.timeZone) };
  return { ...view, series: await seriesView(ctx.db, e, v.timeZone), tasks: await loadEventTasks(ctx.db, taskViewer, e, ctx.now, members), travel: await travelView(ctx.db, v.userId, v.memberId, e, ctx.now), ...(await reminderDetails(ctx.db, v.accountId, e, v.timeZone, ctx.now)) };
}

/** Confirmations en attente d'un profil (US-75 RF4, US-84) : provisoires qu'il peut traiter, à venir. Les écartés n'y figurent plus. */
export async function listPending(ctx: Ctx, session: SessionContext): Promise<EventView[]> {
  const v = await viewerOf(ctx, session);
  const events = (await loadCalendarEvents(ctx.db, v.accountId, { from: ctx.now, to: new Date(ctx.now.getTime() + 800 * 86_400_000) }, ["provisional"]))
    .filter((e) => canSee(v, e) && canAct(v, e) && !isPast(e, ctx.now));
  const members = await loadMembers(ctx.db, v.accountId);
  events.splice(0, events.length, ...firstOfEachSeries(events));
  const names = await firstNames(ctx.db, events.flatMap((e) => [e.createdByUserId, e.statusChangedByUserId]));
  return events.map((e) => toView(v, e, members, names, ctx.now));
}

/** Prochains rendez-vous de l'accueil de l'assistant (US-79 RF1) : confirmés et provisoires à venir. */
export async function listUpcoming(ctx: Ctx, session: SessionContext, limit = 10): Promise<EventView[]> {
  const v = await viewerOf(ctx, session);
  const events = (await loadCalendarEvents(ctx.db, v.accountId, { from: ctx.now, to: new Date(ctx.now.getTime() + 400 * 86_400_000) }, ["provisional", "confirmed"]))
    .filter((e) => canSee(v, e));
  events.splice(limit);
  const members = await loadMembers(ctx.db, v.accountId);
  const names = await firstNames(ctx.db, events.flatMap((e) => [e.createdByUserId, e.statusChangedByUserId]));
  return events.map((e) => toView(v, e, members, names, ctx.now));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Séries
// ---------------------------------------------------------------------------------------------------------------------------

/** Une série provisoire n'attend qu'une confirmation : seule sa première séance figure dans les confirmations en attente (US-109 RF6). */
function firstOfEachSeries(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (!e.seriesId) return true;
    if (seen.has(e.seriesId)) return false;
    seen.add(e.seriesId);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Changements d'état
// ---------------------------------------------------------------------------------------------------------------------------

export interface ChangeOptions {
  /** Version que l'écran affichait : une version dépassée est refusée (US-76 RT1). */
  expectedVersion?: number;
  /** Confirmer ou enregistrer malgré un conflit (US-74 RF7, US-80 RF3). */
  allowConflict?: boolean;
  /** Portée sur une série : « cette séance » (par défaut), « cette séance et les suivantes », « toute la série » (US-109 RF8). */
  scope?: Scope;
  /** « Confirmer sans les tâches » : les tâches proposées avec le RDV sont abandonnées (US-95 RF4). */
  withoutTasks?: boolean;
}

async function already(db: Kysely<DB>, e: CalendarEvent): Promise<Rejection> {
  const names = await firstNames(db, [e.statusChangedByUserId]);
  const by = e.statusChangedByUserId ? (names.get(e.statusChangedByUserId) ?? null) : null;
  return fail("already_handled", by ? `Ce rendez-vous a déjà été traité par ${by}.` : "Ce rendez-vous a déjà été traité.", 409, { status: e.status, by, at: e.statusChangedAt.toISOString(), version: e.version });
}
const stale = (e: CalendarEvent) => fail("stale_version", "Ce rendez-vous a été modifié entre-temps.", 409, { version: e.version });

/** Verrouille le rendez-vous (une seule opération à la fois : deux parents qui confirment ensemble, un seul l'emporte, US-75 RT2). */
async function locked(trx: Kysely<DB>, v: Viewer, id: string): Promise<CalendarEvent> {
  const e = await loadCalendarEvent(trx, v.accountId, id, { forUpdate: true });
  if (!e || !canSee(v, e)) throw NOT_FOUND();
  if (!canAct(v, e)) throw fail("forbidden", "Vous ne pouvez pas traiter ce rendez-vous.", 403);
  return e;
}

/** US-75 RF7 : confirmer (ou, pour un RDV écarté encore visible, « Confirmer quand même », US-77 RF4). */
export async function confirmEvent(ctx: Ctx, session: SessionContext, id: string, options: ChangeOptions = {}): Promise<EventView> {
  const v = await viewerOf(ctx, session);
  await ctx.db.transaction().execute(async (trx) => {
    const e = await locked(trx, v, id);
    if (e.status !== "provisional" && e.status !== "set_aside") throw await already(trx, e);
    if (options.expectedVersion !== undefined && options.expectedVersion !== e.version) throw stale(e);
    if (isPast(e, ctx.now)) throw fail("event_past", "Ce rendez-vous est déjà passé.", 409);
    // US-74 RF9 : le conflit est vérifié à nouveau au moment de la confirmation.
    const { views } = await conflictsOf(trx, v, e);
    if (e.seriesId) {
      // Une série se confirme d'un geste, toutes ses séances ou aucune (US-109 RF6, RT2) ; les séances en conflit sont signalées (RF5).
      const clashes = await conflictingSessions(trx, e.seriesId);
      if ((views.length || clashes.length) && !options.allowConflict) {
        throw fail("conflict", "Une ou plusieurs séances chevauchent un autre rendez-vous.", 409, { conflicts: views, alternatives: [], sessions: clashes.map((c) => utcToLocal(c.startsAt, v.timeZone)) });
      }
      if (options.withoutTasks) await dropProposedTasks(trx, e);
      await confirmSeries(trx, e, v.userId);
      // Les modèles de tâche proposés avec la série deviennent des tâches récurrentes : une occurrence par séance (US-95 RF12).
      await materializeEventSeriesTasks(trx, e.seriesId, ctx.now);
      await cancelPendingNotices(trx, id, ["follow_up_24h", "follow_up_48h"]);
      return;
    }
    if (views.length && !options.allowConflict) throw fail("conflict", "Ce créneau chevauche un autre rendez-vous.", 409, { conflicts: views, alternatives: await nearestSlots(trx, v, e, ctx.now) });
    // Les tâches proposées passent à « à faire » avec le rendez-vous, dans la même transaction (la base s'en charge, D48) ; « sans les tâches », elles sont abandonnées d'abord.
    if (options.withoutTasks) await dropProposedTasks(trx, e);
    await changeStatus(trx, e, "confirmed", v.userId);
    await cancelPendingNotices(trx, id, ["follow_up_24h", "follow_up_48h"]);
  });
  // L'autre parent est prévenu tout de suite, une fois la confirmation enregistrée (US-113 RT1) ; le planificateur reprend en cas d'échec.
  // Une série n'a qu'une notification, celle de sa première séance (US-113 RF9).
  await notifyAfterConfirmation(ctx, id);
  return getEvent(ctx, session, id);
}

/** US-77 : « Ignorer » écarte un rendez-vous provisoire, qui reste visible en gris et barré jusqu'à la relance suivante. */
export async function setAsideEvent(ctx: Ctx, session: SessionContext, id: string, options: ChangeOptions = {}): Promise<EventView> {
  const v = await viewerOf(ctx, session);
  await ctx.db.transaction().execute(async (trx) => {
    const e = await locked(trx, v, id);
    if (e.status !== "provisional") throw await already(trx, e);
    if (options.expectedVersion !== undefined && options.expectedVersion !== e.version) throw stale(e);
    // « Ignorer » une série provisoire l'écarte tout entière : ses séances sont ignorées (US-109).
    if (e.seriesId) await cancelSeries(trx, e, "all", v.userId);
    else await changeStatus(trx, e, "set_aside", v.userId);
  });
  if (!(await loadCalendarEvent(ctx.db, v.accountId, id).then((e) => e && VISIBLE.includes(e.status)))) {
    // La série ignorée n'est plus visible : on rend l'état de la séance, sans le détail.
    const e = (await loadCalendarEvent(ctx.db, v.accountId, id))!;
    return toView(v, e, await loadMembers(ctx.db, v.accountId), await firstNames(ctx.db, [e.createdByUserId]), ctx.now);
  }
  return getEvent(ctx, session, id);
}

/** US-80 : annuler un rendez-vous confirmé. Il disparaît du calendrier et ne peut pas être rétabli. */
export async function cancelEvent(ctx: Ctx, session: SessionContext, id: string, options: ChangeOptions = {}): Promise<{ id: string; status: "canceled"; retiredTasks: number }> {
  const v = await viewerOf(ctx, session);
  let seriesId: string | null = null;
  await ctx.db.transaction().execute(async (trx) => {
    const e = await locked(trx, v, id);
    seriesId = e.seriesId;
    if (e.status !== "confirmed") throw e.status === "canceled" || e.status === "ignored" ? stale(e) : fail("not_confirmed", "Seul un rendez-vous confirmé peut être annulé.", 409);
    if (options.expectedVersion !== undefined && options.expectedVersion !== e.version) throw stale(e);
    if (isPast(e, ctx.now)) throw fail("event_past", "Ce rendez-vous est déjà passé.", 409);
    if (e.seriesId) {
      const scope = options.scope && SCOPES.includes(options.scope) ? options.scope : "this";
      await cancelSeries(trx, e, scope, v.userId);
      await cancelPendingNotices(trx, id, ["reminder_d7", "reminder_d1", "reminder_day_of"]);
      return;
    }
    await changeStatus(trx, e, "canceled", v.userId);
    await cancelPendingNotices(trx, id, ["reminder_d7", "reminder_d1", "reminder_day_of"]);
  });
  // Les tâches « à faire » du rendez-vous annulé sont annulées avec lui par la base : on les compte pour le dire (US-95 RF10).
  const retired = await sql<{ n: string | null }>`
    select coalesce(sum(family_event_retired_task_count(e.id)), 0) as n from family_events e
     where e.account_id = ${v.accountId}::uuid and e.status in ('cancelled', 'dismissed')
       and (e.id = ${id}::uuid or (${seriesId}::uuid is not null and e.series_id = ${seriesId}::uuid and e.status_changed_at > now() - interval '1 minute'))`.execute(ctx.db);
  return { id, status: "canceled", retiredTasks: Number(retired.rows[0]?.n ?? 0) };
}

export interface EventChanges {
  title: string;
  type: EventType;
  allFamily: boolean;
  memberIds: string[];
  /** « AAAA-MM-JJTHH:MM », ou « AAAA-MM-JJ » pour une journée entière. */
  start: string;
  end?: string | null;
  allDay: boolean;
  place?: string | null;
  /**
   * Coordonnées de l'adresse choisie dans les suggestions (US-107 RT2). `"keep"` : garder celles du rendez-vous si le texte du lieu n'a pas changé. Sinon (vide, ou texte changé
   * à la main), elles sont effacées. Jamais pour un rendez-vous médical.
   */
  placePoint?: PlacePoint | "keep" | null;
  notes?: string | null;
  /** Répétition (US-109 RF7) : transforme un RDV provisoire en série, ou change la règle d'une série. */
  repetition?: RepetitionInput | null;
}

/** Coordonnées chiffrées à garder pour le lieu : celles qui viennent d'être choisies, celles du rendez-vous si le texte n'a pas changé, sinon aucune. */
function resolvePoint(input: EventChanges, current: CalendarEvent, place: string | null): Buffer | null {
  if (!place || input.type === "medical") return null;
  const wanted = input.placePoint;
  if (wanted === "keep") return current.place === place ? current.locationPoint : null;
  if (!wanted) return null;
  const point = parsePoint(wanted);
  if (!point) throw fail("invalid_place", "Les coordonnées de l'adresse sont invalides.", 422);
  return sealPoint(point);
}

function validated(v: Viewer, input: EventChanges, validMembers: Set<string>): { title: string; place: string | null; notes: string | null; from: Date; to: Date; endIsDefault: boolean } {
  if (!EVENT_TYPES.includes(input.type)) throw fail("invalid_type", "Le type de rendez-vous est inconnu.", 422);
  // Le titre d'un rendez-vous médical est facultatif : sans titre propre (ou avec le titre générique), « RDV médical — prénom » est composé à l'affichage (US-93 RF4).
  const typed = (input.title ?? "").trim();
  if (!typed && input.type !== "medical") throw fail("invalid_title", "Le titre est obligatoire.", 422);
  const title = input.type === "medical" && (!typed || typed.startsWith(MEDICAL_TITLE)) ? "" : typed;
  if (title.length > MAX_EVENT_TITLE) throw fail("invalid_title", `Le titre ne peut pas dépasser ${MAX_EVENT_TITLE} caractères.`, 422);
  const place = input.place?.trim() || null;
  const notes = input.notes?.trim() || null;
  if (place && place.length > MAX_EVENT_PLACE) throw fail("invalid_place", `Le lieu ne peut pas dépasser ${MAX_EVENT_PLACE} caractères.`, 422);
  if (notes && notes.length > MAX_EVENT_NOTES) throw fail("invalid_notes", `La note ne peut pas dépasser ${MAX_EVENT_NOTES} caractères.`, 422);
  if (!input.allFamily) {
    if (!input.memberIds?.length) throw fail("invalid_members", "Choisissez au moins un membre concerné.", 422);
    if (input.memberIds.some((m) => !validMembers.has(m))) throw fail("invalid_members", "Un des membres choisis n'existe pas dans cette famille.", 422);
  }
  let from: Date;
  let to: Date;
  try {
    if (input.allDay) {
      const day = (input.start ?? "").slice(0, 10);
      const lastDay = (input.end ?? input.start ?? "").slice(0, 10);
      from = localToUtc(day, v.timeZone);
      to = localToUtc(`${lastDay}T23:59`, v.timeZone);
    } else {
      if (!input.start || input.start.length < 16) throw new Error("heure de début manquante");
      from = localToUtc(input.start, v.timeZone);
      to = input.end ? localToUtc(input.end, v.timeZone) : new Date(from.getTime() + DEFAULT_MINUTES * 60_000);
    }
  } catch {
    throw fail("invalid_date", "La date ou l'heure est invalide.", 422);
  }
  if (to <= from && !input.allDay) throw fail("invalid_range", "L'heure de fin doit être après l'heure de début.", 422);
  if (to < from) throw fail("invalid_range", "La date de fin doit être après la date de début.", 422);
  return { title, place, notes, from, to, endIsDefault: !input.allDay && !input.end };
}

/**
 * US-76 (provisoire) et US-80 (confirmé) : modifier un rendez-vous. Le statut ne change pas. Une modification fondée sur une version
 * dépassée est refusée. Pour un rendez-vous confirmé, un conflit demande de confirmer l'enregistrement (`allowConflict`).
 */
export async function updateEvent(ctx: Ctx, session: SessionContext, id: string, changes: EventChanges, options: ChangeOptions & { expectedVersion: number }): Promise<EventView> {
  const v = await viewerOf(ctx, session);
  const members = await loadMembers(ctx.db, v.accountId);
  const checked = validated(v, changes, new Set(members.keys()));
  let resultId = id;
  await ctx.db.transaction().execute(async (trx) => {
    const e = await locked(trx, v, id);
    if (e.status !== "provisional" && e.status !== "confirmed") throw e.status === "canceled" || e.status === "ignored" ? stale(e) : await already(trx, e);
    if (options.expectedVersion !== e.version) throw stale(e);
    if (isPast(e, ctx.now)) throw fail("event_past", "Ce rendez-vous est déjà passé.", 409);
    // Un membre retiré n'est plus proposé (US-93 RF6) ; il peut rester sur un rendez-vous où il figure déjà.
    if (!changes.allFamily && changes.memberIds.some((m) => members.get(m)?.removed && !e.memberIds.includes(m))) {
      throw fail("invalid_members", "Un des membres choisis a été retiré de la famille.", 422);
    }
    const placePoint = resolvePoint(changes, e, checked.place);
    const scope: Scope = e.seriesId ? (e.status === "provisional" ? "all" : options.scope && SCOPES.includes(options.scope) ? options.scope : "this") : "this";
    const edit: SeriesEdit = {
      title: checked.title, type: changes.type, allFamily: changes.allFamily, memberIds: changes.allFamily ? [] : [...new Set(changes.memberIds)], from: checked.from, to: checked.to,
      allDay: changes.allDay, place: checked.place, placePoint, notes: checked.notes, repetition: changes.repetition,
    };
    // Un RDV provisoire devient une série (CA 7.1) ; une série se modifie pour toute la portée choisie (RF8). « Cette séance » suit le chemin d'un RDV ordinaire.
    if (!e.seriesId && changes.repetition) {
      if (e.status !== "provisional") throw fail("not_provisional", "Seul un rendez-vous en attente de confirmation peut devenir une série.", 409);
      resultId = await transformToSeries(trx, e, { ...edit, repetition: changes.repetition }, ctx.now, v.userId, v.timeZone);
      return;
    }
    if (e.seriesId && scope === "all") {
      resultId = await rewriteSeries(trx, e, edit, ctx.now);
      await recordModified(trx, resultId, e.status, v.userId, ctx.now);
      return;
    }
    if (e.seriesId && scope === "following") {
      resultId = await splitSeries(trx, e, edit, ctx.now, v.userId);
      await recordModified(trx, resultId, e.status, v.userId, ctx.now);
      return;
    }
    const rescheduled = checked.from.getTime() !== e.startsAt.getTime() || changes.allDay !== e.allDay;
    const next: CalendarEvent = { ...e, startsAt: checked.from, endsAt: checked.to, allFamily: changes.allFamily, memberIds: changes.allFamily ? [] : [...new Set(changes.memberIds)] };
    if (e.status === "confirmed") {
      const { views } = await conflictsOf(trx, v, next);
      if (views.length && !options.allowConflict) throw fail("conflict", "Ce créneau chevauche un autre rendez-vous.", 409, { conflicts: views, alternatives: await nearestSlots(trx, v, next, ctx.now) });
    }
    const typeId = (await eventTypeIds(trx)).get(TYPE_CODE[changes.type])!;
    // Les membres d'abord : la base refuse de passer un rendez-vous en « toute la famille » tant qu'il en désigne.
    await trx.deleteFrom("family_event_members").where("event_id", "=", id).execute();
    try {
      await trx
        .updateTable("family_events")
        .set({
          title: checked.title ? seal(checked.title) : null, event_type_id: typeId, starts_at: checked.from, ends_at: checked.to, end_is_default: checked.endIsDefault, all_day: changes.allDay,
          // Le lieu n'est réécrit que s'il change : la base efface les résultats « Sur place » d'un RDV dont l'adresse change (US-112 RF9).
          ...(checked.place !== e.place ? { location: sealOptional(checked.place) } : {}),
          ...(placePoint !== e.locationPoint ? { location_point: placePoint } : {}),
          note: sealOptional(checked.notes), whole_family: changes.allFamily, fingerprint: fingerprintOf({ ...next, type: changes.type }),
          // Une séance modifiée seule reste rattachée à la série avec la mention « Modifiée » (US-109 RF8).
          ...(e.seriesId ? { is_modified: true } : {}),
        })
        .where("id", "=", id)
        .execute();
    } catch (error) {
      if (isDuplicate(error)) throw fail("duplicate", "Un rendez-vous identique existe déjà à ce créneau.", 409);
      throw error;
    }
    if (!changes.allFamily) await trx.insertInto("family_event_members").values(next.memberIds.map((m) => ({ event_id: id, member_id: m, account_id: v.accountId }))).execute();
    // Un changement d'horaire annule les rappels en cours d'envoi de l'ancienne date ; ceux de la nouvelle repartent d'eux-mêmes (US-81 RF9).
    if (rescheduled) await cancelPendingNotices(trx, id, ["reminder_d7", "reminder_d1", "reminder_day_of"]);
    await recordModified(trx, id, e.status, v.userId, ctx.now);
  });
  return getEvent(ctx, session, resultId);
}

