import { readFileSync } from "node:fs";
import path from "node:path";
import type { OutingCategory, OutingMood } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { estimateCostUsd } from "../cost";
import { createModel, type AssistantModel, type ContentBlock, type ModelMessage } from "../model";
import type { IdeaDraft } from "./proposals";
import { offerHash } from "./proposals";

/**
 * Le sous-agent Sorties (US-115 RT1 à RT3, SG-3, SG-4). Il est lancé par le planificateur, pas dans le tchat. Il ne reçoit que les critères : catégories et thèmes, budget et
 * nombre de personnes, jour visé, ville de départ, ambiance. Jamais un prénom, une adresse, un âge exact, un titre de RDV ni le calendrier. Sa recherche passe par l'outil de
 * recherche web du modèle : c'est l'exception à D52 décidée par le PO (D64), soumise à l'avis du DPO et à la déclaration du sous-traitant avant le pilote. Les pages lues sont des
 * informations (SG-4) ; le code, lui, vérifie tout ce qui compte : prix dans le budget, liens issus des résultats de la recherche, nombre d'idées, offres déjà proposées.
 */

export interface SearchCategory {
  category: OutingCategory;
  label: string;
  themes: { key: string; label: string }[];
}

export interface SearchRequest {
  categories: SearchCategory[];
  budget: number;
  people: number;
  /** Jour visé « AAAA-MM-JJ » et son nom (« samedi »). */
  targetDate: string;
  weekday: string;
  place: string;
  mood: OutingMood;
  /** Aujourd'hui « AAAA-MM-JJ », pour que la date du relevé des prix soit celle d'aujourd'hui et non une date de mémoire. */
  today: string;
}

export interface SearchResult {
  ideas: IdeaDraft[];
  costUsd: number | null;
  searches: number;
}

const MOOD_LABEL: Record<OutingMood, string> = { calm: "calme", playful: "ludique", both: "calme ou ludique" };
export const MAX_IN_BUDGET = 6;
export const PER_THEME = 2;
export const MAX_NOVELTIES = 2;
const MAX_SEARCHES = 8;
/** Poursuites permises quand la recherche s'interrompt côté fournisseur (`pause_turn`). */
const MAX_CONTINUATIONS = 3;

const instructions = (): string => readFileSync(path.join(process.env.ASSISTANT_AGENT_DIR ?? path.join(process.cwd(), "agent"), "sorties-instructions.md"), "utf8");

let outingModelCache: AssistantModel | undefined;

/** Le modèle des Sorties : celui de l'assistant, avec le temps qu'il faut à une recherche web ; vide tant que l'assistant n'est pas ouvert. */
export function outingModel(): AssistantModel | null {
  const settings = env();
  if (settings.ASSISTANT_MODE !== "live") return null;
  outingModelCache ??= createModel({ provider: settings.ASSISTANT_PROVIDER, apiKey: settings.ANTHROPIC_API_KEY!, model: settings.ASSISTANT_MODEL, effort: "medium", timeoutMs: 150_000, maxTokens: 12_000 });
  return outingModelCache;
}

/** Ce que reçoit le modèle : uniquement les critères (SG-3). Contrôlé par les tests : ni prénom ni adresse n'y figurent. */
export function searchInput(request: SearchRequest): string {
  return `<criteres>${JSON.stringify({
    aujourdhui: request.today,
    jour_vise: `${request.weekday} ${request.targetDate}`,
    depart: request.place,
    budget_total_eur: request.budget,
    personnes: request.people,
    ambiance: MOOD_LABEL[request.mood],
    categories: request.categories.map((c) => ({ categorie: c.category, libelle: c.label, themes: c.themes.map((t) => ({ theme: t.key, libelle: t.label })) })),
  })}</criteres>`;
}

const textOf = (blocks: ContentBlock[]): string => blocks.map((b) => (b.type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");

/** Adresses des résultats de la recherche web : seules celles-là peuvent figurer dans une idée (RF4). */
export function resultUrls(blocks: ContentBlock[]): Set<string> {
  const urls = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "web_search_tool_result") continue;
    const content = (block as { content?: unknown }).content;
    if (Array.isArray(content)) for (const item of content as { url?: unknown }[]) if (typeof item?.url === "string") urls.add(normalizeUrl(item.url));
  }
  return urls;
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim();
  }
}

const str = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

interface RawIdea {
  categorie?: unknown;
  theme?: unknown;
  nom?: unknown;
  lieu?: unknown;
  description?: unknown;
  details?: unknown;
  url?: unknown;
  prix?: unknown;
  prix_estime?: unknown;
  calcul?: unknown;
  releve?: unknown;
  ouverture?: unknown;
}

