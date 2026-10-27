import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { Rejection } from "@/server/http";
import { TYPE_CODE, eventTypeIds, type CalendarEvent, type EventType } from "./calendar";
import { seal, sealOptional } from "./fields";
import { localDay, utcToLocal } from "./local-time";
import { copyTemplates, proposedTasksToTemplates } from "./event-tasks";
import { materializeEventSeriesTasks } from "./task-series";
import { addDays, holidaysOf, horizonDay, isoWeekday, loadSeries, materialize, ruleLabel, ruleOf, type Db, type SeriesRule } from "./series";

/**
 * Ce que l'on fait sur une série déjà créée : la présenter (règle, séances en conflit), la confirmer d'un geste, l'annuler ou la modifier avec une portée
 * (« cette séance », « cette séance et les suivantes », « toute la série », US-109 RF8). La base garde les règles de statut ; ici, le calcul des séances.
 */

export type Scope = "this" | "following" | "all";
export const SCOPES: Scope[] = ["this", "following", "all"];

export interface RepetitionInput {
  frequency: "weekly" | "biweekly" | "monthly_day" | "monthly_weekday";
  /** Jours de la semaine ISO (1 = lundi) pour une répétition hebdomadaire ; par défaut, le jour de la première séance. */
  weekdays?: number[];
  end: { kind: "date"; date: string } | { kind: "count"; count: number } | { kind: "never" };
  skipSchoolHolidays?: boolean;
}

const fail = (code: string, message: string, status = 409, details?: unknown) => new Rejection(code, message, status, details);

/** Règle complète à partir de ce que l'on choisit dans le formulaire ou que dit l'agent, et de la date de la première séance. */
export function ruleFromRepetition(input: RepetitionInput, firstDate: string): SeriesRule {
  const weekday = isoWeekday(firstDate);
  const day = Number(firstDate.slice(8, 10));
  const base = { end: input.end, skipSchoolHolidays: Boolean(input.skipSchoolHolidays) };
  switch (input.frequency) {
    case "weekly":
      return { unit: "week", interval: 1, weekdays: input.weekdays?.length ? [...new Set(input.weekdays)].sort((a, b) => a - b) : [weekday], ...base };
    case "biweekly":
      return { unit: "week", interval: 2, weekdays: input.weekdays?.length ? [...new Set(input.weekdays)].sort((a, b) => a - b) : [weekday], ...base };
    case "monthly_day":
      return { unit: "month", interval: 1, monthMode: "day_of_month", monthDay: day, ...base };
    case "monthly_weekday":
      return { unit: "month", interval: 1, monthMode: "nth_weekday", monthNth: Math.ceil(day / 7) > 4 ? -1 : Math.ceil(day / 7), monthWeekday: weekday, ...base };
  }
}

