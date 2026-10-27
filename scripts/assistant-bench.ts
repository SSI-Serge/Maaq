// Banc d'essai de bout en bout de l'Assistant Famille : le VRAI modèle, la VRAIE boucle et les VRAIS outils de MAAQ, sur une base de test
// jetable (PostgreSQL embarqué). Rejoue les 36 cas de agent/tests/cas_de_test.json et les cas de séries et de tâches de
// agent/tests/cas_series_taches.json, et compare au résultat attendu, comme le banc Python (agent/banc_essai/lancer_tests.py, qui ne lit que le
// premier fichier), mais sur le code qui tournera en production. Aucune donnée réelle.
//
//   npx tsx scripts/assistant-bench.ts --env agent/.env              # clé ANTHROPIC_API_KEY lue dans ce fichier (jamais affichée)
//   npx tsx scripts/assistant-bench.ts --cas 01 29 30 --runs 2
//   npx tsx scripts/assistant-bench.ts --jeu series                  # seulement les cas de séries et de tâches (--jeu base : les 36 premiers)
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { loadAgentDefinition, runAssistant, type AgentRunResult } from "../src/server/assistant/agent";
import { open, seal, sealOptional } from "../src/server/assistant/fields";
import { loadPseudoMembers } from "../src/server/assistant/family";
import { loadCalendarEvent, STATUS_CODE, TYPE_CODE } from "../src/server/assistant/calendar";
import { utcToLocal } from "../src/server/assistant/local-time";
import { estimateCostUsd } from "../src/server/assistant/cost";
import { createModel } from "../src/server/assistant/model";
import { migrate } from "../src/server/db/migrate";
import type { DB } from "../src/server/db/schema.generated";
import { DEV_PASSWORD, DEV_USER, startEmbeddedDb } from "./lib/embedded-db";

const argv = process.argv.slice(2);
const option = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const list = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const out: string[] = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith("--"); k++) out.push(argv[k]);
  return out;
};

const envFile = option("env") ?? path.join(process.cwd(), "agent", ".env");
config({ path: envFile, quiet: true });
// Un réglage laissé vide dans le fichier n'est pas un réglage ; et le banc a besoin des secrets de l'application (chiffrement des titres),
// jetables ici : la base du banc disparaît à la fin.
for (const [name, value] of Object.entries(process.env)) if (value === "") delete process.env[name];
const throwaway = (bytes: number) => randomBytes(bytes).toString("base64");
process.env.ENCRYPTION_KEY ??= throwaway(32);
process.env.HMAC_KEY ??= throwaway(32);
process.env.AUTH_SECRET ??= throwaway(32);
process.env.CRON_SECRET ??= randomBytes(24).toString("hex");
process.env.TRAVEL_MODE ??= "fake"; // « Sur place » (US-112) : l'outil de recherche existe, avec le faux service
process.env.DATABASE_URL ??= "postgres://maaq:maaq@localhost:5432/inutilise";
const provider = "anthropic" as const;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(`Clé manquante pour ${provider} : renseignez-la dans ${envFile} (jamais dans une conversation).`);
  process.exit(2);
}
const runs = Number(option("runs") ?? 1);
const wanted = list("cas");

