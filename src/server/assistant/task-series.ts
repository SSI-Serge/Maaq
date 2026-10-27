import { sql } from "kysely";
import { Rejection } from "@/server/http";
import { integerSetting } from "@/server/settings";
import { open, openOptional, seal } from "./fields";
import { localDay } from "./local-time";
import { addDays, expandOccurrences, isoWeekday, ruleOf, type Db, type SeriesRule } from "./series";
import { ruleFromRepetition, repetitionOf, type RepetitionInput } from "./series-ops";

/**
 * Tâches récurrentes (US-110 RF3, RF5, RT2) et tâches qui suivent une série de RDV (US-95 RF12). Comme pour les séances de RDV, une série est une règle et
 * un modèle ; ses occurrences sont de vraies tâches, créées 8 semaines à l'avance puis complétées par le planificateur. Une occurrence se coche seule (RF4).
 */

const fail = (code: string, message: string, status = 409) => new Rejection(code, message, status);

export interface TaskRepetition {
  frequency: "daily" | RepetitionInput["frequency"];
  weekdays?: number[];
  end: RepetitionInput["end"];
}

/** Règle complète à partir du formulaire ou de l'agent. « Chaque jour » est une règle hebdomadaire sur les sept jours. */
export function ruleFromTaskRepetition(repetition: TaskRepetition, firstDate: string): SeriesRule {
  const base = repetition.frequency === "daily" ? { frequency: "weekly" as const, weekdays: [1, 2, 3, 4, 5, 6, 7] } : { frequency: repetition.frequency, weekdays: repetition.weekdays };
  return ruleFromRepetition({ ...base, end: repetition.end, skipSchoolHolidays: false }, firstDate);
}

export function taskRepetitionOf(rule: SeriesRule): TaskRepetition {
  const { frequency, weekdays, end } = repetitionOf(rule);
  if (frequency === "weekly" && weekdays?.length === 7) return { frequency: "daily", end };
  return { frequency, ...(weekdays ? { weekdays } : {}), end };
}

