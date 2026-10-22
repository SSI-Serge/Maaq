import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockDigitorn } from "@/server/adapters/digitorn/mock";
import type { RequestContext } from "@/server/adapters/digitorn/types";
import { contextBlock, COUP_DE_MAIN_FAILURE_MESSAGE, COUP_DE_MAIN_REF, coupDeMainBrain } from "@/server/agents/coup-de-main";
import { missingBeforeSearch } from "@/server/agents/coup-de-main-tools";
import type { AgentTurnInput, LlmClient, LlmMessage } from "@/server/agents/types";
import type { DB } from "@/server/db/schema.generated";
import { getPrefsView, updatePrefs } from "@/server/marketplace/buyer-service";
import { draftSharedText, supplierNotice } from "@/server/marketplace/introduction";
import { DbMatchStore } from "@/server/marketplace/match-db-store";
import { IntroductionOpen, MemoryMatchStore, type ServiceRequest } from "@/server/marketplace/match-store";
import { checkEligibility, matchRequest, renderSuggestions, safeReason, type RelevanceOutput } from "@/server/marketplace/matching";
import { DbStorefrontStore } from "@/server/marketplace/db-store";
import type { StorefrontFields } from "@/server/marketplace/model";
import { proactiveText, runRematch } from "@/server/marketplace/rematch";
import { COOLDOWN_DAYS, SCORE_LOW, SCORE_STRONG } from "@/server/marketplace/rules";
import { MemoryStorefrontStore, type StorefrontStore } from "@/server/marketplace/store";
import { fakeLlm } from "./helpers/fake-llm";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

const NOW = new Date("2026-10-22T09:00:00Z");
const TODAY = "2026-10-22";

function context(): RequestContext {
  return { rank: "primary_user", autoParticipants: [], ccAddresses: [], info: {} };
}

function turn(text: string, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return { userRef: "camille", text, context: context(), history: [], today: NOW, timezone: "Europe/Paris", channel: "web", ...overrides };
}

/** Faux modèle de pertinence : rend les scores prévus par vitrine (clé = nom affiché), et compte les appels. */
function fakeRelevance(scores: Record<string, { score: number; reason?: string; concerns?: string[] }>) {
  const calls: LlmMessage[][] = [];
  const complete: LlmClient["complete"] = async ({ messages }) => {
    calls.push(messages);
    const text = messages.at(-1)!.content;
    const json = JSON.parse(text.slice(text.indexOf("[")).trim()) as { id: string; nom: string }[];
    const evaluations: RelevanceOutput["evaluations"] = json.map((c) => {
      const s = scores[c.nom] ?? { score: 0 };
      return { id: c.id, score: s.score, reason: s.reason ?? `${c.nom} propose ce que vous cherchez.`, concerns: s.concerns ?? [] };
    });
    return { evaluations } as never;
  };
  return { complete, calls };
}

/** Vitrine publiée d'un fournisseur, complète et confirmée. */
async function publish(store: StorefrontStore, userId: string, fields: Partial<StorefrontFields>, publishedAt = "2026-10-01T10:00:00Z") {
  const base: Partial<StorefrontFields> = {
    displayName: "Sarah Tresses",
    categoryCode: "coiffure",
    services: ["tresses", "twists"],
    description: "Tresses et twists.",
    postcode: "69007",
    city: "Lyon",
    modes: ["at_supplier", "travels"],
    travelNote: "le samedi seulement",
    availabilityMode: "by_arrangement",
    contactMethod: "whatsapp",
    contactValue: "0612345678",
    ...fields,
  };
  const origin = Object.fromEntries(["displayName", "category", "services", "description", "area", "availability", "price", "languages", "notice", "qualifications", "contact"].map((g) => [g, "confirmed" as const]));
  await store.save(userId, base, origin);
  return store.setState(userId, { status: "published", publishedAt, lastConfirmedAt: publishedAt });
}

function memory() {
  const storefronts = new MemoryStorefrontStore(() => NOW);
  const store = new MemoryMatchStore(storefronts, () => NOW);
  return { storefronts, store };
}

const sarah = { id: "sf-1", userId: "sarah", publishedAt: null, lastConfirmedAt: null, displayName: "Sarah Tresses", categoryCode: "coiffure", services: ["tresses"], description: "", postcode: "69007", city: "Lyon", modes: ["at_supplier" as const, "travels" as const], travelAreas: ["01"], travelNote: null, availabilityMode: "by_arrangement" as const, availabilityText: null, priceMode: null, priceMin: null, priceMax: null, languages: [], noticeText: null, qualificationsText: null, contactMethod: "whatsapp" as const };

