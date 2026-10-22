import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryCalendar } from "@/server/adapters/calendar/dev";
import { coupDeMainBrain } from "@/server/agents/coup-de-main";
import type { AgentTurnInput, LlmClient, LlmMessage } from "@/server/agents/types";
import type { DB } from "@/server/db/schema.generated";
import { addDays, agendaQuestion, runAgendaScan, type Classification } from "@/server/marketplace/agenda";
import { getPrefsView, updatePrefs } from "@/server/marketplace/buyer-service";
import { DbMatchStore } from "@/server/marketplace/match-db-store";
import { MemoryMatchStore } from "@/server/marketplace/match-store";
import type { RelevanceOutput } from "@/server/marketplace/matching";
import type { StorefrontFields } from "@/server/marketplace/model";
import { getMyProfile, updateMyNames } from "@/server/profile/me";
import { AGENDA_CONSENT_VERSION, AGENDA_MIN_CONFIDENCE } from "@/server/marketplace/rules";
import { MemoryStorefrontStore, type StorefrontStore } from "@/server/marketplace/store";
import { fakeLlm } from "./helpers/fake-llm";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

const NOW = new Date("2026-10-22T09:00:00Z");
const TODAY = "2026-10-22";

/** Faux modèle : classe les titres d'agenda selon une table, et note les vitrines selon une autre. */
function fakeModel(options: { classify?: Record<string, Partial<Classification>>; scores?: Record<string, number> } = {}) {
  const calls: { kind: "classify" | "relevance"; messages: LlmMessage[] }[] = [];
  const complete: LlmClient["complete"] = async ({ system, messages }) => {
    const text = messages.at(-1)!.content;
    if (system.startsWith("Tu lis des titres")) {
      calls.push({ kind: "classify", messages });
      const items = (JSON.parse(text) as { id: string; titre: string }[]).map((e) => ({ id: e.id, category: "none", confidence: 1, need: "", ...(options.classify?.[e.titre] ?? {}) }));
      return { items } as never;
    }
    calls.push({ kind: "relevance", messages });
    const json = JSON.parse(text.slice(text.indexOf("[")).trim()) as { id: string; nom: string }[];
    const evaluations: RelevanceOutput["evaluations"] = json.map((c) => ({ id: c.id, score: options.scores?.[c.nom] ?? 0, reason: `${c.nom} fait ce qu'il faut.`, concerns: [] }));
    return { evaluations } as never;
  };
  return { complete, calls };
}

async function publish(store: StorefrontStore, userId: string, fields: Partial<StorefrontFields> = {}) {
  const groups = ["displayName", "category", "services", "description", "area", "availability", "price", "languages", "notice", "qualifications", "contact"];
  await store.save(userId, { displayName: "Sarah Tresses", categoryCode: "coiffure", services: ["tresses"], description: "Tresses.", postcode: "69007", city: "Lyon", modes: ["at_supplier"], availabilityMode: "by_arrangement", contactMethod: "whatsapp", contactValue: "0612345678", ...fields }, Object.fromEntries(groups.map((g) => [g, "confirmed" as const])));
  return store.setState(userId, { status: "published", publishedAt: "2026-10-01T10:00:00Z", lastConfirmedAt: "2026-10-01T10:00:00Z" });
}

function memory() {
  const storefronts = new MemoryStorefrontStore(() => NOW);
  const store = new MemoryMatchStore(storefronts, () => NOW);
  return { storefronts, store };
}

function turn(text: string): AgentTurnInput {
  return { userRef: "camille", text, context: { rank: "primary_user", autoParticipants: [], ccAddresses: [], info: {} }, history: [], today: NOW, timezone: "Europe/Paris", channel: "web" };
}

