import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { SOURCE_CODE, TYPE_CODE, eventTypeIds, findConflicts, fingerprintOf, loadCalendarEvent, loadCalendarEvents, type CalendarEvent, type EventSource, type EventStatus, type EventType } from "./calendar";
import { createSeries, SeriesError } from "./series";
import { ruleFromRepetition, type RepetitionInput } from "./series-ops";
import { changeProposedTask, dropProposedTask, insertEventTask, matchTasks, type ProposedTarget, type WriteContext } from "./event-tasks";
import { seal, sealOptional } from "./fields";
import { loadMembers } from "./member-chips";
import { familyTimeZone } from "./reminders";
import { isDay, type TaskRepetition } from "./tasks";
import { Rejection } from "@/server/http";
import { isLocalDateTime, localDay, localMs, localToUtc, utcToLocal } from "./local-time";
import { ageBand, fold, Pseudonymizer, type PseudoMember } from "./pseudonymize";

/**
 * Les huit outils de l'Assistant Famille, exécutés par MAAQ et jamais par le modèle (agent/INTEGRATION.md § 4).
 * Référence de comportement : agent/banc_essai/lancer_tests.py (CalendrierSimule).
 *
 * Règles de sécurité : aucun outil ne reçoit l'identifiant du foyer du modèle, il vient de la session ; toutes les lectures et
 * écritures sont filtrées dessus ; un membre se désigne par son alias, tout autre texte est une erreur d'outil.
 * D31 : le modèle voit les événements sans titre ni lieu ni note ; un rendez-vous médical reçoit un titre générique.
 */

export class ToolError extends Error {}

/** Types vus par le modèle (agent/outils/outils.json) et leur valeur en base. */
export const TYPE_TO_DB: Record<string, EventType> = {
  ecole: "school", medical: "medical", pro: "work", familial: "family", perso: "personal", admin: "admin",
};
const TYPE_FROM_DB: Record<EventType, string> = Object.fromEntries(Object.entries(TYPE_TO_DB).map(([fr, en]) => [en, fr])) as Record<EventType, string>;
const DAYS_FR: Record<string, number> = { lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6, dimanche: 7 };
const FREQUENCY: Record<string, RepetitionInput["frequency"]> = {
  hebdomadaire: "weekly", toutes_les_2_semaines: "biweekly", mensuelle_jour_du_mois: "monthly_day", mensuelle_jour_de_la_semaine: "monthly_weekday",
};

/** Répétition décrite par l'agent → règle de l'application ; toute incohérence revient au modèle comme une erreur d'outil. */
function repetitionOf(value: unknown): RepetitionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolError("« repetition » doit être un objet");
  const input = value as Record<string, unknown>;
  const frequency = FREQUENCY[String(input.frequence)];
  if (!frequency) throw new ToolError(`fréquence inconnue : « ${String(input.frequence)} » (attendu : ${Object.keys(FREQUENCY).join(", ")})`);
  const days = Array.isArray(input.jours) ? input.jours.map((d) => DAYS_FR[String(d)]) : undefined;
  if (days?.some((d) => !d)) throw new ToolError("jour de la semaine inconnu dans « jours »");
  const end = input.fin as Record<string, unknown> | undefined;
  if (!end || typeof end !== "object") throw new ToolError("« fin » est obligatoire : demandez « Jusqu'à quand ? » à l'utilisateur");
  let fin: RepetitionInput["end"];
  if (end.type === "date") {
    if (typeof end.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(end.date)) throw new ToolError("date de fin illisible (attendu AAAA-MM-JJ)");
    fin = { kind: "date", date: end.date };
  } else if (end.type === "seances") {
    const n = Number(end.nombre);
    if (!Number.isInteger(n) || n < 1 || n > 400) throw new ToolError("nombre de séances invalide (1 à 400)");
    fin = { kind: "count", count: n };
  } else if (end.type === "jamais") fin = { kind: "never" };
  else throw new ToolError("type de fin inconnu (attendu : date, seances, jamais)");
  return { frequency, ...(days ? { weekdays: days } : {}), end: fin, skipSchoolHolidays: input.sauf_vacances_scolaires === true };
}

/** Tâche proposée par l'agent, que la famille ajoute elle-même depuis une carte du tchat (US-110 RF1) : rien n'est enregistré avant. */
export interface TaskDraft {
  title: string;
  due: string;
  dueTime: string | null;
  assigneeId: string | null;
  repetition: TaskRepetition | null;
}

