import { describe, expect, it } from "vitest";
import { DevPlaces, MemoryDirectory } from "@/server/adapters/places/dev";
import { GooglePlaces, PLACES_FIELD_MASK, textSearchBody, toPlace as googlePlace } from "@/server/adapters/places/google";
import { GoogleThenSirene } from "@/server/adapters/places";
import { NAF_BY_CATEGORY, SireneDirectory, sireneUrl, toPlace as sirenePlace } from "@/server/adapters/places/sirene";
import { NoDirectory, type ExternalPlace } from "@/server/adapters/places/types";
import { coupDeMainBrain } from "@/server/agents/coup-de-main";
import type { AgentTurnInput, LlmClient, LlmMessage } from "@/server/agents/types";
import { renderExternal, searchExternal, shouldComplement } from "@/server/marketplace/external";
import { MemoryMatchStore } from "@/server/marketplace/match-store";
import type { RelevanceOutput } from "@/server/marketplace/matching";
import { SERVICE_CATEGORIES, type StorefrontFields } from "@/server/marketplace/model";
import { MemoryStorefrontStore, type StorefrontStore } from "@/server/marketplace/store";
import { fakeLlm } from "./helpers/fake-llm";

const NOW = new Date("2026-10-22T09:00:00Z");

const SALON: ExternalPlace = { id: "g1", name: "Salon Belle Boucle", rating: 4.6, reviewCount: 128, locality: "Lyon", url: "https://maps.google.com/?cid=1", source: "google" };
const BARBER: ExternalPlace = { id: "g2", name: "Barber du 7e", rating: 4.2, reviewCount: 41, locality: "Lyon", url: null, source: "google" };
const THIRD: ExternalPlace = { id: "g3", name: "Coiff' Express", rating: null, reviewCount: null, locality: "Lyon", url: null, source: "google" };

function fakeRelevance(scores: Record<string, number>) {
  const calls: LlmMessage[][] = [];
  const complete: LlmClient["complete"] = async ({ messages }) => {
    calls.push(messages);
    const text = messages.at(-1)!.content;
    const json = JSON.parse(text.slice(text.indexOf("[")).trim()) as { id: string; nom: string }[];
    const evaluations: RelevanceOutput["evaluations"] = json.map((c) => ({ id: c.id, score: scores[c.nom] ?? 0, reason: `${c.nom} fait des tresses.`, concerns: [] }));
    return { evaluations } as never;
  };
  return { complete, calls };
}

async function publish(store: StorefrontStore, userId: string, fields: Partial<StorefrontFields> = {}) {
  const groups = ["displayName", "category", "services", "description", "area", "availability", "price", "languages", "notice", "qualifications", "contact"];
  await store.save(userId, { displayName: "Sarah Tresses", categoryCode: "coiffure", services: ["tresses"], description: "Tresses.", postcode: "69007", city: "Lyon", modes: ["at_supplier"], availabilityMode: "by_arrangement", contactMethod: "whatsapp", contactValue: "0612345678", ...fields }, Object.fromEntries(groups.map((g) => [g, "confirmed" as const])));
  return store.setState(userId, { status: "published", publishedAt: "2026-10-01T10:00:00Z", lastConfirmedAt: "2026-10-01T10:00:00Z" });
}

function turn(text: string): AgentTurnInput {
  return { userRef: "camille", text, context: { rank: "primary_user", autoParticipants: [], ccAddresses: [], info: {} }, history: [], today: NOW, timezone: "Europe/Paris", channel: "web" };
}

const label = (code: string) => SERVICE_CATEGORIES.find((c) => c.code === code)?.label ?? code;

