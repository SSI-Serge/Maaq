import { readFileSync } from "node:fs";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { describeError } from "@/server/safe-log";
import { loadCalendarEvents, type CalendarEvent } from "./calendar";
import { listEvents, type CalendarListItem } from "./events";
import { presentedQuestions, type QuestionView } from "./anticipation";
import { loadPseudoMembers } from "./family";
import { open, seal } from "./fields";
import { localDay, localToUtc, utcToLocal } from "./local-time";
import { estimateCostUsd } from "./cost";
import { createModel, type AssistantModel } from "./model";
import { getPersonalSettings } from "./notices";
import { Pseudonymizer } from "./pseudonymize";
import { addDays, isoWeekday } from "./series";
import { claimDaily, dispatch, recipientsOf, type Recipient } from "./task-notices";
import { isDay, listTasksBetween, taskViewer, type TaskView } from "./tasks";

/**
 * Point de la semaine (US-98). Les listes (RDV, tâches, points d'attention) sont calculées en direct pour le profil qui les lit (D26) ; seul le résumé est conservé
 * (`weekly_digests`), rédigé une fois par famille par le modèle léger à partir de références sans titre, lieu ni prénom (D39, AF-8), et remplacé par les titres à l'affichage.
 * Un invité secondaire n'a que le résumé de MAAQ, calculé sur ce qu'il voit. Le point couvre le lundi-dimanche qui suit son envoi (D47, schéma `week_start`).
 */

export const DIGEST_URL = "/assistant/semaine";
/** Le résumé est préparé une heure avant l'envoi (RT1) ; un envoi manqué reste possible 12 heures. */
const PREPARE_MS = 3_600_000;
const GRACE_MS = 12 * 3_600_000;
/** Une préparation restée « en cours » au-delà de ce délai (serveur arrêté) est reprise. */
const PENDING_TTL_SECONDS = 600;
const SUMMARY_TIMEOUT_MS = 30_000;
const WEEKDAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

export interface DigestSettings {
  enabled: boolean;
  weekday: number;
  hour: number;
}

/** Lundi qui suit le jour donné : un point envoyé un dimanche couvre la semaine suivante, un point envoyé un mercredi aussi (D47). */
export const mondayAfter = (day: string) => addDays(day, 8 - isoWeekday(day));

/** L'envoi de ce profil qui est en cours (de une heure avant à douze heures après son heure), s'il y en a un. */
export function digestSlot(settings: DigestSettings, timeZone: string, now: Date): { sendAt: Date; weekStart: string } | null {
  const today = localDay(now, timeZone);
  for (let back = 1; back >= -1; back--) {
    const day = addDays(today, -back);
    if (isoWeekday(day) !== settings.weekday) continue;
    const sendAt = localToUtc(`${day}T${String(settings.hour).padStart(2, "0")}:00`, timeZone);
    if (now.getTime() >= sendAt.getTime() - PREPARE_MS && now.getTime() <= sendAt.getTime() + GRACE_MS) return { sendAt, weekStart: mondayAfter(day) };
  }
  return null;
}

/** La semaine du dernier point envoyé à ce profil : il reste consultable jusqu'au suivant (RF8). */
export function currentDigestWeek(settings: DigestSettings, timeZone: string, now: Date): string {
  const today = localDay(now, timeZone);
  for (let back = 0; back <= 7; back++) {
    const day = addDays(today, -back);
    if (isoWeekday(day) !== settings.weekday) continue;
    if (localToUtc(`${day}T${String(settings.hour).padStart(2, "0")}:00`, timeZone) <= now) return mondayAfter(day);
  }
  return mondayAfter(addDays(today, -7));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture : l'écran « Point de la semaine »
// ---------------------------------------------------------------------------------------------------------------------------

export interface DigestEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  status: "provisional" | "confirmed";
  members: CalendarListItem["members"];
  conflict: boolean;
}

export interface DigestDay {
  date: string;
  events: DigestEvent[];
  tasks: TaskView[];
  /** Deux RDV de ce jour se chevauchent pour une même personne. */
  conflict: boolean;
}

export interface AttentionPoint {
  kind: "conflict" | "unassigned" | "to_confirm";
  text: string;
  link: { type: "event" | "task"; id: string };
}