/** Répétition d'une tâche décrite par l'agent : celles des RDV, plus « quotidienne ». */
function taskRepetitionOf(value: unknown): TaskRepetition {
  if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).frequence === "quotidienne") {
    return { frequency: "daily", end: repetitionOf({ ...(value as object), frequence: "hebdomadaire" }).end };
  }
  const { frequency, weekdays, end } = repetitionOf(value);
  return { frequency, ...(weekdays ? { weekdays } : {}), end };
}

/** Échéances relatives que l'agent peut proposer (US-95 RF3) et leur écart en jours. */
const DUE_DAYS: Record<string, number> = { le_jour_meme: 0, la_veille: 1, "2_jours_avant": 2, "3_jours_avant": 3, "1_semaine_avant": 7 };
/** Pour un RDV médical, trois titres génériques seulement, sans spécialité ni motif (AT-4, D31). */
const MEDICAL_TASKS = new Map([
  ["preparer la carte vitale", "Préparer la carte Vitale"],
  ["preparer le carnet de sante", "Préparer le carnet de santé"],
  ["preparer les documents a apporter", "Préparer les documents à apporter"],
]);
const MAX_AGENT_TASKS = 5;

interface AgentTask {
  title: string;
  daysBefore: number;
  assigneeId: string | null;
}

/** Titre d'une tâche écrit par l'agent : prénoms retraduits ; pour un RDV médical, un des trois titres génériques, composé avec le prénom (AT-4). */
function agentTitle(raw: unknown, ctx: ToolContext, medical: boolean, firstName: string | null): string {
  let title = ctx.pseudo.fromModel(text(raw, "titre de la tâche", { max: 200 })!).trim();
  if (medical) {
    const allowed = MEDICAL_TASKS.get(fold(title).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim());
    if (!allowed) throw new ToolError(`pour un rendez-vous médical, seuls ces titres sont acceptés : ${[...MEDICAL_TASKS.values()].join(" ; ")}`);
    title = firstName ? `${allowed} — RDV médical de ${firstName}` : `${allowed} — RDV médical`;
  }
  title = title.slice(0, MAX_TITLE);
  if (!title) throw new ToolError("le titre de la tâche est vide");
  return title;
}

function dueDays(value: unknown): number {
  const days = DUE_DAYS[String(value)];
  if (days === undefined) throw new ToolError(`échéance inconnue : « ${String(value)} » (attendu : ${Object.keys(DUE_DAYS).join(", ")})`);
  return days;
}

function agentTask(raw: unknown, ctx: ToolContext, medical: boolean, firstName: string | null): AgentTask {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError("chaque tâche doit être un objet {titre, echeance}");
  const t = raw as Record<string, unknown>;
  const daysBefore = dueDays(t.echeance);
  return { title: agentTitle(t.titre, ctx, medical, firstName), daysBefore, assigneeId: t.membre ? members(ctx, [t.membre])[0].id : null };
}

/**
 * La tâche « proposée » que l'agent désigne par le titre qu'il a écrit (D61). Le serveur compare ; une tâche déjà enregistrée n'est jamais modifiée par l'agent, qui renvoie le parent
 * vers l'écran Tâches (il n'en voit pas le titre, AT-4).
 */
async function proposedTask(ctx: ToolContext, event: CalendarEvent, wanted: unknown): Promise<ProposedTarget> {
  const typed = ctx.pseudo.fromModel(text(wanted, "titre", { max: 300 })!);
  const { proposed, registered } = await matchTasks(ctx.db, event, typed);
  if (proposed.length === 1) return proposed[0];
  if (proposed.length > 1) throw new ToolError("plusieurs tâches proposées correspondent : précise laquelle avec son titre complet");
  if (registered > 0) throw new ToolError("cette tâche est déjà enregistrée : tu ne peux pas la modifier ni la retirer. Réponds poliment : « Je ne peux pas modifier une tâche enregistrée : ouvrez-la dans Tâches. »");
  throw new ToolError("aucune tâche proposée ne correspond à ce titre : redemande au parent de quelle tâche il parle");
}