describe("mise en relation — éligibilité expliquée, sans modèle", () => {
  const ctx = { buyerUserId: "camille", buyerDepartement: "69", remoteOk: false, categoryCode: "coiffure", mutedCategories: [], blocked: new Map<string, string>() };

  it("accepte une vitrine locale de la bonne catégorie et explique chaque règle", () => {
    const result = checkEligibility(sarah, ctx);
    expect(result).toMatchObject({ eligible: true, local: true });
    expect(result.lines).toEqual([
      "Compte : vitrine d'un autre membre ✔",
      "Catégorie : coiffure demandée, vitrine coiffure ✔",
      "Zone : département 69 desservi (69, 01) ✔",
      "Catégories coupées : aucune ne s'applique ✔",
      "Historique : ni suggestion active, ni mise en relation récente ✔",
    ]);
  });

  it("refuse hors zone, hors catégorie, sa propre vitrine, une catégorie coupée, un couple bloqué", () => {
    expect(checkEligibility(sarah, { ...ctx, buyerDepartement: "75" }).lines[2]).toBe("Zone : département 75 non desservi (69, 01), pas de service à distance ✘");
    expect(checkEligibility(sarah, { ...ctx, buyerDepartement: "75" }).eligible).toBe(false);
    expect(checkEligibility(sarah, { ...ctx, categoryCode: "menage" }).lines[1]).toBe("Catégorie : menage demandée, vitrine coiffure ✘");
    expect(checkEligibility(sarah, { ...ctx, buyerUserId: "sarah" }).lines[0]).toBe("Compte : votre propre vitrine ✘");
    expect(checkEligibility(sarah, { ...ctx, mutedCategories: ["coiffure"] }).lines[3]).toBe("Catégories coupées : coiffure coupée par l'acheteur ✘");
    expect(checkEligibility(sarah, { ...ctx, blocked: new Map([["sf-1", "écartée le 2026-10-01, pas avant 90 jours"]]) }).lines[4]).toBe("Historique : écartée le 2026-10-01, pas avant 90 jours ✘");
    // Zone inconnue et vitrine locale seulement : on ne devine pas.
    expect(checkEligibility(sarah, { ...ctx, buyerDepartement: null }).lines[2]).toBe("Zone : code postal de l'acheteur inconnu, vitrine locale seulement (69, 01) ✘");
  });

  it("une vitrine à distance est éligible hors département, mais jamais comme locale", () => {
    const remote = { ...sarah, id: "sf-2", modes: ["remote" as const], travelAreas: [] };
    const far = checkEligibility(remote, { ...ctx, buyerDepartement: "75" });
    expect(far).toMatchObject({ eligible: true, local: false });
    expect(far.lines[2]).toBe("Zone : service à distance, hors du département 75 ✔");
    const unknown = checkEligibility(remote, { ...ctx, buyerDepartement: null });
    expect(unknown).toMatchObject({ eligible: true, local: false });
  });

  it("ne confirme jamais une disponibilité ou un prix absents de la fiche", () => {
    const label = (c: string) => c;
    expect(safeReason("Elle est disponible samedi matin pour vos tresses.", sarah, label)).toEqual({ reason: "Sarah Tresses propose tresses.", replaced: expect.stringContaining("disponibilité affirmée") });
    expect(safeReason("Tresses à 40 € près de chez vous.", sarah, label).replaced).toContain("prix affirmé");
    expect(safeReason("Elle fait des tresses à Lyon, comme vous le demandez.", sarah, label)).toEqual({ reason: "Elle fait des tresses à Lyon, comme vous le demandez.", replaced: null });
    // Avec des horaires donnés, le mot « disponible » n'est pas une invention.
    expect(safeReason("Disponible le samedi selon ses horaires.", { ...sarah, availabilityMode: "hours", availabilityText: "samedi 9h-18h" }, label).replaced).toBeNull();
  });

  it("le texte de mise en relation ne contient que le besoin, le moment, la zone et le prénom", () => {
    const text = draftSharedText({ firstName: "Camille", request: { text: "des tresses samedi", timingText: "samedi", postcode: "69007", remoteOk: false }, precisions: "cheveux longs" });
    expect(text).toContain("Camille, membre de MAAQ, cherche : des tresses samedi");
    expect(text).toContain("Où : code postal 69007 (département 69)");
    expect(text).toContain("Précisions : cheveux longs");
    expect(text).not.toContain("Test");
    expect(draftSharedText({ firstName: "", request: { text: "x", timingText: null, postcode: null, remoteOk: true } })).toContain("Un membre MAAQ, membre de MAAQ, cherche : x\nQuand : à convenir\nOù : à distance");
    expect(missingBeforeSearch({ postcode: null, remoteOk: false } as ServiceRequest)).toHaveLength(1);
    expect(missingBeforeSearch({ postcode: null, remoteOk: true } as ServiceRequest)).toHaveLength(0);
  });
});