export interface DigestView {
  weekStart: string;
  weekEnd: string;
  /** Résumé de l'agent (parents) ou de MAAQ (invité secondaire) ; vide quand l'agent n'a pas pu le produire (RF9). */
  summary: { text: string; source: "agent" | "maaq" } | null;
  counts: { events: number; tasks: number; alerts: number; toConfirm: number };
  days: DigestDay[];
  attention: AttentionPoint[];
  /** « Fait la semaine passée » (AT-9) et « Encore ouvert de la semaine passée », sans couleur d'alerte. */
  lastWeek: { doneTasks: number; doneEvents: number; open: TaskView[] };
  calm: boolean;
  parent: boolean;
  /** Questions de rappel de la semaine (US-102 RF4) : réservées aux parents. */
  questions: QuestionView[];
  today: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function dayLabel(date: string): string {
  return WEEKDAY_NAMES[isoWeekday(date) - 1];
}

/** Résumé de MAAQ pour un invité secondaire : seulement ce qu'il voit, sans rien laisser deviner du reste (RF3). */
function maaqSummary(days: DigestDay[]): string {
  const events = days.reduce((n, d) => n + d.events.length, 0);
  const tasks = days.reduce((n, d) => n + d.tasks.length, 0);
  if (!events && !tasks) return "Semaine calme : rien de prévu pour vous pour l'instant.";
  const busiest = [...days].sort((a, b) => b.events.length + b.tasks.length - (a.events.length + a.tasks.length))[0];
  const items = busiest.events.length + busiest.tasks.length;
  return `Cette semaine : ${plural(events, "RDV", "RDV")} et ${plural(tasks, "tâche", "tâches")} pour vous.${items > 1 ? ` Le jour le plus rempli est ${dayLabel(busiest.date)} (${items} éléments).` : ""}`;
}

function overlap(a: CalendarListItem, b: CalendarListItem): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Le point de la semaine d'un profil. Sans `weekStart`, c'est celui du dernier envoi de ce profil (RF8). Les listes suivent la visibilité du profil ; le résumé de l'agent n'est
 * montré qu'aux parents, avec les références remplacées par les titres que ce profil a le droit de voir (D39).
 */
export async function getDigest(ctx: Ctx, session: SessionContext, weekParam?: string): Promise<DigestView> {
  const v = await taskViewer(ctx, session);
  const settings = (await getPersonalSettings(ctx, session)).weeklyDigest;
  if (weekParam !== undefined && (!isDay(weekParam) || isoWeekday(weekParam) !== 1)) throw new Rejection("invalid_week", "La semaine demandée est invalide.", 422);
  const weekStart = weekParam ?? currentDigestWeek(settings, v.timeZone, ctx.now);
  const weekEnd = addDays(weekStart, 6);
  const previous = { from: addDays(weekStart, -7), to: addDays(weekStart, -1) };

  const events = (await listEvents(ctx, session, { from: weekStart, to: weekEnd })).filter((e): e is CalendarListItem & { status: "provisional" | "confirmed" } => e.status === "provisional" || e.status === "confirmed");
  const tasks = (await listTasksBetween(ctx, session, { from: weekStart, to: weekEnd })).filter((t) => t.status === "todo");
  const days: DigestDay[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i);
    const dayEvents = events.filter((e) => e.start.slice(0, 10) === date);
    return {
      date,
      events: dayEvents.map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, status: e.status, members: e.members, conflict: e.conflictsWith.length > 0 })),
      tasks: tasks.filter((t) => t.due === date),
      conflict: dayEvents.some((e) => e.conflictsWith.length > 0),
    };
  });

  const attention: AttentionPoint[] = [];
  const seen = new Set<string>();
  for (const e of events.filter((x) => x.conflictsWith.length > 0)) {
    for (const id of e.conflictsWith) {
      const other = events.find((o) => o.id === id);
      const key = [e.id, id].sort().join("|");
      if (!other || seen.has(key) || !overlap(e, other)) continue;
      seen.add(key);
      attention.push({ kind: "conflict", text: `Conflit ${dayLabel(e.start.slice(0, 10))} : ${e.title} et ${other.title}`, link: { type: "event", id: e.id } });
    }
  }
  if (v.parent) for (const t of tasks.filter((x) => !x.assignee)) attention.push({ kind: "unassigned", text: `Sans personne : ${t.title}`, link: { type: "task", id: t.id } });
  const toConfirm = events.filter((e) => e.status === "provisional" && e.can.confirm);
  for (const e of toConfirm) attention.push({ kind: "to_confirm", text: `À confirmer : ${e.title}`, link: { type: "event", id: e.id } });

  const lastEvents = await listEvents(ctx, session, previous);
  const lastTasks = await listTasksBetween(ctx, session, previous);

  let summary: DigestView["summary"] = null;
  if (v.parent) {
    const row = await ctx.db.selectFrom("weekly_digests").select("agent_summary").where("account_id", "=", v.accountId).where("week_start", "=", sql<Date>`${weekStart}::date`).where("summary_status", "=", "generated").executeTakeFirst();
    if (row?.agent_summary) summary = { text: await expandSummary(ctx.db, v.accountId, open(row.agent_summary), events, tasks), source: "agent" };
  } else summary = { text: maaqSummary(days), source: "maaq" };

  return {
    weekStart, weekEnd, summary,
    counts: { events: events.length, tasks: tasks.length, alerts: attention.filter((a) => a.kind !== "to_confirm").length, toConfirm: toConfirm.length },
    days, attention,
    lastWeek: { doneTasks: lastTasks.filter((t) => t.status === "done").length, doneEvents: lastEvents.filter((e) => e.status === "confirmed" && e.past).length, open: lastTasks.filter((t) => t.status === "todo") },
    calm: events.length === 0 && tasks.length === 0, parent: v.parent, questions: v.parent ? await presentedQuestions(ctx.db, v.accountId, v.timeZone, ctx.now) : [], today: v.today,
  };
}