describe("agenda — passage périodique", () => {
  function setup(options: Parameters<typeof fakeModel>[0] = {}) {
    const { storefronts, store } = memory();
    const calendar = new MemoryCalendar();
    const model = fakeModel(options);
    const posted: { userId: string; text: string }[] = [];
    const deps = { store, calendar, llm: model, now: NOW, today: TODAY, postInApp: async (userId: string, text: string) => void posted.push({ userId, text }) };
    return { storefronts, store, calendar, model, posted, deps };
  }

  it("ne lit rien sans le consentement propre à l'agenda, même avec les suggestions activées", async () => {
    const { store, calendar, model, posted, deps } = setup({ classify: { "Coiffeur enfants": { category: "coiffure", confidence: 0.9, need: "une coupe pour les enfants" } } });
    store.profiles.set("camille", { firstName: "Camille", postcode: "69007" });
    calendar.add("camille", { title: "Coiffeur enfants", date: addDays(TODAY, 3), time: null });
    await store.setPrefs("camille", { suggestionsOptIn: true });
    expect(await runAgendaScan(deps)).toEqual({ profiles: 0, events: 0, proposed: 0, failed: 0 });
    // Agenda sans suggestions : refusé par le service d'écran ; ici le magasin l'exige aussi.
    await store.setPrefs("camille", { suggestionsOptIn: false, agendaOptIn: true });
    expect(await runAgendaScan(deps)).toMatchObject({ profiles: 0 });
    expect(model.calls).toEqual([]);
    expect(posted).toEqual([]);
  });

  it("pose une question d'abord, ne cherche pas, ne garde pas le titre, et n'examine un événement qu'une fois", async () => {
    const { storefronts, store, calendar, model, posted, deps } = setup({
      classify: {
        "Coiffeur enfants 15h": { category: "coiffure", confidence: 0.9, need: "une coupe de cheveux pour les enfants" },
        "Réunion budget": { category: "none" },
        "Peut-être un plombier ?": { category: "bricolage", confidence: AGENDA_MIN_CONFIDENCE - 0.1, need: "un plombier" },
        "Cours piano Léa": { category: "plomberie_inconnue", confidence: 0.95, need: "x" },
      },
      scores: { "Sarah Tresses": 0.9 },
    });
    await publish(storefronts, "sarah");
    store.profiles.set("camille", { firstName: "Camille", postcode: "69007" });
    await store.setPrefs("camille", { suggestionsOptIn: true, agendaOptIn: true, agendaConsentVersion: AGENDA_CONSENT_VERSION });
    const hair = calendar.add("camille", { title: "Coiffeur enfants 15h", date: addDays(TODAY, 4), time: "15:00" });
    calendar.add("camille", { title: "Réunion budget", date: addDays(TODAY, 1), time: "10:00" });
    calendar.add("camille", { title: "Peut-être un plombier ?", date: addDays(TODAY, 2), time: null });
    calendar.add("camille", { title: "Cours piano Léa", date: addDays(TODAY, 2), time: null });
    calendar.add("camille", { title: "Coiffeur dans un mois", date: addDays(TODAY, 40), time: null });

    const first = await runAgendaScan(deps);
    expect(first).toEqual({ profiles: 1, events: 4, proposed: 1, failed: 0 });
    expect(model.calls.map((c) => c.kind)).toEqual(["classify"]); // jamais la pertinence : on n'a pas cherché
    expect(model.calls[0].messages[0].content).toContain("Coiffeur enfants 15h");
    expect(model.calls[0].messages[0].content).not.toContain("Coiffeur dans un mois");

    const [request] = await store.listRequests("camille");
    expect(request).toMatchObject({ status: "proposed", source: "agenda", categoryCode: "coiffure", postcode: "69007", text: "une coupe de cheveux pour les enfants", agendaEventKey: hair.id, agendaEventDate: addDays(TODAY, 4), timingText: "26/10/2026" });
    expect(await store.listRequests("camille")).toHaveLength(1);
    expect(await store.listSuggestions("camille")).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0].text).toBe(agendaQuestion("Camille", { id: hair.id, title: "Coiffeur enfants 15h", date: addDays(TODAY, 4), time: "15:00" }, "une coupe de cheveux pour les enfants"));
    expect(posted[0].text).toContain("Voulez-vous que je cherche quelqu'un près de chez vous pour une coupe de cheveux pour les enfants ?");
    expect(posted[0].text).not.toContain("Sarah");

    // Second passage : rien de nouveau, aucun appel au modèle, aucun doublon.
    expect(await runAgendaScan(deps)).toEqual({ profiles: 1, events: 0, proposed: 0, failed: 0 });
    expect(model.calls).toHaveLength(1);
    expect(posted).toHaveLength(1);
  });

  it("sur le oui de la personne, l'agent cherche la demande proposée ; sur le non, il la clôt", async () => {
    const { storefronts, store, calendar, model, deps } = setup({
      classify: { Coiffeur: { category: "coiffure", confidence: 0.9, need: "une coupe de cheveux" }, Ménage: { category: "menage", confidence: 0.9, need: "un ménage de printemps" } },
      scores: { "Sarah Tresses": 0.9 },
    });
    await publish(storefronts, "sarah");
    store.profiles.set("camille", { firstName: "Camille", postcode: "69007" });
    await store.setPrefs("camille", { suggestionsOptIn: true, agendaOptIn: true });
    calendar.add("camille", { title: "Ménage", date: addDays(TODAY, 1), time: null });
    calendar.add("camille", { title: "Coiffeur", date: addDays(TODAY, 2), time: null });
    await runAgendaScan(deps);
    const requests = await store.listRequests("camille");
    expect(requests.map((r) => r.status)).toEqual(["proposed", "proposed"]);
    const hair = requests.find((r) => r.categoryCode === "coiffure")!;
    const cleaning = requests.find((r) => r.categoryCode === "menage")!;

    const fake = fakeLlm([]);
    const brain = coupDeMainBrain({ runTools: fake.llm.runTools, complete: model.complete }, { store, profileOf: async (ref) => ({ id: ref, firstName: "Camille", postcode: "69007" }), now: () => NOW });
    fake.steps.push({ calls: [{ tool: "chercher", input: { demande_id: hair.id } }], text: (r) => r[0] });
    const yes = await brain.generate(turn("Oui pour le coiffeur"));
    expect(yes.reply.text).toContain("1. Sarah Tresses");
    expect((await store.getRequest("camille", hair.id))!.status).toBe("suggested");
    expect(fake.lastPrompt()).toContain("issue de votre agenda, en attente de votre réponse (oui → chercher ; non → clore_demande)");

    fake.steps.push({ calls: [{ tool: "clore_demande", input: { demande_id: cleaning.id } }], text: (r) => r[0] });
    const no = await brain.generate(turn("Non pour le ménage"));
    expect(no.reply.text).toBe("Demande close : je n'en reparlerai pas.");
    expect((await store.getRequest("camille", cleaning.id))!).toMatchObject({ status: "closed", closedAt: NOW.toISOString() });
  });

  it("une demande écrite sans zone prend le code postal du profil, sauf à distance", async () => {
    const { store } = memory();
    const fake = fakeLlm([]);
    const brain = coupDeMainBrain({ runTools: fake.llm.runTools, complete: fakeModel().complete }, { store, profileOf: async (ref) => ({ id: ref, firstName: "Camille", postcode: "69007" }), now: () => NOW });
    fake.steps.push({ calls: [{ tool: "demander_service", input: { texte: "des tresses", categorie: "coiffure" } }, { tool: "demander_service", input: { texte: "cours d'anglais", categorie: "cours", a_distance: true } }], text: (r) => r.join("\n") });
    const reply = await brain.generate(turn("Des tresses, et un cours d'anglais en ligne"));
    expect(reply.reply.text).toContain("Zone prise sur le profil");
    expect(fake.lastPrompt()).toContain("Code postal du profil : 69007");
    const requests = await store.listRequests("camille");
    expect(requests.find((r) => r.text === "des tresses")).toMatchObject({ postcode: "69007", remoteOk: false });
    expect(requests.find((r) => r.text === "cours d'anglais")).toMatchObject({ postcode: null, remoteOk: true });
  });
});

