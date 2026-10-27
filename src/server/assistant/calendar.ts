import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { open, openOptional } from "./fields";

/** Lecture du calendrier familial (déchiffrement compris) et détection des conflits, communes à l'agent et aux écrans. */

/** Types, statuts et origines tels que l'application les nomme ; `TYPE_CODE`, `STATUS_CODE` et `SOURCE_CODE` donnent leur valeur en base. */
export type EventType = "school" | "medical" | "work" | "family" | "personal" | "admin";
export type EventStatus = "provisional" | "confirmed" | "canceled" | "set_aside" | "ignored";
export type EventSource = "typed" | "dictation" | "capture" | "mail";

export const EVENT_TYPES: EventType[] = ["school", "medical", "work", "family", "personal", "admin"];

export const TYPE_CODE: Record<EventType, string> = { school: "school", medical: "medical", work: "professional", family: "family", personal: "personal", admin: "administrative" };
export const STATUS_CODE: Record<EventStatus, "provisional" | "confirmed" | "cancelled" | "set_aside" | "dismissed"> = {
  provisional: "provisional", confirmed: "confirmed", canceled: "cancelled", set_aside: "set_aside", ignored: "dismissed",
};
export const SOURCE_CODE: Record<EventSource, "chat_text" | "voice" | "photo" | "forwarded_email"> = { typed: "chat_text", dictation: "voice", capture: "photo", mail: "forwarded_email" };

const fromCode = <K extends string>(table: Record<K, string>, code: string): K => (Object.keys(table) as K[]).find((k) => table[k] === code) as K;

/** Type d'application d'un code de la table `event_types`. */
export const typeOfCode = (code: string): EventType => fromCode(TYPE_CODE, code);

export interface CalendarEvent {
  id: string;
  accountId: string;
  /** Titre affiché : celui du parent, ou « RDV médical — prénom » pour un rendez-vous médical, dont le titre n'est pas conservé. */
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
  /** Demandeur du rendez-vous, ou parent qui a transféré le mail. */
  createdByUserId: string | null;
  statusChangedAt: Date;
  /** Qui a confirmé, écarté, ignoré ou annulé en dernier ; vide pour un changement du système. */
  statusChangedByUserId: string | null;
  updatedAt: Date;
  /** Confirmé d'office, au nom de « MAAQ (sans réponse) » (AT-8). */
  autoConfirmed: boolean;
  /** Échéance d'enregistrement sans réponse d'un RDV provisoire ; vide = jamais (série, source hors tchat, proposé trop tard). */
  autoConfirmAt: Date | null;
  /** Série dont ce RDV est une séance, et date locale d'origine de la séance (US-109). */
  seriesId: string | null;
  occurrenceDate: string | null;
  /** Séance modifiée seule, qui reste rattachée à la série (mention « Modifiée »). */
  isModified: boolean;
  memberIds: string[];
}

/** Un rendez-vous occupe le calendrier tant qu'il est provisoire ou confirmé (D32 : écarté, ignoré et annulé ne bloquent pas). */
export const ACTIVE: EventStatus[] = ["provisional", "confirmed"];

/** Titre d'un rendez-vous médical : calculé à l'affichage à partir du premier membre concerné (US-93 RF4). */
export const MEDICAL_TITLE = "RDV médical";

export async function eventTypeIds(db: Kysely<DB>): Promise<Map<string, number>> {
  return new Map((await db.selectFrom("event_types").select(["id", "code"]).execute()).map((t) => [t.code, t.id]));
}

/**
 * Empreinte d'un rendez-vous (créneau, type, membres) : deux rendez-vous actifs identiques sont refusés par la base (US-89 RT3).
 * Le titre n'en fait pas partie.
 */
export function fingerprintOf(event: { startsAt: Date; endsAt: Date; type: EventType; allFamily: boolean; memberIds: string[] }): Buffer {
  const who = event.allFamily ? "famille" : [...new Set(event.memberIds)].sort().join(",");
  return createHash("sha256").update(`${event.startsAt.toISOString()}|${event.endsAt.toISOString()}|${TYPE_CODE[event.type]}|${who}`).digest();
}

const changedBy = sql<string | null>`(
  select h.user_id from family_event_history h
   where h.event_id = e.id and h.action in ('confirmed', 'set_aside', 'dismissed', 'cancelled')
   order by h.occurred_at desc, h.id desc limit 1
)`.as("changed_by_user_id");