/**
 * Transforme la réponse du modèle en idées enregistrables, en appliquant les règles : pas de prix, de lien ou d'horaire de mémoire (le lien doit venir d'un résultat de la recherche),
 * le prix total d'une idée « dans le budget » tient dans le budget, au plus 2 idées par thème et 6 en tout, 2 nouveautés au plus, aucune offre déjà proposée (RF2, RF3, RF4, RF8).
 * Ce qui ne respecte pas une règle est écarté, jamais corrigé.
 */
export function validateIdeas(text: string, request: SearchRequest, allowedUrls: Set<string>, excluded: Set<string>): IdeaDraft[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let data: { dans_le_budget?: unknown; nouveautes?: unknown };
  try {
    data = JSON.parse(text.slice(start, end + 1)) as typeof data;
  } catch {
    return [];
  }
  const chosen = new Map<OutingCategory, Set<string>>(request.categories.map((c) => [c.category, new Set(c.themes.map((t) => t.key))]));
  const seen = new Set<string>();
  const common = (raw: RawIdea): Omit<IdeaDraft, "section" | "category" | "themeKey" | "openedYear"> | null => {
    const name = str(raw.nom, 150);
    const place = str(raw.lieu, 200);
    const description = str(raw.description, 600);
    const url = str(raw.url, 1000);
    const price = typeof raw.prix === "number" && Number.isFinite(raw.prix) ? Math.round(raw.prix * 100) / 100 : NaN;
    if (!name || !place || !description || !url || !(price >= 0)) return null;
    if (!allowedUrls.has(normalizeUrl(url))) return null;
    const key = offerHash(name, place).toString("hex");
    if (excluded.has(key) || seen.has(key)) return null;
    seen.add(key);
    const estimated = raw.prix_estime === true;
    const checked = /^\d{4}-\d{2}-\d{2}$/.test(str(raw.releve, 10)) ? str(raw.releve, 10) : request.today;
    return { name, place, description, details: str(raw.details, 400) || null, url, priceEur: price, priceEstimated: estimated, priceBasis: estimated ? str(raw.calcul, 300) || null : null, checkedOn: checked };
  };

  const ideas: IdeaDraft[] = [];
  const perTheme = new Map<string, number>();
  for (const raw of (Array.isArray(data.dans_le_budget) ? data.dans_le_budget : []) as RawIdea[]) {
    if (ideas.length >= MAX_IN_BUDGET) break;
    const category = raw.categorie as OutingCategory;
    const theme = str(raw.theme, 40);
    if (!chosen.get(category)?.has(theme)) continue;
    const key = `${category}/${theme}`;
    if ((perTheme.get(key) ?? 0) >= PER_THEME) continue;
    const idea = common(raw);
    if (!idea || idea.priceEur > request.budget) continue;
    perTheme.set(key, (perTheme.get(key) ?? 0) + 1);
    ideas.push({ ...idea, section: "in_budget", category, themeKey: theme, openedYear: null });
  }
  let novelties = 0;
  for (const raw of (Array.isArray(data.nouveautes) ? data.nouveautes : []) as RawIdea[]) {
    if (novelties >= MAX_NOVELTIES) break;
    const idea = common(raw);
    if (!idea) continue;
    const year = typeof raw.ouverture === "number" && Number.isInteger(raw.ouverture) && raw.ouverture >= 1900 && raw.ouverture <= 2100 ? raw.ouverture : null;
    novelties += 1;
    ideas.push({ ...idea, section: "novelty", category: null, themeKey: null, openedYear: year });
  }
  return ideas;
}

/**
 * Lance la recherche et rend les idées retenues, ou aucune. Plusieurs recherches en parallèle sont faites par le modèle lui-même (outil de recherche du fournisseur) ; si le
 * fournisseur interrompt le tour (`pause_turn`), la recherche reprend, quelques fois au plus.
 */
export async function findIdeas(model: AssistantModel, request: SearchRequest, excluded: Set<string>): Promise<SearchResult> {
  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: searchInput(request) }] }];
  const urls = new Set<string>();
  let costUsd: number | null = 0;
  let searches = 0;
  let text = "";
  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    const answer = await model.send({ system: instructions(), tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }], messages });
    for (const url of resultUrls(answer.content)) urls.add(url);
    searches += answer.content.filter((b) => b.type === "server_tool_use").length;
    const cost = estimateCostUsd(model.id, answer.usage);
    costUsd = costUsd === null || cost === null ? null : costUsd + cost;
    text = textOf(answer.content) || text;
    if (answer.stopReason !== "pause_turn") break;
    messages.push({ role: "assistant", content: answer.content });
  }
  return { ideas: validateIdeas(text, request, urls, excluded), costUsd, searches };
}