function agentTasks(value: unknown, ctx: ToolContext, medical: boolean, firstName: string | null): AgentTask[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolError("« taches » doit être une liste");
  if (value.length > MAX_AGENT_TASKS) throw new ToolError(`au plus ${MAX_AGENT_TASKS} tâches par rendez-vous`);
  return value.map((raw) => agentTask(raw, ctx, medical, firstName));
}

/** Enregistre les tâches au statut « proposée » avec le rendez-vous (D48) ; celles que la base ou les règles refusent sont signalées au modèle, sans bloquer le rendez-vous. */
async function attachTasks(ctx: ToolContext, event: CalendarEvent, tasks: AgentTask[]): Promise<{ taches: number; taches_ignorees?: { echeance_jours_avant: number; raison: string }[] }> {
  if (!tasks.length) return { taches: 0 };
  const write: WriteContext = {
    accountId: ctx.accountId, userId: ctx.userId, timeZone: await familyTimeZone(ctx.db, ctx.accountId), now: ctx.now, members: await loadMembers(ctx.db, ctx.accountId), parent: true,
    memberId: ctx.authorMemberId ?? null, source: "agent",
  };
  let added = 0;
  const ignored: { echeance_jours_avant: number; raison: string }[] = [];
  for (const task of tasks) {
    try {
      await insertEventTask(ctx.db, write, event, { title: task.title, daysBefore: task.daysBefore, assigneeId: task.assigneeId });
      added += 1;
    } catch (error) {
      if (!(error instanceof Rejection)) throw error;
      ignored.push({ echeance_jours_avant: task.daysBefore, raison: error.message });
    }
  }
  return { taches: added, ...(ignored.length ? { taches_ignorees: ignored } : {}) };
}

const STATUS_FR: Partial<Record<EventStatus, string>> = { provisional: "provisoire", confirmed: "confirme" };

/** Limites des écrans (US-76 RF2) : titre 100 caractères, lieu 200, note 500. */
export const MAX_TITLE = 100;
export const MAX_PLACE = 200;
export const MAX_NOTES = 500;
const STOP_WORDS = new Set(["rendez", "vous", "avec", "pour", "dans", "chez", "votre", "notre", "cabinet"]);

export interface ToolContext {
  db: Kysely<DB>;
  accountId: string;
  userId: string;
  /** Fiche « membre » du parent qui écrit ou qui transfère (D39 : ajouté d'office aux membres de la recherche de doublon). */
  authorMemberId?: string | null;
  timeZone: string;
  now: Date;
  /** Identifiant de la demande : rend la création idempotente. */
  requestId: string;
  source: EventSource;
  pseudo: Pseudonymizer;
  /** Message du parent qui a déclenché la demande : les rendez-vous créés s'y rattachent (source_message_id). */
  sourceMessageId?: number | null;
  /** Rendez-vous créés pendant cette demande. */
  created: { ids: string[] };
  proposals: string[];
  /** Tâches seules proposées pendant cette demande : cartes du tchat, jamais enregistrées par l'agent. */
  taskDrafts?: TaskDraft[];
}

const shortRef = (id: string) => `evt-${id.slice(0, 8)}`;
export const EVENT_REF = /^evt-([0-9a-f]{8})$/;

function words(text: string): Set<string> {
  return new Set(fold(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w)));
}

const loadEvents = (ctx: ToolContext, from: Date, to: Date) => loadCalendarEvents(ctx.db, ctx.accountId, { from, to });

/** Alias des personnes d'un rendez-vous : tous les membres pour un rendez-vous « toute la famille ». */
function aliases(ctx: ToolContext, e: CalendarEvent): string[] {
  return e.allFamily ? ctx.pseudo.active.map((m) => Pseudonymizer.aliasOf(m)) : e.memberIds.map((m) => ctx.pseudo.aliasFor(m));
}

const concerns = (e: CalendarEvent, who: Set<string>) => e.allFamily || e.memberIds.some((m) => who.has(m));

/** Événement tel que le modèle le voit : identifiant, créneau, type, statut, membres ; sans titre, lieu ni note (D31). */
function publicEvent(ctx: ToolContext, e: CalendarEvent) {
  return {
    id: shortRef(e.id),
    debut: utcToLocal(e.startsAt, ctx.timeZone),
    fin: utcToLocal(e.endsAt, ctx.timeZone),
    type: TYPE_FROM_DB[e.type],
    statut: STATUS_FR[e.status] ?? e.status,
    membres: aliases(ctx, e),
    ...(e.allDay ? { journee_entiere: true } : {}),
  };
}