function selectEvents(db: Kysely<DB>) {
  return db
    .selectFrom("family_events as e")
    .innerJoin("event_types as t", "t.id", "e.event_type_id")
    .select([
      "e.id", "e.account_id", "e.title", "t.code as type_code", "e.starts_at", "e.ends_at", "e.all_day", "e.location", "e.note", "e.status", "e.whole_family",
      "e.version", "e.source", "e.requested_by_user_id", "e.status_changed_at", "e.updated_at", "e.auto_confirmed", "e.auto_confirm_at", "e.series_id", sql<string | null>`e.occurrence_date::text`.as("occurrence_date"), "e.is_modified", changedBy,
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof selectEvents>["execute"]>>[number];

async function hydrate(db: Kysely<DB>, rows: Row[]): Promise<CalendarEvent[]> {
  if (!rows.length) return [];
  const links = await db.selectFrom("family_event_members").select(["event_id", "member_id"]).where("event_id", "in", rows.map((r) => r.id)).execute();
  const byEvent = new Map<string, string[]>();
  for (const l of links) byEvent.set(l.event_id, [...(byEvent.get(l.event_id) ?? []), l.member_id]);
  // Les rendez-vous médicaux n'ont pas de titre en base : on le recompose avec le premier membre concerné.
  const medical = rows.filter((r) => r.title === null);
  const firstNames = new Map<string, string>();
  if (medical.length) {
    const ids = [...new Set(medical.flatMap((r) => byEvent.get(r.id) ?? []))];
    if (ids.length) {
      const members = await db.selectFrom("family_members").select(["id", "first_name"]).where("id", "in", ids).orderBy("role").orderBy("alias_number").execute();
      for (const m of members) if (m.first_name) firstNames.set(m.id, m.first_name);
    }
  }
  const titleOf = (r: Row) => {
    if (r.title) return open(r.title);
    const name = (byEvent.get(r.id) ?? []).map((m) => firstNames.get(m)).find(Boolean);
    return name && !r.whole_family ? `${MEDICAL_TITLE} — ${name}` : MEDICAL_TITLE;
  };
  return rows.map((r) => ({
    id: r.id, accountId: r.account_id, title: titleOf(r), type: fromCode(TYPE_CODE, r.type_code), startsAt: r.starts_at, endsAt: r.ends_at, allDay: r.all_day,
    place: openOptional(r.location), notes: openOptional(r.note), status: fromCode(STATUS_CODE, r.status), allFamily: r.whole_family, version: r.version,
    source: fromCode(SOURCE_CODE, r.source), createdByUserId: r.requested_by_user_id, statusChangedAt: r.status_changed_at,
    statusChangedByUserId: r.changed_by_user_id, updatedAt: r.updated_at, autoConfirmed: r.auto_confirmed, autoConfirmAt: r.auto_confirm_at, seriesId: r.series_id, occurrenceDate: r.occurrence_date, isModified: r.is_modified, memberIds: byEvent.get(r.id) ?? [],
  }));
}

/** Rendez-vous d'un foyer qui chevauchent la période [from, to[, dans les statuts demandés. */
export async function loadCalendarEvents(db: Kysely<DB>, accountId: string, range: { from: Date; to: Date }, statuses: EventStatus[] = ACTIVE): Promise<CalendarEvent[]> {
  const rows = await selectEvents(db)
    .where("e.account_id", "=", accountId)
    .where("e.status", "in", statuses.map((s) => STATUS_CODE[s]))
    .where("e.starts_at", "<", range.to)
    .where("e.ends_at", ">", range.from)
    .orderBy("e.starts_at")
    .execute();
  return hydrate(db, rows);
}

export async function loadCalendarEvent(db: Kysely<DB>, accountId: string, id: string, options: { forUpdate?: boolean } = {}): Promise<CalendarEvent | undefined> {
  let query = selectEvents(db).where("e.account_id", "=", accountId).where("e.id", "=", id);
  // Le verrou ne porte que sur le rendez-vous : les tables jointes ne servent qu'à le lire.
  if (options.forUpdate) query = query.forUpdate("e");
  const row = await query.executeTakeFirst();
  return row ? (await hydrate(db, [row]))[0] : undefined;
}

async function loadByIds(db: Kysely<DB>, accountId: string, ids: string[]): Promise<CalendarEvent[]> {
  if (!ids.length) return [];
  return hydrate(db, await selectEvents(db).where("e.account_id", "=", accountId).where("e.id", "in", ids).orderBy("e.starts_at").execute());
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
 * La règle est celle de la base (`find_family_event_conflicts`).
 */
export async function findConflicts(db: Kysely<DB>, accountId: string, query: ConflictQuery): Promise<CalendarEvent[]> {
  const { rows } = await sql<{ id: string }>`
    select find_family_event_conflicts as id
      from find_family_event_conflicts(${accountId}::uuid, ${sql.val(query.memberIds)}::uuid[], ${query.allFamily}, ${query.from}, ${query.to}, ${query.excludeId ?? null}::uuid)`.execute(db);
  return loadByIds(db, accountId, rows.map((r) => r.id));
}
