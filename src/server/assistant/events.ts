import type { Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { EVENT_TYPES, findConflicts, loadCalendarEvent, loadCalendarEvents, type CalendarEvent, type EventSource, type EventStatus, type EventType } from "./calendar";
import { seal, sealOptional } from "./fields";
import { ensureParentMembers, isParent } from "./family";
import { isLocalDateTime, localMs, localToUtc, utcToLocal } from "./local-time";
import { reminderDetails, type NudgeView, type ReminderView } from "./reminders";

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

export interface MemberChip {
  id: string;
  firstName: string;
  role: "parent" | "child";
  color: string;
  /** Membre retiré (US-93) : ses rendez-vous gardent son prénom, mais il n'est plus proposé. */
  removed?: boolean;
}

export interface ConflictView {
  id: string;
  /** Vide quand le profil n'a pas le droit de voir ce rendez-vous (US-74 RF10). */
  title: string | null;
  start: string;
  end: string;
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
  notes: string | null;
  allFamily: boolean;
  members: MemberChip[];
  source: EventSource;
  requestedBy: string | null;
  version: number;
  past: boolean;
  /** Dernier changement de statut : « Confirmé par Julien le 24/10 à 9 h 12 ». */
  statusChange: { byFirstName: string | null; at: string } | null;
  can: EventActions;
  /** Autres rendez-vous en conflit avec celui-ci (provisoires, confirmés ; écartés et annulés ne comptent pas). */
  conflicts: ConflictView[];
  /** Créneaux libres proches, quand il y a un conflit (US-74 RF6). */
  alternatives: { start: string; end: string }[];
  /** Rappels J-7, J-1 et Jour J d'un rendez-vous confirmé, avec leur état (US-81). Remplis dans le détail seulement. */
  reminders: ReminderView[];
  /** Dernière relance envoyée pour un rendez-vous provisoire (US-83 RF8). Rempli dans le détail seulement. */
  nudge: NudgeView | null;
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
  if (isParent(session)) await ensureParentMembers(ctx.db, accountId);
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

async function loadMembers(db: Kysely<DB>, accountId: string): Promise<Map<string, MemberChip>> {
  const rows = await db.selectFrom("family_members").select(["id", "first_name", "role", "color", "alias_index", "archived_at"]).where("account_id", "=", accountId).orderBy("role").orderBy("alias_index").execute();
  return new Map(rows.map((r) => [r.id, { id: r.id, firstName: r.first_name, role: r.role, color: r.color ?? FALLBACK_COLOR, ...(r.archived_at ? { removed: true } : {}) }]));
}
export const FALLBACK_COLOR = "#6b7280";

async function firstNames(db: Kysely<DB>, userIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
  if (!ids.length) return new Map();
  return new Map((await db.selectFrom("users").select(["id", "first_name"]).where("id", "in", ids).execute()).map((u) => [u.id, u.first_name]));
}

function toView(v: Viewer, e: CalendarEvent, members: Map<string, MemberChip>, names: Map<string, string>, now: Date): EventView {
  const chips = e.allFamily ? [...members.values()].filter((m) => !m.removed) : e.memberIds.map((id) => members.get(id)).filter((m): m is MemberChip => Boolean(m));
  return {
    id: e.id, title: e.title, type: e.type, status: e.status, start: utcToLocal(e.startsAt, v.timeZone), end: utcToLocal(e.endsAt, v.timeZone), allDay: e.allDay,
    place: e.place, notes: e.notes, allFamily: e.allFamily, members: chips, source: e.source, requestedBy: e.createdByUserId ? (names.get(e.createdByUserId) ?? null) : null,
    version: e.version, past: isPast(e, now), statusChange: { byFirstName: e.statusChangedByUserId ? (names.get(e.statusChangedByUserId) ?? null) : null, at: e.statusChangedAt.toISOString() },
    can: actionsFor(v, e, now), conflicts: [], alternatives: [], reminders: [], nudge: null,
  };
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
  return { ...view, conflicts: views, alternatives: views.length && e.status !== "confirmed" ? await nearestSlots(db, v, e, now) : [] };
}

async function record(db: Kysely<DB>, accountId: string, eventId: string, action: "created" | "confirmed" | "modified" | "set_aside" | "ignored" | "canceled", from: EventStatus | null, to: EventStatus, userId: string | null, at: Date, reason?: string) {
  await db.insertInto("family_event_history").values({ account_id: accountId, event_id: eventId, action, from_status: from, to_status: to, by_user_id: userId, reason: reason ?? null, created_at: at }).execute();
}

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
  return { ...view, ...(await reminderDetails(ctx.db, v.accountId, e, v.timeZone, ctx.now)) };
}

/** Confirmations en attente d'un profil (US-75 RF4, US-84) : provisoires qu'il peut traiter, à venir. Les écartés n'y figurent plus. */
export async function listPending(ctx: Ctx, session: SessionContext): Promise<EventView[]> {
  const v = await viewerOf(ctx, session);
  const events = (await loadCalendarEvents(ctx.db, v.accountId, { from: ctx.now, to: new Date(ctx.now.getTime() + 800 * 86_400_000) }, ["provisional"]))
    .filter((e) => canSee(v, e) && canAct(v, e) && !isPast(e, ctx.now));
  const members = await loadMembers(ctx.db, v.accountId);
  const names = await firstNames(ctx.db, events.flatMap((e) => [e.createdByUserId, e.statusChangedByUserId]));
  return events.map((e) => toView(v, e, members, names, ctx.now));
}

/** Prochains rendez-vous de l'accueil de l'assistant (US-79 RF1) : confirmés et provisoires à venir. */
export async function listUpcoming(ctx: Ctx, session: SessionContext, limit = 10): Promise<EventView[]> {
  const v = await viewerOf(ctx, session);
  const events = (await loadCalendarEvents(ctx.db, v.accountId, { from: ctx.now, to: new Date(ctx.now.getTime() + 400 * 86_400_000) }, ["provisional", "confirmed"]))
    .filter((e) => canSee(v, e))
    .slice(0, limit);
  const members = await loadMembers(ctx.db, v.accountId);
  const names = await firstNames(ctx.db, events.flatMap((e) => [e.createdByUserId, e.statusChangedByUserId]));
  return events.map((e) => toView(v, e, members, names, ctx.now));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Changements d'état
// ---------------------------------------------------------------------------------------------------------------------------

export interface ChangeOptions {
  /** Version que l'écran affichait : une version dépassée est refusée (US-76 RT1). */
  expectedVersion?: number;
  /** Confirmer ou enregistrer malgré un conflit (US-74 RF7, US-80 RF3). */
  allowConflict?: boolean;
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
    if (views.length && !options.allowConflict) throw fail("conflict", "Ce créneau chevauche un autre rendez-vous.", 409, { conflicts: views, alternatives: await nearestSlots(trx, v, e, ctx.now) });
    await trx.updateTable("family_events").set({ status: "confirmed", version: e.version + 1, status_changed_at: ctx.now, status_changed_by_user_id: v.userId, reminders_from: ctx.now, updated_at: ctx.now }).where("id", "=", id).execute();
    await record(trx, v.accountId, id, "confirmed", e.status, "confirmed", v.userId, ctx.now);
  });
  return getEvent(ctx, session, id);
}

