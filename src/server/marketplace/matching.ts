import { z } from "zod";
import type { LlmClient } from "@/server/agents/types";
import type { BlockedStorefronts, EligibleStorefront, MatchLogEntry, MatchStore, ServiceRequest, Suggestion, SuggestionFit, SuggestionInput } from "./match-store";
import { areaLabel, availabilityLabel, departementOf, priceLabel, servedDepartements, type ServiceCategory } from "./model";
import { COOLDOWN_DAYS, isStrong, isWithheld, MAX_CANDIDATES, MAX_SHOWN, SCORE_LOW, SCORE_STRONG } from "./rules";

/**
 * Mise en relation (marketplace silencieux, phase 2) : pour un besoin exprimé, trouver les vitrines éligibles
 * (règles déterministes, chacune expliquée), puis demander au modèle un score de pertinence et une raison en
 * langage courant pour chaque candidate, en un seul appel structuré. Rien n'est inventé : sans vitrine
 * éligible, pas d'appel au modèle ; une disponibilité « à convenir » reste « à convenir » ; une vitrine hors du
 * département n'est jamais présentée comme locale. Chaque décision est journalisée (US-11, US-14, US-17).
 */

export interface MatchDeps {
  store: MatchStore;
  llm: Pick<LlmClient, "complete">;
  now: () => Date;
  /** Jour civil de l'acheteur, AAAA-MM-JJ. */
  today: string;
}

/** Ce que les règles d'éligibilité savent d'un acheteur et de sa demande. */
export interface EligibilityContext {
  buyerUserId: string;
  buyerDepartement: string | null;
  remoteOk: boolean;
  categoryCode: string | null;
  mutedCategories: string[];
  blocked: BlockedStorefronts;
}

export interface EligibilityResult {
  eligible: boolean;
  /** Une ligne par règle, lisible par un opérateur. */
  lines: string[];
  /** La vitrine dessert le département de l'acheteur (sinon : service à distance). */
  local: boolean;
}

const OK = "✔";
const KO = "✘";

/** Règles d'éligibilité d'une vitrine pour une demande, avec l'explication de chacune. */
export function checkEligibility(sf: EligibleStorefront, ctx: EligibilityContext): EligibilityResult {
  const lines: string[] = [];
  let eligible = true;
  const fail = (line: string) => {
    lines.push(`${line} ${KO}`);
    eligible = false;
  };
  const pass = (line: string) => lines.push(`${line} ${OK}`);

  if (sf.userId === ctx.buyerUserId) fail("Compte : votre propre vitrine");
  else pass("Compte : vitrine d'un autre membre");

  if (ctx.categoryCode === null) pass("Catégorie : non précisée, toutes acceptées");
  else if (sf.categoryCode === ctx.categoryCode) pass(`Catégorie : ${ctx.categoryCode} demandée, vitrine ${sf.categoryCode}`);
  else fail(`Catégorie : ${ctx.categoryCode} demandée, vitrine ${sf.categoryCode ?? "sans catégorie"}`);

  const served = servedDepartements(sf);
  const remote = sf.modes.includes("remote");
  let local = false;
  if (ctx.buyerDepartement !== null && served.includes(ctx.buyerDepartement)) {
    local = true;
    pass(`Zone : département ${ctx.buyerDepartement} desservi (${served.join(", ")})`);
  } else if (remote && (ctx.buyerDepartement === null || ctx.remoteOk || served.length === 0)) {
    pass(`Zone : service à distance${ctx.buyerDepartement ? `, hors du département ${ctx.buyerDepartement}` : ", zone de l'acheteur non précisée"}`);
  } else if (remote) {
    pass(`Zone : service à distance, hors du département ${ctx.buyerDepartement}`);
  } else if (ctx.buyerDepartement === null) {
    fail(`Zone : code postal de l'acheteur inconnu, vitrine locale seulement (${served.join(", ") || "zone non précisée"})`);
  } else {
    fail(`Zone : département ${ctx.buyerDepartement} non desservi (${served.join(", ") || "zone non précisée"}), pas de service à distance`);
  }

  if (sf.categoryCode && ctx.mutedCategories.includes(sf.categoryCode)) fail(`Catégories coupées : ${sf.categoryCode} coupée par l'acheteur`);
  else pass("Catégories coupées : aucune ne s'applique");

  const reason = ctx.blocked.get(sf.id);
  if (reason) fail(`Historique : ${reason}`);
  else pass("Historique : ni suggestion active, ni mise en relation récente");

  return { eligible, lines, local };
}

