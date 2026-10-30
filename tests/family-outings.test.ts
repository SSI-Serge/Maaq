import { randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { STATUS_CODE, TYPE_CODE } from "@/server/assistant/calendar";
import { addChild } from "@/server/assistant/family";
import { seal } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import type { AssistantModel, ContentBlock, ModelRequest } from "@/server/assistant/model";
import { availableCategories, getCriteria, looksLikeAddress, saveCriteria, type CriteriaInput } from "@/server/assistant/outings/criteria";
import { matchesPreferences, NOTICE_TEXT, periodStart, pickTargetDay, runOutings, sendOutingNotices } from "@/server/assistant/outings/planner";
import { asProfile } from "@/server/assistant/outings/profile";
import { addIdeaToCalendar, createProposal, dismissIdea, dismissProposal, getProposal, homeCard, ideaForm, offerHash, restoreProposal, visibilityWarning, type IdeaDraft } from "@/server/assistant/outings/proposals";
import { findIdeas, normalizeUrl, searchInput, validateIdeas, type SearchRequest } from "@/server/assistant/outings/search";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { saveSubscription } from "@/server/push/service";
import { createGuest, createProfile, messagesTo, sessionFor, testDb } from "./helpers/fixtures";

process.env.OUTINGS_MODE = "live";
process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "cle-de-test";
process.env.VAPID_PUBLIC_KEY = "BPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTe";
process.env.VAPID_PRIVATE_KEY = "PrivateKeyDeTestPrivateKeyDeTestPrivateKeyDeTe";
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
const send = vi.mocked(webpush.sendNotification);

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
});

const TZ = "Europe/Paris";
const MONDAY = "2054-11-02T10:00:00Z"; // 11 h à Paris
const at = (iso = MONDAY): Ctx => ({ get db() { return db; }, now: new Date(iso) }) as Ctx;
const TODAY = "2054-11-02";

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

const fcm = () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });

/** Foyer : Camille (utilisateur principal, avec téléphone), Julien (invité 1), Élodie (invitée secondaire) et deux enfants dont la naissance est donnée. */
async function family(options: { children?: { born: string | null }[]; julien?: boolean } = {}) {
  const camille = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: TZ }).where("id", "=", camille.accountId!).execute();
  await db.updateTable("users").set({ first_name: "Camille" }).where("id", "=", camille.id).execute();
  const julien = options.julien === false ? null : await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const camilleSession = await sessionFor(db, camille.id);
  await db.insertInto("devices").values({ id: camilleSession.device.id, user_id: camille.id, device_type: "android" }).execute();
  await saveSubscription(at(), camilleSession, fcm());
  const julienSession = julien ? await sessionFor(db, julien.id) : null;
  const elodieSession = await sessionFor(db, elodie.id);
  const kids = [];
  for (const [index, kid] of (options.children ?? [{ born: "2050-05" }, { born: "2047-09" }]).entries()) {
    const child = await addChild(at(), camilleSession, { firstName: `Petit${index}`, birth: kid.born });
    kids.push(child.id);
  }
  send.mockClear();
  const camilleMember = (await db.selectFrom("family_members").select("id").where("user_id", "=", camille.id).executeTakeFirstOrThrow()).id;
  return { accountId: camille.accountId!, camille, julien, elodie, camilleSession, julienSession, elodieSession, kids, camilleMember };
}
type Family = Awaited<ReturnType<typeof family>>;

const NATURE_FOODIE: CriteriaInput = { enabled: true, selected: { self: ["nature", "foodie"] }, budget: 80, people: 2, place: "Lyon", mood: "both", days: ["weekend"], frequency: "monthly" };

