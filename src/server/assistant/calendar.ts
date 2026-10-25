import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { open, openOptional } from "./fields";

/** Lecture du calendrier familial (déchiffrement compris) et détection des conflits, communes à l'agent et aux écrans. */

export type EventType = "school" | "medical" | "work" | "family" | "personal" | "admin";
export type EventStatus = "provisional" | "confirmed" | "canceled" | "set_aside" | "ignored";
export type EventSource = "typed" | "dictation" | "capture" | "mail";

export const EVENT_TYPES: EventType[] = ["school", "medical", "work", "family", "personal", "admin"];

export interface CalendarEvent {
  id: string;
  title: string;
  type: EventType;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  place: string | null;
  notes: string | null;
  status: EventStatus;
  allFamily: boolean;
  version: number;
  source: EventSource;
  createdByUserId: string | null;
  statusChangedAt: Date;
  statusChangedByUserId: string | null;
  memberIds: string[];
}

/** Un rendez-vous occupe le calendrier tant qu'il est provisoire ou confirmé (D32 : écarté, ignoré et annulé ne bloquent pas). */
export const ACTIVE: EventStatus[] = ["provisional", "confirmed"];

const COLUMNS = [
  "id", "title_encrypted", "event_type", "starts_at", "ends_at", "all_day", "place_encrypted", "notes_encrypted", "status", "all_family",
  "version", "source", "created_by_user_id", "status_changed_at", "status_changed_by_user_id",
] as const;

type Row = {
  id: string; title_encrypted: Buffer; event_type: EventType; starts_at: Date; ends_at: Date; all_day: boolean; place_encrypted: Buffer | null;
  notes_encrypted: Buffer | null; status: EventStatus; all_family: boolean; version: number; source: EventSource; created_by_user_id: string | null;
  status_changed_at: Date; status_changed_by_user_id: string | null;
};

async function hydrate(db: Kysely<DB>, rows: Row[]): Promise<CalendarEvent[]> {
  if (!rows.length) return [];
  const links = await db.selectFrom("family_event_members").select(["event_id", "member_id"]).where("event_id", "in", rows.map((r) => r.id)).execute();
  const byEvent = new Map<string, string[]>();
  for (const l of links) byEvent.set(l.event_id, [...(byEvent.get(l.event_id) ?? []), l.member_id]);
  return rows.map((r) => ({
    id: r.id, title: open(r.title_encrypted), type: r.event_type, startsAt: r.starts_at, endsAt: r.ends_at, allDay: r.all_day,
    place: openOptional(r.place_encrypted), notes: openOptional(r.notes_encrypted), status: r.status, allFamily: r.all_family, version: r.version,
    source: r.source, createdByUserId: r.created_by_user_id, statusChangedAt: r.status_changed_at, statusChangedByUserId: r.status_changed_by_user_id,
    memberIds: byEvent.get(r.id) ?? [],
  }));
}

/** Rendez-vous d'un foyer qui chevauchent la période [from, to[, dans les statuts demandés. */
export async function loadCalendarEvents(db: Kysely<DB>, accountId: string, range: { from: Date; to: Date }, statuses: EventStatus[] = ACTIVE): Promise<CalendarEvent[]> {
  const rows = await db
    .selectFrom("family_events")
    .select(COLUMNS)
    .where("account_id", "=", accountId)
    .where("status", "in", statuses)
    .where("starts_at", "<", range.to)
    .where("ends_at", ">", range.from)
    .orderBy("starts_at")
    .execute();
  return hydrate(db, rows as Row[]);
}

export async function loadCalendarEvent(db: Kysely<DB>, accountId: string, id: string, options: { forUpdate?: boolean } = {}): Promise<CalendarEvent | undefined> {
  let query = db.selectFrom("family_events").select(COLUMNS).where("account_id", "=", accountId).where("id", "=", id);
  if (options.forUpdate) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row ? (await hydrate(db, [row as Row]))[0] : undefined;
}

export interface ConflictQuery {
  from: Date;
  to: Date;
  memberIds: string[];
  allFamily: boolean;
  /** Le rendez-vous lui-même, pour qu'il ne soit pas en conflit avec lui-même. */
  excludeId?: string;
}

/**
 * US-74 RF2 à RF4 : deux rendez-vous sont en conflit quand leurs créneaux se chevauchent et qu'ils ont au moins un membre en commun ;
 * un rendez-vous « toute la famille » est en conflit avec tout rendez-vous qui le chevauche. Seuls les provisoires et confirmés comptent.
 */
export async function findConflicts(db: Kysely<DB>, accountId: string, query: ConflictQuery): Promise<CalendarEvent[]> {
  const who = new Set(query.memberIds);
  return (await loadCalendarEvents(db, accountId, { from: query.from, to: query.to }))
    .filter((e) => e.id !== query.excludeId)
    .filter((e) => query.allFamily || e.allFamily || e.memberIds.some((m) => who.has(m)));
}