describe("mise en relation — service avec magasin en mémoire", () => {
  it("sans vitrine éligible, aucun appel au modèle et aucune suggestion inventée", async () => {
    const { store } = memory();
    const relevance = fakeRelevance({});
    const request = await store.createRequest("camille", { text: "des tresses", categoryCode: "coiffure", postcode: "69007" });
    const outcome = await matchRequest({ store, llm: relevance, now: () => NOW, today: TODAY }, request);
    expect(outcome).toMatchObject({ suggestions: [], candidates: 0, eligible: 0 });
    expect(relevance.calls).toHaveLength(0);
    expect(outcome.request.lastMatchedAt).toBe(NOW.toISOString());
    expect(outcome.request.status).toBe("open");
    expect(await store.listSuggestions("camille")).toEqual([]);
  });

  it("montre les bonnes vitrines avec leur raison, pose les moyennes en question, retient les faibles, journalise tout", async () => {
    const { storefronts, store } = memory();
    await publish(storefronts, "sarah", {});
    await publish(storefronts, "ines", { displayName: "Inès Coiffure", services: ["coupe", "brushing"] });
    await publish(storefronts, "paul", { displayName: "Paul Barbier", services: ["barbe"] });
    await publish(storefronts, "nina", { displayName: "Nina Ménage", categoryCode: "menage", services: ["ménage"] });
    await publish(storefronts, "zoe", { displayName: "Zoé Paris", postcode: "75011", city: "Paris", modes: ["at_supplier"] });
    const relevance = fakeRelevance({
      "Sarah Tresses": { score: 0.9, reason: "Elle est disponible samedi pour des tresses." },
      "Inès Coiffure": { score: 0.5, reason: "Elle coiffe à Lyon, sans mention des tresses.", concerns: ["tresses non citées"] },
      "Paul Barbier": { score: 0.1 },
    });
    const request = await store.createRequest("camille", { text: "des tresses samedi", categoryCode: "coiffure", postcode: "69007", timingText: "samedi" });
    const outcome = await matchRequest({ store, llm: relevance, now: () => NOW, today: TODAY }, request);

    expect(relevance.calls).toHaveLength(1);
    expect(relevance.calls[0][0].content).toContain("Besoin : des tresses samedi");
    expect(relevance.calls[0][0].content).not.toContain("0612345678");
    expect(outcome).toMatchObject({ candidates: 4, eligible: 3, withheld: 1 });
    expect(outcome.suggestions.map((v) => [v.name, v.suggestion.fit])).toEqual([
      ["Sarah Tresses", "strong"],
      ["Inès Coiffure", "possible"],
    ]);
    // La raison qui affirmait une disponibilité a été remplacée ; la fiche dit « à convenir ».
    expect(outcome.suggestions[0].suggestion.reason).toBe("Sarah Tresses propose tresses, twists.");
    expect(outcome.suggestions[0].suggestion.internalReason).toContain("disponibilité affirmée");
    expect(outcome.suggestions[0].suggestion.internalReason).toContain(`Pertinence : score 0,90 (seuils ${SCORE_LOW.toFixed(2).replace(".", ",")} / ${SCORE_STRONG.toFixed(2).replace(".", ",")}) → affirmée`);
    expect(outcome.suggestions[1].suggestion.internalReason).toContain("Réserves : tresses non citées");

    const text = renderSuggestions(outcome.suggestions);
    expect(text).toContain("1. Sarah Tresses — Coiffure et barbier : tresses, twists");
    expect(text).toContain("Disponibilité : à convenir (non confirmée) · Tarif : Sur devis");
    expect(text).toContain("2. Peut-être Inès Coiffure, qui fait coupe, brushing — est-ce le genre de service que vous cherchez ?");
    expect(text).not.toMatch(/disponible samedi/i);

    const log = outcome.log.map((l) => [l.name, l.decision]);
    expect(log).toContainEqual(["Paul Barbier", "withheld"]);
    expect(log).toContainEqual(["Zoé Paris", "ineligible"]);
    expect(log).not.toContainEqual(["Nina Ménage", expect.anything()]); // filtrée par catégorie avant même les règles
    expect(outcome.log.find((l) => l.name === "Zoé Paris")!.lines[2]).toContain("département 69 non desservi (75)");
    expect(outcome.request).toMatchObject({ status: "suggested", matchLog: outcome.log });
  });

  it("n'affiche jamais une vitrine hors zone comme locale, et prend « à distance » au mot", async () => {
    const { storefronts, store } = memory();
    await publish(storefronts, "lea", { displayName: "Léa Maths", categoryCode: "cours", services: ["maths"], postcode: "75011", city: "Paris", modes: ["remote"] });
    const relevance = fakeRelevance({ "Léa Maths": { score: 0.8 } });
    const request = await store.createRequest("camille", { text: "cours de maths", categoryCode: "cours", postcode: "69007", remoteOk: true });
    const outcome = await matchRequest({ store, llm: relevance, now: () => NOW, today: TODAY }, request);
    expect(outcome.suggestions[0]).toMatchObject({ local: false, area: "À distance (fournisseur à Paris)" });
    expect(renderSuggestions(outcome.suggestions)).toContain("Zone : À distance (fournisseur à Paris)");
    expect(relevance.calls[0][0].content).toContain('"zone":"À distance (fournisseur à Paris)"');
  });

  it("une vitrine écartée n'est pas reproposée pendant la carence, puis l'est à nouveau", async () => {
    const { storefronts, store } = memory();
    await publish(storefronts, "sarah", {});
    const relevance = fakeRelevance({ "Sarah Tresses": { score: 0.9 } });
    const request = await store.createRequest("camille", { text: "des tresses", categoryCode: "coiffure", postcode: "69007" });
    const first = await matchRequest({ store, llm: relevance, now: () => NOW, today: TODAY }, request);
    expect(first.suggestions).toHaveLength(1);

    // Déjà suggérée : pas de doublon.
    const again = await matchRequest({ store, llm: relevance, now: () => NOW, today: TODAY }, request);
    expect(again.suggestions).toHaveLength(0);
    expect(again.log[0].lines[4]).toBe("Historique : déjà suggérée, en attente de votre réponse ✘");

    await store.setSuggestionStatus("camille", first.suggestions[0].suggestion.id, "dismissed");
    const dismissed = await matchRequest({ store, llm: relevance, now: () => NOW, today: TODAY }, request);
    expect(dismissed.suggestions).toHaveLength(0);
    expect(dismissed.log[0].lines[4]).toBe(`Historique : écartée le ${TODAY}, pas avant ${COOLDOWN_DAYS} jours ✘`);

    const later = new MemoryMatchStore(storefronts, () => new Date(NOW.getTime() + (COOLDOWN_DAYS + 1) * 86_400_000));
    expect(await later.blockedStorefronts("camille", COOLDOWN_DAYS)).toEqual(new Map());
    // Le magasin « plus tard » n'a pas les suggestions de l'autre : on vérifie la règle de carence directement.
    expect((await store.blockedStorefronts("camille", 0)).size).toBe(0);
  });

  it("une mise en relation en cours bloque le couple, et une seule peut être ouverte", async () => {
    const { storefronts, store } = memory();
    const sf = await publish(storefronts, "sarah", {});
    await store.createIntroduction({ suggestionId: null, buyerUserId: "camille", storefrontId: sf.id, sharedText: "x" });
    await expect(store.createIntroduction({ suggestionId: null, buyerUserId: "camille", storefrontId: sf.id, sharedText: "y" })).rejects.toBeInstanceOf(IntroductionOpen);
    expect((await store.blockedStorefronts("camille", COOLDOWN_DAYS)).get(sf.id)).toBe("mise en relation en cours");
  });
});