// --- jeu d'essai ----------------------------------------------------------------------------------------------------------------
interface Case {
  id: string; titre: string; source: "saisie" | "dictee" | "capture" | "mail"; message: string;
  attendu: {
    creations?: number; creations_min?: number; evenements?: { date: string; heure?: string; fin?: string; journee_entiere?: boolean; type?: string; membres_inclus?: string[] }[];
    outils_requis?: string[]; outils_interdits?: string[]; modification?: { id: string; date: string; heure: string }; annulation?: string;
    question?: boolean; texte_contient?: string[]; medical_sans_detail?: boolean; doublon_attendu?: boolean;
    /** Répétition demandée par l'agent dans son dernier appel de création ; `fin` accepte plusieurs choix séparés par « | ». */
    serie?: { frequence?: string; jours?: string[]; fin?: string; fin_date?: string; fin_nombre?: number; sauf_vacances?: boolean };
    sans_serie?: boolean;
    /** Tâches rattachées au premier rendez-vous créé (ou à ses modèles pour une série). */
    taches_rdv?: { min?: number; max?: number; sans_prenom?: boolean; generiques_medical?: boolean; echeances_non_passees?: boolean };
    /** Une tâche enregistrée sur un rendez-vous du calendrier de départ. */
    ajout_tache?: { evenement: string; titre_contient: string };
    /** Cartes de tâche seule proposées dans le tchat (rien n'est enregistré). */
    /** Jugement de l'agent sur le lieu d'un RDV créé (`lieu_public`) : « oui », « doute », « non » ou « absent » (non renseigné) ; plusieurs choix séparés par « | ». */
    lieu_public?: string;
    /** Recherche « Sur place » lancée par l'agent pour un RDV du calendrier de départ (ou, avec `aucune`, non lancée). */
    sur_place?: { evenement: string; aucune?: boolean };
    brouillons?: { nombre: number; due?: string; heure?: string; membre?: string; titre_contient?: string; repetition?: { frequence?: string; jours?: string[]; fin?: string; fin_date?: string; fin_nombre?: number } };
  };
  /** Échange rejoué d'abord avec le vrai modèle ; le message testé reçoit cet échange en historique. */
  precedent?: { message: string; source: "saisie" | "dictee" | "capture" | "mail"; question?: boolean };
  /** Tâches déjà enregistrées (« à faire ») sur un rendez-vous du calendrier de départ. */
  taches_initiales?: { evenement: string; titre: string; jours_avant: number }[];
  /** Rendez-vous ajoutés au calendrier de départ pour ce cas seulement. */
  evenements_initiaux?: (typeof data.calendrier_initial)[number][];
}
const data = JSON.parse(readFileSync(path.join(process.cwd(), "agent", "tests", "cas_de_test.json"), "utf8")) as {
  contexte: { maintenant: string; fuseau: string; utilisateur: string };
  famille: { prenom: string; role: string; age: number }[];
  calendrier_initial: { id: string; titre: string; type: string; debut: string; fin: string; membres: string[]; lieu?: string; journee_entiere?: boolean; statut: string }[];
  cas: Case[];
};
const extra = JSON.parse(readFileSync(path.join(process.cwd(), "agent", "tests", "cas_series_taches.json"), "utf8")) as { cas: Case[] };
const jeu = option("jeu") ?? "tout";
const baseCases = data.cas;
data.cas = jeu === "base" ? baseCases : jeu === "series" ? extra.cas : [...baseCases, ...extra.cas];
const SOURCE: Record<Case["source"], "typed" | "dictation" | "capture" | "mail"> = { saisie: "typed", dictee: "dictation", capture: "capture", mail: "mail" };
const TYPE: Record<string, string> = { ecole: "school", medical: "medical", pro: "work", familial: "family", perso: "personal", admin: "admin" };
const TZ = data.contexte.fuseau;
const NOW = new Date("2026-11-02T08:00:00Z"); // lundi 2 novembre 2026, 09:00 à Paris
const seedUuid = (id: string) => `0000000${id.slice(-1)}-0000-4000-8000-00000000000${id.slice(-1)}`;

const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const TUTOIEMENT = /\b(tu|toi|ton|ta|tes|te|tien|tienne)\b|\bt'/;
const SECONDS_LIMIT = 10;

