import type { Ctx } from "@/server/auth/service";
import { accessToken } from "@/server/contracts/storage";
import { alertAdmin } from "@/server/logbook/service";

/**
 * Alerte avant la limite de dépense de la clé Anthropic (test « Friends and family »). Sans table : une fois par heure, la dépense du mois est recalculée en additionnant
 * les lignes « model_call » des journaux Google du service (une par appel au modèle, avec son coût estimé). À 50 %, 80 % et 95 % du budget (BUDGET_ALERT_USD), un email part
 * à l'adresse d'alerte de la console, une seule fois par palier et par mois : les paliers déjà annoncés sont relus dans ces mêmes journaux (ligne « budget_alert »).
 * C'est une estimation : la facture d'Anthropic fait foi. Sans BUDGET_ALERT_USD, ou hors de Cloud Run, rien ne se passe.
 */

export const BUDGET_THRESHOLDS = [50, 80, 95];
const MAX_PAGES = 100;

export interface LogReader {
  /** Lignes de journal du service depuis `since`, dont le champ JSON `field` existe. */
  entries(since: Date, field: "apiCostUsd" | "threshold"): Promise<Record<string, unknown>[]>;
}

async function metadata(path: string): Promise<string> {
  const response = await fetch(`http://metadata.google.internal/computeMetadata/v1/${path}`, { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error(`Métadonnées Google indisponibles (${response.status})`);
  return response.text();
}

/** Lecture des journaux par l'API Cloud Logging, avec le compte de service de Cloud Run. */
export function googleLogReader(service: string): LogReader {
  return {
    async entries(since, field) {
      const project = await metadata("project/project-id");
      const filter = [
        'resource.type="cloud_run_revision"',
        `resource.labels.service_name="${service}"`,
        `timestamp>="${since.toISOString()}"`,
        field === "apiCostUsd" ? 'jsonPayload.event="model_call"' : 'jsonPayload.event="budget_alert"',
      ].join(" AND ");
      const found: Record<string, unknown>[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await fetch("https://logging.googleapis.com/v2/entries:list", {
          method: "POST",
          headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ resourceNames: [`projects/${project}`], filter, pageSize: 1000, pageToken }),
        });
        if (!response.ok) throw new Error(`Lecture des journaux refusée (${response.status})`);
        const body = (await response.json()) as { entries?: { jsonPayload?: Record<string, unknown> }[]; nextPageToken?: string };
        for (const entry of body.entries ?? []) if (entry.jsonPayload) found.push(entry.jsonPayload);
        pageToken = body.nextPageToken;
        if (!pageToken) return found;
      }
      throw new Error("Trop de lignes de journal pour ce mois : la dépense n'a pas pu être additionnée.");
    },
  };
}

let lastHour: string | null = null;

export type BudgetResult = { status: "off" | "not_due" } | { status: "checked"; month: string; spentUsd: number; budgetUsd: number; sent: number[] };

export async function runBudgetAlert(ctx: Ctx, options: { budgetUsd?: number; reader?: LogReader; alert?: (subject: string, text: string) => Promise<void> } = {}): Promise<BudgetResult> {
  const budgetUsd = options.budgetUsd ?? Number(process.env.BUDGET_ALERT_USD ?? 0);
  const service = process.env.K_SERVICE;
  if (!(budgetUsd > 0) || (!options.reader && !service)) return { status: "off" };
  const hour = ctx.now.toISOString().slice(0, 13);
  if (lastHour === hour) return { status: "not_due" };
  lastHour = hour;

  const reader = options.reader ?? googleLogReader(service!);
  const month = ctx.now.toISOString().slice(0, 7);
  const since = new Date(`${month}-01T00:00:00Z`);
  const spentUsd = (await reader.entries(since, "apiCostUsd")).reduce((sum, e) => sum + (typeof e.apiCostUsd === "number" ? e.apiCostUsd : 0), 0);
  const already = new Set((await reader.entries(since, "threshold")).filter((e) => e.month === month).map((e) => Number(e.threshold)));
  const percent = (spentUsd / budgetUsd) * 100;
  const sent: number[] = [];
  // Un seul email par passage : le palier le plus haut atteint et pas encore annoncé ; les paliers inférieurs sont notés comme annoncés avec lui.
  const reached = BUDGET_THRESHOLDS.filter((t) => percent >= t && !already.has(t));
  if (reached.length > 0) {
    const top = reached[reached.length - 1];
    const spent = spentUsd.toFixed(2).replace(".", ",");
    await (options.alert ?? ((subject, text) => alertAdmin(ctx.db, subject, text)))(
      `Dépense IA du mois : ${top} % du budget atteints`,
      `La dépense estimée des appels à l'IA atteint ${spent} $ sur ${budgetUsd} $ pour ${month}, soit ${Math.floor(percent)} % du budget.\n\n` +
        "Quand la limite réglée sur la clé Anthropic est atteinte, toute l'IA s'arrête pour tous les profils jusqu'au mois suivant.\n\n" +
        "Ce montant est une estimation calculée par MAAQ : la facture d'Anthropic fait foi.\n",
    );
    for (const threshold of reached) {
      console.info(JSON.stringify({ event: "budget_alert", month, threshold, spentUsd: Math.round(spentUsd * 100) / 100, budgetUsd }));
      sent.push(threshold);
    }
  }
  return { status: "checked", month, spentUsd, budgetUsd, sent };
}

/** Pour les essais : oublie le dernier passage. */
export function resetBudgetAlert(): void {
  lastHour = null;
}