/** Remplace les alias par les prénoms et les références par les titres que le lecteur voit ; une référence qu'il ne voit pas devient « un rendez-vous » ou « une tâche » (D39). */
async function expandSummary(db: Kysely<DB>, accountId: string, text: string, events: { id: string; title: string }[], tasks: { id: string; title: string }[]): Promise<string> {
  const pseudo = new Pseudonymizer(await loadPseudoMembers(db, accountId));
  return pseudo
    .fromModel(text)
    .replace(/\[\[evt-([0-9a-f]{8})\]\]/g, (_all, p: string) => events.find((e) => e.id.startsWith(p))?.title ?? "un rendez-vous")
    .replace(/\[\[tch-([0-9a-f]{8})\]\]/g, (_all, p: string) => tasks.find((t) => t.id.startsWith(p))?.title ?? "une tâche");
}

// ---------------------------------------------------------------------------------------------------------------------------
// Résumé de l'agent (une fois par famille)
// ---------------------------------------------------------------------------------------------------------------------------

let digestModelCache: AssistantModel | undefined;

/** Le modèle léger du résumé (`ASSISTANT_DIGEST_MODEL`, sinon celui de l'assistant) ; vide tant que l'assistant n'est pas ouvert. */
export function digestModel(): AssistantModel | null {
  const settings = env();
  if (settings.ASSISTANT_MODE !== "live") return null;
  digestModelCache ??= createModel({ provider: settings.ASSISTANT_PROVIDER, apiKey: settings.ANTHROPIC_API_KEY!, model: settings.ASSISTANT_DIGEST_MODEL ?? settings.ASSISTANT_MODEL, effort: "low", maxTokens: 1_000 });
  return digestModelCache;
}

const instructions = () => readFileSync(path.join(process.env.ASSISTANT_AGENT_DIR ?? path.join(process.cwd(), "agent"), "digest-instructions.md"), "utf8");

const evtRef = (id: string) => `evt-${id.slice(0, 8)}`;
const tchRef = (id: string) => `tch-${id.slice(0, 8)}`;