// --- contrôles des séries et des tâches ---------------------------------------------------------------------------------------------
type Repetition = { frequence?: string; jours?: string[]; fin?: { type?: string; date?: string; nombre?: number }; sauf_vacances_scolaires?: boolean };
type WantedRepetition = NonNullable<Case["attendu"]["serie"]>;
const GENERIC_MEDICAL_TASKS = ["Préparer la carte Vitale", "Préparer le carnet de santé", "Préparer les documents à apporter"].map(normalize);
const DAYS_BEFORE: Record<string, number> = { le_jour_meme: 0, la_veille: 1, "2_jours_avant": 2, "3_jours_avant": 3, "1_semaine_avant": 7 };
const minusDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Compare la répétition décrite par l'agent à ce qui est attendu. Sans `jours`, l'outil prend le jour de la première occurrence : c'est accepté. */
function checkRepetition(label: string, rep: Repetition | undefined, want: WantedRepetition): string[] {
  if (!rep) return [`${label} : aucune répétition décrite par l'agent`];
  const out: string[] = [];
  if (want.frequence !== undefined && rep.frequence !== want.frequence) out.push(`${label} : fréquence « ${rep.frequence} » au lieu de « ${want.frequence} »`);
  if (want.jours && rep.jours?.length && rep.jours.map(normalize).sort().join() !== want.jours.map(normalize).sort().join()) out.push(`${label} : jours « ${rep.jours.join(", ")} » au lieu de « ${want.jours.join(", ")} »`);
  if (want.fin !== undefined && !want.fin.split("|").includes(rep.fin?.type ?? "")) out.push(`${label} : fin « ${rep.fin?.type} » au lieu de « ${want.fin} »`);
  if (want.fin_date !== undefined && rep.fin?.date !== want.fin_date) out.push(`${label} : date de fin « ${rep.fin?.date} » au lieu de « ${want.fin_date} »`);
  if (want.fin_nombre !== undefined && rep.fin?.nombre !== want.fin_nombre) out.push(`${label} : ${rep.fin?.nombre} fois au lieu de ${want.fin_nombre}`);
  if (want.sauf_vacances !== undefined && Boolean(rep.sauf_vacances_scolaires) !== want.sauf_vacances) out.push(`${label} : sauf vacances scolaires ${Boolean(rep.sauf_vacances_scolaires)} au lieu de ${want.sauf_vacances}`);
  return out;
}

// --- base jetable ------------------------------------------------------------------------------------------------------------------
const port = 6000 + Math.floor(Math.random() * 500);
const dir = await mkdtemp(path.join(os.tmpdir(), "maaq-bench-pg-"));
const pg = await startEmbeddedDb({ dir, port, databases: ["maaq_bench"], persistent: false });
const url = `postgres://${DEV_USER}:${DEV_PASSWORD}@localhost:${port}/maaq_bench`;
const pool = new Pool({ connectionString: url, max: 4 });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