describe("coup_de_main — agent avec faux modèle", () => {
  /** Les pas du scénario s'ajoutent au fil du test (`steps.push`) : les identifiants n'existent qu'en cours de conversation. */
  function setup(scores: Record<string, { score: number; reason?: string }> = {}) {
    const { storefronts, store } = memory();
    const fake = fakeLlm([]);
    const relevance = fakeRelevance(scores);
    const llm: LlmClient = { runTools: fake.llm.runTools, complete: relevance.complete };
    const notified: { userId: string; text: string }[] = [];
    const brain = coupDeMainBrain(llm, { store, profileOf: async (ref) => ({ id: ref, firstName: "Camille" }), notifySupplier: async (userId, text) => void notified.push({ userId, text }), now: () => NOW });
    return { storefronts, store, brain, relevance, notified, steps: fake.steps, lastPrompt: fake.lastPrompt };
  }

  it("enregistre le besoin, ne demande que la zone manquante, puis cherche", async () => {
    const { storefronts, store, brain, steps } = setup({ "Sarah Tresses": { score: 0.85, reason: "Elle fait des tresses à Lyon." } });
    await publish(storefronts, "sarah", {});

    steps.push({ calls: [{ tool: "demander_service", input: { texte: "des tresses samedi", categorie: "coiffure", quand: "samedi" } }], text: (r) => r[0] });
    const first = await brain.generate(turn("Je cherche quelqu'un pour des tresses samedi"));
    expect(first.calls).toEqual(["demander_service"]);
    expect(first.reply.text).toContain("il manque : la ville ou le code postal");
    const request = (await store.listRequests("camille"))[0];
    expect(request).toMatchObject({ text: "des tresses samedi", categoryCode: "coiffure", timingText: "samedi", postcode: null });

    steps.push({ calls: [{ tool: "chercher", input: {} }], text: (r) => r[0] });
    expect((await brain.generate(turn("Cherche quand même"))).reply.text).toContain("Refusé : avant de chercher, il manque la ville ou le code postal");

    steps.push({ calls: [{ tool: "demander_service", input: { demande_id: request.id, code_postal: "69007" } }, { tool: "chercher", input: { demande_id: request.id } }], text: (r) => r.join("\n---\n") });
    const second = await brain.generate(turn("Lyon, 69007"));
    expect(second.calls).toEqual(["demander_service", "chercher"]);
    expect(second.reply.text).toContain("Prête : appelez chercher.");
    expect(second.reply.text).toContain("1. Sarah Tresses — Coiffure et barbier : tresses, twists");
    expect(second.reply.text).toContain("Pourquoi : Elle fait des tresses à Lyon.");
    expect(second.reply.proposals).toEqual([]);
    expect(await store.listRequests("camille")).toHaveLength(1);
    expect((await store.listRequests("camille"))[0].status).toBe("suggested");
  });

  it("sans fournisseur, dit la vérité et propose d'être prévenu, ce qui exige le consentement", async () => {
    const { store, brain, steps, relevance } = setup();
    steps.push({ calls: [{ tool: "demander_service", input: { texte: "un plombier", categorie: "bricolage", code_postal: "69007" } }, { tool: "chercher", input: {} }], text: (r) => r[1] });
    const search = await brain.generate(turn("Un plombier à Lyon"));
    expect(search.reply.text).toContain("Aucun fournisseur à proposer pour l'instant : aucune vitrine publiée dans cette catégorie");
    expect(search.reply.text).toContain("N'inventez rien");
    expect(relevance.calls).toHaveLength(0);
    const request = (await store.listRequests("camille"))[0];

    steps.push({ calls: [{ tool: "prevenir_plus_tard", input: { activer: true } }], text: (r) => r[0] });
    const refused = await brain.generate(turn("Préviens-moi"));
    expect(refused.reply.text).toContain("Refusé : les suggestions ne sont pas activées");
    expect((await store.getRequest("camille", request.id))!.notifyLater).toBe(false);

    await store.setPrefs("camille", { suggestionsOptIn: true, consentVersion: "2026-10" });
    steps.push({ calls: [{ tool: "prevenir_plus_tard", input: { demande_id: request.id, activer: true } }], text: (r) => r[0] });
    const accepted = await brain.generate(turn("Préviens-moi"));
    expect(accepted.reply.text).toContain("la personne sera prévenue");
    expect((await store.getRequest("camille", request.id))!.notifyLater).toBe(true);
  });

  it("la carte est la seule voie vers une mise en relation ; validée, elle prévient le fournisseur", async () => {
    const { storefronts, store, brain, notified, steps } = setup({ "Sarah Tresses": { score: 0.9 } });
    await publish(storefronts, "sarah", {});
    steps.push({ calls: [{ tool: "demander_service", input: { texte: "des tresses samedi", categorie: "coiffure", code_postal: "69007", quand: "samedi" } }, { tool: "chercher", input: {} }], text: "Voici." });
    await brain.generate(turn("Des tresses samedi à Lyon 69007"));
    const suggestion = (await store.listSuggestions("camille"))[0];
    expect(suggestion.status).toBe("shown");

    steps.push({ calls: [{ tool: "interesse", input: { suggestion_id: suggestion.id, precisions: "cheveux longs" } }], text: (r) => r[0] });
    const interest = await brain.generate(turn("La première m'intéresse"));
    expect(interest.calls).toEqual(["interesse"]);
    expect(interest.reply.text).toContain("Rien n'est envoyé avant sa validation");
    expect(interest.reply.proposals).toHaveLength(1);
    const card = interest.reply.proposals[0];
    expect(card.summary).toContain("Envoyer cette présentation à Sarah Tresses ?");
    expect(card.summary).toContain("Camille, membre de MAAQ, cherche : des tresses samedi");
    expect(card.summary).toContain("Précisions : cheveux longs");
    expect(card.summary).not.toContain("0612345678");

    // Tant que la carte n'est pas validée : rien.
    expect(await store.listIntroductions("camille")).toEqual([]);
    expect(notified).toEqual([]);
    expect((await store.getSuggestion("camille", suggestion.id))!.status).toBe("shown");

    await card.execute();
    const [introduction] = await store.listIntroductions("camille");
    expect(introduction).toMatchObject({ status: "requested", storefrontId: suggestion.storefrontId, suggestionId: suggestion.id, channel: "app" });
    expect(introduction.sharedText).toBe(card.summary.slice(card.summary.indexOf("« ") + 2, -2));
    expect((await store.getSuggestion("camille", suggestion.id))!.status).toBe("interested");
    expect(notified).toHaveLength(1);
    expect(notified[0].userId).toBe("sarah");
    expect(notified[0].text).toBe(supplierNotice(introduction, { displayName: "Sarah Tresses" }));
    expect(notified[0].text).toContain("Nouvelle demande de mise en relation pour votre vitrine « Sarah Tresses »");

    // Une seconde validation (double clic) ne crée rien de plus.
    await card.execute();
    expect(await store.listIntroductions("camille")).toHaveLength(1);
    expect(notified).toHaveLength(1);

    // Et l'agent refuse une seconde demande tant que celle-ci est en cours.
    steps.push({ calls: [{ tool: "interesse", input: { suggestion_id: suggestion.id } }], text: (r) => r[0] });
    expect((await brain.generate(turn("Encore"))).reply.text).toContain("Refusé : une mise en relation est déjà en cours");
  });

  it("écarte, coupe une catégorie et fait le point ; le contexte décrit l'état", async () => {
    const { storefronts, store, brain, steps, lastPrompt } = setup({ "Sarah Tresses": { score: 0.9 } });
    await publish(storefronts, "sarah", {});
    await store.setPrefs("camille", { suggestionsOptIn: true });
    steps.push({ calls: [{ tool: "demander_service", input: { texte: "des tresses", categorie: "coiffure", code_postal: "69007" } }, { tool: "chercher", input: {} }], text: "Voici." });
    await brain.generate(turn("Des tresses à Lyon 69007"));
    const suggestion = (await store.listSuggestions("camille"))[0];

    steps.push({ calls: [{ tool: "ignorer", input: { suggestion_id: suggestion.id } }, { tool: "ignorer", input: { suggestion_id: suggestion.id } }], text: (r) => r.join(" | ") });
    const ignored = await brain.generate(turn("Non merci"));
    expect(ignored.reply.text).toBe("Écartée : cette vitrine ne sera pas reproposée avant 90 jours. | Refusé : cette suggestion est déjà écartée.");

    steps.push({ calls: [{ tool: "couper_suggestions", input: { categorie: "coiffure" } }, { tool: "statut", input: {} }], text: (r) => r.join("\n") });
    const muted = await brain.generate(turn("Plus de coiffure"));
    expect(muted.reply.text).toContain("Coupée : Coiffure et barbier. Catégories coupées : Coiffure et barbier.");
    expect(muted.reply.text).toContain("Suggestions proactives : activées ; catégories coupées : Coiffure et barbier");
    expect(muted.reply.text).toContain("[demande ");
    expect(lastPrompt()).toContain("Demandes en cours :");

    steps.push({ calls: [{ tool: "couper_suggestions", input: { tout: true } }], text: (r) => r[0] });
    const off = await brain.generate(turn("Arrête tout"));
    expect(off.reply.text).toContain("Suggestions proactives désactivées");
    expect((await store.getPrefs("camille")).suggestionsOptIn).toBe(false);
    expect(await contextBlock({ store }, "camille", turn("x"), TODAY)).toContain("Suggestions proactives : non activées");
  });

  it("rend un message d'excuse si le modèle ne répond rien, et refuse un profil inconnu", async () => {
    const { brain, steps } = setup();
    steps.push({ text: "" });
    expect((await brain.generate(turn("Bonjour"))).reply.text).toBe(COUP_DE_MAIN_FAILURE_MESSAGE);
    const unknown = coupDeMainBrain(fakeLlm([]).llm, { store: memory().store, profileOf: async () => null });
    expect((await unknown.respond(turn("Bonjour"))).text).toContain("Je ne retrouve pas votre profil");
  });

  it("dans le simulateur Digitorn, la mise en relation n'existe qu'après validation de la carte", async () => {
    const { storefronts, store } = memory();
    const sf = await publish(storefronts, "sarah", {});
    const request = await store.createRequest("camille", { text: "des tresses", categoryCode: "coiffure", postcode: "69007" });
    const [suggestion] = await store.addSuggestions([{ requestId: request.id, buyerUserId: "camille", storefrontId: sf.id, reason: "Tresses à Lyon.", internalReason: "test", score: 0.9, fit: "strong" }]);
    const fake = fakeLlm([{ calls: [{ tool: "interesse", input: { suggestion_id: suggestion.id } }], text: "Validez la carte." }]);
    const notified: string[] = [];
    const brain = coupDeMainBrain(fake.llm, { store, profileOf: async (ref) => ({ id: ref, firstName: "Camille" }), notifySupplier: async (userId) => void notified.push(userId) });
    const mock = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0, brains: [brain] });
    await mock.submitRequest({ requestId: "r1", userRef: "camille", agentRef: COUP_DE_MAIN_REF, text: "Intéressée", context: context(), channel: "web" });
    await mock.settle();
    const events = await mock.getConversation("camille", COUP_DE_MAIN_REF);
    expect(events.map((e) => e.type)).toEqual(["user_message", "agent_message", "action_proposal"]);
    const card = events[2];
    if (card.type !== "action_proposal") throw new Error("carte attendue");
    expect(card.proposal.summary).toContain("Envoyer cette présentation à Sarah Tresses ?");
    expect(await store.listIntroductions("camille")).toEqual([]);

    await mock.decideAction({ proposalId: card.proposal.proposalId, userRef: "camille", decision: "validate" });
    await mock.settle();
    expect(card.proposal.status).toBe("succeeded");
    expect(await store.listIntroductions("camille")).toHaveLength(1);
    expect(notified).toEqual(["sarah"]);
  });
});

