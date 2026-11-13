// Relevé des coûts d'IA par type d'appel, à partir des lignes « model_call » des journaux du service (une par appel au modèle : type, coût estimé, recherches web).
// Aucune donnée personnelle : ces lignes ne portent ni contenu ni identifiant de profil. Lecture seule, par la commande gcloud déjà connectée au projet.
//   npx tsx scripts/cost-report.ts [--jours 7] [--projet maaq-test] [--service maaq-test] [--budget 500]
// Le coût est une estimation de MAAQ : la facture d'Anthropic fait foi.
import { execSync } from "node:child_process";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const days = Number(arg("jours", "7"));
const project = arg("projet", "maaq-test");
const service = arg("service", "maaq-test");
const budget = Number(arg("budget", "500"));

export interface Call {
  kind: string;
  apiCostUsd: number;
  webSearches: number;
}

/** Par type : nombre d'appels, coût total, coût moyen, recherches web ; trié du plus coûteux au moins coûteux. */
export function summarize(calls: Call[]): { kind: string; calls: number; costUsd: number; averageUsd: number; webSearches: number }[] {
  const byKind = new Map<string, { calls: number; costUsd: number; webSearches: number }>();
  for (const c of calls) {
    const row = byKind.get(c.kind) ?? { calls: 0, costUsd: 0, webSearches: 0 };
    row.calls += 1;
    row.costUsd += c.apiCostUsd;
    row.webSearches += c.webSearches;
    byKind.set(c.kind, row);
  }
  return [...byKind.entries()].map(([kind, r]) => ({ kind, ...r, averageUsd: r.costUsd / r.calls })).sort((a, b) => b.costUsd - a.costUsd);
}

/** Lecture par l'API Cloud Logging, avec le jeton de la session gcloud du poste (aucun guillemet à faire passer par l'interpréteur de commandes). */
async function read(since: Date): Promise<Call[]> {
  const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  const filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="${service}" AND jsonPayload.event="model_call" AND timestamp>="${since.toISOString()}"`;
  const calls: Call[] = [];
  let pageToken: string | undefined;
  do {
    const response = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ resourceNames: [`projects/${project}`], filter, pageSize: 1000, pageToken }),
    });
    if (!response.ok) throw new Error(`Lecture des journaux refusée (${response.status})`);
    const body = (await response.json()) as { entries?: { jsonPayload?: Partial<Call> }[]; nextPageToken?: string };
    for (const e of body.entries ?? []) calls.push({ kind: e.jsonPayload?.kind ?? "autre", apiCostUsd: Number(e.jsonPayload?.apiCostUsd ?? 0), webSearches: Number(e.jsonPayload?.webSearches ?? 0) });
    pageToken = body.nextPageToken;
  } while (pageToken);
  return calls;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/cost-report.ts")) {
  const now = new Date();
  const week = await read(new Date(now.getTime() - days * 86_400_000));
  const month = await read(new Date(`${now.toISOString().slice(0, 7)}-01T00:00:00Z`));
  const usd = (n: number) => n.toFixed(n < 1 ? 4 : 2);
  console.log(`Coûts d'IA estimés, ${days} derniers jours (${service})`);
  console.log("type\tappels\tcoût $\tmoyen $\trecherches web");
  for (const r of summarize(week)) console.log(`${r.kind}\t${r.calls}\t${usd(r.costUsd)}\t${usd(r.averageUsd)}\t${r.webSearches}`);
  const total = week.reduce((s, c) => s + c.apiCostUsd, 0);
  const monthTotal = month.reduce((s, c) => s + c.apiCostUsd, 0);
  console.log(`total\t${week.length}\t${usd(total)}`);
  console.log(`Cumul du mois : ${usd(monthTotal)} $ sur ${budget} $ (${Math.round((monthTotal / budget) * 100)} %).`);
}