/** La règle suit la date déplacée (CA 5.1) : une tâche du mardi décalée au mercredi passe, pour toute la portée choisie, au mercredi. */
export function shiftRule(rule: SeriesRule, oldDue: string, newDue: string): SeriesRule {
  if (oldDue === newDue) return rule;
  if (rule.unit === "week") {
    const delta = isoWeekday(newDue) - isoWeekday(oldDue);
    const weekdays = (rule.weekdays ?? []).map((w) => ((w - 1 + delta + 7) % 7) + 1).sort((a, b) => a - b);
    return { ...rule, weekdays };
  }
  return ruleFromRepetition({ frequency: rule.monthMode === "day_of_month" ? "monthly_day" : "monthly_weekday", end: rule.end }, newDue);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------------------------------------------------------

const COLUMNS = [
  "id", "account_id", "title", "note", "assigned_member_id", sql<string | null>`due_time::text`.as("due_time"), "event_series_id", "days_before_event", sql<string | null>`first_date::text`.as("first_date"),
  "repeat_unit", "repeat_interval", "weekdays", "month_mode", "month_day", "month_nth", "month_weekday", "end_kind", sql<string | null>`until_date::text`.as("until_date"), "occurrence_count",
  sql<string | null>`materialized_until::text`.as("materialized_until"), "ended_at", "proposed", "created_by_user_id", "source", "version",
] as const;

export async function loadTaskSeries(db: Db, accountId: string, id: string, options: { forUpdate?: boolean } = {}) {
  let query = db.selectFrom("family_task_series").select(COLUMNS).where("account_id", "=", accountId).where("id", "=", id);
  if (options.forUpdate) query = query.forUpdate();
  return query.executeTakeFirst();
}
export type TaskSeriesRow = NonNullable<Awaited<ReturnType<typeof loadTaskSeries>>>;

/** Règle d'une tâche à règle propre (la colonne d'unité n'est vide que pour une tâche qui suit une série de RDV). */
export const taskRuleOf = (row: TaskSeriesRow): SeriesRule => ruleOf({ ...row, repeat_unit: row.repeat_unit ?? "week" });

/** Fin de l'horizon de création : aujourd'hui (jour de la famille) plus 8 semaines glissantes (réglage de la plateforme). */
export async function taskHorizon(db: Db, today: string): Promise<string> {
  return addDays(today, 7 * (await integerSetting(db, "task_series_horizon_weeks", 8)));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Création des occurrences
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Crée les occurrences manquantes d'une tâche à règle propre, d'aujourd'hui à `until` (inclus). Jamais d'occurrence dans le passé : une règle qui commence avant
 * aujourd'hui démarre à sa prochaine date. Idempotent (index unique sur la série et la date d'origine).
 */
export async function materializeOwnSeries(db: Db, series: TaskSeriesRow, today: string, until: string): Promise<number> {
  const from = series.materialized_until;
  const dates = expandOccurrences(taskRuleOf(series), series.first_date!, until).filter((d) => d >= today && (!from || d > from));
  let created = 0;
  for (let i = 0; i < dates.length; i += 100) {
    const rows = dates.slice(i, i + 100).map((day) => ({
      account_id: series.account_id, series_id: series.id, occurrence_date: day, title: series.title, note: series.note, status: "todo" as const, due_date: day, due_time: series.due_time,
      assigned_member_id: series.assigned_member_id, created_by_user_id: series.created_by_user_id, source: series.source,
    }));
    const inserted = await db.insertInto("family_tasks").values(rows).onConflict((oc) => oc.columns(["series_id", "occurrence_date"]).where(sql<boolean>`series_id is not null`).doNothing()).returning("id").execute();
    created += inserted.length;
  }
  await db.updateTable("family_task_series").set({ materialized_until: until }).where("id", "=", series.id).execute();
  return created;
}

/**
 * Une occurrence par séance confirmée de la série de RDV et par modèle de tâche actif : échéance = jour de la séance moins l'écart. Une échéance déjà passée est ramenée à
 * aujourd'hui, pour qu'une tâche ne naisse pas en retard (US-95 RF3 bis). Retourne le nombre d'occurrences créées.
 */
export async function materializeEventTemplates(db: Db, eventSeriesId: string, now: Date, timeZone: string): Promise<number> {
  const templates = await db.selectFrom("family_task_series").select(COLUMNS).where("event_series_id", "=", eventSeriesId).where("proposed", "=", false).where("ended_at", "is", null).execute();
  if (!templates.length) return 0;
  const sessions = await db
    .selectFrom("family_events")
    .select(["id", "starts_at", sql<string>`occurrence_date::text`.as("occurrence_date")])
    .where("series_id", "=", eventSeriesId)
    .where("status", "=", "confirmed")
    .where("starts_at", ">", now)
    .execute();
  if (!sessions.length) return 0;
  const today = localDay(now, timeZone);
  let created = 0;
  for (const template of templates) {
    const rows = sessions.map((s) => {
      const eventDay = localDay(s.starts_at, timeZone);
      const due = addDays(eventDay, -(template.days_before_event ?? 0));
      return {
        account_id: template.account_id, series_id: template.id, occurrence_date: s.occurrence_date, event_id: s.id, title: template.title, note: template.note, status: "todo" as const,
        due_date: due < today ? today : due, due_time: template.due_time, days_before_event: template.days_before_event, assigned_member_id: template.assigned_member_id,
        created_by_user_id: template.created_by_user_id, source: template.source,
      };
    });
    for (let i = 0; i < rows.length; i += 100) {
      const inserted = await db.insertInto("family_tasks").values(rows.slice(i, i + 100)).onConflict((oc) => oc.columns(["series_id", "occurrence_date"]).where(sql<boolean>`series_id is not null`).doNothing()).returning("id").execute();
      created += inserted.length;
    }
  }
  return created;
}

/** Même chose, pour le fuseau de la famille de la série (appelé par les opérations sur les séries de RDV). */
export async function materializeEventSeriesTasks(db: Db, eventSeriesId: string, now: Date): Promise<number> {
  const row = await db.selectFrom("family_event_series as s").innerJoin("accounts as a", "a.id", "s.account_id").select("a.family_timezone").where("s.id", "=", eventSeriesId).executeTakeFirst();
  return materializeEventTemplates(db, eventSeriesId, now, row?.family_timezone ?? "Europe/Paris");
}

// ---------------------------------------------------------------------------------------------------------------------------
// Modification d'une tâche à règle propre (US-110 RF5)
// ---------------------------------------------------------------------------------------------------------------------------

export interface SeriesTaskEdit {
  title: string;
  note: string | null;
  assigneeId: string | null;
  dueTime: string | null;
  rule: SeriesRule;
  by: string;
}

const ruleColumns = (rule: SeriesRule) => ({
  repeat_unit: rule.unit, repeat_interval: rule.interval, weekdays: rule.weekdays ?? null, month_mode: rule.monthMode ?? null, month_day: rule.monthDay ?? null, month_nth: rule.monthNth ?? null,
  month_weekday: rule.monthWeekday ?? null, end_kind: rule.end.kind, until_date: rule.end.kind === "date" ? rule.end.date : null, occurrence_count: rule.end.kind === "count" ? rule.end.count : null,
});

/**
 * « Toutes » : le modèle et la règle sont remplacés, les occurrences à venir qui restent à faire et qui suivent le modèle sont recréées ; les passées, les faites, les annulées et
 * celles déjà modifiées seules (autre date, autre titre, autre personne, autre heure) ne bougent pas (D47, D61). L'occurrence d'où l'on modifie est toujours réécrite.
 */
export async function rewriteOwnSeries(db: Db, series: TaskSeriesRow, edit: SeriesTaskEdit, today: string, anchorId?: string): Promise<void> {
  const title = open(series.title);
  const note = openOptional(series.note);
  const time = series.due_time ? series.due_time.slice(0, 5) : null;
  const upcoming = await db
    .selectFrom("family_tasks")
    .select(["id", "title", "note", "assigned_member_id", sql<string>`due_date::text`.as("due"), sql<string | null>`due_time::text`.as("due_time"), sql<string>`occurrence_date::text`.as("occurrence")])
    .where("series_id", "=", series.id)
    .where("status", "=", "todo")
    .where((eb) => eb.or([eb("due_date", ">=", sql<Date>`${today}::date`), eb("occurrence_date", ">=", sql<Date>`${today}::date`)]))
    .execute();
  const replaceable = upcoming
    .filter((t) => t.id === anchorId || (t.due === t.occurrence && open(t.title) === title && openOptional(t.note) === note && t.assigned_member_id === series.assigned_member_id && (t.due_time ? t.due_time.slice(0, 5) : null) === time))
    .map((t) => t.id);
  await db
    .updateTable("family_task_series")
    .set({ title: seal(edit.title), note: edit.note ? seal(edit.note) : null, assigned_member_id: edit.assigneeId, due_time: edit.dueTime, ...ruleColumns(edit.rule), materialized_until: null })
    .where("id", "=", series.id)
    .execute();
  if (replaceable.length) await db.deleteFrom("family_tasks").where("id", "in", replaceable).execute();
  const fresh = (await loadTaskSeries(db, series.account_id, series.id))!;
  await materializeOwnSeries(db, fresh, today, await taskHorizon(db, today));
}

/** Occurrences de la règle avant un jour donné, pour ramener « après N fois » au reste à faire. */
export const occurrencesBefore = (rule: SeriesRule, firstDate: string, day: string): number => (day <= firstDate ? 0 : expandOccurrences(rule, firstDate, addDays(day, -1)).length);

/** Remplace la fin de la règle par la veille de `day` (la fin « après N fois » devient une date). */
export async function endOwnRuleBefore(db: Db, seriesId: string, day: string): Promise<void> {
  await db.updateTable("family_task_series").set({ end_kind: "date", until_date: addDays(day, -1), occurrence_count: null }).where("id", "=", seriesId).execute();
}

/**
 * « Cette fois et les suivantes » : la règle s'arrête la veille de l'occurrence, ses occurrences à faire à partir d'elle sont remplacées par celles d'une nouvelle série
 * qui porte le modèle modifié. Les occurrences passées gardent leur ancienne date (CA 5.1).
 */
export async function splitOwnSeries(db: Db, series: TaskSeriesRow, anchor: string, newFirst: string, edit: SeriesTaskEdit, today: string): Promise<string> {
  const oldRule = taskRuleOf(series);
  const before = occurrencesBefore(oldRule, series.first_date!, anchor);
  let end = edit.rule.end;
  if (end.kind === "count") {
    const left = end.count - before;
    if (left < 1) throw fail("invalid_repetition", "La règle ne produit plus aucune occurrence.", 422);
    end = { kind: "count", count: left };
  }
  const rule = { ...edit.rule, end };
  await endOwnRuleBefore(db, series.id, anchor);
  await db.deleteFrom("family_tasks").where("series_id", "=", series.id).where("status", "=", "todo").where("occurrence_date", ">=", sql<Date>`${anchor}::date`).execute();
  const row = await db
    .insertInto("family_task_series")
    .values({
      account_id: series.account_id, title: seal(edit.title), note: edit.note ? seal(edit.note) : null, assigned_member_id: edit.assigneeId, due_time: edit.dueTime, first_date: newFirst, ...ruleColumns(rule),
      created_by_user_id: series.created_by_user_id, source: series.source,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const fresh = (await loadTaskSeries(db, series.account_id, row.id))!;
  await materializeOwnSeries(db, fresh, today, await taskHorizon(db, today));
  return row.id;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Planificateur
// ---------------------------------------------------------------------------------------------------------------------------

export interface TaskCompletion {
  completed: number;
  created: number;
  ended: number;
}

/**
 * Passage du planificateur : complète les tâches récurrentes vers l'avant (8 semaines glissantes), crée les occurrences des séances nouvellement créées pour les tâches
 * qui suivent une série de RDV, et termine les règles dont la dernière occurrence est passée.
 */
export async function completeTaskSeries(db: Db, now: Date, options: { accountId?: string } = {}): Promise<TaskCompletion> {
  const result: TaskCompletion = { completed: 0, created: 0, ended: 0 };
  const due = await db
    .selectFrom("family_task_series")
    .select(["id", "account_id"])
    .where("event_series_id", "is", null)
    .where("proposed", "=", false)
    .where("ended_at", "is", null)
    .$if(Boolean(options.accountId), (qb) => qb.where("account_id", "=", options.accountId!))
    .execute();
  for (const { id, account_id } of due) {
    await db.transaction().execute(async (trx) => {
      const locked = await trx.selectFrom("family_task_series").select("id").where("id", "=", id).forUpdate().skipLocked().executeTakeFirst();
      if (!locked) return;
      const series = (await loadTaskSeries(trx, account_id, id))!;
      const timeZone = (await trx.selectFrom("accounts").select("family_timezone").where("id", "=", account_id).executeTakeFirst())?.family_timezone ?? "Europe/Paris";
      const today = localDay(now, timeZone);
      const horizon = await taskHorizon(trx, today);
      if (!series.materialized_until || series.materialized_until < horizon) {
        result.created += await materializeOwnSeries(trx, series, today, horizon);
        result.completed += 1;
      }
      if (series.end_kind !== "never") {
        const all = expandOccurrences(taskRuleOf(series), series.first_date!, series.end_kind === "date" ? series.until_date! : "2200-12-31");
        const lastDay = all[all.length - 1];
        if (lastDay && lastDay < today) {
          await trx.updateTable("family_task_series").set({ ended_at: now }).where("id", "=", id).execute();
          result.ended += 1;
        }
      }
    });
  }
  // Tâches qui suivent une série de RDV : séances créées depuis le dernier passage.
  const followers = await db
    .selectFrom("family_task_series as s")
    .innerJoin("accounts as a", "a.id", "s.account_id")
    .select(["s.event_series_id", "a.family_timezone"])
    .where("s.event_series_id", "is not", null)
    .where("s.proposed", "=", false)
    .where("s.ended_at", "is", null)
    .$if(Boolean(options.accountId), (qb) => qb.where("s.account_id", "=", options.accountId!))
    .groupBy(["s.event_series_id", "a.family_timezone"])
    .execute();
  for (const f of followers) result.created += await materializeEventTemplates(db, f.event_series_id!, now, f.family_timezone ?? "Europe/Paris");
  return result;
}