// ---------------------------------------------------------------------------------------------------------------------------
describe("critères (US-114)", () => {
  it("CA 2.1 : désactivés par défaut ; CA 1.1 : propres à chaque parent, l'autre ne les voit pas", async () => {
    const f = await family();
    expect(await getCriteria(at(), f.camilleSession)).toMatchObject({ enabled: false, selected: {}, budget: null, place: "", mood: "both", days: ["weekend"], frequency: "monthly", open: true });
    await saveCriteria(at(), f.camilleSession, NATURE_FOODIE);
    const julien = await getCriteria(at(), f.julienSession!);
    expect(julien).toMatchObject({ enabled: false, selected: {}, budget: null, place: "" });
    expect(julien.otherParent).toBe("Camille");
    expect((await getCriteria(at(), f.camilleSession)).selected).toEqual({ self: ["nature", "foodie"] });
  });

  it("RF2 : les quatre catégories et leurs thèmes ; au moins un thème par catégorie choisie", async () => {
    const open = await family({ children: [{ born: null }] }); // sans date de naissance, toutes les catégories sont proposées (RF3)
    const view = await getCriteria(at(), open.camilleSession);
    expect(view.categories.map((c) => c.category)).toEqual(["self", "couple", "kids", "teens"]);
    expect(view.categories.find((c) => c.category === "self")!.themes.map((t) => t.label)).toEqual(["Culture", "Bien-être", "Nature", "Gourmand", "Créatif", "Sport", "Spectacle", "Flânerie", "Entre amis"]);
    expect(view.categories.find((c) => c.category === "teens")!.themes).toHaveLength(10);
  });

  it("CA 3.1 : sans enfant de 11 à 17 ans, la catégorie ados n'est pas proposée ; sans date de naissance, elle l'est", async () => {
    const young = await family({ children: [{ born: "2050-05" }, { born: "2047-09" }] }); // 4 ans et 7 ans en 2054
    expect([...(await availableCategories(at(), young.accountId))].sort()).toEqual(["couple", "kids", "self"]);
    expect((await getCriteria(at(), young.camilleSession)).categories.map((c) => c.category)).not.toContain("teens");
    expect((await failure(saveCriteria(at(), young.camilleSession, { ...NATURE_FOODIE, selected: { teens: ["sport"] } }))).code).toBe("invalid_category");
    const unknown = await family({ children: [{ born: null }] });
    expect([...(await availableCategories(at(), unknown.accountId))].sort()).toEqual(["couple", "kids", "self", "teens"]);
    const teen = await family({ children: [{ born: "2041-01" }] }); // 13 ans
    expect([...(await availableCategories(at(), teen.accountId))].sort()).toEqual(["couple", "self", "teens"]);
    const none = await family({ children: [] });
    expect([...(await availableCategories(at(), none.accountId))].sort()).toEqual(["couple", "self"]);
  });

  it("CA 4.1 : budget entre 10 et 2 000 €, personnes entre 1 et 10", async () => {
    const f = await family();
    expect((await failure(saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, budget: 5 }))).message).toBe("Indiquez un budget entre 10 € et 2 000 €.");
    expect((await failure(saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, budget: 2001 }))).code).toBe("invalid_budget");
    expect((await failure(saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, people: 11 }))).code).toBe("invalid_people");
    expect((await saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, budget: 10, people: 1 })).budget).toBe(10);
  });

  it("CA 5.1 : une adresse n'est pas un lieu de départ ; une ville ou un secteur oui", async () => {
    const f = await family();
    for (const place of ["12 rue des Lilas, Tours", "5 bis, impasse du Moulin", "avenue de la République", "Rue Victor Hugo"]) {
      expect((await failure(saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, place }))).message).toBe("Indiquez une ville ou un secteur, pas une adresse.");
    }
    for (const place of ["Lyon", "Paris et Île-de-France", "Place-de-Brest", "Cours-la-Ville"]) expect(looksLikeAddress(place)).toBe(false);
    expect((await saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, place: "Paris et Île-de-France" })).place).toBe("Paris et Île-de-France");
  });

  it("CA 6.1 : activés, les critères exigent catégorie, thème, budget, personnes et lieu ; désactivés, ils s'enregistrent incomplets", async () => {
    const f = await family();
    expect((await failure(saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, selected: {} }))).code).toBe("incomplete");
    expect((await failure(saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, budget: null }))).code).toBe("incomplete");
    expect((await failure(saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, place: "" }))).code).toBe("incomplete");
    expect((await saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, enabled: false, selected: {}, budget: null, place: "" })).enabled).toBe(false);
  });

  it("S-15 : plusieurs jours préférés ; l'invité secondaire n'a ni critères ni sorties (S-02)", async () => {
    const f = await family();
    const saved = await saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, days: ["weekend", "wednesday", "weekday_evenings"], frequency: "weekly", mood: "calm" });
    expect(saved).toMatchObject({ days: ["weekend", "wednesday", "weekday_evenings"], frequency: "weekly", mood: "calm" });
    expect((await failure(saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, days: [] }))).code).toBe("invalid_days");
    expect((await failure(getCriteria(at(), f.elodieSession))).status).toBe(403);
    expect((await failure(saveCriteria(at(), f.elodieSession, NATURE_FOODIE))).status).toBe(403);
  });

  it("l'invité secondaire ne peut pas avoir de critères activés, même directement en base (garde-fou de la base)", async () => {
    const f = await family();
    await expect(db.insertInto("outing_criteria").values({ user_id: f.elodie.id, account_id: f.accountId }).execute()).rejects.toThrow(/réservées aux deux parents/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("jours visés (US-115 RF1)", () => {
  const ids = (f: Family) => ({ accountId: f.accountId, userId: f.camille.id, memberId: f.camilleMember, today: TODAY, timeZone: TZ });

  it("jours préférés, périodes de la fréquence", () => {
    expect(matchesPreferences("2054-11-07", ["weekend"])).toBe(true); // samedi
    expect(matchesPreferences("2054-11-09", ["weekend"])).toBe(false);
    expect(matchesPreferences("2054-11-04", ["weekday_evenings"])).toBe(true); // mercredi
    expect(matchesPreferences("2054-11-04", ["wednesday"])).toBe(true);
    expect(matchesPreferences("2054-11-05", ["wednesday", "friday"])).toBe(false); // jeudi
    expect(matchesPreferences("2054-11-06", ["wednesday", "friday"])).toBe(true); // vendredi
    expect([periodStart("2054-11-12", "monthly"), periodStart("2054-11-12", "twice_monthly"), periodStart("2054-11-20", "twice_monthly"), periodStart("2054-11-12", "weekly")]).toEqual(["2054-11-01", "2054-11-01", "2054-11-16", "2054-11-09"]);
  });

  it("CA 1.1 : le prochain samedi ou dimanche au moins 4 jours plus tard", async () => {
    const f = await family();
    expect(await pickTargetDay(db, { ...ids(f), prefs: ["weekend"] })).toBe("2054-11-07"); // lundi 2 + 4 = vendredi 6 : le samedi 7
    expect(await pickTargetDay(db, { ...ids(f), today: "2054-11-04", prefs: ["weekend"] })).toBe("2054-11-08"); // jeudi 4 + 4 = lundi 8 : le samedi suivant est le 14...
  });

  it("CA 1.2 : un RDV sur toute la journée visée fait viser le jour préféré suivant", async () => {
    const f = await family();
    const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE.family).executeTakeFirstOrThrow();
    const event = await db
      .insertInto("family_events")
      .values({
        account_id: f.accountId, event_type_id: type.id, title: seal("Mariage"), starts_at: localToUtc("2054-11-07T00:00", TZ), ends_at: localToUtc("2054-11-08T00:00", TZ), all_day: true, status: STATUS_CODE.confirmed,
        source: "chat_text", whole_family: false, requested_by_user_id: f.camille.id, fingerprint: randomBytes(16), confirmed_at: new Date(MONDAY), confirmed_by_user_id: f.camille.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db.insertInto("family_event_members").values({ event_id: event.id, member_id: f.camilleMember, account_id: f.accountId }).execute();
    expect(await pickTargetDay(db, { ...ids(f), prefs: ["weekend"] })).toBe("2054-11-08"); // le dimanche
    // Le RDV d'un autre membre ne bloque pas Camille.
    await db.deleteFrom("family_event_members").where("event_id", "=", event.id).execute();
    await db.insertInto("family_event_members").values({ event_id: event.id, member_id: f.kids[0], account_id: f.accountId }).execute();
    expect(await pickTargetDay(db, { ...ids(f), prefs: ["weekend"] })).toBe("2054-11-07");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
const REQUEST: SearchRequest = {
  categories: [{ category: "self", label: "sortie perso", themes: [{ key: "nature", label: "Nature" }, { key: "foodie", label: "Gourmand" }] }],
  budget: 80, people: 2, targetDate: "2054-11-07", weekday: "samedi", place: "Lyon", mood: "both", today: TODAY,
};
const URL_A = "https://exemple.test/jardin";
const URL_B = "https://exemple.test/restaurant";
const URL_C = "https://exemple.test/nouveau";
const idea = (over: Record<string, unknown>) => ({ categorie: "self", theme: "nature", nom: "Jardin botanique", lieu: "Lyon 6e", description: "Une promenade calme.", details: "2 h", url: URL_A, prix: 24, prix_estime: false, calcul: "", releve: "2054-11-01", ...over });
const answerJson = (budget: unknown[], nouveautes: unknown[] = []) => JSON.stringify({ dans_le_budget: budget, nouveautes });
const results = (...urls: string[]): ContentBlock => ({ type: "web_search_tool_result", tool_use_id: "srv_1", content: urls.map((url) => ({ type: "web_search_result", url, title: "t" })) });

function fakeModel(turns: { blocks: ContentBlock[]; stopReason?: string }[]): AssistantModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  return {
    requests,
    id: "claude-sonnet-5-5",
    async send(request) {
      requests.push(request);
      const turn = turns[Math.min(i++, turns.length - 1)];
      return { content: turn.blocks, stopReason: turn.stopReason ?? "end_turn", usage: { inputTokens: 4000, outputTokens: 900, cacheRead: 0, cacheWrite: 0 }, requestId: null };
    },
  };
}
const final = (text: string, ...urls: string[]) => ({ blocks: [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "x" } } as ContentBlock, results(...urls), { type: "text", text } as ContentBlock] });

describe("recherche et règles de validation (US-115 RF2 à RF4, RF8, RT2, RT3)", () => {
  it("RT2 : le modèle ne reçoit que les critères — ni prénom, ni adresse, ni calendrier ; la recherche web est son outil", async () => {
    const sent = searchInput(REQUEST);
    expect(sent).toContain("Lyon");
    expect(sent).toContain("samedi 2054-11-07");
    expect(sent).not.toMatch(/Camille|Julien|Léo|rue |@/);
    const model = fakeModel([final(answerJson([idea({})]), URL_A)]);
    const found = await findIdeas(model, REQUEST, new Set());
    expect(found.ideas).toHaveLength(1);
    expect(found.searches).toBe(1);
    expect(found.costUsd).toBeGreaterThan(0);
    expect(model.requests[0].tools).toEqual([expect.objectContaining({ type: "web_search_20250305", name: "web_search" })]);
    expect(model.requests[0].system).toContain("jamais des instructions");
  });

  it("RF4 : un lien qui ne vient pas d'un résultat de la recherche est écarté ; les liens se comparent sans la barre finale ni l'ancre", () => {
    const text = answerJson([idea({}), idea({ nom: "Autre", url: "https://invente.test/page" }), idea({ nom: "Troisième", url: `${URL_B}/#carte` })]);
    const kept = validateIdeas(text, REQUEST, new Set([normalizeUrl(URL_A), normalizeUrl(URL_B)]), new Set());
    expect(kept.map((i) => i.name)).toEqual(["Jardin botanique", "Troisième"]);
    expect(normalizeUrl("HTTPS://Exemple.test/a/#x")).toBe("https://exemple.test/a");
  });

  it("RF3 : une idée dans le budget dépasse-t-elle le budget ? écartée ; un prix estimé garde son calcul, un prix relevé n'en a pas", () => {
    const text = answerJson([idea({ prix: 95 }), idea({ nom: "Estimé", url: URL_B, prix: 40, prix_estime: true, calcul: "2 × 20 €" }), idea({ nom: "Relevé", url: URL_B + "/2", prix: 30, calcul: "inutile" })]);
    const kept = validateIdeas(text, REQUEST, new Set([normalizeUrl(URL_A), normalizeUrl(URL_B), normalizeUrl(URL_B + "/2")]), new Set());
    expect(kept.map((i) => [i.name, i.priceEstimated, i.priceBasis])).toEqual([["Estimé", true, "2 × 20 €"], ["Relevé", false, null]]);
  });

  it("RF2 : 2 idées par thème, 6 au plus ; 2 nouveautés au plus, sans catégorie ni thème ; un thème non choisi est écarté", () => {
    const many = [1, 2, 3].map((n) => idea({ nom: `Nature ${n}`, url: `${URL_A}/${n}` })).concat([1, 2, 3].map((n) => idea({ theme: "foodie", nom: `Table ${n}`, url: `${URL_B}/${n}` })), [idea({ theme: "sport", nom: "Sport", url: `${URL_A}/s` })]);
    const novelties = [1, 2, 3].map((n) => ({ nom: `Nouveau ${n}`, lieu: "Lyon", description: "Ouvert récemment.", url: `${URL_C}/${n}`, prix: 300, prix_estime: false, releve: "2054-11-01", ouverture: 2053 }));
    const urls = new Set([...[1, 2, 3].flatMap((n) => [`${URL_A}/${n}`, `${URL_B}/${n}`, `${URL_C}/${n}`]), `${URL_A}/s`].map(normalizeUrl));
    const kept = validateIdeas(answerJson(many, novelties), REQUEST, urls, new Set());
    expect(kept.filter((i) => i.section === "in_budget").map((i) => i.name)).toEqual(["Nature 1", "Nature 2", "Table 1", "Table 2"]);
    expect(kept.filter((i) => i.section === "novelty")).toHaveLength(2);
    expect(kept.filter((i) => i.section === "novelty").every((i) => i.category === null && i.themeKey === null && i.openedYear === 2053)).toBe(true);
  });

  it("RF8 : une offre déjà proposée n'est pas reproposée", () => {
    const excluded = new Set([offerHash("Jardin botanique", "Lyon 6e").toString("hex")]);
    expect(validateIdeas(answerJson([idea({})]), REQUEST, new Set([normalizeUrl(URL_A)]), excluded)).toEqual([]);
    expect(validateIdeas(answerJson([idea({ nom: "jardin  BOTANIQUE", lieu: "Lyon 6e" })]), REQUEST, new Set([normalizeUrl(URL_A)]), excluded)).toEqual([]);
  });

  it("une réponse illisible ne donne aucune idée ; la recherche interrompue côté fournisseur reprend (pause_turn)", async () => {
    expect(validateIdeas("Voici mes idées !", REQUEST, new Set(), new Set())).toEqual([]);
    const model = fakeModel([{ blocks: [{ type: "server_tool_use", id: "s", name: "web_search", input: {} } as ContentBlock, results(URL_A)], stopReason: "pause_turn" }, final(answerJson([idea({})]))]);
    const found = await findIdeas(model, REQUEST, new Set());
    expect(model.requests).toHaveLength(2);
    expect(found.ideas).toHaveLength(1); // le lien vient d'un résultat du premier tour
    expect(model.requests[1].messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
const draft = (over: Partial<IdeaDraft> = {}): IdeaDraft => ({
  section: "in_budget", category: "self", themeKey: "nature", name: "Jardin botanique", place: "Lyon 6e", description: "Une promenade calme.", details: "2 h", url: URL_A, priceEur: 24, priceEstimated: false, priceBasis: null, checkedOn: "2054-11-01", openedYear: null, ...over,
});
async function ready(f: Family, ideas: IdeaDraft[] = [draft(), draft({ name: "Table du marché", url: URL_B, themeKey: "foodie", priceEur: 60 }), draft({ section: "novelty", category: null, themeKey: null, name: "Nouvelle serre", url: URL_C, priceEur: 240, openedYear: 2053 })], target = "2054-11-07") {
  return createProposal(db, { accountId: f.accountId, userId: f.camille.id, targetDate: target, budget: 80, people: 2, place: "Lyon", ideas, now: new Date(MONDAY) });
}

describe("propositions privées (US-115 RF5 à RF7, US-116, US-117)", () => {
  it("enregistre la proposition complète, idées chiffrées, mémoire des offres sans texte lisible (RF8, US-117 RF5)", async () => {
    const f = await family();
    const { id } = await ready(f);
    const rows = await db.selectFrom("outing_proposal_ideas").select(["name", "offer_url", "price_eur"]).where("proposal_id", "=", id).execute();
    expect(rows).toHaveLength(3);
    expect(rows[0].name.toString("utf8")).not.toContain("Jardin");
    expect(rows[0].offer_url.toString("utf8")).not.toContain("exemple.test");
    const memory = await db.selectFrom("outing_offer_memory").select("offer_hash").where("user_id", "=", f.camille.id).execute();
    expect(memory).toHaveLength(3);
    expect(memory.every((m) => m.offer_hash.length === 32)).toBe(true);
    const view = await getProposal(at(), f.camilleSession, id);
    expect(view.ideas.map((i) => i.name)).toEqual(["Jardin botanique", "Table du marché", "Nouvelle serre"]);
    expect(view.note).toBe("Disponibilités non vérifiées : réservez au plus tôt.");
  });

  it("CA 3.1, 3.2 : jauge « X % du budget » pour une idée dans le budget ; aucune jauge ni repère pour une nouveauté ; prix estimé signalé", async () => {
    const f = await family();
    const { id } = await ready(f, [draft({ priceEur: 24 }), draft({ name: "Estimé", url: URL_B, priceEur: 40, priceEstimated: true, priceBasis: "2 × 20 €" }), draft({ section: "novelty", category: null, themeKey: null, name: "Nouvelle serre", url: URL_C, priceEur: 240, priceEstimated: true, openedYear: 2053 })]);
    const [a, b, c] = (await getProposal(at(), f.camilleSession, id)).ideas;
    expect([a.budgetPercent, b.budgetPercent, c.budgetPercent]).toEqual([30, 50, null]);
    expect(b).toMatchObject({ estimated: true, priceBasis: "2 × 20 €" });
    expect(c).toMatchObject({ estimated: true, openedYear: 2053, budgetPercent: null, themeLabel: null });
    expect(a.themeLabel).toBe("Nature");
  });

  it("CA 7.1 : la carte reste jusqu'à la fin du jour visé, puis disparaît de l'accueil", async () => {
    const f = await family();
    await ready(f, undefined, "2054-11-07");
    expect(await homeCard(at("2054-11-07T20:00:00Z"), f.camilleSession)).toMatchObject({ targetDate: "2054-11-07", ideas: 3 }); // le samedi à 21 h locales
    expect(await homeCard(at("2054-11-08T09:00:00Z"), f.camilleSession)).toBeNull(); // le dimanche
  });

  it("US-117 CA 1.1, 1.2, 3.1 : l'autre parent ne voit ni la carte ni la proposition ; l'accès direct est refusé comme une page inexistante", async () => {
    const f = await family();
    const { id } = await ready(f);
    expect(await homeCard(at(), f.julienSession!)).toBeNull();
    const refused = await failure(getProposal(at(), f.julienSession!, id));
    expect(refused).toMatchObject({ status: 404, message: "Cette page n'existe plus ou ne vous est pas accessible." });
    expect((await failure(getProposal(at(), f.elodieSession, id))).status).toBe(403);
    expect((await failure(getProposal(at(), f.camilleSession, "pas-un-identifiant"))).status).toBe(404);
    expect((await failure(dismissProposal(at(), f.julienSession!, id))).status).toBe(404);
    const idea = (await db.selectFrom("outing_proposal_ideas").select("id").where("proposal_id", "=", id).executeTakeFirstOrThrow()).id;
    expect((await failure(dismissIdea(at(), f.julienSession!, String(idea)))).status).toBe(404);
    expect((await failure(ideaForm(at(), f.julienSession!, String(idea)))).status).toBe(404);
    expect((await failure(addIdeaToCalendar(at(), f.julienSession!, String(idea), { title: "x", place: null, notes: null, type: "family", memberIds: [], start: "2054-11-07T15:00", end: "2054-11-07T17:00" }))).status).toBe(404);
  });

  it("US-117 RT1 : la sécurité par ligne ne montre à un profil que ses lignes, une fois le profil indiqué (rôle limité, condition du pilote)", async () => {
    const f = await family();
    await ready(f);
    // Avec le rôle de l'application (propriétaire), la sécurité par ligne n'est pas forcée : on la teste avec un rôle limité, le temps du test.
    const role = `maaq_rls_${randomBytes(4).toString("hex")}`;
    await sql`create role ${sql.id(role)} nologin`.execute(db);
    try {
      await sql`grant select on outing_proposals, outing_proposal_ideas to ${sql.id(role)}`.execute(db);
      const count = (user: string | null) =>
        db.transaction().execute(async (trx) => {
          await sql`set local role ${sql.id(role)}`.execute(trx);
          if (user) await sql`select set_config('app.user_id', ${user}, true)`.execute(trx);
          return (await sql<{ n: number }>`select count(*)::int as n from outing_proposals`.execute(trx)).rows[0].n;
        });
      expect(await count(f.camille.id)).toBe(1);
      expect(await count(f.julien!.id)).toBe(0);
      expect(await count(null)).toBe(0);
    } finally {
      await sql`drop owned by ${sql.id(role)}`.execute(db);
      await sql`drop role ${sql.id(role)}`.execute(db);
    }
  });

  it("CA 1.1, 1.2 (US-116) : « Annuler » retire la proposition ; « Annuler » du message la ramène", async () => {
    const f = await family();
    const { id } = await ready(f);
    await dismissProposal(at(), f.camilleSession, id);
    expect(await homeCard(at(), f.camilleSession)).toBeNull();
    expect((await getProposal(at(), f.camilleSession, id)).status).toBe("dismissed");
    await restoreProposal(at(), f.camilleSession, id);
    expect(await homeCard(at(), f.camilleSession)).toMatchObject({ id });
  });

  it("CA 2.1 (US-116) : « Pas cette fois » retire une idée ; la dernière idée retirée retire la proposition, pour de bon", async () => {
    const f = await family();
    const { id } = await ready(f);
    const ideas = (await getProposal(at(), f.camilleSession, id)).ideas;
    await dismissIdea(at(), f.camilleSession, ideas[0].id);
    expect(await homeCard(at(), f.camilleSession)).toMatchObject({ ideas: 2 });
    await dismissIdea(at(), f.camilleSession, ideas[1].id);
    await dismissIdea(at(), f.camilleSession, ideas[2].id);
    expect(await homeCard(at(), f.camilleSession)).toBeNull();
    expect((await getProposal(at(), f.camilleSession, id)).status).toBe("dismissed");
    // Plus aucune idée à voir : « Pas cette fois » est définitif, rien ne revient (la base refuse de rouvrir une proposition vide).
    expect((await failure(restoreProposal(at(), f.camilleSession, id))).code).toBe("not_allowed");
    expect((await failure(dismissIdea(at(), f.camilleSession, ideas[0].id, true))).code).toBe("not_allowed");
    expect(await homeCard(at(), f.camilleSession)).toBeNull();
  });

  it("une proposition retirée n'est pas annoncée ; la notification en attente est annulée (US-116)", async () => {
    const f = await family();
    const { id } = await ready(f);
    await db.insertInto("scheduled_notifications").values({ kind: "outing_proposal", subject_date: "2054-11-07", due_at: new Date(MONDAY), recipient_user_id: f.camille.id, status: "scheduled" }).execute();
    await dismissProposal(at(), f.camilleSession, id);
    const row = await db.selectFrom("scheduled_notifications").select("status").where("recipient_user_id", "=", f.camille.id).where("kind", "=", "outing_proposal").executeTakeFirstOrThrow();
    expect(row.status).toBe("cancelled");
  });

  it("la purge supprime les propositions 30 jours après le jour visé, et la mémoire des offres après 90 jours (RF7, RF8)", async () => {
    const f = await family();
    const { id } = await ready(f, undefined, "2020-01-01");
    await ready(f, undefined, "2054-11-14");
    await sql`select purge_expired_outing_data()`.execute(db);
    expect(await db.selectFrom("outing_proposals").select("id").where("id", "=", id).execute()).toHaveLength(0);
    expect(await db.selectFrom("outing_proposals").select("id").where("user_id", "=", f.camille.id).execute()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("planificateur (US-115 RF1, RF6, RF8, RF9, RF10)", () => {
  const modelWith = (...ideas: unknown[]) => fakeModel([final(answerJson(ideas, [{ nom: "Nouvelle serre", lieu: "Lyon", description: "Ouverte récemment.", url: URL_C, prix: 240, prix_estime: false, releve: "2054-11-01", ouverture: 2053 }]), URL_A, URL_B, URL_C)]);
  const good = () => modelWith(idea({}), idea({ theme: "foodie", nom: "Table du marché", url: URL_B, prix: 60 }));
  const proposalsOf = (f: Family) => db.selectFrom("outing_proposals").select([sql<string>`target_date::text`.as("d"), "status"]).where("user_id", "=", f.camille.id).orderBy("target_date").execute();

  async function enabled(f: Family, over: Partial<CriteriaInput> = {}) {
    await saveCriteria(at(), f.camilleSession, { ...NATURE_FOODIE, ...over });
  }

  it("OUTINGS_MODE=off : rien n'est préparé, même avec des critères activés", async () => {
    const f = await family();
    await enabled(f);
    const previous = process.env.OUTINGS_MODE;
    process.env.OUTINGS_MODE = "off";
    vi.resetModules();
    try {
      const { runOutings: closed } = await import("@/server/assistant/outings/planner");
      const model = good();
      expect(await closed(at(), { accountId: f.accountId, model })).toEqual({ prepared: 0, empty: 0, notified: 0, failed: 0 });
      expect(model.requests).toHaveLength(0);
    } finally {
      process.env.OUTINGS_MODE = previous;
    }
  });

  it("CA 1.1, 2.1 : prépare la proposition du mois pour le prochain week-end, avec 2 idées par thème et 2 nouveautés ; une seule par période", async () => {
    const f = await family();
    await enabled(f);
    const model = good();
    expect(await runOutings(at(), { accountId: f.accountId, model })).toMatchObject({ prepared: 1, empty: 0 });
    expect(await proposalsOf(f)).toEqual([{ d: "2054-11-07", status: "ready" }]);
    const card = (await homeCard(at(), f.camilleSession))!;
    const view = await getProposal(at(), f.camilleSession, card.id);
    expect(view.ideas.map((i) => [i.section, i.name])).toEqual([["in_budget", "Jardin botanique"], ["in_budget", "Table du marché"], ["novelty", "Nouvelle serre"]]);
    expect(view).toMatchObject({ budget: 80, people: 2, place: "Lyon" });
    // RT2 : ce que le modèle a reçu ne contient ni prénom ni adresse.
    expect(JSON.stringify(model.requests[0].messages)).not.toMatch(/Camille|Julien|Enfant/);
    // Un second passage le même mois ne prépare rien.
    expect(await runOutings(at("2054-11-02T11:00:00Z"), { accountId: f.accountId, model: good() })).toMatchObject({ prepared: 0 });
    expect(await proposalsOf(f)).toHaveLength(1);
    // Le mois suivant, une nouvelle proposition, vers un autre jour : l'offre d'avant n'y est pas reproposée (RF8).
    const next = good();
    expect(await runOutings(at("2054-12-01T10:00:00Z"), { accountId: f.accountId, model: next })).toMatchObject({ prepared: 0, empty: 1 }); // mêmes offres : tout est exclu
    expect(await proposalsOf(f)).toHaveLength(2);
  });

  it("RF1 : pas la nuit, et pas pour un parent qui n'a rien activé ; l'invité secondaire n'en a jamais", async () => {
    const f = await family();
    const model = good();
    expect(await runOutings(at(), { accountId: f.accountId, model })).toMatchObject({ prepared: 0 }); // critères désactivés
    await enabled(f);
    expect(await runOutings(at("2054-11-02T05:00:00Z"), { accountId: f.accountId, model })).toMatchObject({ prepared: 0 }); // 6 h à Paris
    expect(model.requests).toHaveLength(0);
  });

  it("CA 9.1 : rien ne tient dans le budget, aucune carte ni notification ; la tentative suivante vise le jour préféré suivant", async () => {
    const f = await family();
    await enabled(f);
    const nothing = fakeModel([final(answerJson([idea({ prix: 500 })]), URL_A)]);
    expect(await runOutings(at(), { accountId: f.accountId, model: nothing })).toMatchObject({ prepared: 0, empty: 1 });
    expect(await homeCard(at(), f.camilleSession)).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(await proposalsOf(f)).toEqual([{ d: "2054-11-07", status: "dismissed" }]); // repère : sans idée
    // Pas de seconde tentative le même jour, même 5 minutes plus tard.
    expect(await runOutings(at("2054-11-02T10:05:00Z"), { accountId: f.accountId, model: good() })).toMatchObject({ prepared: 0, empty: 0 });
    // Le lendemain : le jour préféré suivant, et la proposition compte puisque le repère n'en est pas une.
    expect(await runOutings(at("2054-11-03T10:00:00Z"), { accountId: f.accountId, model: good() })).toMatchObject({ prepared: 1 });
    expect((await proposalsOf(f)).map((p) => p.d)).toEqual(["2054-11-07", "2054-11-08"]);
  });

  it("une erreur de la recherche ne compte pas dans le plafond quotidien, ne laisse aucune carte et n'est pas réessayée avant demain", async () => {
    const f = await family();
    await enabled(f);
    const broken: AssistantModel = { async send() { throw new Error("indisponible"); } };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runOutings(at(), { accountId: f.accountId, model: broken })).toMatchObject({ prepared: 0, failed: 1 });
    quiet.mockRestore();
    expect(await homeCard(at(), f.camilleSession)).toBeNull();
    const counter = await db.selectFrom("daily_request_counters").select("request_count").where("user_id", "=", f.camille.id).executeTakeFirst();
    expect(counter?.request_count ?? 0).toBe(0);
    expect(await runOutings(at("2054-11-02T10:05:00Z"), { accountId: f.accountId, model: good() })).toMatchObject({ prepared: 0, empty: 0 });
  });

  it("SG-5 : une proposition compte comme une demande du plafond quotidien ; plafond atteint, rien n'est préparé", async () => {
    const f = await family();
    await enabled(f);
    await db.updateTable("accounts").set({ daily_request_limit: 1 }).where("id", "=", f.accountId).execute();
    await sql`select register_agent_request(${f.camille.id}::uuid, ${TODAY}::date)`.execute(db);
    const model = good();
    expect(await runOutings(at(), { accountId: f.accountId, model })).toMatchObject({ prepared: 0 });
    expect(model.requests).toHaveLength(0);
  });

  it("CA 6.1 : la notification est générique, au seul parent concerné, par notification et jamais par email ; rien d'autre n'est envoyé à l'autre parent", async () => {
    const f = await family();
    await enabled(f);
    await runOutings(at(), { accountId: f.accountId, model: good() });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(send.mock.calls[0][1] as string) as { title: string; body: string; url: string };
    expect(payload.body).toBe(NOTICE_TEXT);
    expect(payload.body).toBe("L'heure de penser à vous");
    expect(JSON.stringify(payload)).not.toMatch(/Jardin|Lyon|samedi|07|novembre|sortie|80|budget/i);
    expect(await messagesTo(f.camille.email)).toHaveLength(0);
    expect(await messagesTo(f.julien!.email)).toHaveLength(0);
    const rows = await db.selectFrom("scheduled_notifications").select(["recipient_user_id", "status", "email_sent_at", "channel"]).where("kind", "=", "outing_proposal").where("recipient_user_id", "in", [f.camille.id, f.julien!.id]).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_user_id: f.camille.id, status: "sent", email_sent_at: null, channel: null });
    // Une seule fois : un nouveau passage ne la renvoie pas.
    await sendOutingNotices(at("2054-11-02T10:05:00Z"), { accountId: f.accountId });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("RF6 : la nuit (21 h à 8 h) la notification attend 8 h ; sans appareil autorisé, rien ne part (jamais d'email)", async () => {
    const f = await family();
    await enabled(f);
    await runOutings(at("2054-11-02T10:00:00Z"), { accountId: f.accountId, model: good(), });
    send.mockClear();
    await db.deleteFrom("scheduled_notifications").where("recipient_user_id", "=", f.camille.id).execute();
    // 22 h à Paris : rien. Le lendemain 8 h 05 : elle part.
    expect(await sendOutingNotices(at("2054-11-02T21:00:00Z"), { accountId: f.accountId })).toEqual({ notified: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await sendOutingNotices(at("2054-11-03T07:05:00Z"), { accountId: f.accountId })).toEqual({ notified: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    // Sans abonnement : « sans objet », aucun email.
    const g = await family();
    await db.deleteFrom("push_subscriptions").where("device_id", "=", g.camilleSession.device.id).execute();
    await enabled(g);
    await runOutings(at(), { accountId: g.accountId, model: good() });
    expect(await messagesTo(g.camille.email)).toHaveLength(0);
    const row = await db.selectFrom("scheduled_notifications").select("status").where("recipient_user_id", "=", g.camille.id).where("kind", "=", "outing_proposal").executeTakeFirstOrThrow();
    expect(row.status).toBe("not_applicable");
  });

  it("les deux parents ont leurs propres propositions, chacun la sienne", async () => {
    const f = await family();
    await enabled(f);
    await saveCriteria(at(), f.julienSession!, { ...NATURE_FOODIE, place: "Paris" });
    expect(await runOutings(at(), { accountId: f.accountId, model: good() })).toMatchObject({ prepared: 2 });
    const mine = (await homeCard(at(), f.camilleSession))!;
    const his = (await homeCard(at(), f.julienSession!))!;
    expect(mine.id).not.toBe(his.id);
    expect((await getProposal(at(), f.julienSession!, his.id)).place).toBe("Paris");
    expect((await failure(getProposal(at(), f.julienSession!, mine.id))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("ajouter au calendrier (US-120, US-121)", () => {
  const input = (over: Record<string, unknown> = {}) => ({ title: "Jardin botanique", place: "Lyon 6e", notes: "x", type: "personal" as const, memberIds: [] as string[], start: "2054-11-07T15:00", end: "2054-11-07T17:00", ...over });
  const firstIdea = async (f: Family) => String((await db.selectFrom("outing_proposal_ideas").select("id").where("user_id", "=", f.camille.id).orderBy("idea_position").executeTakeFirstOrThrow()).id);

  it("CA 1.1, 2.1 : formulaire prérempli — titre, lieu, note avec le prix et le lien, type, le parent seul — sans date ni heure, avec « Proposé pour »", async () => {
    const f = await family();
    await ready(f);
    const form = await ideaForm(at(), f.camilleSession, await firstIdea(f));
    expect(form).toMatchObject({ title: "Jardin botanique", place: "Lyon 6e", type: "personal", memberId: f.camilleMember, suggestedDate: "2054-11-07" });
    expect(form.notes).toContain("Une promenade calme.");
    expect(form.notes).toContain("24 €");
    expect(form.notes).toContain(URL_A);
    expect(form.help).toBe("Pour garder la surprise, vous pouvez choisir un titre discret.");
    expect(Object.keys(form)).not.toContain("start");
  });

  it("RF1 : une sortie en couple ou avec les enfants est « Familial », une sortie perso « Personnel »", async () => {
    const f = await family();
    await ready(f, [draft({ category: "couple", themeKey: "romantic" }), draft({ category: "kids", themeKey: "animals", name: "Zoo", url: URL_B })]);
    const ids = (await db.selectFrom("outing_proposal_ideas").select("id").where("user_id", "=", f.camille.id).orderBy("idea_position").execute()).map((r) => String(r.id));
    expect((await ideaForm(at(), f.camilleSession, ids[0])).type).toBe("family");
    expect((await ideaForm(at(), f.camilleSession, ids[1])).type).toBe("family");
  });

  it("US-121 CA 1.1, 4.1, RF5 : l'avertissement cite l'autre parent ; sans autre parent, aucun ; un invité secondaire concerné est cité", async () => {
    const f = await family();
    await ready(f);
    const id = await firstIdea(f);
    const form = await ideaForm(at(), f.camilleSession, id);
    expect(form.warning).toBe("Ce RDV sera visible par Julien dans le calendrier familial dès son enregistrement.");
    const elodieMember = (await db.selectFrom("family_members").select("id").where("user_id", "=", f.elodie.id).executeTakeFirstOrThrow()).id;
    const withElodie = await ideaForm(at(), f.camilleSession, id, [f.camilleMember, elodieMember]);
    expect(withElodie.warning).toBe("Ce RDV sera visible par Julien et Élodie dans le calendrier familial dès son enregistrement.");
    const alone = await family({ julien: false });
    await ready(alone);
    expect((await ideaForm(at(), alone.camilleSession, await firstIdea(alone))).warning).toBeNull();
    expect(visibilityWarning([])).toBeNull();
  });

  it("CA 4.1, 2.1 (US-121) : le RDV est enregistré confirmé, sous le titre choisi, source « sortie », rappels compris ; l'idée passe à « ajoutée » et la proposition quitte l'accueil (RF6)", async () => {
    const f = await family();
    const { id } = await ready(f);
    const event = await addIdeaToCalendar(at(), f.camilleSession, await firstIdea(f), input({ title: "Soirée", memberIds: [f.camilleMember] }));
    expect(event).toMatchObject({ title: "Soirée", status: "confirmed", place: "Lyon 6e", source: "outing", start: "2054-11-07T15:00", end: "2054-11-07T17:00" });
    const row = await db.selectFrom("family_events").select(["status", "source", "confirmed_by_user_id", "auto_confirmed", "source_message_id"]).where("id", "=", event.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "confirmed", source: "outing", confirmed_by_user_id: f.camille.id, auto_confirmed: false, source_message_id: null });
    expect(await homeCard(at(), f.camilleSession)).toBeNull();
    const view = await getProposal(at(), f.camilleSession, id);
    expect(view.status).toBe("added");
    expect(view.ideas[0].status).toBe("added");
    // L'autre parent voit le RDV comme tout autre (US-117 CA 2.1).
    const { getEvent } = await import("@/server/assistant/events");
    expect((await getEvent(at(), f.julienSession!, event.id)).title).toBe("Soirée");
  });

  it("CA 5.1 : l'autre parent ne reçoit pas la notification « RDV ajouté »", async () => {
    const f = await family();
    await db.insertInto("platform_settings").values({ setting_key: "event_notice_activation_at", value_type: "timestamp", value_text: "2000-01-01T00:00:00Z" } as never).onConflict((oc) => oc.doNothing()).execute().catch(() => undefined);
    await ready(f);
    const event = await addIdeaToCalendar(at(), f.camilleSession, await firstIdea(f), input({ memberIds: [f.camilleMember] }));
    const { rows } = await sql<{ user_id: string }>`select user_id from family_event_notice_recipients(${event.id}::uuid, 'event_added'::notification_kind)`.execute(db);
    expect(rows).toEqual([]);
    const sent = await db.selectFrom("scheduled_notifications").select("id").where("event_id", "=", event.id).where("kind", "in", ["event_added", "event_to_confirm"]).execute();
    expect(sent).toHaveLength(0);
  });

  it("CA 7.1 : un conflit avec un autre RDV est signalé avec des créneaux alternatifs ; « enregistrer malgré tout » passe ; un RDV identique est refusé", async () => {
    const f = await family();
    await ready(f, [draft({ name: "Jardin" })], "2054-11-07");
    await addIdeaToCalendar(at(), f.camilleSession, await firstIdea(f), input({ memberIds: [f.camilleMember] })); // samedi 15 h à 17 h
    await ready(f, [draft({ name: "Concert", url: URL_C })], "2054-11-14");
    const concert = String((await db.selectFrom("outing_proposal_ideas").select("id").where("user_id", "=", f.camille.id).orderBy("id", "desc").executeTakeFirstOrThrow()).id);
    const overlapping = input({ title: "Concert", memberIds: [f.camilleMember], start: "2054-11-07T16:00", end: "2054-11-07T18:00" });
    const conflict = await failure(addIdeaToCalendar(at(), f.camilleSession, concert, overlapping));
    expect(conflict).toMatchObject({ status: 409, code: "conflict" });
    const details = conflict.details as { conflicts: unknown[]; alternatives: unknown[] };
    expect(details.conflicts).toHaveLength(1);
    expect(details.alternatives.length).toBeGreaterThan(0);
    expect(await db.selectFrom("family_events").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(1); // rien n'a été enregistré
    expect((await db.selectFrom("outing_proposal_ideas").select("status").where("id", "=", concert).executeTakeFirstOrThrow()).status).toBe("proposed");
    expect((await failure(addIdeaToCalendar(at(), f.camilleSession, concert, input({ title: "Concert", memberIds: [f.camilleMember] })))).code).toBe("duplicate"); // même créneau, mêmes membres, même type
    const forced = await addIdeaToCalendar(at(), f.camilleSession, concert, { ...overlapping, allowConflict: true });
    expect(forced.status).toBe("confirmed");
  });

  it("RF3 : la date et l'heure sont obligatoires ; un créneau passé, un titre vide ou un membre inconnu sont refusés ; une idée déjà ajoutée n'est plus proposée", async () => {
    const f = await family();
    await ready(f);
    const id = await firstIdea(f);
    const ok = (over: Record<string, unknown>) => addIdeaToCalendar(at(), f.camilleSession, id, input({ memberIds: [f.camilleMember], ...over }));
    expect((await failure(ok({ start: "", end: "" }))).code).toBe("invalid_time");
    expect((await failure(ok({ end: "2054-11-07T14:00" }))).code).toBe("invalid_time");
    expect((await failure(ok({ start: "2054-10-01T10:00", end: "2054-10-01T12:00" }))).code).toBe("event_past");
    expect((await failure(ok({ title: "  " }))).code).toBe("invalid_title");
    expect((await failure(ok({ memberIds: [] }))).code).toBe("invalid_members");
    expect((await failure(ok({ memberIds: [randomUUID()] }))).code).toBe("invalid_members");
    expect((await failure(ok({ type: "medical" }))).code).toBe("invalid_type");
    await ok({});
    expect((await failure(ok({}))).code).toBe("idea_gone");
  });

  it("la proposition écartée ne peut plus être ajoutée ; « Plus tard » ne laisse rien d'enregistré (le formulaire se ferme)", async () => {
    const f = await family();
    const { id } = await ready(f);
    const first = await firstIdea(f);
    const before = await db.selectFrom("family_events").select("id").where("account_id", "=", f.accountId).execute();
    await ideaForm(at(), f.camilleSession, first); // ouvrir puis fermer le formulaire n'écrit rien
    expect(await db.selectFrom("family_events").select("id").where("account_id", "=", f.accountId).execute()).toEqual(before);
    expect((await getProposal(at(), f.camilleSession, id)).ideas[0].status).toBe("proposed");
    await dismissProposal(at(), f.camilleSession, id);
    expect((await failure(addIdeaToCalendar(at(), f.camilleSession, first, input({ memberIds: [f.camilleMember] })))).code).toBe("idea_gone");
  });

  it("le profil est indiqué à la base dans la transaction (asProfile) et ne fuit pas d'une transaction à l'autre", async () => {
    const f = await family();
    const inside = await asProfile(db, f.camille.id, async (trx) => (await sql<{ v: string }>`select current_setting('app.user_id', true) as v`.execute(trx)).rows[0].v);
    expect(inside).toBe(f.camille.id);
    const outside = (await sql<{ v: string | null }>`select nullif(current_setting('app.user_id', true), '') as v`.execute(db)).rows[0].v;
    expect(outside).toBeNull();
  });
});
