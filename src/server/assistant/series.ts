import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { integerSetting } from "@/server/settings";
import { TYPE_CODE, SOURCE_CODE, eventTypeIds, fingerprintOf, typeOfCode, type EventSource, type EventType } from "./calendar";
import { seal, sealOptional } from "./fields";
import { localDay, localToUtc } from "./local-time";

/**
 * Séries de RDV récurrents (US-109). Une série est une règle de répétition et un modèle ; ses séances sont de vrais RDV, créés à l'avance sur
 * 6 mois glissants puis complétés par le planificateur (RT1) : les conflits, les rappels et les tâches s'appliquent ainsi à chaque séance.
 * La base porte le reste : tout-ou-rien de la confirmation (`confirm_family_series`), annulation (`cancel_family_series`), plafond de 30 séries actives.
 */

export type Db = Kysely<DB>;

export interface SeriesRule {
  /** « year » (D70) : chaque année, même jour et même mois que la première séance ; le 29 février devient le 28 les années non bissextiles. */
  unit: "week" | "month" | "year";
  /** 1 = chaque semaine, chaque mois ou chaque année, 2 = toutes les deux semaines. */
  interval: 1 | 2;
  /** Jours de la semaine, ISO : 1 = lundi … 7 = dimanche (règle hebdomadaire). */
  weekdays?: number[];
  monthMode?: "day_of_month" | "nth_weekday";
  /** « le 5 » (règle mensuelle par jour du mois). */
  monthDay?: number;
  /** « le premier mardi » : rang 1 à 4, ou -1 pour le dernier ; jour ISO. */
  monthNth?: number;
  monthWeekday?: number;
  end: { kind: "date"; date: string } | { kind: "count"; count: number } | { kind: "never" };
  /** « Sauf vacances scolaires » : retire les séances qui tombent pendant les vacances de la zone de la famille. */
  skipSchoolHolidays: boolean;
}

export type HolidayPeriod = readonly [startsOn: string, endsOn: string];

// ---------------------------------------------------------------------------------------------------------------------------
// Calcul des dates (jours locaux « AAAA-MM-JJ », sans heure : un changement d'heure ne décale pas l'heure locale d'une séance, RT4)
// ---------------------------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const iso = (value: number) => new Date(value).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => iso(ms(day) + n * DAY);
/** Jour de la semaine ISO : 1 = lundi … 7 = dimanche. */
export const isoWeekday = (day: string) => ((new Date(ms(day)).getUTCDay() + 6) % 7) + 1;
const daysInMonth = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();