function members(ctx: ToolContext, refs: unknown): PseudoMember[] {
  if (!Array.isArray(refs) || refs.length === 0) throw new ToolError("au moins un membre est attendu");
  return refs.map((ref) => {
    const m = ctx.pseudo.resolve(ref);
    if (!m) throw new ToolError(`membre inconnu : « ${String(ref)} ». Utilisez une référence renvoyée par lister_membres.`);
    return m;
  });
}

function text(value: unknown, name: string, { required = true, max = 5000 } = {}): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ToolError(`« ${name} » est obligatoire`);
    return null;
  }
  if (typeof value !== "string") throw new ToolError(`« ${name} » doit être un texte`);
  if (value.length > max) throw new ToolError(`« ${name} » est trop long (${max} caractères au plus)`);
  return value;
}

function local(value: unknown, name: string): string {
  const v = text(value, name)!;
  if (!isLocalDateTime(v)) throw new ToolError(`date illisible : « ${v} » (attendu AAAA-MM-JJTHH:MM ou AAAA-MM-JJ)`);
  return v.trim();
}

function toUtc(ctx: ToolContext, value: string): Date {
  try {
    return localToUtc(value, ctx.timeZone);
  } catch (error) {
    throw new ToolError((error as Error).message);
  }
}

function span(ctx: ToolContext, start: string, end: string): { from: Date; to: Date; allDay: boolean } {
  const allDay = start.length === 10;
  const from = toUtc(ctx, start);
  const to = end.length === 10 ? toUtc(ctx, `${end}T23:59`) : toUtc(ctx, end);
  if (to < from) throw new ToolError("la fin doit être après le début");
  return { from, to, allDay: allDay || end.length === 10 };
}

async function findEvent(ctx: ToolContext, ref: unknown): Promise<CalendarEvent> {
  const m = EVENT_REF.exec(String(ref).trim());
  if (!m) throw new ToolError(`aucun événement avec l'identifiant ${String(ref)}`);
  const rows = await ctx.db
    .selectFrom("family_events")
    .select("id")
    .where("account_id", "=", ctx.accountId)
    .where(sql<boolean>`id::text like ${`${m[1]}%`}`)
    .limit(2)
    .execute();
  if (rows.length === 0) throw new ToolError(`aucun événement avec l'identifiant ${String(ref)}`);
  if (rows.length > 1) throw new ToolError(`identifiant ambigu : ${String(ref)}`);
  return (await loadCalendarEvent(ctx.db, ctx.accountId, rows[0].id))!;
}

type Tool = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

