// Essai réel du sous-agent Sorties (US-115) avec des critères FICTIFS : aucune base, aucun compte de famille, aucune donnée personnelle. Sert à vérifier que l'outil de recherche web
// répond, à mesurer le coût réel d'une proposition (recherches, jetons, durée) et à contrôler la qualité (liens issus des résultats, prix relevés ou estimés, nouveautés récentes).
//
//   ANTHROPIC_API_KEY=… npx tsx scripts/outings-trial.ts [--minimal] [--runs 3] [--seulement 1] [--sortie fichier.json]
//
// Le coût estimé suit les tarifs publics (jetons + 10 dollars les 1 000 recherches) : la facture de l'API Anthropic fait foi.
import { writeFileSync } from "node:fs";
import { estimateCostUsd } from "../src/server/assistant/cost";
import { createModel } from "../src/server/assistant/model";
import { findIdeas, searchInput, type SearchRequest } from "../src/server/assistant/outings/search";
import { loadEnv } from "./lib/load-env";

// Les clés locales servent seulement à calculer les empreintes d'offres ; aucune base n'est ouverte.
loadEnv();

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("ANTHROPIC_API_KEY est absente de l'environnement.");
  process.exit(1);
}
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const MODEL = process.env.ASSISTANT_MODEL ?? "claude-sonnet-5-5";
const model = createModel({ provider: "anthropic", apiKey: key, model: MODEL, effort: "medium", timeoutMs: 180_000, maxTokens: 12_000 });
const today = new Date().toISOString().slice(0, 10);

/** Garde-fou : l'essai s'arrête si le coût cumulé dépasse ce montant. */
const MAX_TOTAL_USD = Number(process.env.TRIAL_MAX_USD ?? 6);

async function minimal() {
  const started = Date.now();
  const answer = await model.send({
    system: "Réponds en une phrase courte, en français.",
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    messages: [{ role: "user", content: [{ type: "text", text: "Cherche sur le web un lieu ouvert au public à Lyon (musée ou parc) et donne son nom." }] }],
  });
  const text = answer.content.map((b) => (b.type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
  console.log(JSON.stringify({ essai: "minimal", arret: answer.stopReason, recherches: answer.usage.webSearches, jetons: answer.usage, coutEstimeUsd: estimateCostUsd(MODEL, answer.usage), dureeMs: Date.now() - started, reponse: text.slice(0, 160) }));
  return estimateCostUsd(MODEL, answer.usage) ?? 0;
}

const SCENARIOS: { name: string; request: SearchRequest }[] = [
  {
    name: "Lyon, couple, gastronomie et nature, 120 € pour 2",
    request: { categories: [{ category: "couple", label: "sortie couple", themes: [{ key: "gastronomy", label: "Gastronomie" }, { key: "nature", label: "Nature" }] }], budget: 120, people: 2, targetDate: "2026-11-14", weekday: "samedi", place: "Lyon", mood: "both", today },
  },
  {
    name: "Paris et Île-de-France, couple, découverte et culture, 150 € pour 2",
    request: { categories: [{ category: "couple", label: "sortie couple", themes: [{ key: "discovery", label: "Découverte" }, { key: "culture", label: "Culture" }] }], budget: 150, people: 2, targetDate: "2026-11-15", weekday: "dimanche", place: "Paris et Île-de-France", mood: "calm", today },
  },
  {
    name: "Bordeaux, sortie perso, bien-être et flânerie, 60 € pour 1",
    request: { categories: [{ category: "self", label: "sortie perso", themes: [{ key: "wellbeing", label: "Bien-être" }, { key: "strolling", label: "Flânerie" }] }], budget: 60, people: 1, targetDate: "2026-11-21", weekday: "samedi", place: "Bordeaux", mood: "calm", today },
  },
];

let total = 0;
if (process.argv.includes("--minimal")) {
  await minimal();
} else {
  total += await minimal();
  const runs = Math.min(SCENARIOS.length, Number(arg("runs") ?? 3));
  const only = arg("seulement");
  const report: unknown[] = [];
  for (const scenario of only === undefined ? SCENARIOS.slice(0, runs) : [SCENARIOS[Number(only)]]) {
    if (total > MAX_TOTAL_USD) {
      console.log(`Arrêt : le coût cumulé (${total.toFixed(2)} $) dépasse le garde-fou (${MAX_TOTAL_USD} $).`);
      break;
    }
    const input = searchInput(scenario.request);
    const found = await findIdeas(model, scenario.request, new Set()).catch((error) => ({ error: String(error) }));
    if ("error" in found) {
      console.log(JSON.stringify({ scenario: scenario.name, erreur: found.error }));
      continue;
    }
    total += found.costUsd ?? 0;
    const summary = {
      scenario: scenario.name,
      appels: found.calls,
      recherches: found.searches,
      jetonsEntree: found.tokens.input + found.tokens.cacheRead + found.tokens.cacheWrite,
      jetonsSortie: found.tokens.output,
      jetons: found.tokens,
      coutEstimeUsd: found.costUsd,
      dureeS: Math.round(found.durationMs / 100) / 10,
      idees: found.ideas.length,
      dansLeBudget: found.ideas.filter((i) => i.section === "in_budget").length,
      nouveautes: found.ideas.filter((i) => i.section === "novelty").length,
      liensDesResultats: found.urls.length,
    };
    console.log(JSON.stringify(summary));
    report.push({ ...summary, entree: input, ideas: found.ideas, rawText: found.rawText, urls: found.urls });
  }
  console.log(`Coût estimé total : ${total.toFixed(3)} $`);
  const out = arg("sortie");
  if (out) writeFileSync(out, JSON.stringify(report, null, 1));
}
