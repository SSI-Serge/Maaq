import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import { draftSharedText, proposalSummary, supplierNotice } from "@/server/marketplace/introduction";
import { IntroductionOpen, type EligibleStorefront, type Introduction, type MatchStore, type ServiceRequest, type Suggestion } from "@/server/marketplace/match-store";
import { matchRequest, renderSuggestions, viewOf, type MatchOutcome } from "@/server/marketplace/matching";
import { buyerPreview, departementOf, SERVICE_CATEGORIES, servedDepartements } from "@/server/marketplace/model";
import type { BrainProposal, LlmClient } from "./types";

/**
 * Outils de coup_de_main, l'agent acheteur du marketplace silencieux : exprimer un besoin, chercher des vitrines,
 * en voir une, s'y intéresser (carte de validation : la seule voie vers une mise en relation), en écarter une,
 * couper les suggestions, suivre l'état. Le modèle choisit l'outil ; l'outil vérifie, borne et explique.
 */

export interface ToolDeps {
  store: MatchStore;
  llm: Pick<LlmClient, "complete">;
  userId: string;
  firstName: string;
  /** Code postal du profil : zone par défaut d'une demande qui n'en donne pas. */
  postcode: string | null;
  /** Jour civil de l'acheteur, AAAA-MM-JJ. */
  today: string;
  now: () => Date;
  /** Dépose un message dans le tchat vitrine du fournisseur (après validation de la carte). */
  notifySupplier: (supplierUserId: string, text: string) => Promise<void>;
}

export interface TurnCollector {
  calls: string[];
  proposals: BrainProposal[];
  /** Refus des contrôles objectifs et résultats de recherche, pour les évaluations. */
  problems: string[];
  outcomes: MatchOutcome[];
}

export function newCollector(): TurnCollector {
  return { calls: [], proposals: [], problems: [], outcomes: [] };
}

const CATEGORY_CODES = SERVICE_CATEGORIES.map((c) => c.code) as [string, ...string[]];
const POSTCODE = /^\d{5}$/;

export const REQUEST_STATUS_TEXT: Record<ServiceRequest["status"], string> = { proposed: "issue de votre agenda, en attente de votre réponse", open: "ouverte", suggested: "suggestions envoyées", closed: "close" };
export const SUGGESTION_STATUS_TEXT: Record<Suggestion["status"], string> = { shown: "proposée", interested: "intéressé(e), mise en relation demandée", dismissed: "écartée", muted: "catégorie coupée", expired: "expirée" };
export const INTRODUCTION_STATUS_TEXT: Record<Introduction["status"], string> = {
  requested: "demandée, en attente du fournisseur",
  accepted: "acceptée par le fournisseur",
  declined: "refusée par le fournisseur",
  question: "le fournisseur a posé une question",
  connected: "mise en relation faite",
  expired: "sans réponse, expirée",
};

/** Ce qui manque à une demande avant de chercher : seule la zone est indispensable, sauf service à distance. */
export function missingBeforeSearch(request: ServiceRequest): string[] {
  const missing: string[] = [];
  if (!request.postcode && !request.remoteOk) missing.push("la ville ou le code postal (ou préciser qu'un service à distance convient)");
  return missing;
}

export function describeRequest(r: ServiceRequest, categoryLabel: (code: string) => string): string {
  const dep = r.postcode ? departementOf(r.postcode) : null;
  return `[demande ${r.id}] « ${r.text} » — catégorie ${r.categoryCode ? categoryLabel(r.categoryCode) : "non précisée"}, zone ${dep ? `département ${dep}` : r.remoteOk ? "à distance" : "non précisée"}, quand : ${r.timingText ?? "non précisé"}, état ${REQUEST_STATUS_TEXT[r.status]}${r.notifyLater ? ", à prévenir si un fournisseur apparaît" : ""}${r.source === "agenda" && r.status === "proposed" ? " (oui → chercher ; non → clore_demande)" : ""}`;
}