describe("annuaire externe — adaptateurs, sans réseau", () => {
  it("Google Places : requête réduite à la catégorie et au code postal, masque de champs minimal, fiche mappée", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ places: [{ id: "p1", displayName: { text: "Salon Belle Boucle" }, formattedAddress: "12 rue X, 69007 Lyon, France", addressComponents: [{ longText: "Lyon", types: ["locality"] }], rating: 4.6, userRatingCount: 128, googleMapsUri: "https://maps.google.com/?cid=1", businessStatus: "OPERATIONAL" }, { id: "p2", displayName: { text: "Fermé" }, businessStatus: "CLOSED_PERMANENTLY" }, { id: "p3" }] }), { status: 200 });
    }) as typeof fetch;
    const google = new GooglePlaces({ apiKey: "k", fetch: fetchFn });
    const found = await google.search({ categoryCode: "coiffure", categoryLabel: "Coiffure et barbier", postcode: "69007", limit: 3 });
    expect(found).toEqual([{ id: "p1", name: "Salon Belle Boucle", rating: 4.6, reviewCount: 128, locality: "Lyon", url: "https://maps.google.com/?cid=1", source: "google" }]);
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("k");
    expect(headers["X-Goog-FieldMask"]).toBe(PLACES_FIELD_MASK);
    expect(PLACES_FIELD_MASK).not.toContain("reviews");
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ textQuery: "Coiffure et barbier 69007", languageCode: "fr", regionCode: "FR", pageSize: 3 });
    expect(textSearchBody({ categoryCode: "x", categoryLabel: "Ménage", postcode: "75011", limit: 50 }).pageSize).toBe(10);
    expect(googlePlace({ id: "p", displayName: { text: "Sans adresse" }, formattedAddress: "Rue Y, 69001 Lyon, France" })).toMatchObject({ locality: "69001 Lyon", rating: null });
  });

  it("Sirene : codes NAF par catégorie, URL de recherche, établissements actifs seulement, repli derrière Google", async () => {
    expect(NAF_BY_CATEGORY.coiffure).toEqual(["96.02A"]);
    expect(sireneUrl("96.02A", "69007", 3)).toBe("https://recherche-entreprises.api.gouv.fr/search?activite_principale=96.02A&code_postal=69007&etat_administratif=A&per_page=3&page=1");
    expect(sirenePlace({ siren: "123456789", nom_complet: "SALON DUPONT", siege: { libelle_commune: "LYON 7EME" } })).toEqual({ id: "sirene:123456789", name: "SALON DUPONT", rating: null, reviewCount: null, locality: "LYON 7EME", url: "https://annuaire-entreprises.data.gouv.fr/entreprise/123456789", source: "sirene" });
    expect(sirenePlace({ siren: "1", nom_complet: "Fermé", etat_administratif: "C" })).toBeNull();

    const urls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ results: [{ siren: "111", nom_complet: "A" }, { siren: "111", nom_complet: "A bis" }, { siren: "222", nom_complet: "B" }] }), { status: 200 });
    }) as typeof fetch;
    const sirene = new SireneDirectory({ fetch: fetchFn });
    expect((await sirene.search({ categoryCode: "coiffure", categoryLabel: "Coiffure", postcode: "69007", limit: 5 })).map((p) => p.id)).toEqual(["sirene:111", "sirene:222"]);
    expect(await sirene.search({ categoryCode: "autre", categoryLabel: "Autre", postcode: "69007", limit: 5 })).toEqual([]);
    expect(urls).toHaveLength(1);

    const failing = new MemoryDirectory("google", []);
    failing.search = async () => {
      throw new Error("quota");
    };
    const combined = new GoogleThenSirene(failing, new MemoryDirectory("sirene", [{ ...SALON, id: "s1", source: "sirene", rating: null, reviewCount: null }]));
    expect((await combined.search({ categoryCode: "coiffure", categoryLabel: "Coiffure", postcode: "69007", limit: 3 }))[0].source).toBe("sirene");
  });
});