/** Inverse : ce que le formulaire affiche pour une règle existante. */
export function repetitionOf(rule: SeriesRule): RepetitionInput {
  const frequency: RepetitionInput["frequency"] = rule.unit === "week" ? (rule.interval === 2 ? "biweekly" : "weekly") : rule.monthMode === "day_of_month" ? "monthly_day" : "monthly_weekday";
  return { frequency, ...(rule.weekdays ? { weekdays: rule.weekdays } : {}), end: rule.end, skipSchoolHolidays: rule.skipSchoolHolidays };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Présentation
// ---------------------------------------------------------------------------------------------------------------------------

export interface SeriesView {
  id: string;
  version: number;
  /** « Chaque mercredi jusqu'au 30/06/2027 » (RF10). */
  rule: string;
  repetition: RepetitionInput;
  /** Séance modifiée seule : mention « Modifiée » (RF8). */
  modified: boolean;
  /** Séances encore à venir, non annulées. */
  sessions: number;
  /** Séances à venir qui chevauchent un autre rendez-vous (RF5) : « 3 séances sur 24 sont en conflit ». */
  conflicts: { count: number; sessions: { id: string; start: string }[] };
  /** Série demandée par un autre profil : ne se modifie pas (D26) ; calculé par l'appelant. */
  status: "provisional" | "confirmed";
}

/** Séances de la série qui sont en conflit avec un autre RDV, parmi celles qui attendent une confirmation (provisoires ou écartées). */
export async function conflictingSessions(db: Db, seriesId: string): Promise<{ id: string; startsAt: Date }[]> {
  const rows = await sql<{ id: string; starts_at: Date }>`
    select e.id, e.starts_at from family_events e
     where e.series_id = ${seriesId}::uuid and e.status in ('provisional', 'set_aside') and e.starts_at > now()
       and exists (select 1 from find_family_event_conflicts(e.account_id, array(select m.member_id from family_event_members m where m.event_id = e.id), e.whole_family, e.starts_at, e.ends_at, e.id))
     order by e.starts_at`.execute(db);
  return rows.rows.map((r) => ({ id: r.id, startsAt: r.starts_at }));
}

export async function seriesView(db: Db, e: CalendarEvent, timeZone: string): Promise<SeriesView | null> {
  if (!e.seriesId) return null;
  const series = await loadSeries(db, e.accountId, e.seriesId);
  if (!series) return null;
  const rule = ruleOf(series);
  const sessions = await db
    .selectFrom("family_events")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("series_id", "=", e.seriesId)
    .where("status", "in", ["provisional", "set_aside", "confirmed"])
    .where("starts_at", ">", sql<Date>`now()`)
    .executeTakeFirstOrThrow();
  const clashes = series.status === "provisional" ? await conflictingSessions(db, e.seriesId) : [];
  return {
    id: series.id, version: series.version, rule: ruleLabel(rule), repetition: repetitionOf(rule), modified: e.isModified, sessions: Number(sessions.n),
    conflicts: { count: clashes.length, sessions: clashes.map((c) => ({ id: c.id, start: utcToLocal(c.startsAt, timeZone) })) },
    status: series.status === "confirmed" ? "confirmed" : "provisional",
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Confirmation et annulation
// ---------------------------------------------------------------------------------------------------------------------------

/** Confirme la série entière d'un geste : toutes les séances à venir, ou aucune (RF6, RT2). Retourne le nombre de séances confirmées. */
export async function confirmSeries(db: Db, e: CalendarEvent, userId: string): Promise<number> {
  const { rows } = await sql<{ n: number | null }>`select confirm_family_series(${e.seriesId}::uuid, ${userId}::uuid, ${null}::integer) as n`.execute(db);
  const n = rows[0]?.n;
  if (n === null || n === undefined) throw fail("already_handled", "Cette série a déjà été traitée.", 409);
  return Number(n);
}

/** Annule ou ignore selon la portée. « Cette séance » : une séance ; « suivantes » : de cette séance à la fin, la règle s'arrête la veille ; « toute la série » : tout. */
export async function cancelSeries(db: Db, e: CalendarEvent, scope: Scope, userId: string): Promise<void> {
  const series = (await loadSeries(db, e.accountId, e.seriesId!, { forUpdate: true }))!;
  if (scope === "this") {
    const to = e.status === "confirmed" ? "cancelled" : "dismissed";
    const { rows } = await sql<{ ok: boolean }>`select change_family_event_status(${e.id}::uuid, ${to}::event_status, ${userId}::uuid, ${null}::integer, 'user_request'::event_change_reason, 'this'::change_scope) as ok`.execute(db);
    if (!rows[0]?.ok) throw fail("already_handled", "Cette séance a déjà été traitée.", 409);
    return;
  }
  const first = await db.selectFrom("family_events").select(sql<string>`min(occurrence_date)::text`.as("d")).where("series_id", "=", series.id).executeTakeFirstOrThrow();
  if (scope === "all" || e.occurrenceDate === first.d) {
    const { rows } = await sql<{ n: number | null }>`select cancel_family_series(${series.id}::uuid, ${userId}::uuid, ${null}::integer, 'user_request'::event_change_reason) as n`.execute(db);
    if (rows[0]?.n === null) throw fail("already_handled", "Cette série a déjà été traitée.", 409);
    return;
  }
  const to = series.status === "confirmed" ? "cancelled" : "dismissed";
  const later = await db
    .selectFrom("family_events")
    .select("id")
    .where("series_id", "=", series.id)
    .where("occurrence_date", ">=", sql<Date>`${e.occurrenceDate!}::date`)
    .where("starts_at", ">", sql<Date>`now()`)
    .where("status", "in", series.status === "confirmed" ? ["confirmed"] : ["provisional", "set_aside"])
    .orderBy("starts_at")
    .execute();
  for (const row of later) {
    const { rows } = await sql<{ ok: boolean }>`select change_family_event_status(${row.id}::uuid, ${to}::event_status, ${userId}::uuid, ${null}::integer, 'user_request'::event_change_reason, 'following'::change_scope) as ok`.execute(db);
    if (!rows[0]?.ok) throw fail("already_handled", "Une séance a déjà été traitée.", 409);
  }
  // La règle s'arrête la veille : plus aucune séance ne sera recréée au-delà.
  await endRuleBefore(db, series.id, e.occurrenceDate!);
}

/** Remplace la fin de la règle par la veille de `day` (la fin « après N séances » devient une date). */
export async function endRuleBefore(db: Db, seriesId: string, day: string): Promise<void> {
  await db.updateTable("family_event_series").set({ end_kind: "date", until_date: addDays(day, -1), occurrence_count: null }).where("id", "=", seriesId).execute();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Modification
// ---------------------------------------------------------------------------------------------------------------------------

export interface SeriesEdit {
  title: string;
  type: EventType;
  allFamily: boolean;
  memberIds: string[];
  /** Début de la séance modifiée, heure locale « AAAA-MM-JJTHH:MM » ; l'heure et la durée valent pour toute la portée choisie. */
  from: Date;
  to: Date;
  allDay: boolean;
  place: string | null;
  /** Coordonnées chiffrées du lieu, déjà décidées par l'appelant (conservées, remplacées ou effacées). */
  placePoint: Buffer | null;
  notes: string | null;
  /** Nouvelle règle (RF7), sinon celle de la série est conservée. */
  repetition?: RepetitionInput | null;
}

/** Heure locale et durée du modèle, d'après la séance modifiée. */
function timing(edit: SeriesEdit, timeZone: string): { startTime: string; duration: number } {
  return { startTime: utcToLocal(edit.from, timeZone).slice(11, 16), duration: Math.max(1, Math.round((edit.to.getTime() - edit.from.getTime()) / 60_000)) };
}

async function replaceMembers(db: Db, seriesId: string, accountId: string, memberIds: string[], allFamily: boolean): Promise<void> {
  await db.deleteFrom("family_event_series_members").where("series_id", "=", seriesId).execute();
  if (!allFamily && memberIds.length) await db.insertInto("family_event_series_members").values(memberIds.map((member_id) => ({ series_id: seriesId, member_id, account_id: accountId }))).execute();
}

/** Applique le modèle modifié à la série et recrée ses séances à venir qui n'ont pas été modifiées seules (D47). Retourne l'identifiant de la séance qui remplace `e`. */
export async function rewriteSeries(db: Db, e: CalendarEvent, edit: SeriesEdit, now: Date): Promise<string> {
  const series = (await loadSeries(db, e.accountId, e.seriesId!, { forUpdate: true }))!;
  const typeId = (await eventTypeIds(db)).get(TYPE_CODE[edit.type])!;
  const { startTime, duration } = timing(edit, series.series_timezone);
  const rule = edit.repetition ? ruleFromRepetition(edit.repetition, series.first_date) : ruleOf(series);
  if (rule.skipSchoolHolidays && !(await holidaysOf(db, e.accountId)).zone) throw fail("no_school_zone", "« Sauf vacances scolaires » n'est pas possible : la zone scolaire de la famille n'est pas réglée.", 422);
  const medical = edit.type === "medical";
  await db
    .updateTable("family_event_series")
    .set({
      event_type_id: typeId, title: medical || !edit.title ? null : seal(edit.title), location: sealOptional(edit.place), location_point: medical ? null : edit.placePoint, note: sealOptional(edit.notes), start_time: edit.allDay ? "00:00" : startTime,
      duration_minutes: duration, all_day: edit.allDay, whole_family: edit.allFamily, repeat_unit: rule.unit, repeat_interval: rule.interval, weekdays: rule.weekdays ?? null,
      month_mode: rule.monthMode ?? null, month_day: rule.monthDay ?? null, month_nth: rule.monthNth ?? null, month_weekday: rule.monthWeekday ?? null,
      end_kind: rule.end.kind, until_date: rule.end.kind === "date" ? rule.end.date : null, occurrence_count: rule.end.kind === "count" ? rule.end.count : null,
      skip_school_holidays: rule.skipSchoolHolidays, materialized_until: null,
    })
    .where("id", "=", series.id)
    .execute();
  // allFamily avant les membres : la base refuse de désigner des membres pour « toute la famille ».
  await replaceMembers(db, series.id, e.accountId, edit.memberIds, edit.allFamily);
  // Séances à venir non modifiées seules : supprimées puis recréées sur le nouveau modèle (les passées, annulées et modifiées seules restent).
  const status = series.status === "confirmed" ? ["confirmed"] : ["provisional", "set_aside"];
  await db.deleteFrom("family_events").where("series_id", "=", series.id).where("is_modified", "=", false).where("starts_at", ">", sql<Date>`now()`).where("status", "in", status as ("confirmed" | "provisional" | "set_aside")[]).execute();
  const fresh = (await loadSeries(db, e.accountId, series.id))!;
  const members = edit.allFamily ? [] : [...new Set(edit.memberIds)];
  const until = await horizonDay(db, now, series.series_timezone);
  const created = await materialize(db, fresh, members, until, now);
  // Les séances recréées reçoivent les tâches de la série (US-95 RF12).
  await materializeEventSeriesTasks(db, series.id, now);
  const wanted = e.occurrenceDate!;
  const same = created.length ? await db.selectFrom("family_events").select(["id", sql<string>`occurrence_date::text`.as("d")]).where("id", "in", created).orderBy("occurrence_date").execute() : [];
  return (same.find((r) => r.d >= wanted) ?? same[0])?.id ?? e.id;
}

/** « Cette séance et les suivantes » : la série est scindée ; la nouvelle porte le modèle modifié, l'ancienne s'arrête la veille. Retourne la première séance de la nouvelle série. */
export async function splitSeries(db: Db, e: CalendarEvent, edit: SeriesEdit, now: Date, userId: string): Promise<string> {
  const old = (await loadSeries(db, e.accountId, e.seriesId!, { forUpdate: true }))!;
  const firstDate = e.occurrenceDate!;
  const oldRule = ruleOf(old);
  const rule = edit.repetition ? ruleFromRepetition(edit.repetition, firstDate) : oldRule;
  // L'ancienne règle s'arrête la veille (la fin « après N séances » devient une date) ; ses séances à partir d'ici sont remplacées.
  await endRuleBefore(db, old.id, firstDate);
  const status = old.status === "confirmed" ? ["confirmed"] : ["provisional", "set_aside"];
  await db.deleteFrom("family_events").where("series_id", "=", old.id).where("occurrence_date", ">=", sql<Date>`${firstDate}::date`).where("starts_at", ">", sql<Date>`now()`).where("status", "in", status as ("confirmed" | "provisional" | "set_aside")[]).execute();
  const typeId = (await eventTypeIds(db)).get(TYPE_CODE[edit.type])!;
  const { startTime, duration } = timing(edit, old.series_timezone);
  const medical = edit.type === "medical";
  const confirmed = old.status === "confirmed";
  const row = await db
    .insertInto("family_event_series")
    .values({
      account_id: e.accountId, event_type_id: typeId, title: medical || !edit.title ? null : seal(edit.title), location: sealOptional(edit.place), location_point: medical ? null : edit.placePoint, note: sealOptional(edit.notes),
      start_time: edit.allDay ? "00:00" : startTime, duration_minutes: duration, all_day: edit.allDay, whole_family: edit.allFamily, series_timezone: old.series_timezone, first_date: firstDate,
      repeat_unit: rule.unit, repeat_interval: rule.interval, weekdays: rule.weekdays ?? null, month_mode: rule.monthMode ?? null, month_day: rule.monthDay ?? null, month_nth: rule.monthNth ?? null,
      month_weekday: rule.monthWeekday ?? null, end_kind: rule.end.kind, until_date: rule.end.kind === "date" ? rule.end.date : null, occurrence_count: rule.end.kind === "count" ? rule.end.count : null,
      skip_school_holidays: rule.skipSchoolHolidays, status: confirmed ? "confirmed" : "provisional", source: old.source as "chat_text", requested_by_user_id: old.requested_by_user_id,
      source_at: now, source_message_id: old.source_message_id === null ? null : Number(old.source_message_id), split_from_series_id: old.id,
      ...(confirmed ? { confirmed_at: now, confirmed_by_user_id: userId } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await replaceMembers(db, row.id, e.accountId, edit.memberIds, edit.allFamily);
  // La nouvelle série garde les tâches de l'ancienne (US-95 RF12).
  await copyTemplates(db, old.id, row.id, !confirmed);
  const fresh = (await loadSeries(db, e.accountId, row.id))!;
  const until = await horizonDay(db, now, old.series_timezone);
  const created = await materialize(db, fresh, edit.allFamily ? [] : [...new Set(edit.memberIds)], until, now);
  await materializeEventSeriesTasks(db, row.id, now);
  if (!created.length) throw fail("empty_series", "La règle de répétition ne produit aucune séance.", 422);
  const first = await db.selectFrom("family_events").select("id").where("id", "in", created).orderBy("occurrence_date").limit(1).executeTakeFirstOrThrow();
  return first.id;
}

/** Un RDV provisoire devient une série (RF7, CA 7.1) : le RDV unique est remplacé par les séances de la série. Retourne la première séance. */
export async function transformToSeries(db: Db, e: CalendarEvent, edit: SeriesEdit & { repetition: RepetitionInput }, now: Date, userId: string, timeZone: string): Promise<string> {
  const { createSeries, SeriesError } = await import("./series");
  const firstDate = localDay(edit.from, timeZone);
  const { startTime, duration } = timing(edit, timeZone);
  const source = (await db.selectFrom("family_events").select(["source", "source_message_id"]).where("id", "=", e.id).executeTakeFirstOrThrow());
  const reverse = { chat_text: "typed", voice: "dictation", photo: "capture", forwarded_email: "mail" } as const;
  try {
    // La première séance a le même créneau que le RDV d'origine : l'empreinte anti-doublon de ce dernier est libérée avant de créer les séances.
    await db.updateTable("family_events").set({ fingerprint: randomBytes(16) }).where("id", "=", e.id).execute();
    const result = await createSeries(db, {
      accountId: e.accountId, userId, type: edit.type, title: edit.title, place: edit.place, placePoint: edit.type === "medical" ? null : edit.placePoint, notes: edit.notes, startTime, durationMinutes: duration, allDay: edit.allDay, allFamily: edit.allFamily,
      memberIds: edit.memberIds, firstDate, rule: ruleFromRepetition(edit.repetition, firstDate), timeZone, source: reverse[source.source as keyof typeof reverse] ?? "typed",
      sourceMessageId: source.source_message_id === null ? null : Number(source.source_message_id), now,
    });
    // Les tâches proposées du RDV deviennent les modèles de la série, avant que le RDV d'origine soit remplacé par ses séances.
    await proposedTasksToTemplates(db, e, result.seriesId, timeZone);
    await db.deleteFrom("family_events").where("id", "=", e.id).execute();
    return result.eventIds[0];
  } catch (error) {
    if (error instanceof SeriesError) throw fail("invalid_repetition", error.message, 422);
    throw error;
  }
}