// ---------------------------------------------------------------------------
// Pertinence : un appel structuré au modèle

const RELEVANCE_SYSTEM = `Tu évalues, pour MAAQ, si des vitrines de service correspondent au besoin d'un membre. Tu ne connais de chaque fournisseur que sa fiche, rien d'autre.

Pour chaque vitrine, rends :
- score : entre 0 et 1, la probabilité que ce fournisseur rende exactement le service recherché (0 = sans rapport, 1 = c'est précisément cela).
- reason : une phrase en français, adressée au membre (vouvoiement), qui dit pourquoi cette vitrine peut convenir, en citant le service concret de la fiche et la zone telle qu'indiquée.
- concerns : ce qui manque, doute ou ne colle pas (vide si rien).

Interdits absolus : affirmer une disponibilité, un créneau, un délai ou un prix qui ne sont pas écrits dans la fiche ; si la disponibilité est « À convenir », ne dis pas que la personne est disponible ; n'ajoute ni service, ni qualification, ni avis. Une vitrine marquée « à distance » n'est pas présentée comme proche. Texte brut, sans Markdown.`;

const relevanceSchema = z.object({
  evaluations: z.array(
    z.object({
      id: z.string().describe("Identifiant de la vitrine, recopié tel quel"),
      score: z.number().describe("Entre 0 et 1"),
      reason: z.string().describe("Une phrase adressée au membre"),
      concerns: z.array(z.string()),
    }),
  ),
});

export type RelevanceOutput = z.infer<typeof relevanceSchema>;

/** Fiche d'une vitrine telle que le modèle la lit : jamais le contact. */
export function candidateCard(sf: EligibleStorefront, categoryLabel: (code: string) => string, local: boolean) {
  return {
    id: sf.id,
    nom: sf.displayName ?? "Sans nom",
    categorie: sf.categoryCode ? categoryLabel(sf.categoryCode) : "non précisée",
    services: sf.services,
    description: sf.description ?? "",
    zone: local ? areaLabel(sf) : `À distance (fournisseur à ${sf.city ?? "ville non précisée"})`,
    disponibilite: availabilityLabel(sf),
    tarif: priceLabel(sf),
    delai: sf.noticeText,
    langues: sf.languages,
    qualifications: sf.qualificationsText,
  };
}

export function describeNeed(request: ServiceRequest, categoryLabel: (code: string) => string): string {
  const dep = request.postcode ? departementOf(request.postcode) : null;
  return [
    `Besoin : ${request.text}`,
    `Catégorie : ${request.categoryCode ? categoryLabel(request.categoryCode) : "non précisée"}`,
    `Zone de l'acheteur : ${dep ? `département ${dep}` : "non précisée"}${request.remoteOk ? " (service à distance accepté)" : ""}`,
    `Quand : ${request.timingText ?? "non précisé"}`,
  ].join("\n");
}

const AVAILABILITY_CLAIM = /\b(disponibles?|dispo|libres?|créneaux?|peut vous recevoir|vous recevoir d[èe]s|d[èe]s demain|d[èe]s ce)\b/i;
const PRICE_CLAIM = /\d+\s*(€|euros?)/i;

/**
 * La raison affichée ne doit rien promettre que la fiche ne dit pas : une disponibilité affirmée alors qu'elle
 * est « à convenir », ou un prix alors que la vitrine est « sur devis », est remplacée par une raison neutre.
 */
export function safeReason(reason: string, sf: EligibleStorefront, categoryLabel: (code: string) => string): { reason: string; replaced: string | null } {
  const text = reason.replace(/\s+/g, " ").trim();
  const fallback = `${sf.displayName ?? "Ce fournisseur"} propose ${sf.services.length ? sf.services.join(", ") : (sf.categoryCode ? categoryLabel(sf.categoryCode) : "ce service").toLowerCase()}.`;
  if (sf.availabilityMode !== "hours" && AVAILABILITY_CLAIM.test(text)) return { reason: fallback, replaced: "raison du modèle écartée : disponibilité affirmée alors qu'elle est à convenir" };
  if ((sf.priceMode === null || sf.priceMode === "quote") && PRICE_CLAIM.test(text)) return { reason: fallback, replaced: "raison du modèle écartée : prix affirmé alors que la vitrine est sur devis" };
  return { reason: text || fallback, replaced: null };
}

