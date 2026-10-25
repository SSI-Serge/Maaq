// Banc d'essai de bout en bout de l'Assistant Famille : le VRAI modèle, la VRAIE boucle et les VRAIS outils de MAAQ, sur une base de test
// jetable (PostgreSQL embarqué). Rejoue les 36 cas de agent/tests/cas_de_test.json et compare au résultat attendu, comme le banc Python
// (agent/banc_essai/lancer_tests.py), mais sur le code qui tournera en production. Aucune donnée réelle.
//
//   npx tsx scripts/assistant-bench.ts --env agent/.env              # clé ANTHROPIC_API_KEY lue dans ce fichier (jamais affichée)
//   npx tsx scripts/assistant-bench.ts --cas 01 29 30 --runs 2
//   npx tsx scripts/assistant-bench.ts --provider foundry            # avec FOUNDRY_RESOURCE et FOUNDRY_API_KEY (quand le quota sera accordé)
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "dotenv";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { loadAgentDefinition, runAssistant, type AgentRunResult } from "../src/server/assistant/agent";
import { ensureParentMembers, loadPseudoMembers } from "../src/server/assistant/family";
import { utcToLocal } from "../src/server/assistant/local-time";
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
const provider = (option("provider") ?? process.env.FOURNISSEUR ?? "anthropic") as "anthropic" | "foundry";
const apiKey = provider === "foundry" ? process.env.FOUNDRY_API_KEY : process.env.ANTHROPIC_API_KEY;
if (!apiKey || (provider === "foundry" && !process.env.FOUNDRY_RESOURCE)) {
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
  };
}
const data = JSON.parse(readFileSync(path.join(process.cwd(), "agent", "tests", "cas_de_test.json"), "utf8")) as {
  contexte: { maintenant: string; fuseau: string; utilisateur: string };
  famille: { prenom: string; role: string; age: number }[];
  calendrier_initial: { id: string; titre: string; type: string; debut: string; fin: string; membres: string[]; lieu?: string; journee_entiere?: boolean; statut: string }[];
  cas: Case[];
};
const SOURCE: Record<Case["source"], "typed" | "dictation" | "capture" | "mail"> = { saisie: "typed", dictee: "dictation", capture: "capture", mail: "mail" };
const TYPE: Record<string, string> = { ecole: "school", medical: "medical", pro: "work", familial: "family", perso: "personal", admin: "admin" };
const TZ = data.contexte.fuseau;
const NOW = new Date("2026-11-02T08:00:00Z"); // lundi 2 novembre 2026, 09:00 à Paris
const seedUuid = (id: string) => `0000000${id.slice(-1)}-0000-4000-8000-00000000000${id.slice(-1)}`;

const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const TUTOIEMENT = /\b(tu|toi|ton|ta|tes|te|tien|tienne)\b|\bt'/;
const SECONDS_LIMIT = 10;

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
  await ensureParentMembers(db, account.id);
  for (const child of data.famille.filter((m) => m.role === "enfant")) {
    const born = new Date(NOW);
    born.setUTCFullYear(born.getUTCFullYear() - child.age);
    born.setUTCMonth(born.getUTCMonth() - 1);
    const alias = (await loadPseudoMembers(db, account.id)).filter((m) => m.role === "child").length + 1;
    await db.insertInto("family_members").values({ account_id: account.id, first_name: child.prenom, role: "child", birth_date: born.toISOString().slice(0, 10), alias_index: alias }).execute();
  }
  return { accountId: account.id, userId: ids.get(data.contexte.utilisateur)! };
}

async function seedCalendar(accountId: string) {
  await db.deleteFrom("family_event_proposals").where("account_id", "=", accountId).execute();
  await db.deleteFrom("family_events").where("account_id", "=", accountId).execute();
  const members = await db.selectFrom("family_members").select(["id", "first_name"]).where("account_id", "=", accountId).execute();
  const { localToUtc } = await import("../src/server/assistant/local-time");
  for (const e of data.calendrier_initial) {
    await db
      .insertInto("family_events")
      .values({
        id: seedUuid(e.id), account_id: accountId, title: e.titre, event_type: TYPE[e.type] as never, starts_at: localToUtc(e.debut, TZ), ends_at: localToUtc(e.fin, TZ),
        all_day: Boolean(e.journee_entiere), place: e.lieu ?? null, status: "confirmed", source: "typed",
      })
      .execute();
    await db.insertInto("family_event_members").values(e.membres.map((m) => ({ event_id: seedUuid(e.id), member_id: members.find((x) => x.first_name === m)!.id }))).execute();
  }
}