/** Date de la répétition annuelle pour l'année donnée : même mois et même jour que la première séance, le 29 février devenant le 28 les années non bissextiles. */
function yearlyDay(firstDate: string, year: number): string {
  const month = Number(firstDate.slice(5, 7));
  const day = Math.min(Number(firstDate.slice(8, 10)), new Date(Date.UTC(year, month, 0)).getUTCDate());
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Lundi de la semaine du jour donné. */
const mondayOf = (day: string) => addDays(day, 1 - isoWeekday(day));

function matches(rule: SeriesRule, firstDate: string, day: string): boolean {
  if (rule.unit === "week") {
    if (!(rule.weekdays ?? []).includes(isoWeekday(day))) return false;
    const weeks = Math.round((ms(mondayOf(day)) - ms(mondayOf(firstDate))) / (7 * DAY));
    return weeks >= 0 && weeks % rule.interval === 0;
  }
  const dayOfMonth = Number(day.slice(8, 10));
  if (rule.monthMode === "day_of_month") return dayOfMonth === Math.min(rule.monthDay ?? 1, daysInMonth(day));
  if (isoWeekday(day) !== rule.monthWeekday) return false;
  return rule.monthNth === -1 ? dayOfMonth + 7 > daysInMonth(day) : Math.ceil(dayOfMonth / 7) === rule.monthNth;
}

/**
 * Dates des séances de la règle, de `firstDate` à `upTo` inclus. Une séance qui tombe pendant des vacances est sautée (et ne compte pas dans « après N séances »,
 * D47). Pure : la même règle donne toujours les mêmes dates, ce qui permet au planificateur de rejouer le calcul sans créer de doublon.
 */
export function expandOccurrences(rule: SeriesRule, firstDate: string, upTo: string, holidays: readonly HolidayPeriod[] = []): string[] {
  const last = rule.end.kind === "date" && rule.end.date < upTo ? rule.end.date : upTo;
  const maxCount = rule.end.kind === "count" ? rule.end.count : Infinity;
  const out: string[] = [];
  if (rule.unit === "year") {
    // Une date par an, sans balayer les jours (une règle sans fin peut être calculée jusqu'à l'an 9999).
    for (let year = Number(firstDate.slice(0, 4)); out.length < maxCount; year += 1) {
      const day = yearlyDay(firstDate, year);
      if (day > last) break;
      out.push(day);
    }
    return out;
  }
  for (let day = firstDate; day <= last && out.length < maxCount; day = addDays(day, 1)) {
    if (!matches(rule, firstDate, day)) continue;
    if (rule.skipSchoolHolidays && holidays.some(([from, to]) => day >= from && day <= to)) continue;
    out.push(day);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Libellé de la règle (« Chaque mercredi jusqu'au 30/06/2027 », RF10)
// ---------------------------------------------------------------------------------------------------------------------------

const WEEKDAY = ["", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const NTH: Record<number, string> = { 1: "premier", 2: "deuxième", 3: "troisième", 4: "quatrième", [-1]: "dernier" };
const MONTH = ["", "janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const frDate = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

function list(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

/**
 * Texte de la règle sans l'heure ni la fin : « Chaque mercredi », « Toutes les deux semaines le lundi et le jeudi », « Le premier mardi de chaque mois »… La règle annuelle
 * (D70) n'a pas de jour propre : `firstDate` la date (« Chaque année le 8 novembre »).
 */
export function ruleBase(rule: SeriesRule, firstDate?: string): string {
  let text: string;
  if (rule.unit === "year") {
    text = firstDate ? `Chaque année le ${Number(firstDate.slice(8, 10)) === 1 ? "1er" : Number(firstDate.slice(8, 10))} ${MONTH[Number(firstDate.slice(5, 7))]}` : "Chaque année";
  } else if (rule.unit === "week") {
    const days = [...(rule.weekdays ?? [])].sort((a, b) => a - b);
    text = rule.interval === 2
      ? `Toutes les deux semaines le ${list(days.map((d) => WEEKDAY[d]))}`
      : days.length === 7 ? "Chaque jour" : `Chaque ${list(days.map((d) => WEEKDAY[d]))}`;
  } else if (rule.monthMode === "day_of_month") {
    text = `Chaque mois le ${rule.monthDay === 1 ? "1er" : rule.monthDay}`;
  } else {
    text = `Le ${NTH[rule.monthNth ?? 1]} ${WEEKDAY[rule.monthWeekday ?? 1]} de chaque mois`;
  }
  return text;
}

/** Texte de la règle avec sa fin : « Chaque mercredi jusqu'au 30/06/2027 » (RF10). */
export function ruleLabel(rule: SeriesRule, firstDate?: string): string {
  let text = ruleBase(rule, firstDate);
  if (rule.end.kind === "date") text += ` jusqu'au ${frDate(rule.end.date)}`;
  else if (rule.end.kind === "count") text += ` (${rule.end.count} séance${rule.end.count > 1 ? "s" : ""})`;
  return text;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture de la ligne de base
// ---------------------------------------------------------------------------------------------------------------------------

type SeriesRow = {
  id: string; account_id: string; event_type_id: number; title: Buffer | null; location: Buffer | null; location_point: Buffer | null; note: Buffer | null; start_time: string; duration_minutes: number;
  all_day: boolean; whole_family: boolean; series_timezone: string; first_date: string; repeat_unit: "day" | "week" | "month" | "yearly"; repeat_interval: number; weekdays: number[] | null;
  month_mode: "day_of_month" | "nth_weekday" | null; month_day: number | null; month_nth: number | null; month_weekday: number | null; end_kind: "date" | "count" | "never";
  until_date: string | null; occurrence_count: number | null; skip_school_holidays: boolean; status: string; materialized_until: string | null; version: number;
  source: string; requested_by_user_id: string | null; confirmed_by_user_id: string | null; source_message_id: string | number | null;
};

const SERIES_COLUMNS = [
  "id", "account_id", "event_type_id", "title", "location", "location_point", "note", sql<string>`start_time::text`.as("start_time"), "duration_minutes", "all_day", "whole_family", "series_timezone",
  sql<string>`first_date::text`.as("first_date"), "repeat_unit", "repeat_interval", "weekdays", "month_mode", "month_day", "month_nth", "month_weekday", "end_kind",
  sql<string | null>`until_date::text`.as("until_date"), "occurrence_count", "skip_school_holidays", "status", sql<string | null>`materialized_until::text`.as("materialized_until"), "version",
  "source", "requested_by_user_id", "confirmed_by_user_id", "source_message_id",
] as const;

export async function loadSeries(db: Db, accountId: string, id: string, options: { forUpdate?: boolean } = {}): Promise<SeriesRow | undefined> {
  let query = db.selectFrom("family_event_series").select(SERIES_COLUMNS).where("account_id", "=", accountId).where("id", "=", id);
  if (options.forUpdate) query = query.forUpdate();
  return (await query.executeTakeFirst()) as SeriesRow | undefined;
}

export type RuleColumns = Pick<SeriesRow, "repeat_unit" | "repeat_interval" | "weekdays" | "month_mode" | "month_day" | "month_nth" | "month_weekday" | "end_kind" | "until_date" | "occurrence_count"> & { skip_school_holidays?: boolean };

export function ruleOf(row: RuleColumns): SeriesRule {
  return {
    unit: row.repeat_unit === "month" ? "month" : row.repeat_unit === "yearly" ? "year" : "week",
    interval: row.repeat_interval === 2 ? 2 : 1,
    ...(row.weekdays ? { weekdays: row.weekdays.map(Number) } : {}),
    ...(row.month_mode ? { monthMode: row.month_mode, monthDay: row.month_day ?? undefined, monthNth: row.month_nth ?? undefined, monthWeekday: row.month_weekday ?? undefined } : {}),
    end: row.end_kind === "date" ? { kind: "date", date: row.until_date! } : row.end_kind === "count" ? { kind: "count", count: row.occurrence_count! } : { kind: "never" },
    skipSchoolHolidays: row.skip_school_holidays ?? false,
  };
}

/** Vacances de la zone scolaire de la famille ; vide si aucune zone n'est réglée (l'option « Sauf vacances scolaires » n'est alors pas proposée, RF4). */
export async function holidaysOf(db: Db, accountId: string): Promise<{ zone: string | null; periods: HolidayPeriod[] }> {
  const setting = await db.selectFrom("family_settings").select("school_zone").where("account_id", "=", accountId).executeTakeFirst();
  const zone = setting?.school_zone ?? null;
  if (!zone) return { zone: null, periods: [] };
  const rows = await db.selectFrom("school_holiday_periods").select([sql<string>`starts_on::text`.as("s"), sql<string>`ends_on::text`.as("e")]).where("zone", "=", zone).execute();
  return { zone, periods: rows.map((r): HolidayPeriod => [r.s, r.e]) };
}

/** Fin de l'horizon de création des séances : aujourd'hui (jour de la famille) plus N mois glissants (réglage de la plateforme, 6 par défaut). */
export async function horizonDay(db: Db, now: Date, timeZone: string): Promise<string> {
  const months = await integerSetting(db, "event_series_horizon_months", 6);
  const today = localDay(now, timeZone);
  const date = new Date(ms(today));
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Création et complétion
// ---------------------------------------------------------------------------------------------------------------------------

/** Valeur de la colonne d'unité pour une règle (la base écrit « yearly » pour l'année). */
export const unitColumn = (rule: SeriesRule): "week" | "month" | "yearly" => (rule.unit === "year" ? "yearly" : rule.unit);

export interface NewSeries {
  accountId: string;
  userId: string;
  type: EventType;
  /** Vide pour un RDV médical : « RDV médical — prénom » est composé à l'affichage. */
  title: string;
  place: string | null;
  /** Coordonnées chiffrées du lieu, quand l'adresse vient d'une suggestion (US-107 RT2) ; jamais pour un RDV médical. */
  placePoint?: Buffer | null;
  notes: string | null;
  /** « HH:MM » dans le fuseau de la série. */
  startTime: string;
  durationMinutes: number;
  allDay: boolean;
  allFamily: boolean;
  memberIds: string[];
  firstDate: string;
  rule: SeriesRule;
  timeZone: string;
  source: EventSource;
  sourceMessageId?: number | null;
  now: Date;
}

export class SeriesError extends Error {}

function bounds(series: Pick<SeriesRow, "start_time" | "duration_minutes" | "all_day" | "series_timezone">, day: string): { startsAt: Date; endsAt: Date } {
  if (series.all_day) return { startsAt: localToUtc(day, series.series_timezone), endsAt: localToUtc(`${day}T23:59`, series.series_timezone) };
  const startsAt = localToUtc(`${day}T${series.start_time.slice(0, 5)}`, series.series_timezone);
  return { startsAt, endsAt: new Date(startsAt.getTime() + series.duration_minutes * 60_000) };
}

/**
 * Dates des séances à créer jusqu'à `until`. Une série annuelle (D70) a toujours ses deux prochaines séances créées, même au-delà de l'horizon de 6 mois : un anniversaire dans
 * huit mois existe dès la création, et la suivante aussi.
 */
function seriesDates(rule: SeriesRule, firstDate: string, until: string, holidays: readonly HolidayPeriod[], today: string): string[] {
  const dates = expandOccurrences(rule, firstDate, until, holidays);
  if (rule.unit !== "year") return dates;
  const ahead = expandOccurrences(rule, firstDate, addDays(today, 3 * 366)).filter((d) => d >= today).slice(0, 2);
  return [...new Set([...dates, ...ahead])].sort();
}

/**
 * Crée les séances manquantes de la série jusqu'à `until` (inclus), au statut de la série (provisoire, ou confirmé pour une série déjà confirmée). Idempotent : une séance
 * déjà créée à cette date d'origine n'est jamais recréée (index unique). Retourne les identifiants des séances créées, dans l'ordre des dates.
 */
export async function materialize(db: Db, series: SeriesRow, memberIds: string[], until: string, now: Date): Promise<string[]> {
  const holidays = series.skip_school_holidays ? (await holidaysOf(db, series.account_id)).periods : [];
  const from = series.materialized_until;
  const dates = seriesDates(ruleOf(series), series.first_date, until, holidays, localDay(now, series.series_timezone)).filter((d) => !from || d > from);
  const typeId = series.event_type_id;
  const code = [...(await eventTypeIds(db)).entries()].find(([, id]) => id === typeId)?.[0] ?? "personal";
  const typeName = typeOfCode(code);
  const confirmed = series.status === "confirmed";
  const created: string[] = [];
  for (let i = 0; i < dates.length; i += 100) {
    const batch = dates.slice(i, i + 100).map((day) => {
      const { startsAt, endsAt } = bounds(series, day);
      return {
        account_id: series.account_id, event_type_id: typeId, title: series.title, location: series.location, location_point: series.location_point, note: series.note, starts_at: startsAt, ends_at: endsAt,
        end_is_default: false, all_day: series.all_day, whole_family: series.whole_family, status: confirmed ? ("confirmed" as const) : ("provisional" as const),
        source: series.source as "chat_text", requested_by_user_id: series.requested_by_user_id, source_at: now, source_message_id: series.source_message_id === null ? null : Number(series.source_message_id),
        series_id: series.id, occurrence_date: day,
        fingerprint: fingerprintOf({ startsAt, endsAt, type: typeName, allFamily: series.whole_family, memberIds }),
        ...(confirmed ? { confirmed_at: now, confirmed_by_user_id: series.confirmed_by_user_id } : {}),
      };
    });
    if (!batch.length) continue;
    const rows = await db.insertInto("family_events").values(batch).onConflict((oc) => oc.columns(["series_id", "occurrence_date"]).where(sql<boolean>`series_id is not null`).doNothing()).returning(["id"]).execute();
    created.push(...rows.map((r) => r.id));
    if (!series.whole_family && rows.length) {
      await db.insertInto("family_event_members").values(rows.flatMap((r) => memberIds.map((member_id) => ({ event_id: r.id, member_id, account_id: series.account_id })))).execute();
    }
  }
  await db.updateTable("family_event_series").set({ materialized_until: until }).where("id", "=", series.id).execute();
  return created;
}

/** Crée une série provisoire et ses séances des 6 prochains mois. Lève `SeriesError` si la règle ne produit aucune séance ou si une option n'est pas possible. */
export async function createSeries(db: Db, input: NewSeries): Promise<{ seriesId: string; eventIds: string[] }> {
  if (input.rule.unit === "year" && input.rule.skipSchoolHolidays) throw new SeriesError("« Sauf vacances scolaires » n'est pas possible pour une répétition annuelle.");
  const { zone } = await holidaysOf(db, input.accountId);
  if (input.rule.skipSchoolHolidays && !zone) throw new SeriesError("« Sauf vacances scolaires » n'est pas possible : la zone scolaire de la famille n'est pas réglée.");
  const typeId = (await eventTypeIds(db)).get(TYPE_CODE[input.type])!;
  const medical = input.type === "medical";
  const rule = input.rule;
  const until = await horizonDay(db, input.now, input.timeZone);
  const holidays = rule.skipSchoolHolidays ? (await holidaysOf(db, input.accountId)).periods : [];
  if (!seriesDates(rule, input.firstDate, until, holidays, localDay(input.now, input.timeZone)).length) throw new SeriesError("La règle de répétition ne produit aucune séance dans les 6 prochains mois.");

  let seriesId: string;
  try {
    const row = await db
      .insertInto("family_event_series")
      .values({
        account_id: input.accountId, event_type_id: typeId, title: medical || !input.title ? null : seal(input.title), location: sealOptional(input.place), location_point: input.placePoint ?? null, note: sealOptional(input.notes),
        start_time: input.allDay ? "00:00" : input.startTime, duration_minutes: input.durationMinutes, all_day: input.allDay, whole_family: input.allFamily, series_timezone: input.timeZone,
        first_date: input.firstDate, repeat_unit: unitColumn(rule), repeat_interval: rule.interval, weekdays: rule.weekdays ?? null, month_mode: rule.monthMode ?? null,
        month_day: rule.monthDay ?? null, month_nth: rule.monthNth ?? null, month_weekday: rule.monthWeekday ?? null,
        end_kind: rule.end.kind, until_date: rule.end.kind === "date" ? rule.end.date : null, occurrence_count: rule.end.kind === "count" ? rule.end.count : null,
        skip_school_holidays: rule.skipSchoolHolidays, status: "provisional", source: SOURCE_CODE[input.source], requested_by_user_id: input.userId, source_at: input.now,
        source_message_id: input.sourceMessageId ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    seriesId = row.id;
  } catch (error) {
    if ((error as { code?: string }).code === "23514" && /séries de RDV actives/.test((error as Error).message)) throw new SeriesError("Le nombre maximal de séries actives de la famille est atteint.");
    throw error;
  }
  if (!input.allFamily && input.memberIds.length) {
    await db.insertInto("family_event_series_members").values(input.memberIds.map((member_id) => ({ series_id: seriesId, member_id, account_id: input.accountId }))).execute();
  }
  const series = (await loadSeries(db, input.accountId, seriesId))!;
  const eventIds = await materialize(db, series, input.allFamily ? [] : input.memberIds, until, input.now);
  if (!eventIds.length) throw new SeriesError("La règle de répétition ne produit aucune séance dans les 6 prochains mois.");
  return { seriesId, eventIds };
}

export interface CompletionResult {
  completed: number;
  created: number;
  ended: number;
  dismissed: number;
}

/**
 * Passage du planificateur : complète les séries (séances créées vers l'avant seulement, sans recréer une séance annulée ou purgée), marque terminées celles qui n'ont plus
 * de séance à venir, et ferme les séries provisoires dont la première séance a commencé (`dismiss_unconfirmed_family_series`, D51).
 */
export async function completeSeries(db: Db, now: Date, options: { accountId?: string } = {}): Promise<CompletionResult> {
  const result: CompletionResult = { completed: 0, created: 0, ended: 0, dismissed: 0 };
  const dismissed = await sql<{ n: number }>`select dismiss_unconfirmed_family_series() as n`.execute(db);
  result.dismissed = Number(dismissed.rows[0]?.n ?? 0);
  const due = await db
    .selectFrom("family_event_series")
    .select("id")
    .where("status", "in", ["provisional", "confirmed"])
    .where("ended_at", "is", null)
    .$if(Boolean(options.accountId), (qb) => qb.where("account_id", "=", options.accountId!))
    .execute();
  for (const { id } of due) {
    await db.transaction().execute(async (trx) => {
      const row = (await trx.selectFrom("family_event_series").select("account_id").where("id", "=", id).forUpdate().skipLocked().executeTakeFirst());
      if (!row) return;
      const series = (await loadSeries(trx, row.account_id, id))!;
      const members = (await trx.selectFrom("family_event_series_members").select("member_id").where("series_id", "=", id).execute()).map((m) => m.member_id);
      const horizon = await horizonDay(trx, now, series.series_timezone);
      if (!series.materialized_until || series.materialized_until < horizon) {
        const created = await materialize(trx, series, members, horizon, now);
        result.created += created.length;
        result.completed += 1;
      }
      // Fin de la règle : plus aucune séance à créer, et la dernière est passée.
      if (series.end_kind !== "never") {
        const holidays = series.skip_school_holidays ? (await holidaysOf(trx, series.account_id)).periods : [];
        const all = expandOccurrences(ruleOf(series), series.first_date, "9999-12-31", holidays);
        const lastDay = all[all.length - 1];
        if (lastDay && lastDay < localDay(now, series.series_timezone) && (series.materialized_until ?? "") >= lastDay) {
          await trx.updateTable("family_event_series").set({ ended_at: now }).where("id", "=", id).execute();
          result.ended += 1;
        }
      }
    });
  }
  return result;
}