/** Ce que reçoit le modèle : références, jour, moment, type, alias et conflit. Jamais un titre, un lieu ni un prénom (AF-8, RF4). */
async function summaryInput(db: Kysely<DB>, accountId: string, weekStart: string, timeZone: string): Promise<{ text: string; events: number; tasks: number }> {
  const pseudo = new Pseudonymizer(await loadPseudoMembers(db, accountId));
  const from = localToUtc(weekStart, timeZone);
  const to = localToUtc(addDays(weekStart, 7), timeZone);
  const events = (await loadCalendarEvents(db, accountId, { from, to }, ["provisional", "confirmed"])).filter((e) => e.startsAt >= from);
  const moment = (e: CalendarEvent) => {
    const hour = Number(utcToLocal(e.startsAt, timeZone).slice(11, 13));
    return e.allDay ? "journée entière" : hour < 12 ? "matin" : hour < 18 ? "après-midi" : "soir";
  };
  const clash = (a: CalendarEvent, b: CalendarEvent) => a.id !== b.id && a.startsAt < b.endsAt && b.startsAt < a.endsAt && (a.allFamily || b.allFamily || a.memberIds.some((m) => b.memberIds.includes(m)));
  const tasks = await db
    .selectFrom("family_tasks as t")
    .select(["t.id", "t.event_id", "t.assigned_member_id", sql<string>`t.due_date::text`.as("due"), sql<boolean>`t.due_time is not null`.as("timed")])
    .where("t.account_id", "=", accountId)
    .where("t.status", "=", "todo")
    .where("t.due_date", ">=", sql<Date>`${weekStart}::date`)
    .where("t.due_date", "<=", sql<Date>`${addDays(weekStart, 6)}::date`)
    .execute();
  const payload = {
    debut: weekStart,
    fin: addDays(weekStart, 6),
    evenements: events.map((e) => ({
      ref: evtRef(e.id), jour: dayLabel(localDay(e.startsAt, timeZone)), moment: moment(e), type: e.type, statut: e.status === "confirmed" ? "confirmé" : "provisoire",
      personnes: e.allFamily ? ["toute la famille"] : e.memberIds.map((m) => pseudo.aliasFor(m)), conflit: events.some((o) => clash(e, o)),
    })),
    taches: tasks.map((t) => ({ ref: tchRef(t.id), echeance: dayLabel(t.due), assignee: t.assigned_member_id ? pseudo.aliasFor(t.assigned_member_id) : "personne", ...(t.event_id ? { rdv: evtRef(t.event_id) } : {}), ...(t.timed ? { heure_precise: true } : {}) })),
  };
  return { text: `<semaine>\n${JSON.stringify(payload, null, 1)}\n</semaine>`, events: events.length, tasks: tasks.length };
}

/**
 * Prépare le résumé de la famille pour cette semaine, une seule fois (RT1) : la ligne « en cours » est réservée avant l'appel du modèle. En cas d'échec, le point est quand même
 * envoyé, sans résumé (RF9). Retourne vrai quand un résumé a été produit.
 */