/** US-77 : « Ignorer » écarte un rendez-vous provisoire, qui reste visible en gris et barré jusqu'à la relance suivante. */
export async function setAsideEvent(ctx: Ctx, session: SessionContext, id: string, options: ChangeOptions = {}): Promise<EventView> {
  const v = await viewerOf(ctx, session);
  await ctx.db.transaction().execute(async (trx) => {
    const e = await locked(trx, v, id);
    if (e.status !== "provisional") throw await already(trx, e);
    if (options.expectedVersion !== undefined && options.expectedVersion !== e.version) throw stale(e);
    await trx.updateTable("family_events").set({ status: "set_aside", version: e.version + 1, status_changed_at: ctx.now, status_changed_by_user_id: v.userId, updated_at: ctx.now }).where("id", "=", id).execute();
    await record(trx, v.accountId, id, "set_aside", "provisional", "set_aside", v.userId, ctx.now);
  });
  return getEvent(ctx, session, id);
}

/** US-80 : annuler un rendez-vous confirmé. Il disparaît du calendrier et ne peut pas être rétabli. */
export async function cancelEvent(ctx: Ctx, session: SessionContext, id: string, options: ChangeOptions = {}): Promise<{ id: string; status: "canceled" }> {
  const v = await viewerOf(ctx, session);
  await ctx.db.transaction().execute(async (trx) => {
    const e = await locked(trx, v, id);
    if (e.status !== "confirmed") throw e.status === "canceled" || e.status === "ignored" ? stale(e) : fail("not_confirmed", "Seul un rendez-vous confirmé peut être annulé.", 409);
    if (options.expectedVersion !== undefined && options.expectedVersion !== e.version) throw stale(e);
    if (isPast(e, ctx.now)) throw fail("event_past", "Ce rendez-vous est déjà passé.", 409);
    await trx.updateTable("family_events").set({ status: "canceled", version: e.version + 1, status_changed_at: ctx.now, status_changed_by_user_id: v.userId, updated_at: ctx.now }).where("id", "=", id).execute();
    await record(trx, v.accountId, id, "canceled", "confirmed", "canceled", v.userId, ctx.now);
  });
  return { id, status: "canceled" };
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
  notes?: string | null;
}