describe("agenda — base, consentement et profil", () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = testDb();
  });
  afterAll(async () => {
    await db.destroy();
  });

  it("l'agenda exige les suggestions, a sa propre version de consentement, et le code postal vient du profil", async () => {
    const buyer = await createProfile(db);
    const session = await sessionFor(db, buyer.id);
    const ctx = { db, now: new Date("2026-10-22T10:00:00Z") };

    expect((await getPrefsView(ctx, session)).agendaConsentText).toContain("titres et dates");
    const alone = await updatePrefs(ctx, session, { agendaOptIn: true });
    expect(alone.prefs).toMatchObject({ suggestionsOptIn: false, agendaOptIn: false, agendaOptInAt: null, agendaConsentVersion: null });

    const both = await updatePrefs(ctx, session, { suggestionsOptIn: true, agendaOptIn: true });
    expect(both.prefs).toMatchObject({ suggestionsOptIn: true, agendaOptIn: true, agendaConsentVersion: AGENDA_CONSENT_VERSION });
    expect(both.prefs.agendaOptInAt).not.toBeNull();
    expect(both.postcode).toBeNull();

    const store = new DbMatchStore(db, () => ctx.now);
    expect((await store.listAgendaProfiles()).some((p) => p.userId === buyer.id && p.postcode === null)).toBe(true);
    await expect(updateMyNames(ctx, session, { firstName: "Camille", lastName: "Test", postcode: "6900" })).rejects.toMatchObject({ code: "invalid_info" });
    await updateMyNames(ctx, session, { firstName: "Camille", lastName: "Test", postcode: "69007" });
    expect((await getMyProfile(ctx, session)).postcode).toBe("69007");
    expect((await store.listAgendaProfiles()).find((p) => p.userId === buyer.id)).toEqual({ userId: buyer.id, firstName: "Camille", postcode: "69007" });

    // Couper les suggestions coupe l'agenda avec.
    const off = await updatePrefs(ctx, session, { suggestionsOptIn: false });
    expect(off.prefs).toMatchObject({ suggestionsOptIn: false, agendaOptIn: false, agendaConsentVersion: null });
    expect((await store.listAgendaProfiles()).some((p) => p.userId === buyer.id)).toBe(false);

    // Clés vues : une seule fois chacune ; demande d'agenda unique par événement.
    expect(await store.unseenAgendaKeys(buyer.id, ["a", "b"])).toEqual(["a", "b"]);
    await store.markAgendaSeen(buyer.id, ["a"]);
    await store.markAgendaSeen(buyer.id, ["a"]);
    expect(await store.unseenAgendaKeys(buyer.id, ["a", "b"])).toEqual(["b"]);
    const request = await store.createRequest(buyer.id, { text: "une coupe", categoryCode: "coiffure", postcode: "69007", source: "agenda", agendaEventKey: "evt-1", agendaEventDate: "2026-10-26", status: "proposed" });
    expect(request).toMatchObject({ status: "proposed", source: "agenda", agendaEventKey: "evt-1", agendaEventDate: "2026-10-26" });
    await expect(store.createRequest(buyer.id, { text: "bis", source: "agenda", agendaEventKey: "evt-1", status: "proposed" })).rejects.toThrow();
    expect((await store.updateRequest(buyer.id, request.id, { status: "open" })).status).toBe("open");
  });
});