export async function prepareDigest(ctx: Ctx, accountId: string, weekStart: string, timeZone: string, model: AssistantModel | null = digestModel()): Promise<boolean> {
  let claimed = (await ctx.db.insertInto("weekly_digests").values({ account_id: accountId, week_start: weekStart }).onConflict((oc) => oc.columns(["account_id", "week_start"]).doNothing()).returning("id").executeTakeFirst())?.id;
  if (!claimed) {
    claimed = (await sql<{ id: string }>`update weekly_digests set created_at = now() where account_id = ${accountId}::uuid and week_start = ${weekStart}::date and summary_status = 'pending' and created_at < now() - ${sql.lit(`${PENDING_TTL_SECONDS} seconds`)}::interval returning id`.execute(ctx.db)).rows[0]?.id;
  }
  if (!claimed) return false;
  let input: Awaited<ReturnType<typeof summaryInput>> | undefined;
  try {
    input = await summaryInput(ctx.db, accountId, weekStart, timeZone);
    if (!model) throw new Error("assistant fermé");
    const answer = await Promise.race([
      model.send({ system: instructions(), tools: [], messages: [{ role: "user", content: input.text }] }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("délai dépassé")), SUMMARY_TIMEOUT_MS)),
    ]);
    // Trace d'exploitation : métadonnées seulement, jamais le contenu du résumé.
    console.info(JSON.stringify({ event: "assistant_digest", model: model.id ?? null, tokens: answer.usage, costUsd: estimateCostUsd(model.id, answer.usage), requestId: answer.requestId }));
    const text = answer.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!text || answer.stopReason !== "end_turn") throw new Error("réponse inutilisable");
    await ctx.db.updateTable("weekly_digests").set({ summary_status: "generated", agent_summary: seal(text), generated_at: ctx.now, events_count: input.events, tasks_count: input.tasks }).where("id", "=", claimed).execute();
    return true;
  } catch (error) {
    console.error(`Résumé du point de la semaine non produit : ${describeError(error)}`);
    await ctx.db.updateTable("weekly_digests").set({ summary_status: "failed", events_count: input?.events ?? null, tasks_count: input?.tasks ?? null }).where("id", "=", claimed).execute();
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Planificateur
// ---------------------------------------------------------------------------------------------------------------------------

export interface DigestsResult {
  prepared: number;
  sent: number;
  failed: number;
}

async function visibleCounts(db: Kysely<DB>, userId: string, weekStart: string, timeZone: string): Promise<{ events: number; tasks: number }> {
  const from = localToUtc(weekStart, timeZone);
  const to = localToUtc(addDays(weekStart, 7), timeZone);
  const events = await sql<{ n: string }>`select count(*) as n from family_events_visible_to(${userId}::uuid) e where e.status in ('confirmed', 'provisional') and e.starts_at >= ${from} and e.starts_at < ${to}`.execute(db);
  const tasks = await sql<{ n: string }>`select count(*) as n from family_tasks_visible_to(${userId}::uuid) t where t.status = 'todo' and t.due_date >= ${weekStart}::date and t.due_date <= ${addDays(weekStart, 6)}::date`.execute(db);
  return { events: Number(events.rows[0]?.n ?? 0), tasks: Number(tasks.rows[0]?.n ?? 0) };
}

/** « Votre semaine est prête : 5 RDV, 3 tâches » (US-98 RF1). */
export const digestBody = (events: number, tasks: number) => `Votre semaine est prête : ${events} RDV, ${tasks} tâche${tasks > 1 ? "s" : ""}`;

async function digestSettingsOf(db: Kysely<DB>, userId: string): Promise<DigestSettings> {
  const row = await db.selectFrom("user_assistant_settings").select(["weekly_digest_enabled", "weekly_digest_weekday", sql<string>`weekly_digest_time::text`.as("t")]).where("user_id", "=", userId).executeTakeFirst();
  return { enabled: row?.weekly_digest_enabled ?? true, weekday: row?.weekly_digest_weekday ?? 7, hour: Number((row?.t ?? "19:00").slice(0, 2)) };
}

/**
 * Un passage : prépare le résumé de chaque famille une heure avant le premier envoi, puis envoie à chaque profil son point à l'heure qu'il a choisie (une fois par semaine couverte).
 * Le point est envoyé même sans résumé (RF9) et même pour une semaine calme (RF6). Sans danger à relancer.
 */
export async function runDigests(ctx: Ctx, options: { accountId?: string; model?: AssistantModel | null } = {}): Promise<DigestsResult> {
  const totals: DigestsResult = { prepared: 0, sent: 0, failed: 0 };
  const accounts = await ctx.db
    .selectFrom("accounts")
    .select(["id", "family_timezone"])
    .where("status", "in", ["active", "grace_period"])
    .$if(Boolean(options.accountId), (qb) => qb.where("id", "=", options.accountId!))
    .execute();
  for (const account of accounts) {
    try {
      const timeZone = account.family_timezone ?? "Europe/Paris";
      const recipients = await recipientsOf(ctx.db, account.id);
      const slots: { r: Recipient; sendAt: Date; weekStart: string }[] = [];
      for (const r of recipients) {
        const settings = await digestSettingsOf(ctx.db, r.id);
        const slot = settings.enabled ? digestSlot(settings, timeZone, ctx.now) : null;
        if (slot) slots.push({ r, ...slot });
      }
      if (!slots.length) continue;
      // Le résumé de l'agent n'est préparé que pour les parents, une fois par famille et par semaine couverte.
      for (const weekStart of new Set(slots.filter((s) => s.r.parent).map((s) => s.weekStart))) {
        const done = await prepareDigest(ctx, account.id, weekStart, timeZone, options.model === undefined ? digestModel() : options.model);
        if (done) totals.prepared += 1;
      }
      for (const { r, sendAt, weekStart } of slots) {
        if (ctx.now < sendAt) continue;
        if (!(await claimDaily(ctx, "weekly_digest", r.id, weekStart, sendAt, new Date(sendAt.getTime() + GRACE_MS)))) continue;
        const { events, tasks } = await visibleCounts(ctx.db, r.id, weekStart, timeZone);
        const body = digestBody(events, tasks);
        const out = await dispatch(ctx, account.id, r, { kind: "weekly_digest", userId: r.id, day: weekStart, dueAt: sendAt }, { body, url: DIGEST_URL, tag: `digest-${weekStart}`, subject: body, lines: [body] }, true);
        if (out === "sent") totals.sent += 1;
        else if (out === "failed") totals.failed += 1;
      }
    } catch (error) {
      console.error(`Point de la semaine (foyer) : ${describeError(error)}`);
      totals.failed += 1;
    }
  }
  return totals;
}