function clamp(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, Math.round(score * 100) / 100));
}

function frScore(score: number): string {
  return score.toFixed(2).replace(".", ",");
}

// ---------------------------------------------------------------------------
// Résultat

/** Suggestion enregistrée, avec ce qu'il faut pour l'afficher à l'acheteur. */
export interface SuggestionView {
  suggestion: Suggestion;
  storefront: EligibleStorefront;
  name: string;
  category: string;
  /** Zone telle qu'affichée : locale si le département est desservi, sinon explicitement à distance. */
  area: string;
  local: boolean;
  availability: string;
  price: string;
}

export interface MatchOutcome {
  request: ServiceRequest;
  suggestions: SuggestionView[];
  candidates: number;
  eligible: number;
  withheld: number;
  log: MatchLogEntry[];
}

export function viewOf(suggestion: Suggestion, sf: EligibleStorefront, local: boolean, categoryLabel: (code: string) => string): SuggestionView {
  return {
    suggestion,
    storefront: sf,
    name: sf.displayName ?? "Sans nom",
    category: sf.categoryCode ? categoryLabel(sf.categoryCode) : "Catégorie non précisée",
    area: local ? areaLabel(sf) : `À distance (fournisseur à ${sf.city ?? "ville non précisée"})`,
    local,
    availability: availabilityLabel(sf),
    price: priceLabel(sf),
  };
}

/** Texte d'une suggestion pour l'acheteur : nom, service, zone, disponibilité et tarif tels que la fiche les donne, puis la raison. */
export function renderSuggestion(view: SuggestionView, index: number): string {
  const { suggestion } = view;
  const services = view.storefront.services.length ? view.storefront.services.join(", ") : view.category.toLowerCase();
  const head = suggestion.fit === "strong" ? `${index}. ${view.name} — ${view.category} : ${services}` : `${index}. Peut-être ${view.name}, qui fait ${services} — est-ce le genre de service que vous cherchez ?`;
  return [head, `   Zone : ${view.area}`, `   Disponibilité : ${view.availability.toLowerCase() === "à convenir" ? "à convenir (non confirmée)" : view.availability} · Tarif : ${view.price}`, `   Pourquoi : ${suggestion.reason}`, `   [suggestion ${suggestion.id}]`].join("\n");
}

export function renderSuggestions(views: SuggestionView[]): string {
  return views.map((view, i) => renderSuggestion(view, i + 1)).join("\n\n");
}

// ---------------------------------------------------------------------------
// Le service

/**
 * Cherche des vitrines pour une demande, enregistre les suggestions retenues (au plus MAX_SHOWN) et le journal
 * complet sur la demande. `changedSince` restreint aux vitrines publiées ou reconfirmées depuis (traitement périodique).
 */