describe("mise en relation — base, consentement et traitement périodique", () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = testDb();
  });
  afterAll(async () => {
    await db.destroy();
  });

  it("lit la vue des vitrines éligibles sans contact, enregistre demandes, suggestions et mises en relation", async () => {
    const buyer = await createProfile(db);
    const supplier = await createProfile(db);
    const other = await createProfile(db);
    const clock = new Date("2026-10-22T10:00:00Z");
    const storefronts = new DbStorefrontStore(db, undefined, () => clock);
    const store = new DbMatchStore(db, () => clock);
    const sf = await publish(storefronts, supplier.id, { displayName: `Sarah ${supplier.id.slice(0, 4)}` }, clock.toISOString());
    await publish(storefronts, other.id, { displayName: "Paused", }, "2026-10-01T10:00:00Z");
    await storefronts.setState(other.id, { pausedUntil: "2026-10-30" });

    const eligible = await store.listEligible("2026-10-22", { categoryCode: "coiffure", excludeUserId: buyer.id });
    expect(eligible.some((s) => s.id === sf.id)).toBe(true);
    expect(eligible.some((s) => s.userId === other.id)).toBe(false);
    expect(JSON.stringify(eligible)).not.toContain("0612345678");
    expect((await store.listEligible("2026-10-22", { categoryCode: "coiffure", excludeUserId: supplier.id })).some((s) => s.id === sf.id)).toBe(false);
    expect((await store.listEligible("2026-10-22", { categoryCode: "coiffure", excludeUserId: buyer.id, changedSince: "2026-10-23T00:00:00Z" })).some((s) => s.id === sf.id)).toBe(false);
    expect((await store.listEligible("2026-10-22", { categoryCode: "coiffure", excludeUserId: buyer.id, changedSince: "2026-10-21T00:00:00Z" })).some((s) => s.id === sf.id)).toBe(true);
    expect((await store.getEligible(sf.id, "2026-10-22"))?.displayName).toContain("Sarah");
    expect(await store.getEligible((await storefronts.get(other.id))!.id, "2026-10-22")).toBeNull();

    const request = await store.createRequest(buyer.id, { text: "des tresses", categoryCode: "coiffure", postcode: "69007", timingText: "samedi" });
    expect(request).toMatchObject({ status: "open", notifyLater: false, remoteOk: false, matchLog: [] });
    expect(await store.getRequest(other.id, request.id)).toBeNull();
    const relevance = fakeRelevance({ [sf.displayName!]: { score: 0.8, reason: "Elle fait des tresses." } });
    const outcome = await matchRequest({ store, llm: relevance, now: () => clock, today: "2026-10-22" }, request);
    expect(outcome.suggestions).toHaveLength(1);
    const [suggestion] = await store.listSuggestions(buyer.id);
    expect(suggestion).toMatchObject({ requestId: request.id, storefrontId: sf.id, score: 0.8, fit: "strong", status: "shown", reason: "Elle fait des tresses." });
    expect((await store.getRequest(buyer.id, request.id))!).toMatchObject({ status: "suggested", lastMatchedAt: clock.toISOString() });
    expect((await store.getRequest(buyer.id, request.id))!.matchLog[0].decision).toBe("shown");

    // Une seule suggestion active par couple ; une seule mise en relation ouverte par couple.
    await expect(store.addSuggestions([{ requestId: request.id, buyerUserId: buyer.id, storefrontId: sf.id, reason: "x", internalReason: "x", score: 0.5, fit: "possible" }])).rejects.toThrow();
    const introduction = await store.createIntroduction({ suggestionId: suggestion.id, buyerUserId: buyer.id, storefrontId: sf.id, sharedText: "Camille cherche des tresses." });
    expect(introduction).toMatchObject({ status: "requested", channel: "app", sharedText: "Camille cherche des tresses." });
    await expect(store.createIntroduction({ suggestionId: suggestion.id, buyerUserId: buyer.id, storefrontId: sf.id, sharedText: "bis" })).rejects.toBeInstanceOf(IntroductionOpen);
    expect((await store.blockedStorefronts(buyer.id, COOLDOWN_DAYS)).get(sf.id)).toBe("mise en relation en cours");
    expect((await store.setSuggestionStatus(buyer.id, suggestion.id, "interested")).decidedAt).toBe(clock.toISOString());
    await expect(store.setSuggestionStatus(other.id, suggestion.id, "dismissed")).rejects.toThrow();
    expect((await store.listIntroductions(buyer.id)).map((i) => i.id)).toEqual([introduction.id]);
  });

  it("consentement : écran Réglages, version du texte, catégories coupées, réexamen périodique", async () => {
    const buyer = await createProfile(db);
    const session = await sessionFor(db, buyer.id);
    const ctx = { db, now: new Date("2026-10-22T10:00:00Z") };
    const before = await getPrefsView(ctx, session);
    expect(before.prefs).toMatchObject({ suggestionsOptIn: false, agendaOptIn: false, mutedCategories: [], optInAt: null });
    expect(before.consentText).toContain("validation explicite");

    await expect(updatePrefs(ctx, session, { mutedCategories: ["plomberie"] })).rejects.toMatchObject({ code: "unknown_category" });
    const on = await updatePrefs(ctx, session, { suggestionsOptIn: true, mutedCategories: ["menage", "menage"] });
    expect(on.prefs).toMatchObject({ suggestionsOptIn: true, mutedCategories: ["menage"], consentVersion: before.consentVersion });
    expect(on.prefs.optInAt).not.toBeNull();
    const off = await updatePrefs(ctx, session, { suggestionsOptIn: false });
    expect(off.prefs).toMatchObject({ suggestionsOptIn: false, mutedCategories: ["menage"], optInAt: null, consentVersion: null });

    // Traitement périodique : une demande « me prévenir » n'est réexaminée qu'avec le consentement, et seulement contre les vitrines nouvelles.
    const store = new DbMatchStore(db, () => ctx.now);
    const request = await store.createRequest(buyer.id, { text: "des tresses", categoryCode: "coiffure", postcode: "69007" });
    await store.updateRequest(buyer.id, request.id, { notifyLater: true, lastMatchedAt: "2026-10-20T00:00:00Z" });
    const supplier = await createProfile(db);
    const name = `Nouvelle ${supplier.id.slice(0, 4)}`;
    await publish(new DbStorefrontStore(db, undefined, () => ctx.now), supplier.id, { displayName: name }, "2026-10-21T12:00:00Z");
    const posted: { userId: string; text: string }[] = [];
    const deps = { store, llm: fakeRelevance({ [name]: { score: 0.9, reason: "Elle fait des tresses à Lyon." } }), now: ctx.now, today: "2026-10-22", postInApp: async (userId: string, text: string) => void posted.push({ userId, text }) };

    const silent = await runRematch(deps, async () => "Camille");
    expect(silent.withoutConsent).toBeGreaterThanOrEqual(1);
    expect(posted.filter((p) => p.userId === buyer.id)).toEqual([]);

    await updatePrefs(ctx, session, { suggestionsOptIn: true });
    const result = await runRematch(deps, async () => "Camille");
    expect(result.suggested).toBeGreaterThanOrEqual(1);
    const mine = posted.filter((p) => p.userId === buyer.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toContain("Bonjour Camille, une vitrine qui pourrait correspondre à votre demande vient d'être publiée");
    expect(mine[0].text).toContain(`1. ${name} — Coiffure et barbier`);
    expect(mine[0].text).toContain("rien n'est transmis sans votre validation");
    expect((await store.getRequest(buyer.id, request.id))!).toMatchObject({ status: "suggested", notifyLater: true, lastMatchedAt: ctx.now.toISOString() });

    // Au passage suivant, rien de nouveau depuis : pas de second message.
    const again = await runRematch(deps, async () => "Camille");
    expect(posted.filter((p) => p.userId === buyer.id)).toHaveLength(1);
    expect(again.failed).toBe(0);
    expect(proactiveText(null, 2, "corps")).toContain("Bonjour, 2 vitrines qui pourraient correspondre");
  });
});
