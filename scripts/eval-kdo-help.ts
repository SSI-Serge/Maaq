import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kdoHelpBrain } from "../src/server/agents/kdo-help";
import { anthropicLlm } from "../src/server/agents/llm";
import type { LlmClient } from "../src/server/agents/types";
import { MemoryPrefsStore } from "../src/server/gifts/prefs";
import { MemoryGiftStore, type GiftStore } from "../src/server/gifts/store";

/**
 * Évaluation de kdo_help avec le vrai modèle, sur un magasin en mémoire.
 *
 *   npm run eval:kdo-help                 # cas qualitatifs (golden.json) : réponses à noter à la main
 *   npm run eval:kdo-help -- --intents    # intention → outil (utterances.json) : précision mesurée
 *   npm run eval:kdo-help -- --dry        # vérifie les jeux sans appel au modèle
 *   npm run eval:kdo-help -- copain       # cas dont l'identifiant contient « copain »
 */

interface PersonSeed {
  nom: string;
  lien?: string;
  anniversaire?: { jour: number; mois: number; annee?: number };
  budget?: number;
  interets?: string[];
  moments_de_vie?: string[];
}

interface GoldenCase {
  id: string;
  request: string;
  people: PersonSeed[];
  good: string;
  bad: string;
}

interface Utterance {
  text: string;
  expect: string[];
  anyOf?: boolean;
  forbid: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const intents = args.includes("--intents");
const filter = args.find((arg) => !arg.startsWith("--")) ?? "";
const model = process.env.LOCAL_AGENTS_MODEL ?? "claude-opus-5-5";

const dryLlm: LlmClient = {
  async complete() {
    throw new Error("--dry");
  },
  async runTools() {
    return { text: "(réponse non générée : --dry)" };
  },
};

async function seed(store: GiftStore, userId: string, people: PersonSeed[]) {
  for (const p of people) {
    await store.createPerson(userId, {
      name: p.nom,
      relationship: p.lien ?? null,
      birthDay: p.anniversaire?.jour ?? null,
      birthMonth: p.anniversaire?.mois ?? null,
      birthYear: p.anniversaire?.annee ?? null,
      budgetAmount: p.budget ?? null,
      details: { interests: p.interets ?? [], lifeEvents: p.moments_de_vie ?? [] },
    });
  }
}

function brainFor(store: GiftStore) {
  return kdoHelpBrain(dry ? dryLlm : anthropicLlm({ model }), { store, prefs: new MemoryPrefsStore() });
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(here, "../Kdo-agent/evals", name), "utf8")) as T;
}

const turn = (userRef: string, text: string, today: Date) => ({
  userRef,
  text,
  context: { rank: "primary_user" as const, autoParticipants: [], ccAddresses: [], info: {} },
  history: [],
  today,
  timezone: "Europe/Paris",
  channel: "web" as const,
});

async function runGolden() {
  const golden = await readJson<{ today: string; cases: GoldenCase[] }>("golden.json");
  const cases = golden.cases.filter((c) => c.id.includes(filter));
  const today = new Date(`${golden.today}T09:00:00Z`);
  console.log(`${cases.length} cas, modèle ${dry ? "(aucun, --dry)" : model}, date ${golden.today}\n`);

  let withProblems = 0;
  for (const c of cases) {
    const store = new MemoryGiftStore();
    await seed(store, c.id, c.people);
    const started = Date.now();
    const generation = await brainFor(store).generate(turn(c.id, c.request, today));
    if (generation.problems.length) withProblems++;

    console.log(`━━━ ${c.id} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    console.log(`Demande : ${c.request}`);
    console.log("");
    console.log(generation.reply.text.replace(/^/gm, "  "));
    if (generation.reply.proposals.length) console.log(`  [carte à valider] ${generation.reply.proposals.map((p) => p.summary).join(" ; ")}`);
    console.log("");
    console.log(`Outils : ${generation.calls.join(" → ") || "aucun"}`);
    console.log(`Contrôles : ${generation.problems.length ? generation.problems.join(" ; ") : "ok"}`);
    console.log(`Bonne réponse : ${c.good}`);
    console.log(`Mauvaise réponse : ${c.bad}`);
    console.log("");
  }
  console.log(`${cases.length - withProblems}/${cases.length} cas sans idée retirée par les contrôles. La qualité se note à la main (voir golden.json).`);
}

async function runIntents() {
  const set = await readJson<{ today: string; people: PersonSeed[]; utterances: Utterance[] }>("utterances.json");
  const utterances = set.utterances.filter((u) => u.text.toLowerCase().includes(filter.toLowerCase()));
  const today = new Date(`${set.today}T09:00:00Z`);
  console.log(`${utterances.length} phrases, modèle ${dry ? "(aucun, --dry)" : model}\n`);

  let passed = 0;
  for (const [index, u] of utterances.entries()) {
    const store = new MemoryGiftStore();
    const userRef = `intent-${index}`;
    await seed(store, userRef, set.people);
    const generation = await brainFor(store).generate(turn(userRef, u.text, today));
    const called = new Set(generation.calls);
    const expected = u.anyOf ? u.expect.some((t) => called.has(t)) : u.expect.every((t) => called.has(t));
    const forbidden = u.forbid.filter((t) => called.has(t));
    const ok = expected && forbidden.length === 0;
    if (ok) passed++;
    console.log(`${ok ? "✓" : "✗"} ${u.text}`);
    console.log(`    appelés : ${generation.calls.join(" → ") || "aucun"}${expected ? "" : ` — attendu : ${u.expect.join(u.anyOf ? " ou " : " et ")}`}${forbidden.length ? ` — interdit : ${forbidden.join(", ")}` : ""}`);
  }
  console.log(`\n${passed}/${utterances.length} phrases routées vers les bons outils.`);
}

(intents ? runIntents() : runGolden()).catch((error) => {
  console.error(error);
  process.exit(1);
});