export async function matchRequest(deps: MatchDeps, request: ServiceRequest, options: { changedSince?: string | null } = {}): Promise<MatchOutcome> {
  const { store } = deps;
  const categories = await store.listCategories();
  const labels = new Map(categories.map((c: ServiceCategory) => [c.code, c.label]));
  const categoryLabel = (code: string) => labels.get(code) ?? code;

  const [candidates, prefs, blocked] = await Promise.all([
    store.listEligible(deps.today, { categoryCode: request.categoryCode, excludeUserId: request.userId, changedSince: options.changedSince ?? null }),
    store.getPrefs(request.userId),
    store.blockedStorefronts(request.userId, COOLDOWN_DAYS),
  ]);
  const ctx: EligibilityContext = {
    buyerUserId: request.userId,
    buyerDepartement: request.postcode ? departementOf(request.postcode) : null,
    remoteOk: request.remoteOk,
    categoryCode: request.categoryCode,
    mutedCategories: prefs.mutedCategories,
    blocked,
  };

  const log: MatchLogEntry[] = [];
  const eligible: { sf: EligibleStorefront; lines: string[]; local: boolean }[] = [];
  for (const sf of candidates) {
    const result = checkEligibility(sf, ctx);
    if (options.changedSince) result.lines.unshift(`Vitrine publiée ou reconfirmée depuis le ${options.changedSince.slice(0, 10)} ${OK}`);
    if (result.eligible) eligible.push({ sf, lines: result.lines, local: result.local });
    else log.push({ storefrontId: sf.id, name: sf.displayName ?? "Sans nom", lines: result.lines, decision: "ineligible" });
  }

  const now = deps.now().toISOString();
  const kept: { input: SuggestionInput; sf: EligibleStorefront; local: boolean }[] = [];
  let withheld = 0;

  // Sans vitrine éligible, rien n'est demandé au modèle : impossible d'inventer une correspondance.
  if (eligible.length > 0) {
    const shortlist = eligible.slice(0, MAX_CANDIDATES);
    for (const extra of eligible.slice(MAX_CANDIDATES)) log.push({ storefrontId: extra.sf.id, name: extra.sf.displayName ?? "Sans nom", lines: [...extra.lines, `Au-delà des ${MAX_CANDIDATES} candidates évaluées ${KO}`], decision: "withheld" });

    const output = await deps.llm.complete({
      system: RELEVANCE_SYSTEM,
      messages: [{ role: "user", content: `${describeNeed(request, categoryLabel)}\n\nVitrines (JSON) :\n${JSON.stringify(shortlist.map((c) => candidateCard(c.sf, categoryLabel, c.local)))}` }],
      schema: relevanceSchema,
    });
    const byId = new Map(output.evaluations.map((e) => [e.id, e]));

    const scored = shortlist
      .map((c) => {
        const evaluation = byId.get(c.sf.id);
        const score = evaluation ? clamp(evaluation.score) : 0;
        return { ...c, score, evaluation };
      })
      .sort((a, b) => b.score - a.score);

    for (const c of scored) {
      const lines = [...c.lines];
      if (!c.evaluation) {
        lines.push(`Pertinence : non évaluée par le modèle ${KO}`);
        log.push({ storefrontId: c.sf.id, name: c.sf.displayName ?? "Sans nom", lines, decision: "withheld" });
        withheld++;
        continue;
      }
      const fit: SuggestionFit = isStrong(c.score) ? "strong" : "possible";
      lines.push(`Pertinence : score ${frScore(c.score)} (seuils ${frScore(SCORE_LOW)} / ${frScore(SCORE_STRONG)}) → ${isWithheld(c.score) ? "retenue, non montrée" : fit === "strong" ? "affirmée" : "posée en question"}`);
      if (c.evaluation.concerns.length) lines.push(`Réserves : ${c.evaluation.concerns.join(" ; ")}`);
      if (isWithheld(c.score) || kept.length >= MAX_SHOWN) {
        if (!isWithheld(c.score)) lines.push(`Au-delà des ${MAX_SHOWN} suggestions montrées ${KO}`);
        log.push({ storefrontId: c.sf.id, name: c.sf.displayName ?? "Sans nom", lines, decision: "withheld" });
        withheld++;
        continue;
      }
      const { reason, replaced } = safeReason(c.evaluation.reason, c.sf, categoryLabel);
      if (replaced) lines.push(`${replaced} (« ${c.evaluation.reason.slice(0, 120)} »)`);
      log.push({ storefrontId: c.sf.id, name: c.sf.displayName ?? "Sans nom", lines, decision: "shown" });
      kept.push({ input: { requestId: request.id, buyerUserId: request.userId, storefrontId: c.sf.id, reason, internalReason: lines.join("\n"), score: c.score, fit }, sf: c.sf, local: c.local });
    }
  }

  const created = await store.addSuggestions(kept.map((k) => k.input));
  const views = created.map((suggestion, i) => viewOf(suggestion, kept[i].sf, kept[i].local, categoryLabel));
  const updated = await store.updateRequest(request.userId, request.id, { lastMatchedAt: now, matchLog: log, ...(views.length ? { status: "suggested" } : {}) });
  return { request: updated, suggestions: views, candidates: candidates.length, eligible: eligible.length, withheld, log };
}