export function coupDeMainTools(deps: ToolDeps, collector: TurnCollector): BetaRunnableTool[] {
  const { store, userId } = deps;
  const note = (name: string) => collector.calls.push(name);
  let labels: Map<string, string> | null = null;
  const categoryLabel = async () => {
    labels ??= new Map((await store.listCategories()).map((c) => [c.code, c.label]));
    return (code: string) => labels!.get(code) ?? code;
  };
  const refuse = (text: string) => {
    collector.problems.push(text);
    return `Refusé : ${text}`;
  };

  /** La demande visée, ou à défaut la plus récente encore ouverte. */
  async function requestOf(id: string | undefined): Promise<ServiceRequest | string> {
    if (id) {
      const found = await store.getRequest(userId, id);
      return found ?? refuse("demande introuvable.");
    }
    const latest = (await store.listRequests(userId)).find((r) => r.status !== "closed");
    return latest ?? refuse("aucune demande en cours : enregistrez d'abord le besoin (demander_service).");
  }

  async function activeSuggestion(id: string): Promise<{ suggestion: Suggestion; storefront: EligibleStorefront } | string> {
    const suggestion = await store.getSuggestion(userId, id);
    if (!suggestion) return refuse("suggestion introuvable.");
    const storefront = await store.getEligible(suggestion.storefrontId, deps.today);
    if (!storefront) return refuse("cette vitrine n'est plus disponible (dépubliée ou en pause).");
    return { suggestion, storefront };
  }

  const demander = betaZodTool({
    name: "demander_service",
    description:
      "Enregistre le besoin de la personne (ou complète une demande existante avec demande_id). Ne transmets que ce qu'elle a dit : catégorie si elle est évidente, code postal ou ville, moment souhaité. L'outil dit s'il manque quelque chose d'indispensable avant de chercher ; ne pose aucune autre question.",
    inputSchema: z.object({
      demande_id: z.string().uuid().optional().describe("Pour compléter une demande déjà enregistrée"),
      texte: z.string().min(1).max(500).optional().describe("Le besoin, avec les mots de la personne"),
      categorie: z.enum(CATEGORY_CODES).optional(),
      code_postal: z.string().regex(POSTCODE).optional(),
      a_distance: z.boolean().optional().describe("true si un service à distance convient à la personne"),
      quand: z.string().max(200).optional().describe("Moment souhaité, tel que dit : « samedi », « avant Noël »"),
    }),
    run: async (input) => {
      note("demander_service");
      const label = await categoryLabel();
      let request: ServiceRequest;
      if (input.demande_id) {
        const existing = await store.getRequest(userId, input.demande_id);
        if (!existing) return refuse("demande introuvable.");
        if (existing.status === "closed") return refuse("cette demande est close ; créez-en une nouvelle.");
        request = await store.updateRequest(userId, existing.id, {
          ...(input.texte !== undefined ? { text: input.texte } : {}),
          ...(input.categorie !== undefined ? { categoryCode: input.categorie } : {}),
          ...(input.code_postal !== undefined ? { postcode: input.code_postal } : {}),
          ...(input.a_distance !== undefined ? { remoteOk: input.a_distance } : {}),
          ...(input.quand !== undefined ? { timingText: input.quand } : {}),
        });
      } else {
        if (!input.texte) return refuse("le texte du besoin est indispensable pour une nouvelle demande.");
        // Sans code postal dans la demande, celui du profil sert de zone par défaut.
        const postcode = input.code_postal ?? (input.a_distance ? null : deps.postcode);
        request = await store.createRequest(userId, { text: input.texte, categoryCode: input.categorie ?? null, postcode, remoteOk: input.a_distance ?? false, timingText: input.quand ?? null });
      }
      const missing = missingBeforeSearch(request);
      const fromProfile = !input.code_postal && request.postcode && request.postcode === deps.postcode ? " Zone prise sur le profil (code postal des Réglages) : dites-le si la personne cherche ailleurs." : "";
      return `${describeRequest(request, label)}\n${missing.length ? `Avant de chercher, il manque : ${missing.join(" ; ")}. Demandez-le en une question courte.` : `Prête : appelez chercher.${fromProfile}`}`;
    },
  });

  const chercher = betaZodTool({
    name: "chercher",
    description:
      "Cherche des vitrines pour une demande enregistrée et montre au plus trois suggestions, avec la raison de chacune. Recopie le résultat tel quel (il ne promet rien que la vitrine ne dise). Sans résultat, dis-le honnêtement et proposez d'être prévenu si un fournisseur apparaît (prevenir_plus_tard).",
    inputSchema: z.object({ demande_id: z.string().uuid().optional().describe("Par défaut, la demande la plus récente") }),
    run: async ({ demande_id }) => {
      note("chercher");
      const request = await requestOf(demande_id);
      if (typeof request === "string") return request;
      if (request.status === "closed") return refuse("cette demande est close.");
      const missing = missingBeforeSearch(request);
      if (missing.length) return refuse(`avant de chercher, il manque ${missing.join(" ; ")} (demander_service avec demande_id).`);
      // Une demande issue de l'agenda ne se cherche que sur le oui de la personne : c'est cet appel.
      if (request.status === "proposed") await store.updateRequest(userId, request.id, { status: "open" });
      let outcome: MatchOutcome;
      try {
        outcome = await matchRequest({ store, llm: deps.llm, now: deps.now, today: deps.today }, request);
      } catch (error) {
        collector.problems.push(`recherche échouée : ${(error as Error).message}`);
        return "Échec : la recherche n'a pas abouti (service momentanément indisponible). Dites-le simplement et proposez de réessayer plus tard.";
      }
      collector.outcomes.push(outcome);
      if (outcome.suggestions.length === 0) {
        const why = outcome.candidates === 0 ? "aucune vitrine publiée dans cette catégorie" : outcome.eligible === 0 ? "aucune vitrine ne dessert cette zone (ni à distance), ou toutes ont déjà été proposées ou écartées" : "les vitrines trouvées ne correspondent pas assez au besoin";
        return `Aucun fournisseur à proposer pour l'instant : ${why}. N'inventez rien. Proposez à la personne d'être prévenue si un fournisseur apparaît (prevenir_plus_tard).`;
      }
      return `${outcome.suggestions.length} suggestion(s) pour la demande ${request.id}. Présentez-les telles quelles, puis demandez si l'une l'intéresse (interesse), ou s'il faut en écarter (ignorer) :\n\n${renderSuggestions(outcome.suggestions)}`;
    },
  });

  const prevenir = betaZodTool({
    name: "prevenir_plus_tard",
    description: "Marque une demande sans résultat pour que MAAQ prévienne la personne si une vitrine correspondante est publiée plus tard. Exige que les suggestions soient activées dans Réglages › Suggestions de services.",
    inputSchema: z.object({ demande_id: z.string().uuid().optional().describe("Par défaut, la demande la plus récente"), activer: z.boolean().describe("false pour ne plus être prévenu") }),
    run: async ({ demande_id, activer }) => {
      note("prevenir_plus_tard");
      const request = await requestOf(demande_id);
      if (typeof request === "string") return request;
      if (activer) {
        const prefs = await store.getPrefs(userId);
        if (!prefs.suggestionsOptIn) return refuse("les suggestions ne sont pas activées. Indiquez à la personne qu'elle peut les activer dans Réglages › Suggestions de services, puis redemander.");
      }
      await store.updateRequest(userId, request.id, { notifyLater: activer, ...(activer ? { status: "open" } : {}) });
      return activer ? "Noté : la personne sera prévenue dans ce tchat si une vitrine correspondante est publiée." : "Noté : la personne ne sera pas prévenue pour cette demande.";
    },
  });

  const voir = betaZodTool({
    name: "voir_vitrine",
    description: "Détail d'une vitrine suggérée, tel qu'un membre peut le voir : services, description, zone, disponibilité, tarif, langues, qualifications. Jamais le contact.",
    inputSchema: z.object({ suggestion_id: z.string().uuid() }),
    run: async ({ suggestion_id }) => {
      note("voir_vitrine");
      const found = await activeSuggestion(suggestion_id);
      if (typeof found === "string") return found;
      const preview = buyerPreview({ ...found.storefront, contactValue: null }, await store.listCategories());
      const buyerDep = (await store.listRequests(userId)).find((r) => r.id === found.suggestion.requestId)?.postcode;
      const dep = buyerDep ? departementOf(buyerDep) : null;
      const local = dep !== null && servedDepartements(found.storefront).includes(dep);
      return JSON.stringify({ ...preview, zone: local ? preview.area : `À distance (fournisseur à ${found.storefront.city ?? "ville non précisée"})`, disponibilite: preview.availability === "À convenir" ? "À convenir (non confirmée)" : preview.availability });
    },
  });

  const interesse = betaZodTool({
    name: "interesse",
    description:
      "La personne veut être mise en relation avec une vitrine suggérée. L'outil rédige ce qui serait envoyé au fournisseur (besoin, moment, zone approximative, prénom seulement) et l'affiche sur une carte à valider. Rien n'est envoyé avant validation de la carte : dites-le, sans considérer la mise en relation faite. Si la personne veut modifier le texte, rappelez l'outil avec precisions.",
    inputSchema: z.object({
      suggestion_id: z.string().uuid(),
      precisions: z.string().max(300).optional().describe("Précisions à ajouter, avec les mots de la personne"),
    }),
    run: async ({ suggestion_id, precisions }) => {
      note("interesse");
      const found = await activeSuggestion(suggestion_id);
      if (typeof found === "string") return found;
      const { suggestion, storefront } = found;
      if (suggestion.status === "dismissed" || suggestion.status === "expired") return refuse("cette suggestion a été écartée ou a expiré.");
      const request = suggestion.requestId ? await store.getRequest(userId, suggestion.requestId) : null;
      if (!request) return refuse("la demande d'origine est introuvable.");
      const introductions = await store.listIntroductions(userId);
      if (introductions.some((i) => i.storefrontId === storefront.id && ["requested", "question", "accepted"].includes(i.status))) return refuse("une mise en relation est déjà en cours avec ce fournisseur (voir statut).");

      const sharedText = draftSharedText({ firstName: deps.firstName, request, precisions: precisions ?? null });
      const name = storefront.displayName ?? "ce fournisseur";
      collector.proposals.push({
        summary: proposalSummary(name, sharedText),
        execute: async () => {
          let introduction: Introduction;
          try {
            introduction = await store.createIntroduction({ suggestionId: suggestion.id, buyerUserId: userId, storefrontId: storefront.id, sharedText, channel: "app" });
          } catch (error) {
            if (error instanceof IntroductionOpen) return;
            throw error;
          }
          await store.setSuggestionStatus(userId, suggestion.id, "interested");
          await deps.notifySupplier(storefront.userId, supplierNotice(introduction, storefront));
        },
      });
      return `Carte de validation affichée pour ${name}. Texte qui serait envoyé, mot pour mot :\n« ${sharedText} »\nDites à la personne de valider ou refuser la carte, ou de demander une modification. Rien n'est envoyé avant sa validation.`;
    },
  });

  const ignorer = betaZodTool({
    name: "ignorer",
    description: "Écarte une suggestion : cette vitrine ne sera pas reproposée à la personne avant 90 jours.",
    inputSchema: z.object({ suggestion_id: z.string().uuid() }),
    run: async ({ suggestion_id }) => {
      note("ignorer");
      const suggestion = await store.getSuggestion(userId, suggestion_id);
      if (!suggestion) return refuse("suggestion introuvable.");
      if (suggestion.status !== "shown") return refuse(`cette suggestion est déjà ${SUGGESTION_STATUS_TEXT[suggestion.status]}.`);
      await store.setSuggestionStatus(userId, suggestion.id, "dismissed");
      return "Écartée : cette vitrine ne sera pas reproposée avant 90 jours.";
    },
  });

  const couper = betaZodTool({
    name: "couper_suggestions",
    description: "Coupe les suggestions d'une catégorie (categorie) ou toutes (tout=true : désactive les suggestions proactives). reactiver=true fait l'inverse. Les demandes explicites restent possibles.",
    inputSchema: z.object({
      categorie: z.enum(CATEGORY_CODES).optional(),
      tout: z.boolean().optional(),
      reactiver: z.boolean().optional(),
    }),
    run: async ({ categorie, tout, reactiver }) => {
      note("couper_suggestions");
      const label = await categoryLabel();
      const prefs = await store.getPrefs(userId);
      if (tout) {
        if (reactiver) return "Les suggestions proactives se réactivent dans Réglages › Suggestions de services (consentement explicite) : indiquez-le à la personne.";
        await store.setPrefs(userId, { suggestionsOptIn: false });
        for (const r of await store.listRequests(userId, { status: "open" })) if (r.notifyLater) await store.updateRequest(userId, r.id, { notifyLater: false });
        return "Suggestions proactives désactivées. La personne peut toujours demander un service explicitement, et réactiver les suggestions dans Réglages › Suggestions de services.";
      }
      if (!categorie) return refuse("précisez une catégorie ou tout=true.");
      const muted = new Set(prefs.mutedCategories);
      if (reactiver) muted.delete(categorie);
      else muted.add(categorie);
      await store.setPrefs(userId, { mutedCategories: [...muted] });
      if (!reactiver) for (const s of await store.listSuggestions(userId, { status: ["shown"] })) {
        const sf = await store.getEligible(s.storefrontId, deps.today);
        if (sf?.categoryCode === categorie) await store.setSuggestionStatus(userId, s.id, "muted");
      }
      return `${reactiver ? "Réactivée" : "Coupée"} : ${label(categorie)}. Catégories coupées : ${[...muted].map(label).join(", ") || "aucune"}.`;
    },
  });

  const clore = betaZodTool({
    name: "clore_demande",
    description: "Clôt une demande : la personne n'en veut plus (par exemple « non » à une demande issue de son agenda). Rien ne sera plus cherché ni proposé pour elle.",
    inputSchema: z.object({ demande_id: z.string().uuid().optional().describe("Par défaut, la demande la plus récente") }),
    run: async ({ demande_id }) => {
      note("clore_demande");
      const request = await requestOf(demande_id);
      if (typeof request === "string") return request;
      await store.updateRequest(userId, request.id, { status: "closed", notifyLater: false, closedAt: deps.now().toISOString() });
      return "Demande close : je n'en reparlerai pas.";
    },
  });

  const statut = betaZodTool({
    name: "statut",
    description: "État des demandes, suggestions en cours et mises en relation de la personne.",
    inputSchema: z.object({}),
    run: async () => {
      note("statut");
      const label = await categoryLabel();
      const [requests, suggestions, introductions, prefs] = await Promise.all([store.listRequests(userId), store.listSuggestions(userId, { status: ["shown", "interested"] }), store.listIntroductions(userId), store.getPrefs(userId)]);
      const lines = [`Suggestions proactives : ${prefs.suggestionsOptIn ? "activées" : "non activées (Réglages › Suggestions de services)"}${prefs.mutedCategories.length ? ` ; catégories coupées : ${prefs.mutedCategories.map(label).join(", ")}` : ""}`];
      lines.push(requests.length ? "Demandes :" : "Aucune demande.");
      for (const r of requests.slice(0, 10)) lines.push(`- ${describeRequest(r, label)}`);
      if (suggestions.length) {
        lines.push("Suggestions en cours :");
        for (const s of suggestions) {
          const sf = await store.getEligible(s.storefrontId, deps.today);
          lines.push(`- ${sf?.displayName ?? "vitrine retirée"} : ${SUGGESTION_STATUS_TEXT[s.status]} [suggestion ${s.id}]`);
        }
      }
      if (introductions.length) {
        lines.push("Mises en relation :");
        for (const i of introductions) {
          const sf = await store.getEligible(i.storefrontId, deps.today);
          lines.push(`- ${sf?.displayName ?? "vitrine retirée"} : ${INTRODUCTION_STATUS_TEXT[i.status]} (demandée le ${i.requestedAt.slice(0, 10)})`);
        }
      }
      return lines.join("\n");
    },
  });

  return [demander, chercher, prevenir, voir, interesse, ignorer, couper, clore, statut];
}

export { viewOf };