const TOOLS: Record<string, Tool> = {
  async lister_membres(_input, ctx) {
    return {
      membres: ctx.pseudo.active.map((m) => ({
        ref: Pseudonymizer.aliasOf(m),
        role: m.role === "child" ? "enfant" : "parent",
        // Un parent sans date de naissance est un adulte ; pour un enfant, la tranche reste inconnue.
        tranche_age: m.birth || m.role === "child" ? ageBand(m.birth, ctx.now) : "18+",
      })),
    };
  },

  async lister_evenements(input, ctx) {
    const from = toUtc(ctx, local(input.date_debut, "date_debut").slice(0, 10));
    const to = toUtc(ctx, `${local(input.date_fin, "date_fin").slice(0, 10)}T23:59`);
    const who = input.membre ? members(ctx, [input.membre])[0].id : null;
    const events = (await loadEvents(ctx, from, to)).filter((e) => !who || e.allFamily || e.memberIds.includes(who));
    return { evenements: events.map((e) => publicEvent(ctx, e)) };
  },

  async verifier_conflits(input, ctx) {
    const who = members(ctx, input.membres).map((m) => m.id);
    const { from, to } = span(ctx, local(input.debut, "debut"), local(input.fin, "fin"));
    if (to <= from) throw new ToolError("la fin doit être après le début");
    const conflicts = await findConflicts(ctx.db, ctx.accountId, { from, to, memberIds: who, allFamily: false });
    return { conflits: conflicts.map((e) => publicEvent(ctx, e)), libre: conflicts.length === 0 };
  },

  async proposer_creneaux(input, ctx) {
    const who = new Set(members(ctx, input.membres).map((m) => m.id));
    const minutes = Number(input.duree_minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 12 * 60) throw new ToolError("duree_minutes doit être un entier de minutes raisonnable");
    const wanted = Math.min(Math.max(Number(input.nombre ?? 3) || 3, 1), 5);
    const startDay = local(input.date_souhaitee, "date_souhaitee").slice(0, 10);
    const rangeFrom = toUtc(ctx, startDay);
    const busy = (await loadEvents(ctx, rangeFrom, new Date(rangeFrom.getTime() + 16 * 86_400_000))).filter((e) => concerns(e, who));
    const busyLocal = busy.map((e) => [localMs(e.startsAt, ctx.timeZone), localMs(e.endsAt, ctx.timeZone)] as const);
    const nowLocal = localMs(ctx.now, ctx.timeZone);
    const slots: { debut: string; fin: string }[] = [];
    const firstDay = Date.parse(`${startDay}T00:00:00Z`);
    for (let d = 0; d < 14 && slots.length < wanted; d++) {
      const day = new Date(firstDay + d * 86_400_000).toISOString().slice(0, 10);
      for (let minute = 8 * 60; minute + minutes <= 20 * 60; minute += 30) {
        const start = Date.parse(`${day}T00:00:00Z`) + minute * 60_000;
        const end = start + minutes * 60_000;
        if (start < nowLocal || ![9, 10, 14, 17, 18].includes(Math.floor(minute / 60)) || minute % 60 !== 0) continue;
        if (busyLocal.some(([s, e]) => s < end && e > start)) continue;
        slots.push({ debut: new Date(start).toISOString().slice(0, 16), fin: new Date(end).toISOString().slice(0, 16) });
        break; // au plus un créneau par jour
      }
    }
    return { creneaux: slots };
  },

  /**
   * D35 : même jour ; heure de début à 30 minutes près si elle est donnée ; membre commun si des membres sont donnés ; objet équivalent
   * (un mot significatif en commun avec le titre ou le lieu) ou, pour un rendez-vous médical, même type.
   * D39 : le parent qui écrit ou qui transfère est ajouté d'office aux membres de la recherche (règle du serveur, pas du modèle) : une
   * réunion de parents « de Léo » est inscrite pour les parents. Sans membres donnés, aucun filtre de membre n'est appliqué.
   */
  async rechercher_doublon(input, ctx) {
    const day = local(input.date, "date").slice(0, 10);
    const who = Array.isArray(input.membres) && input.membres.length ? new Set(members(ctx, input.membres).map((m) => m.id)) : null;
    if (who && ctx.authorMemberId) who.add(ctx.authorMemberId);
    const around = input.heure ? `${day}T${text(input.heure, "heure", { max: 5 })}` : null;
    if (around && !isLocalDateTime(around)) throw new ToolError("heure illisible (attendu HH:MM)");
    const keys = words(ctx.pseudo.fromModel(text(input.objet, "objet", { max: 500 })!));
    const medicalAsked = input.type === "medical";
    const dayStart = toUtc(ctx, day);
    const events = await loadEvents(ctx, dayStart, new Date(dayStart.getTime() + 24 * 3_600_000 + 3_600_000));
    const found = events.filter((e) => {
      if (localDay(e.startsAt, ctx.timeZone) !== day) return false;
      if (around && Math.abs(localMs(e.startsAt, ctx.timeZone) - Date.parse(`${around}:00Z`)) > 30 * 60_000) return false;
      if (who && !concerns(e, who)) return false;
      const sameMedical = medicalAsked && e.type === "medical";
      const equivalent = [...words(`${e.title} ${e.place ?? ""}`)].some((w) => keys.has(w));
      return sameMedical || equivalent;
    });
    return { correspondances: found.map((e) => publicEvent(ctx, e)) };
  },

  async creer_evenement_provisoire(input, ctx) {
    const type = TYPE_TO_DB[String(input.type)];
    if (!type) throw new ToolError(`type inconnu : « ${String(input.type)} » (attendu : ${Object.keys(TYPE_TO_DB).join(", ")})`);
    const who = members(ctx, input.membres);
    const start = local(input.debut, "debut");
    const end = local(input.fin, "fin");
    const { from, to, allDay } = span(ctx, start, end);
    const medical = type === "medical";

    // D31 : titre générique pour un rendez-vous médical, ni lieu ni note renseignés par l'assistant. Règle de MAAQ, pas du modèle.
    const title = medical ? `RDV médical — ${who[0].firstName}` : ctx.pseudo.fromModel(text(input.titre, "titre", { max: MAX_TITLE * 2 })!).trim().slice(0, MAX_TITLE);
    if (!title) throw new ToolError("« titre » est obligatoire");
    const place = medical ? null : (text(input.lieu, "lieu", { required: false, max: MAX_PLACE * 2 }) && ctx.pseudo.fromModel(String(input.lieu)).slice(0, MAX_PLACE));
    const notes = medical ? null : (text(input.notes, "notes", { required: false, max: MAX_NOTES * 2 }) && ctx.pseudo.fromModel(String(input.notes)).slice(0, MAX_NOTES));
    const ignored = medical && (input.lieu || input.notes);
    const proposedTasks = agentTasks(input.taches, ctx, medical, who[0].firstName);

    // Un rendez-vous qui se répète devient une série : une seule proposition, confirmée d'un geste (US-109).
    if (input.repetition !== undefined && input.repetition !== null) {
      const repetition = repetitionOf(input.repetition);
      const firstDate = start.slice(0, 10);
      try {
        const result = await createSeries(ctx.db, {
          accountId: ctx.accountId, userId: ctx.userId, type, title: medical ? "" : title, place, notes, startTime: allDay ? "00:00" : start.slice(11, 16),
          durationMinutes: allDay ? 1440 : Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000)), allDay, allFamily: false, memberIds: who.map((m) => m.id), firstDate,
          rule: ruleFromRepetition(repetition, firstDate), timeZone: ctx.timeZone, source: ctx.source, sourceMessageId: ctx.sourceMessageId ?? null, now: ctx.now,
        });
        if (!ctx.created.ids.includes(result.eventIds[0])) ctx.created.ids.push(result.eventIds[0]);
        const attached = await attachTasks(ctx, (await loadCalendarEvent(ctx.db, ctx.accountId, result.eventIds[0]))!, proposedTasks);
        return {
          id: shortRef(result.eventIds[0]), statut: "provisoire", seances: result.eventIds.length, ...attached,
          message: "Série créée en provisoire, en attente de confirmation par la famille : une seule confirmation vaut pour toutes les séances.",
          ...(ignored ? { avis: "Pour un rendez-vous médical, le lieu et les notes ne sont pas enregistrés par l'assistant." } : {}),
        };
      } catch (error) {
        if (error instanceof SeriesError) throw new ToolError(error.message);
        if ((error as { code?: string }).code === "23505") throw new ToolError("une série identique existe déjà à ces dates");
        throw error;
      }
    }

    // Un rendez-vous actif identique (créneau, type, membres) existe déjà : on le rend, sans rien ajouter. C'est aussi ce qui rend la création
    // idempotente quand la même demande est rejouée (US-89 RT3).
    const memberIds = who.map((m) => m.id);
    const fingerprint = fingerprintOf({ startsAt: from, endsAt: to, type, allFamily: false, memberIds });
    const typeId = (await eventTypeIds(ctx.db)).get(TYPE_CODE[type])!;
    let isNew = true;
    const id = await ctx.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("family_events")
        .values({
          account_id: ctx.accountId, event_type_id: typeId, title: medical ? null : seal(title), location: sealOptional(place), note: sealOptional(notes), starts_at: from, ends_at: to,
          all_day: allDay, status: "provisional", source: SOURCE_CODE[ctx.source], requested_by_user_id: ctx.userId, source_at: ctx.now, source_message_id: ctx.sourceMessageId ?? null, fingerprint,
        })
        .onConflict((oc) => oc.columns(["account_id", "fingerprint"]).where(sql<boolean>`status in ('provisional', 'set_aside', 'confirmed')`).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted) {
        isNew = false;
        return (await trx.selectFrom("family_events").select("id").where("account_id", "=", ctx.accountId).where("fingerprint", "=", fingerprint).where("status", "in", ["provisional", "set_aside", "confirmed"]).executeTakeFirstOrThrow()).id;
      }
      await trx.insertInto("family_event_members").values(memberIds.map((member_id) => ({ event_id: inserted.id, member_id, account_id: ctx.accountId }))).execute();
      await trx.insertInto("family_event_history").values({ event_id: inserted.id, user_id: ctx.userId, action: "created", from_status: null, to_status: "provisional", occurred_at: ctx.now }).execute();
      return inserted.id;
    });
    if (!ctx.created.ids.includes(id)) ctx.created.ids.push(id);
    // Un rendez-vous déjà là (même demande rejouée) n'a pas de nouvelle liste de tâches.
    const attached = isNew ? await attachTasks(ctx, (await loadCalendarEvent(ctx.db, ctx.accountId, id))!, proposedTasks) : { taches: 0 };
    return {
      id: shortRef(id),
      statut: "provisoire",
      message: "Créé en provisoire, en attente de confirmation par la famille.",
      ...attached,
      ...(ignored ? { avis: "Pour un rendez-vous médical, le lieu et les notes ne sont pas enregistrés par l'assistant." } : {}),
    };
  },

  async ajouter_tache_rdv(input, ctx) {
    const event = await findEvent(ctx, input.id);
    const first = event.memberIds[0] ? (ctx.pseudo.active.find((m) => m.id === event.memberIds[0])?.firstName ?? null) : null;
    const [task] = agentTasks([{ titre: input.titre, echeance: input.echeance, membre: input.membre }], ctx, event.type === "medical", first);
    const done = await attachTasks(ctx, event, [task]);
    if (!done.taches) throw new ToolError(done.taches_ignorees?.[0]?.raison ?? "la tâche n'a pas pu être ajoutée");
    return { id: input.id, statut: event.status === "confirmed" ? "tache_ajoutee" : "tache_proposee", message: "Tâche ajoutée à la liste « À préparer » du rendez-vous." };
  },

  async modifier_tache_proposee(input, ctx) {
    const event = await findEvent(ctx, input.id);
    const medical = event.type === "medical";
    const first = event.memberIds[0] ? (ctx.pseudo.active.find((m) => m.id === event.memberIds[0])?.firstName ?? null) : null;
    const target = await proposedTask(ctx, event, input.titre);
    const changes: { title?: string; daysBefore?: number; assigneeId?: string | null } = {};
    if (input.nouveau_titre) changes.title = agentTitle(input.nouveau_titre, ctx, medical, first);
    if (input.echeance) changes.daysBefore = dueDays(input.echeance);
    if (input.membre) changes.assigneeId = members(ctx, [input.membre])[0].id;
    if (!Object.keys(changes).length) throw new ToolError("rien à changer : donne un nouveau titre, une échéance ou une personne");
    const write: WriteContext = {
      accountId: ctx.accountId, userId: ctx.userId, timeZone: await familyTimeZone(ctx.db, ctx.accountId), now: ctx.now, members: await loadMembers(ctx.db, ctx.accountId), parent: true,
      memberId: ctx.authorMemberId ?? null, source: "agent",
    };
    try {
      await changeProposedTask(ctx.db, write, event, target, changes);
    } catch (error) {
      if (error instanceof Rejection) throw new ToolError(error.message);
      throw error;
    }
    return { id: input.id, statut: "tache_proposee_modifiee", message: "La tâche proposée est modifiée dans la carte du rendez-vous." };
  },

  async retirer_tache_proposee(input, ctx) {
    const event = await findEvent(ctx, input.id);
    await dropProposedTask(ctx.db, await proposedTask(ctx, event, input.titre));
    return { id: input.id, statut: "tache_proposee_retiree", message: "La tâche proposée est retirée de la carte du rendez-vous." };
  },

  async proposer_tache(input, ctx) {
    const title = ctx.pseudo.fromModel(text(input.titre, "titre", { max: MAX_TITLE * 2 })!).trim().slice(0, MAX_TITLE);
    if (!title) throw new ToolError("« titre » est obligatoire");
    const due = text(input.echeance, "echeance")!.trim();
    if (!isDay(due)) throw new ToolError(`échéance illisible : « ${due} » (attendu AAAA-MM-JJ)`);
    if (due < localDay(ctx.now, ctx.timeZone)) throw new ToolError("l'échéance est déjà passée : demandez la date au parent");
    const dueTime = input.heure ? String(text(input.heure, "heure", { max: 5 })) : null;
    if (dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) throw new ToolError("heure illisible (attendu HH:MM)");
    const repetition = input.repetition !== undefined && input.repetition !== null ? taskRepetitionOf(input.repetition) : null;
    if (repetition?.end.kind === "date" && repetition.end.date < due) throw new ToolError("la date de fin doit être après la première échéance");
    (ctx.taskDrafts ??= []).push({ title, due, dueTime, assigneeId: input.membre ? members(ctx, [input.membre])[0].id : null, repetition });
    return { statut: "proposee", message: "Tâche proposée à la famille : elle l'ajoute elle-même depuis l'application." };
  },

  async modifier_evenement(input, ctx) {
    const event = await findEvent(ctx, input.id);
    const changes: Record<string, string> = {};
    for (const key of ["debut", "fin"] as const) if (input[key]) changes[key] = local(input[key], key);
    for (const key of ["lieu", "notes"] as const) if (input[key]) changes[key] = ctx.pseudo.fromModel(text(input[key], key)!);
    const reason = text(input.motif, "motif", { max: 500 })!;
    // Un changement d'horaire seul est un report ; sinon c'est une modification, dont les champs sont conservés chiffrés avec le motif.
    const { debut, fin, ...others } = changes;
    const reschedule = Boolean(debut || fin) && Object.keys(others).length === 0;
    const row = await ctx.db
      .insertInto("family_event_change_proposals")
      .values({
        account_id: ctx.accountId, event_id: event.id, kind: reschedule ? "reschedule" : "modification", requested_by_user_id: ctx.userId,
        new_starts_at: reschedule ? (debut ? toUtc(ctx, debut) : event.startsAt) : null,
        new_ends_at: reschedule ? (fin ? toUtc(ctx, fin.length === 10 ? `${fin}T23:59` : fin) : event.endsAt) : null,
        proposed_changes: reschedule ? null : seal(JSON.stringify({ ...changes, motif: reason })),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    ctx.proposals.push(row.id);
    return { id: input.id, statut: "modification_proposee", changements: changes };
  },

  async annuler_evenement(input, ctx) {
    const event = await findEvent(ctx, input.id);
    text(input.motif, "motif", { max: 500 });
    const row = await ctx.db
      .insertInto("family_event_change_proposals")
      .values({ account_id: ctx.accountId, event_id: event.id, kind: "cancellation", requested_by_user_id: ctx.userId })
      .returning("id")
      .executeTakeFirstOrThrow();
    ctx.proposals.push(row.id);
    return { id: input.id, statut: "annulation_proposee" };
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

export interface ToolResult {
  content: string;
  isError: boolean;
}

/** Exécute un outil demandé par le modèle. Une erreur d'outil revient au modèle ; toute autre erreur remonte. */
export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    const tool = TOOLS[name];
    if (!tool) throw new ToolError(`outil inconnu : ${name}`);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ToolError("les paramètres doivent être un objet");
    return { content: JSON.stringify(await tool(input as Record<string, unknown>, ctx)), isError: false };
  } catch (error) {
    if (error instanceof ToolError) return { content: `Erreur : ${error.message}`, isError: true };
    throw error;
  }
}

/**
 * Remplace [[evt-xxxxxxxx]] par le titre du rendez-vous, à l'affichage (D39). Un identifiant inconnu, ou que ce profil n'a pas le droit
 * de voir (D26), devient « un rendez-vous ». Un rendez-vous médical garde son titre générique.
 */
export async function expandEventRefs(db: Kysely<DB>, accountId: string, textWithRefs: string, canSee: (eventId: string) => boolean = () => true): Promise<string> {
  const refs = [...new Set([...textWithRefs.matchAll(/\[\[evt-([0-9a-f]{8})\]\]/g)].map((m) => m[1]))];
  if (!refs.length) return textWithRefs;
  const titles = new Map<string, string>();
  for (const prefix of refs) {
    const rows = await db
      .selectFrom("family_events")
      .select("id")
      .where("account_id", "=", accountId)
      .where(sql<boolean>`id::text like ${`${prefix}%`}`)
      .limit(2)
      .execute();
    if (rows.length !== 1 || !canSee(rows[0].id)) continue;
    // Un rendez-vous médical n'a pas de titre en base : il est composé à la lecture (« RDV médical — prénom »).
    titles.set(prefix, (await loadCalendarEvent(db, accountId, rows[0].id))!.title);
  }
  return textWithRefs.replace(/\[\[evt-([0-9a-f]{8})\]\]/g, (_all, prefix: string) => titles.get(prefix) ?? "un rendez-vous");
}