// --- évaluation -------------------------------------------------------------------------------------------------------------------
async function evaluate(c: Case, result: AgentRunResult, accountId: string): Promise<string[]> {
  const a = c.attendu;
  const failures: string[] = [];
  const names = result.trace.map((t) => t.name);
  const created = result.createdEventIds.length
    ? await db
        .selectFrom("family_events")
        .select(["id", "title", "event_type", "starts_at", "ends_at", "all_day", "place", "notes"])
        .where("id", "in", result.createdEventIds)
        .execute()
    : [];
  const links = created.length ? await db.selectFrom("family_event_members as l").innerJoin("family_members as m", "m.id", "l.member_id").select(["l.event_id", "m.first_name"]).where("l.event_id", "in", created.map((e) => e.id)).execute() : [];
  const rows = created.map((e) => ({
    ...e, start: utcToLocal(e.starts_at, TZ), end: utcToLocal(e.ends_at, TZ), who: links.filter((l) => l.event_id === e.id).map((l) => normalize(l.first_name)),
  }));

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

  const proposals = await db.selectFrom("family_event_proposals").select(["event_id", "kind", "changes"]).where("account_id", "=", accountId).execute();
  if (a.modification) {
    const m = a.modification;
    const ok = proposals.some((p) => p.kind === "modification" && p.event_id === seedUuid(m.id) && String((p.changes as Record<string, string> | null)?.debut ?? "").startsWith(`${m.date}T${m.heure}`));
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
const model = createModel({ provider, apiKey, resource: process.env.FOUNDRY_RESOURCE, model: process.env.MODELE ?? "claude-sonnet-5-5", effort: (process.env.EFFORT as "low" | "medium" | "high") ?? "medium" });
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
      await seedCalendar(accountId);
      await db.deleteFrom("family_event_proposals").where("account_id", "=", accountId).execute();
      console.info = () => {}; // les traces d'exploitation ne sont pas affichées ici
      const result = await runAssistant({
        db, model, definition, accountId, userId, members, authorMemberId: author, timeZone: TZ, now: NOW, requestId: randomUUID(), source: SOURCE[c.source], text: c.message,
      });
      console.info = quiet;
      const failures = await evaluate(c, result, accountId);
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
  const lines = [
    `# Banc d'essai de bout en bout — ${new Date().toLocaleString("fr-FR")}`, "",
    `- Modèle : \`${process.env.MODELE ?? "claude-sonnet-5-5"}\` via \`${provider}\` ; code de production de MAAQ (boucle, outils, pseudonymisation), base de test jetable`,
    `- Résultat : **${passed} / ${outcomes.length}** (${((100 * passed) / outcomes.length).toFixed(0)} %)`,
    `- Durée par demande : médiane ${pct(50).toFixed(1)} s, 95e centile ${pct(95).toFixed(1)} s, ${times.filter((t) => t < SECONDS_LIMIT).length} / ${times.length} sous ${SECONDS_LIMIT} s`,
    `- Jetons : ${tokensIn} en entrée, ${tokensOut} en sortie ; erreurs d'outils : ${outcomes.reduce((n, o) => n + o.result.toolCalls.filter((t) => t.isError).length, 0)}`,
    `- **Doublons manqués : ${missed.length} / ${duplicates.length}**`, "",
    "| Cas | Passage | Résultat | Durée (s) | Outils | Problèmes |", "|---|---|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.id} | ${o.run} | ${o.failures.length ? "ÉCHEC" : "OK"} | ${o.seconds.toFixed(1)} | ${o.result.trace.length} | ${o.failures.join(" ; ") || "–"} |`), "",
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