function validated(v: Viewer, input: EventChanges, validMembers: Set<string>): { title: string; place: string | null; notes: string | null; from: Date; to: Date } {
  const title = (input.title ?? "").trim();
  if (!title) throw fail("invalid_title", "Le titre est obligatoire.", 422);
  if (title.length > MAX_EVENT_TITLE) throw fail("invalid_title", `Le titre ne peut pas dépasser ${MAX_EVENT_TITLE} caractères.`, 422);
  const place = input.place?.trim() || null;
  const notes = input.notes?.trim() || null;
  if (place && place.length > MAX_EVENT_PLACE) throw fail("invalid_place", `Le lieu ne peut pas dépasser ${MAX_EVENT_PLACE} caractères.`, 422);
  if (notes && notes.length > MAX_EVENT_NOTES) throw fail("invalid_notes", `La note ne peut pas dépasser ${MAX_EVENT_NOTES} caractères.`, 422);
  if (!EVENT_TYPES.includes(input.type)) throw fail("invalid_type", "Le type de rendez-vous est inconnu.", 422);
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
  return { title, place, notes, from, to };
}

/**
 * US-76 (provisoire) et US-80 (confirmé) : modifier un rendez-vous. Le statut ne change pas. Une modification fondée sur une version
 * dépassée est refusée. Pour un rendez-vous confirmé, un conflit demande de confirmer l'enregistrement (`allowConflict`).
 */
export async function updateEvent(ctx: Ctx, session: SessionContext, id: string, changes: EventChanges, options: ChangeOptions & { expectedVersion: number }): Promise<EventView> {
  const v = await viewerOf(ctx, session);
  const members = await loadMembers(ctx.db, v.accountId);
  const checked = validated(v, changes, new Set(members.keys()));
  await ctx.db.transaction().execute(async (trx) => {
    const e = await locked(trx, v, id);
    if (e.status !== "provisional" && e.status !== "confirmed") throw e.status === "canceled" || e.status === "ignored" ? stale(e) : await already(trx, e);
    if (options.expectedVersion !== e.version) throw stale(e);
    if (isPast(e, ctx.now)) throw fail("event_past", "Ce rendez-vous est déjà passé.", 409);
    // Un membre retiré n'est plus proposé (US-93 RF6) ; il peut rester sur un rendez-vous où il figure déjà.
    if (!changes.allFamily && changes.memberIds.some((m) => members.get(m)?.removed && !e.memberIds.includes(m))) {
      throw fail("invalid_members", "Un des membres choisis a été retiré de la famille.", 422);
    }
    const rescheduled = checked.from.getTime() !== e.startsAt.getTime() || changes.allDay !== e.allDay;
    const next: CalendarEvent = { ...e, startsAt: checked.from, endsAt: checked.to, allFamily: changes.allFamily, memberIds: changes.allFamily ? [] : [...new Set(changes.memberIds)] };
    if (e.status === "confirmed") {
      const { views } = await conflictsOf(trx, v, next);
      if (views.length && !options.allowConflict) throw fail("conflict", "Ce créneau chevauche un autre rendez-vous.", 409, { conflicts: views, alternatives: await nearestSlots(trx, v, next, ctx.now) });
    }
    await trx
      .updateTable("family_events")
      .set({
        title_encrypted: seal(checked.title), event_type: changes.type, starts_at: checked.from, ends_at: checked.to, all_day: changes.allDay, place_encrypted: sealOptional(checked.place),
        notes_encrypted: sealOptional(checked.notes), all_family: changes.allFamily, version: e.version + 1, updated_at: ctx.now,
        // Un changement d'horaire recalcule les rappels non envoyés : ceux de l'ancienne date ne comptent plus, ceux de la nouvelle repartent (US-81 RF9).
        ...(rescheduled ? { reminders_from: ctx.now } : {}),
      })
      .where("id", "=", id)
      .execute();
    if (rescheduled) await trx.deleteFrom("family_notifications").where("event_id", "=", id).where("kind", "in", ["d7", "d1", "d0"]).execute();
    await trx.deleteFrom("family_event_members").where("event_id", "=", id).execute();
    if (!changes.allFamily) await trx.insertInto("family_event_members").values(next.memberIds.map((m) => ({ event_id: id, member_id: m }))).execute();
    await record(trx, v.accountId, id, "modified", e.status, e.status, v.userId, ctx.now);
  });
  return getEvent(ctx, session, id);
}