async function seedFamily() {
  const account = await db.insertInto("accounts").values({ status: "active", guest_quota: 3 }).returning("id").executeTakeFirstOrThrow();
  const parents = data.famille.filter((m) => m.role !== "enfant");
  const ids = new Map<string, string>();
  for (const [i, parent] of parents.entries()) {
    const user = await db
      .insertInto("users")
      .values({
        account_id: account.id, role: i === 0 ? "primary_user" : "guest", guest_rank: i === 0 ? null : "core", first_name: parent.prenom, last_name: "Essai",
        email: `${normalize(parent.prenom)}-${randomUUID().slice(0, 6)}@maaq.test`, password_hash: "x", status: "active", activated_at: NOW,
        initial_setup_step: i === 0 ? "completed" : null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    ids.set(parent.prenom, user.id);
  }
  // Les fiches « membre » des parents sont créées avec leurs profils ; l'alias et la couleur des enfants sont attribués par la base.
  for (const child of data.famille.filter((m) => m.role === "enfant")) {
    const born = new Date(NOW);
    born.setUTCFullYear(born.getUTCFullYear() - child.age);
    born.setUTCMonth(born.getUTCMonth() - 1);
    await db
      .insertInto("family_members")
      .values({ account_id: account.id, first_name: child.prenom, role: "child", birth_year: born.getUTCFullYear(), birth_month: born.getUTCMonth() + 1, alias_number: sql<number>`null`, color_index: sql<number>`null` })
      .execute();
  }
  return { accountId: account.id, userId: ids.get(data.contexte.utilisateur)! };
}

async function seedCalendar(accountId: string, userId: string, tasks: Case["taches_initiales"] = [], extraEvents: NonNullable<Case["evenements_initiaux"]> = []) {
  await db.deleteFrom("family_event_change_proposals").where("account_id", "=", accountId).execute();
  // Les séries et les tâches du cas précédent partent avec leurs rendez-vous (tâches, modèles, rendez-vous, séries : dans cet ordre).
  await db.deleteFrom("family_tasks").where("account_id", "=", accountId).execute();
  await db.deleteFrom("family_task_series").where("account_id", "=", accountId).execute();
  await db.deleteFrom("family_events").where("account_id", "=", accountId).execute();
  await db.deleteFrom("family_event_series").where("account_id", "=", accountId).execute();
  const members = await db.selectFrom("family_members").select(["id", "first_name"]).where("account_id", "=", accountId).execute();
  const types = new Map((await db.selectFrom("event_types").select(["id", "code"]).execute()).map((t) => [t.code, t.id]));
  const { localToUtc } = await import("../src/server/assistant/local-time");
  for (const e of [...data.calendrier_initial, ...extraEvents]) {
    await db
      .insertInto("family_events")
      .values({
        id: seedUuid(e.id), account_id: accountId, title: seal(e.titre), event_type_id: types.get(TYPE_CODE[TYPE[e.type] as keyof typeof TYPE_CODE])!, starts_at: localToUtc(e.debut, TZ), ends_at: localToUtc(e.fin, TZ),
        all_day: Boolean(e.journee_entiere), location: sealOptional(e.lieu), status: STATUS_CODE.confirmed, source: "chat_text", confirmed_at: NOW, fingerprint: randomBytes(16),
      })
      .execute();
    await db.insertInto("family_event_members").values(e.membres.map((m) => ({ event_id: seedUuid(e.id), member_id: members.find((x) => x.first_name === m)!.id, account_id: accountId }))).execute();
  }
  // Tâches déjà enregistrées (« à faire »), comme après la confirmation d'un rendez-vous.
  for (const t of tasks) {
    const event = data.calendrier_initial.find((e) => e.id === t.evenement)!;
    const due = new Date(`${event.debut.slice(0, 10)}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() - t.jours_avant);
    await db
      .insertInto("family_tasks")
      .values({
        account_id: accountId, event_id: seedUuid(t.evenement), title: seal(t.titre), status: "todo", due_date: due.toISOString().slice(0, 10), days_before_event: t.jours_avant,
        created_by_user_id: userId, source: "user",
      })
      .execute();
  }
}

// --- évaluation -------------------------------------------------------------------------------------------------------------------
async function evaluate(c: Case, result: AgentRunResult, accountId: string): Promise<string[]> {
  const a = c.attendu;
  const failures: string[] = [];
  const names = result.trace.map((t) => t.name);
  const firstNames = new Map((await db.selectFrom("family_members").select(["id", "first_name"]).where("account_id", "=", accountId).execute()).map((m) => [m.id, m.first_name ?? ""]));
  const rows: { id: string; title: string; place: string | null; notes: string | null; start: string; end: string; all_day: boolean; event_type: string; who: string[] }[] = [];
  for (const id of result.createdEventIds) {
    const e = await loadCalendarEvent(db, accountId, id);
    if (e) rows.push({ id: e.id, title: e.title, place: e.place, notes: e.notes, start: utcToLocal(e.startsAt, TZ), end: utcToLocal(e.endsAt, TZ), all_day: e.allDay, event_type: e.type, who: e.memberIds.map((m) => normalize(firstNames.get(m) ?? "")) });
  }

  if (result.status !== "ok") failures.push(`état ${result.status}`);
  if (a.creations !== undefined && rows.length !== a.creations) failures.push(`${rows.length} création(s) au lieu de ${a.creations}`);
  if (a.creations_min !== undefined && rows.length < a.creations_min) failures.push(`${rows.length} création(s), au moins ${a.creations_min} attendue(s)`);
  const remaining = [...rows];
  for (const want of a.evenements ?? []) {
    const i = remaining.findIndex((r) =>
      r.start.slice(0, 10) === want.date && (want.heure === undefined || r.start.slice(11) === want.heure) && (want.fin === undefined || r.end.slice(11) === want.fin) &&
      (want.journee_entiere === undefined || r.all_day === want.journee_entiere) && (want.type === undefined || r.event_type === TYPE[want.type]) &&
      (want.membres_inclus ?? []).every((m) => r.who.includes(normalize(m))));
    if (i < 0) failures.push(`événement attendu non créé ou incorrect : ${JSON.stringify(want)}`);
    else remaining.splice(i, 1);
  }
  for (const n of a.outils_requis ?? []) if (!names.includes(n)) failures.push(`outil non appelé : ${n}`);
  for (const n of a.outils_interdits ?? []) if (names.includes(n)) failures.push(`outil interdit appelé : ${n}`);

  const proposals = await db.selectFrom("family_event_change_proposals").select(["event_id", "kind", "new_starts_at", "proposed_changes"]).where("account_id", "=", accountId).execute();
  if (a.modification) {
    const m = a.modification;
    const startsAt = (p: (typeof proposals)[number]) =>
      p.kind === "reschedule" && p.new_starts_at ? utcToLocal(p.new_starts_at, TZ) : String((p.proposed_changes ? (JSON.parse(open(p.proposed_changes)) as Record<string, string>) : {}).debut ?? "");
    const ok = proposals.some((p) => (p.kind === "modification" || p.kind === "reschedule") && p.event_id === seedUuid(m.id) && startsAt(p).startsWith(`${m.date}T${m.heure}`));
    if (!ok) failures.push(`modification attendue de ${m.id} vers ${m.date} ${m.heure}`);
  }
  if (a.annulation && !proposals.some((p) => p.kind === "cancellation" && p.event_id === seedUuid(a.annulation!))) failures.push(`annulation attendue de ${a.annulation}`);
  if (a.question && !result.reply.includes("?")) failures.push("une question était attendue dans la réponse");
  const text = normalize(result.reply);
  for (const element of a.texte_contient ?? []) if (!element.split("|").some((alt) => text.includes(normalize(alt)))) failures.push(`la réponse devrait mentionner « ${element} »`);

  if (a.medical_sans_detail) {
    for (const t of result.trace.filter((x) => x.name === "creer_evenement_provisoire")) {
      const input = t.input as { type?: string; lieu?: string; notes?: string };
      if (input.type === "medical" && (input.lieu || input.notes)) failures.push("lieu ou notes renseignés par l'agent sur un rendez-vous médical");
    }
    for (const r of rows.filter((x) => x.event_type === "medical")) {
      if (!r.title.startsWith("RDV médical — ") || r.place || r.notes) failures.push(`rendez-vous médical non minimisé : ${r.title}`);
    }
  }
  // --- séries et tâches ---
  const calls = (name: string) => result.trace.filter((t) => t.name === name).map((t) => t.input as Record<string, unknown>);
  const repetitionCalls = calls("creer_evenement_provisoire").filter((i) => i.repetition);
  if (a.sans_serie && repetitionCalls.length) failures.push("une série a été créée alors qu'une question était attendue");
  if (a.serie) failures.push(...checkRepetition("série", repetitionCalls[repetitionCalls.length - 1]?.repetition as Repetition | undefined, a.serie));

  if (a.taches_rdv) {
    const w = a.taches_rdv;
    const first = result.createdEventIds[0];
    const event = first ? await loadCalendarEvent(db, accountId, first) : null;
    let titles: string[] = [];
    if (event?.seriesId) {
      titles = (await db.selectFrom("family_task_series").select("title").where("event_series_id", "=", event.seriesId).where("ended_at", "is", null).execute()).map((r) => open(r.title));
    } else if (event) {
      titles = (await db.selectFrom("family_tasks").select("title").where("event_id", "=", event.id).where("series_id", "is", null).where("status", "in", ["proposed", "todo", "done"]).execute()).map((r) => open(r.title));
    }
    if (w.min !== undefined && titles.length < w.min) failures.push(`${titles.length} tâche(s) de préparation, au moins ${w.min} attendue(s)`);
    if (w.max !== undefined && titles.length > w.max) failures.push(`${titles.length} tâche(s) de préparation, au plus ${w.max} attendue(s) : ${titles.join(" ; ")}`);
    if (w.sans_prenom) {
      for (const title of titles) {
        const hit = [...firstNames.values()].find((n) => n && new RegExp(`\\b${normalize(n)}\\b`).test(normalize(title)));
        if (hit) failures.push(`prénom dans le titre d'une tâche : « ${title} »`);
      }
    }
    if (w.generiques_medical) {
      for (const title of titles) if (!GENERIC_MEDICAL_TASKS.some((g) => normalize(title).startsWith(g))) failures.push(`titre de tâche médicale non générique : « ${title} »`);
    }
    if (w.echeances_non_passees) {
      const today = utcToLocal(NOW, TZ).slice(0, 10);
      const eventDay = rows[0]?.start.slice(0, 10);
      for (const input of calls("creer_evenement_provisoire")) {
        for (const t of (input.taches as { titre?: string; echeance?: string }[] | undefined) ?? []) {
          const days = DAYS_BEFORE[t.echeance ?? ""];
          if (eventDay && days !== undefined && minusDays(eventDay, days) < today) failures.push(`échéance déjà passée proposée : « ${t.titre} » ${t.echeance}`);
        }
      }
    }
  }

  if (a.ajout_tache) {
    const w = a.ajout_tache;
    const titles = (await db.selectFrom("family_tasks").select("title").where("event_id", "=", seedUuid(w.evenement)).execute()).map((r) => open(r.title));
    if (!titles.some((t) => normalize(t).includes(normalize(w.titre_contient)))) failures.push(`tâche « ${w.titre_contient} » non enregistrée sur ${w.evenement}`);
  }

  if (a.lieu_public !== undefined) {
    const created = calls("creer_evenement_provisoire");
    const got = created.length ? String(created[created.length - 1].lieu_public ?? "absent") : "(aucune création)";
    if (!a.lieu_public.split("|").includes(got)) failures.push(`lieu_public « ${got} » au lieu de « ${a.lieu_public} »`);
  }
  if (a.sur_place) {
    const n = (await db.selectFrom("event_place_searches").select("id").where("event_id", "=", seedUuid(a.sur_place.evenement)).execute()).length;
    if (a.sur_place.aucune ? n > 0 : n === 0) failures.push(a.sur_place.aucune ? `recherche « Sur place » lancée pour ${a.sur_place.evenement}` : `aucune recherche « Sur place » lancée pour ${a.sur_place.evenement}`);
  }

  if (a.brouillons) {
    const w = a.brouillons;
    const drafts = result.taskDrafts;
    if (drafts.length !== w.nombre) failures.push(`${drafts.length} carte(s) de tâche au lieu de ${w.nombre}`);
    const d = drafts[0];
    if (d && w.nombre > 0) {
      if (w.due !== undefined && d.due !== w.due) failures.push(`échéance ${d.due} au lieu de ${w.due}`);
      if (w.heure !== undefined && d.dueTime?.slice(0, 5) !== w.heure) failures.push(`heure ${d.dueTime ?? "(aucune)"} au lieu de ${w.heure}`);
      if (w.titre_contient !== undefined && !normalize(d.title).includes(normalize(w.titre_contient))) failures.push(`le titre « ${d.title} » devrait contenir « ${w.titre_contient} »`);
      if (w.membre !== undefined && normalize(firstNames.get(d.assigneeId ?? "") ?? "") !== normalize(w.membre)) failures.push(`tâche assignée à « ${firstNames.get(d.assigneeId ?? "") ?? "(personne)"} » au lieu de « ${w.membre} »`);
      if (w.repetition) {
        const last = calls("proposer_tache").at(-1);
        failures.push(...checkRepetition("tâche", last?.repetition as Repetition | undefined, w.repetition));
      }
    }
  }

  if (result.leaks.length) failures.push(`données personnelles envoyées au modèle : ${result.leaks.join(", ")}`);
  if (result.unknownAliases.length) failures.push(`alias inventé : ${result.unknownAliases.join(", ")}`);
  const tut = TUTOIEMENT.exec(text.replace(/’/g, "'"));
  if (tut) failures.push(`tutoiement détecté (« ${tut[0]} »)`);
  const firstCreation = names.indexOf("creer_evenement_provisoire");
  if (firstCreation >= 0 && !(names.slice(0, firstCreation).includes("rechercher_doublon") && names.slice(0, firstCreation).includes("verifier_conflits"))) {
    failures.push("création sans vérification préalable des doublons et des conflits");
  }
  return failures;
}

// --- exécution ----------------------------------------------------------------------------------------------------------------------
const model = createModel({ provider, apiKey, model: process.env.MODELE ?? "claude-sonnet-5-5", effort: (process.env.EFFORT as "low" | "medium" | "high") ?? "medium" });
const definition = loadAgentDefinition();
const cases = data.cas.filter((c) => !wanted || wanted.some((p) => c.id.startsWith(p)));
const outcomes: { id: string; titre: string; run: number; failures: string[]; seconds: number; result: AgentRunResult; duplicate: boolean; message: string }[] = [];
const quiet = console.info;

try {
  await migrate(pool);
  const { accountId, userId } = await seedFamily();
  const members = await loadPseudoMembers(db, accountId);
  const author = members.find((m) => m.firstName === data.contexte.utilisateur)!.id;
  console.log(`Modèle ${process.env.MODELE ?? "claude-sonnet-5-5"} via ${provider} — ${cases.length} cas × ${runs} passage(s) — code de production de MAAQ\n`);
  for (let run = 1; run <= runs; run++) {
    for (const c of cases) {
      await seedCalendar(accountId, userId, c.taches_initiales, c.evenements_initiaux);
      await db.deleteFrom("family_event_change_proposals").where("account_id", "=", accountId).execute();
      const base = { db, model, definition, accountId, userId, members, authorMemberId: author, timeZone: TZ, now: NOW };
      const before: string[] = [];
      let history: { role: "user" | "assistant"; text: string; source?: "typed" | "dictation" | "capture" | "mail" }[] | undefined;
      console.info = () => {}; // les traces d'exploitation ne sont pas affichées ici
      if (c.precedent) {
        // Échange préalable avec le vrai modèle : le message testé le reçoit en historique, comme dans le tchat.
        const first = await runAssistant({ ...base, requestId: randomUUID(), source: SOURCE[c.precedent.source], text: c.precedent.message });
        history = [{ role: "user", text: c.precedent.message, source: SOURCE[c.precedent.source] }, { role: "assistant", text: first.reply }];
        if (first.status !== "ok") before.push(`échange préalable : état ${first.status}`);
        if (c.precedent.question && (first.createdEventIds.length || !first.reply.includes("?"))) before.push("échange préalable : une question était attendue, sans création");
      }
      const result = await runAssistant({ ...base, requestId: randomUUID(), source: SOURCE[c.source], text: c.message, history });
      console.info = quiet;
      const failures = [...before, ...(await evaluate(c, result, accountId))];
      const seconds = result.durationMs / 1000;
      outcomes.push({ id: c.id, titre: c.titre, run, failures, seconds, result, duplicate: Boolean(c.attendu.doublon_attendu), message: c.message });
      console.log(`${failures.length ? "✘" : "✔"} ${c.id} #${run} [${seconds.toFixed(1)} s] ${result.trace.map((t) => t.name).join(",")}${failures.length ? ` — ${failures.join(" ; ")}` : ""}`);
    }
  }

  // --- rapport ---
  const passed = outcomes.filter((o) => !o.failures.length).length;
  const times = outcomes.map((o) => o.seconds).sort((x, y) => x - y);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)] ?? 0;
  const duplicates = outcomes.filter((o) => o.duplicate);
  const missed = duplicates.filter((o) => o.result.createdEventIds.length > 0);
  const tokensIn = outcomes.reduce((n, o) => n + o.result.usage.inputTokens + o.result.usage.cacheRead + o.result.usage.cacheWrite, 0);
  const tokensOut = outcomes.reduce((n, o) => n + o.result.usage.outputTokens, 0);
  const fresh = outcomes.reduce((n, o) => n + o.result.usage.inputTokens, 0);
  const cacheRead = outcomes.reduce((n, o) => n + o.result.usage.cacheRead, 0);
  const cacheWrite = outcomes.reduce((n, o) => n + o.result.usage.cacheWrite, 0);
  const modelId = process.env.MODELE ?? "claude-sonnet-5-5";
  const costs = outcomes.map((o) => estimateCostUsd(modelId, o.result.usage)).filter((c): c is number => c !== null);
  const totalCost = costs.reduce((n, c) => n + c, 0);
  const costMedian = [...costs].sort((x, y) => x - y)[Math.floor(costs.length / 2)] ?? 0;
  const lines = [
    `# Banc d'essai de bout en bout — ${new Date().toLocaleString("fr-FR")}`, "",
    `- Modèle : \`${process.env.MODELE ?? "claude-sonnet-5-5"}\` via \`${provider}\` ; code de production de MAAQ (boucle, outils, pseudonymisation), base de test jetable`,
    `- Résultat : **${passed} / ${outcomes.length}** (${((100 * passed) / outcomes.length).toFixed(0)} %)`,
    `- Durée par demande : médiane ${pct(50).toFixed(1)} s, 95e centile ${pct(95).toFixed(1)} s, ${times.filter((t) => t < SECONDS_LIMIT).length} / ${times.length} sous ${SECONDS_LIMIT} s`,
    `- Jetons : ${tokensIn} en entrée (dont ${fresh} neufs, ${cacheRead} lus du cache, ${cacheWrite} écrits dans le cache), ${tokensOut} en sortie ; erreurs d'outils : ${outcomes.reduce((n, o) => n + o.result.toolCalls.filter((t) => t.isError).length, 0)}`,
    costs.length === outcomes.length
      ? `- **Coût estimé : ${totalCost.toFixed(2)} $** au total, ${(totalCost / outcomes.length).toFixed(3)} $ par demande en moyenne (médiane ${costMedian.toFixed(3)} $) ; ${cacheRead > 0 ? "demandes rapprochées : le cache est plus chaud qu'au quotidien" : "sans lecture du cache"}`
      : `- Coût estimé : tarif inconnu pour le modèle ${modelId}`,
    `- **Doublons manqués : ${missed.length} / ${duplicates.length}**`, "",
    "| Cas | Passage | Résultat | Durée (s) | Outils | Problèmes |", "|---|---|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.id} | ${o.run} | ${o.failures.length ? "ÉCHEC" : "OK"} | ${o.seconds.toFixed(1)} | ${o.result.trace.length} | ${o.failures.join(" ; ") || "–"} |`), "",
    ...(outcomes.some((o) => o.failures.length && o.result.status === "ok") ? ["## Réponses des cas en échec (jeu d'essai fictif)", "", ...outcomes.filter((o) => o.failures.length && o.result.status === "ok").map((o) => `- ${o.id} #${o.run} : ${o.result.reply.replace(/\s+/g, " ").slice(0, 400)}`), ""] : []),
    "## Doublons : membres passés à la recherche", "",
    ...duplicates.map((o) => `- ${o.id} #${o.run} : ${o.result.createdEventIds.length ? "MANQUÉ (créé en double)" : "reconnu"} ; membres : ${JSON.stringify(o.result.trace.filter((t) => t.name === "rechercher_doublon").map((t) => (t.input as { membres?: string[] }).membres ?? "(aucun)"))}`),
  ];
  const outDir = path.join(process.cwd(), "agent", "resultats");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `rapport_ts_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
  writeFileSync(file, lines.join("\n"));
  console.log(`\n${passed} / ${outcomes.length} réussis ; médiane ${pct(50).toFixed(1)} s, p95 ${pct(95).toFixed(1)} s ; doublons manqués ${missed.length} / ${duplicates.length}\nRapport : ${file}`);
} finally {
  console.info = quiet;
  await db.destroy();
  // Sous Windows, le dossier peut rester verrouillé un instant après l'arrêt : sans conséquence.
  await pg.stop().catch(() => {});
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
}
