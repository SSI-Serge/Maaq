import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { findConflicts, loadCalendarEvent, loadCalendarEvents, type CalendarEvent, type EventSource, type EventStatus, type EventType } from "./calendar";
import { seal, sealOptional } from "./fields";
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
  /** Nombre de créations déjà faites pendant cette demande (rang dans source_ref). */
  created: { count: number; ids: string[] };
  proposals: string[];
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
        tranche_age: m.birthDate || m.role === "child" ? ageBand(m.birthDate, ctx.now) : "18+",
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
    const recurrence = text(input.recurrence, "recurrence", { required: false, max: 300 });
    const ignored = medical && (input.lieu || input.notes);

    const sourceRef = `${ctx.requestId}:${ctx.created.count + 1}`;
    ctx.created.count += 1;
    const inserted = await ctx.db
      .insertInto("family_events")
      .values({
        account_id: ctx.accountId, title_encrypted: seal(title), event_type: type, starts_at: from, ends_at: to, all_day: allDay,
        place_encrypted: sealOptional(place), notes_encrypted: sealOptional(notes), recurrence, status: "provisional", source: ctx.source,
        source_ref: sourceRef, created_by_user_id: ctx.userId, status_changed_at: ctx.now,
      })
      .onConflict((oc) => oc.columns(["account_id", "source_ref"]).where("source_ref", "is not", null).doNothing())
      .returning("id")
      .executeTakeFirst();
    // Même demande traitée deux fois : on rend le rendez-vous déjà créé, sans rien ajouter.
    const id = inserted?.id ?? (await ctx.db.selectFrom("family_events").select("id").where("account_id", "=", ctx.accountId).where("source_ref", "=", sourceRef).executeTakeFirstOrThrow()).id;
    if (inserted) {
      await ctx.db.insertInto("family_event_members").values(who.map((m) => ({ event_id: id, member_id: m.id }))).execute();
      await ctx.db
        .insertInto("family_event_history")
        .values({ account_id: ctx.accountId, event_id: id, action: "created", from_status: null, to_status: "provisional", by_user_id: ctx.userId, created_at: ctx.now })
        .execute();
    }
    ctx.created.ids.push(id);
    return {
      id: shortRef(id),
      statut: "provisoire",
      message: "Créé en provisoire, en attente de confirmation par la famille.",
      ...(ignored ? { avis: "Pour un rendez-vous médical, le lieu et les notes ne sont pas enregistrés par l'assistant." } : {}),
    };
  },

  async modifier_evenement(input, ctx) {
    const event = await findEvent(ctx, input.id);
    const changes: Record<string, string> = {};
    for (const key of ["debut", "fin"] as const) if (input[key]) changes[key] = local(input[key], key);
    for (const key of ["lieu", "notes"] as const) if (input[key]) changes[key] = ctx.pseudo.fromModel(text(input[key], key)!);
    const reason = text(input.motif, "motif", { max: 500 })!;
    const row = await ctx.db
      .insertInto("family_event_proposals")
      .values({ account_id: ctx.accountId, event_id: event.id, kind: "modification", changes: JSON.stringify(changes), reason })
      .returning("id")
      .executeTakeFirstOrThrow();
    ctx.proposals.push(row.id);
    return { id: input.id, statut: "modification_proposee", changements: changes };
  },

  async annuler_evenement(input, ctx) {
    const event = await findEvent(ctx, input.id);
    const reason = text(input.motif, "motif", { max: 500 })!;
    const row = await ctx.db
      .insertInto("family_event_proposals")
      .values({ account_id: ctx.accountId, event_id: event.id, kind: "cancellation", reason })
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
    const event = (await loadCalendarEvent(db, accountId, rows[0].id))!;
    if (event.type === "medical") {
      // Les rendez-vous créés par l'assistant portent déjà leur titre générique ; sinon on le recompose avec la première personne concernée.
      if (event.title.startsWith("RDV médical")) {
        titles.set(prefix, event.title);
        continue;
      }
      const who = await db
        .selectFrom("family_members")
        .select("first_name")
        .where("id", "in", event.memberIds.length ? event.memberIds : ["00000000-0000-0000-0000-000000000000"])
        .orderBy("role")
        .orderBy("alias_index")
        .limit(1)
        .executeTakeFirst();
      titles.set(prefix, who ? `RDV médical — ${who.first_name}` : "RDV médical");
    } else {
      titles.set(prefix, event.title);
    }
  }
  return textWithRefs.replace(/\[\[evt-([0-9a-f]{8})\]\]/g, (_all, prefix: string) => titles.get(prefix) ?? "un rendez-vous");
}

