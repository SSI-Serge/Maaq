import { sql, type Kysely } from "kysely";
import { loadCalendarEvents } from "@/server/assistant/calendar";
import { localDay, localToUtc } from "@/server/assistant/local-time";
import { addDays } from "@/server/assistant/series";
import type { DB } from "@/server/db/schema.generated";

/**
 * Indicateur de charge (US-145, E-05, E-16) : « Calme », « Chargé » ou « Très chargé », par jour et par parent, calculé par MAAQ à partir de règles fixes, sans l'agent. Rien n'est gardé
 * d'une semaine à l'autre et il n'est jamais montré en nombre. Pour un parent et un jour, on compte :
 *  - ses tâches « à faire » dues ce jour (hors tâches des devoirs) ;
 *  - les RDV provisoires ou confirmés du jour dont il est participant ;
 *  - les RDV du jour où aucun parent n'est participant (un enfant seul), pour le parent qui les a créés.
 * Les RDV « toute la famille » et les tâches sans assigné ou assignées à un enfant ne comptent pour personne : elles chargent les deux de la même façon, ou ne se rattachent à personne.
 */

export type LoadLevel = "calm" | "busy" | "very_busy";

export interface DayLoad {
  userId: string;
  firstName: string;
  level: LoadLevel;
}

export const DEFAULT_BUSY_MIN = 2;
export const DEFAULT_VERY_BUSY_MIN = 4;

export interface LoadThresholds {
  busy: number;
  veryBusy: number;
}

/** Seuils réglables dans la console (US-65) ; des valeurs incohérentes reviennent aux valeurs par défaut. */
export async function loadThresholds(db: Kysely<DB>): Promise<LoadThresholds> {
  const rows = await db.selectFrom("platform_settings").select(["setting_key", "value_text"]).where("setting_key", "in", ["workload_busy_min", "workload_very_busy_min"]).execute();
  const value = (key: string, fallback: number) => {
    const n = Number(rows.find((r) => r.setting_key === key)?.value_text);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  const busy = value("workload_busy_min", DEFAULT_BUSY_MIN);
  const veryBusy = value("workload_very_busy_min", DEFAULT_VERY_BUSY_MIN);
  return veryBusy > busy ? { busy, veryBusy } : { busy: DEFAULT_BUSY_MIN, veryBusy: DEFAULT_VERY_BUSY_MIN };
}

export const levelOf = (count: number, t: LoadThresholds): LoadLevel => (count >= t.veryBusy ? "very_busy" : count >= t.busy ? "busy" : "calm");

interface Parent {
  userId: string;
  firstName: string;
  memberId: string;
}

/** Les deux parents du couple et leur fiche « membre ». */
async function coupleParents(db: Kysely<DB>, accountId: string): Promise<Parent[]> {
  const rows = await db
    .selectFrom("users as u")
    .innerJoin("family_members as m", "m.user_id", "u.id")
    .select(["u.id", "u.first_name", "m.id as member_id", "u.role", "u.guest_rank"])
    .where("u.account_id", "=", accountId)
    .where("u.status", "in", ["active", "grace_period"])
    .where("m.archived_at", "is", null)
    .execute();
  return rows.filter((r) => r.role === "primary_user" || r.guest_rank === "core").map((r) => ({ userId: r.id, firstName: r.first_name, memberId: r.member_id }));
}

/** Nombre d'éléments par jour et par parent, pour les sept jours de la semaine qui commence le lundi `weekStart`. */
export async function workloadCounts(db: Kysely<DB>, accountId: string, weekStart: string, timeZone: string): Promise<{ parents: Parent[]; counts: Map<string, Map<string, number>> }> {
  const parents = await coupleParents(db, accountId);
  const counts = new Map<string, Map<string, number>>();
  const add = (day: string, userId: string) => {
    const perDay = counts.get(day) ?? new Map<string, number>();
    perDay.set(userId, (perDay.get(userId) ?? 0) + 1);
    counts.set(day, perDay);
  };
  const byMember = new Map(parents.map((p) => [p.memberId, p.userId]));

  const tasks = await db
    .selectFrom("family_tasks as t")
    .select([sql<string>`t.due_date::text`.as("due"), "t.assigned_member_id"])
    .where("t.account_id", "=", accountId)
    .where("t.status", "=", "todo")
    .where("t.source", "<>", "homework")
    .where("t.due_date", ">=", sql<Date>`${weekStart}::date`)
    .where("t.due_date", "<=", sql<Date>`${addDays(weekStart, 6)}::date`)
    .execute();
  for (const t of tasks) {
    const owner = t.assigned_member_id ? byMember.get(t.assigned_member_id) : undefined;
    if (owner) add(t.due, owner);
  }

  const from = localToUtc(weekStart, timeZone);
  const to = localToUtc(addDays(weekStart, 7), timeZone);
  const events = (await loadCalendarEvents(db, accountId, { from, to }, ["provisional", "confirmed"])).filter((e) => e.startsAt >= from);
  for (const e of events) {
    if (e.allFamily) continue;
    const day = localDay(e.startsAt, timeZone);
    const taking = e.memberIds.map((m) => byMember.get(m)).filter((u): u is string => Boolean(u));
    if (taking.length) for (const u of new Set(taking)) add(day, u);
    else if (e.createdByUserId && parents.some((p) => p.userId === e.createdByUserId)) add(day, e.createdByUserId);
  }
  return { parents, counts };
}

/** Charge de chacun des deux parents, jour par jour (clé : « AAAA-MM-JJ »). */
export async function computeWorkload(db: Kysely<DB>, accountId: string, weekStart: string, timeZone: string): Promise<Map<string, DayLoad[]>> {
  const thresholds = await loadThresholds(db);
  const { parents, counts } = await workloadCounts(db, accountId, weekStart, timeZone);
  const result = new Map<string, DayLoad[]>();
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    result.set(day, parents.map((p) => ({ userId: p.userId, firstName: p.firstName, level: levelOf(counts.get(day)?.get(p.userId) ?? 0, thresholds) })));
  }
  return result;
}