describe("annuaire externe — dans la recherche de coup_de_main", () => {
  function setup(directory: Parameters<typeof coupDeMainBrain>[1]["directory"], scores: Record<string, number> = {}) {
    const storefronts = new MemoryStorefrontStore(() => NOW);
    const store = new MemoryMatchStore(storefronts, () => NOW);
    const fake = fakeLlm([]);
    const relevance = fakeRelevance(scores);
    const brain = coupDeMainBrain({ runTools: fake.llm.runTools, complete: relevance.complete }, { store, profileOf: async (ref) => ({ id: ref, firstName: "Camille", postcode: "69007" }), now: () => NOW, directory });
    return { storefronts, store, brain, steps: fake.steps, relevance };
  }

  it("ne complète que lorsqu'il manque des vitrines, avec une catégorie et un code postal", () => {
    expect(shouldComplement({ categoryCode: "coiffure", postcode: "69007" }, 0)).toBe(true);
    expect(shouldComplement({ categoryCode: "coiffure", postcode: "69007" }, 2)).toBe(true);
    expect(shouldComplement({ categoryCode: "coiffure", postcode: "69007" }, 3)).toBe(false);
    expect(shouldComplement({ categoryCode: null, postcode: "69007" }, 0)).toBe(false);
    expect(shouldComplement({ categoryCode: "coiffure", postcode: null }, 0)).toBe(false);
  });

  it("sans annuaire, aucun bloc ; avec, un bloc à part après les vitrines, limité au complément, sans texte de demande", async () => {
    const none = setup(null);
    none.steps.push({ calls: [{ tool: "demander_service", input: { texte: "des tresses pour le mariage de ma sœur", categorie: "coiffure" } }, { tool: "chercher", input: {} }], text: (r) => r[1] });
    const withoutDirectory = await none.brain.generate(turn("Des tresses"));
    expect(withoutDirectory.reply.text).toContain("Aucune vitrine de membre à proposer");
    expect(withoutDirectory.reply.text).not.toContain("Hors MAAQ");
    expect(withoutDirectory.external).toEqual([]);
    expect(await searchExternal(new NoDirectory(), { categoryCode: "coiffure", postcode: "69007" }, label, 0)).toBeNull();

    const directory = new MemoryDirectory("google", [SALON, BARBER, THIRD]);
    const { storefronts, store, brain, steps } = setup(directory, { "Sarah Tresses": 0.9 });
    await publish(storefronts, "sarah");
    steps.push({ calls: [{ tool: "demander_service", input: { texte: "des tresses pour le mariage de ma sœur", categorie: "coiffure" } }, { tool: "chercher", input: {} }], text: (r) => r[1] });
    const reply = await brain.generate(turn("Des tresses pour le mariage de ma sœur"));
    const text = reply.reply.text;
    expect(text.indexOf("1. Sarah Tresses")).toBeGreaterThan(-1);
    expect(text.indexOf("Hors MAAQ, trouvés sur Google Maps :")).toBeGreaterThan(text.indexOf("1. Sarah Tresses"));
    expect(text).toContain("— Salon Belle Boucle · 4,6/5 (128 avis) · Lyon · https://maps.google.com/?cid=1");
    expect(text).toContain("— Barber du 7e · 4,2/5 (41 avis) · Lyon");
    // Une vitrine de membre + deux externes = trois lignes au plus : le troisième établissement n'apparaît pas.
    expect(text).not.toContain("Coiff' Express");
    expect(text).toContain("contactez-les directement, MAAQ ne peut pas faire de mise en relation");
    expect(reply.external[0].places).toHaveLength(2);
    expect(directory.queries).toEqual([{ categoryCode: "coiffure", categoryLabel: "Coiffure et barbier", postcode: "69007", limit: 2 }]);
    expect(JSON.stringify(directory.queries)).not.toContain("mariage");
    // Les externes ne créent ni suggestion ni carte.
    expect(await store.listSuggestions("camille")).toHaveLength(1);
    expect(reply.reply.proposals).toEqual([]);
  });

  it("trois vitrines de membres : l'annuaire n'est pas interrogé ; une panne d'annuaire n'empêche pas la réponse", async () => {
    const directory = new MemoryDirectory("google", [SALON]);
    const full = setup(directory, { "Sarah Tresses": 0.9, "Inès Coiffure": 0.9, "Paul Barbier": 0.9 });
    await publish(full.storefronts, "sarah");
    await publish(full.storefronts, "ines", { displayName: "Inès Coiffure" });
    await publish(full.storefronts, "paul", { displayName: "Paul Barbier" });
    full.steps.push({ calls: [{ tool: "demander_service", input: { texte: "des tresses", categorie: "coiffure" } }, { tool: "chercher", input: {} }], text: (r) => r[1] });
    const reply = await full.brain.generate(turn("Des tresses"));
    expect(reply.reply.text).not.toContain("Hors MAAQ");
    expect(directory.queries).toEqual([]);

    const broken = new MemoryDirectory("google", [SALON]);
    broken.search = async () => {
      throw new Error("503");
    };
    const failing = setup(broken);
    failing.steps.push({ calls: [{ tool: "demander_service", input: { texte: "des tresses", categorie: "coiffure" } }, { tool: "chercher", input: {} }], text: (r) => r[1] });
    const degraded = await failing.brain.generate(turn("Des tresses"));
    expect(degraded.reply.text).toContain("Aucune vitrine de membre à proposer");
    expect(degraded.problems).toEqual(["annuaire externe indisponible : 503"]);
  });

  it("annuaire de démonstration : des noms clairement fictifs, et le rendu sans avis pour Sirene", async () => {
    const dev = new DevPlaces();
    const block = await searchExternal(dev, { categoryCode: "menage", postcode: "75011" }, label, 1);
    expect(block!.places.map((p) => p.name)).toEqual(["Démo Ménage et repassage du centre", "Démo Ménage et repassage de quartier"]);
    expect(renderExternal({ source: "sirene", places: [{ id: "s", name: "SALON DUPONT", rating: null, reviewCount: null, locality: "LYON 7EME", url: null, source: "sirene" }] })).toContain("Hors MAAQ, inscrits au registre des entreprises (Sirene), sans avis :\n— SALON DUPONT · sans avis · LYON 7EME");
  });
});
