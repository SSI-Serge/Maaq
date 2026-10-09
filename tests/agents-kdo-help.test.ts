import { describe, expect, it } from "vitest";
import { BRAIN_FAILURE_MESSAGE, MockDigitorn } from "@/server/adapters/digitorn/mock";
import type { RequestContext } from "@/server/adapters/digitorn/types";
import { buildMessages, KDO_HELP_REF, kdoHelpBrain, parseBudget, renderReply } from "@/server/agents/kdo-help";
import type { AgentTurnInput, LlmClient, LlmMessage } from "@/server/agents/types";
import { dueReminderPoint, inQuietHours, matchPeople, nextOccurrence, upcomingOccasions, type Person } from "@/server/gifts/model";
import { MemoryPrefsStore } from "@/server/gifts/prefs";
import { MemoryGiftStore } from "@/server/gifts/store";

const TODAY = new Date("2026-10-07T10:00:00Z");

function context(): RequestContext {
  return { rank: "primary_user", autoParticipants: [], ccAddresses: [], info: {} };
}

function turn(text: string, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return { userRef: "u1", text, context: context(), history: [], today: TODAY, timezone: "Europe/Paris", channel: "web", ...overrides };
}

interface ScriptStep {
  calls?: { tool: string; input: unknown }[];
  text: string | ((results: string[]) => string);
}

/** Faux modèle : joue les appels d'outils prévus (validés par leur schéma) puis rend le texte prévu. */
function fakeLlm(steps: ScriptStep[]) {
  const runs: { system: string; messages: LlmMessage[]; results: string[] }[] = [];
  const llm: LlmClient = {
    async complete() {
      throw new Error("non utilisé");
    },
    async runTools({ system, messages, tools }) {
      const step = steps.shift();
      if (!step) throw new Error("modèle indisponible");
      const results: string[] = [];
      for (const call of step.calls ?? []) {
        const tool = tools.find((t) => t.name === call.tool);
        if (!tool) throw new Error(`outil inconnu : ${call.tool}`);
        const out = await tool.run(tool.parse(call.input));
        results.push(typeof out === "string" ? out : JSON.stringify(out));
      }
      runs.push({ system, messages, results });
      return { text: typeof step.text === "function" ? step.text(results) : step.text };
    },
  };
  return { llm, runs, lastPrompt: () => runs.at(-1)!.messages.at(-1)!.content };
}

function person(overrides: Partial<Person> = {}): Person {
  return { id: "p1", name: "Léa", relationship: "fille", birthDay: 15, birthMonth: 10, birthYear: 2019, budgetAmount: null, details: {}, version: 1, deletedAt: null, ...overrides };
}

describe("kdo_help — règles de dates", () => {
  it("calcule la prochaine occurrence, avec passage à l'année suivante", () => {
    expect(nextOccurrence(15, 10, null, "2026-10-07")).toEqual({ date: "2026-10-15", year: 2026 });
    expect(nextOccurrence(5, 1, null, "2026-12-20")).toEqual({ date: "2027-01-05", year: 2027 });
    expect(nextOccurrence(1, 3, 2026, "2026-10-07")).toBeNull();
    expect(nextOccurrence(25, 12, 2026, "2026-10-07")).toEqual({ date: "2026-12-25", year: 2026 });
  });

  it("liste les anniversaires et occasions dans la fenêtre, triés, avec âge et état", () => {
    const occasions = upcomingOccasions(
      {
        people: [person(), person({ id: "p2", name: "Thomas", relationship: "frère", birthDay: 28, birthMonth: 10, birthYear: 1992 }), person({ id: "p3", name: "Papa", birthDay: 25, birthMonth: 12, birthYear: 1958 })],
        events: [
          { id: "e1", personId: null, kind: "christmas", title: "Noël", eventDay: 25, eventMonth: 12, eventYear: null, budgetAmount: 300, version: 1, deletedAt: null },
          { id: "e2", personId: "p2", kind: "other", title: "Crémaillère", eventDay: 20, eventMonth: 10, eventYear: 2026, budgetAmount: null, version: 1, deletedAt: null },
          { id: "e3", personId: null, kind: "other", title: "Passé", eventDay: 1, eventMonth: 10, eventYear: 2026, budgetAmount: null, version: 1, deletedAt: null },
        ],
        states: [{ occasionKey: "person:p1:2026", sortedAt: "2026-10-01T00:00:00Z", snoozedUntil: null }],
      },
      "2026-10-07",
      45,
    );
    expect(occasions.map((o) => [o.key, o.daysRemaining, o.age, o.sorted, o.personName])).toEqual([
      ["person:p1:2026", 8, 7, true, "Léa"],
      ["event:e2:2026", 13, null, false, "Thomas"],
      ["person:p2:2026", 21, 34, false, "Thomas"],
    ]);
  });

  it("choisit l'échéance de rappel atteinte et pas encore envoyée", () => {
    expect(dueReminderPoint(25, new Set())).toBeNull();
    expect(dueReminderPoint(20, new Set())).toBe("T-21");
    expect(dueReminderPoint(20, new Set(["T-21"]))).toBeNull();
    expect(dueReminderPoint(6, new Set(["T-21"]))).toBe("T-7");
    expect(dueReminderPoint(1, new Set(["T-21", "T-7"]))).toBe("T-2");
    expect(dueReminderPoint(1, new Set(["T-2"]))).toBeNull();
  });

  it("reconnaît les heures calmes, y compris à cheval sur minuit", () => {
    expect(inQuietHours(new Date("2026-10-07T21:30:00+02:00"), "Europe/Paris", "21:00", "08:00")).toBe(true);
    expect(inQuietHours(new Date("2026-10-07T06:30:00+02:00"), "Europe/Paris", "21:00", "08:00")).toBe(true);
    expect(inQuietHours(new Date("2026-10-07T12:00:00+02:00"), "Europe/Paris", "21:00", "08:00")).toBe(false);
    expect(inQuietHours(new Date("2026-10-07T13:00:00+02:00"), "Europe/Paris", "12:00", "14:00")).toBe(true);
  });

  it("retrouve un proche par son nom, exact d'abord", () => {
    const people = [person({ id: "a", name: "Sam" }), person({ id: "b", name: "Samuel" }), person({ id: "c", name: "Léa", deletedAt: "2026-01-01T00:00:00Z" })];
    expect(matchPeople(people, "sam").map((p) => p.id)).toEqual(["a"]);
    expect(matchPeople(people, "samu").map((p) => p.id)).toEqual(["b"]);
    expect(matchPeople(people, "léa")).toEqual([]);
  });
});

describe("kdo_help — rendu et budget", () => {
  it("lit le budget maximal de la demande", () => {
    expect(parseBudget("Un cadeau à 20 € max")).toBe(20);
    expect(parseBudget("entre 15 et 30 euros")).toBe(30);
    expect(parseBudget("pas trop cher")).toBeNull();
  });

  it("affiche le message puis les idées numérotées", () => {
    const text = renderReply("Deux pistes :", [
      { personId: null, occasionKey: null, title: "Livre pop-up", why: "Parce que.", priceMin: 15, priceMax: 20 },
      { personId: null, occasionKey: null, title: "Puzzle", why: "Aussi.", priceMin: 12, priceMax: 12 },
    ]);
    expect(text).toBe("Deux pistes :\n\n1. Livre pop-up — 15 à 20 €\n   Parce que.\n\n2. Puzzle — 12 €\n   Aussi.");
  });

  it("commence toujours l'historique par la personne", () => {
    const messages = buildMessages(turn("Et pour 30 € ?", { history: [{ role: "agent", text: "Bonjour" }, { role: "user", text: "Un cadeau" }, { role: "agent", text: "Pour qui ?" }] }), "[ctx]");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages.at(-1)!.content).toBe("[ctx]\n\n[Demande]\nEt pour 30 € ?");
  });
});

describe("kdo_help — outils", () => {
  function setup(steps: ScriptStep[]) {
    const store = new MemoryGiftStore(() => TODAY);
    const prefs = new MemoryPrefsStore();
    const fake = fakeLlm(steps);
    return { store, prefs, ...fake, brain: kdoHelpBrain(fake.llm, { store, prefs }) };
  }

  it("crée un proche, refuse l'homonyme sans confirmation, puis le modifie", async () => {
    const { store, brain, runs } = setup([
      { calls: [{ tool: "creer_proche", input: { nom: "Sam", lien: "frère", anniversaire: { jour: 14, mois: 3, annee: 1992 }, budget: 200, interets: ["vélo"], moments_de_vie: ["premier enfant"] } }], text: "Enregistré : Sam (frère), anniversaire le 14/03/1992, budget 200 €." },
      { calls: [{ tool: "creer_proche", input: { nom: "sam" } }], text: (r) => r[0] },
      { calls: [{ tool: "trouver_proche", input: { nom: "Sam" } }], text: (r) => r[0] },
    ]);
    const first = await brain.generate(turn("Ajoute mon frère Sam, né le 14 mars 1992, fan de vélo, budget 200 €"));
    expect(first.calls).toEqual(["creer_proche"]);
    expect(first.reply.text).toContain("Enregistré : Sam");
    const [sam] = await store.listPeople("u1");
    expect(sam).toMatchObject({ name: "Sam", relationship: "frère", birthDay: 14, birthMonth: 3, birthYear: 1992, budgetAmount: 200, details: { interests: ["vélo"], lifeEvents: ["premier enfant"] } });

    const second = await brain.generate(turn("Ajoute Sam"));
    expect(second.reply.text).toContain("existe déjà");
    expect(await store.listPeople("u1")).toHaveLength(1);

    const third = await brain.generate(turn("Qui est Sam ?"));
    expect(JSON.parse(third.message)[0]).toMatchObject({ nom: "Sam", anniversaire: "14/03/1992", version: 1 });
    expect(runs[0].messages.at(-1)!.content).toContain("Aucun proche enregistré");
    expect(runs[2].messages.at(-1)!.content).toContain("Sam (frère), anniversaire 14/03/1992, budget 200 €, aime : vélo");
  });

  it("enregistre les idées proposées et retire celles hors budget, en trop ou déjà proposées", async () => {
    const { store, brain } = setup([
      {
        calls: [
          { tool: "creer_proche", input: { nom: "Sam", budget: 200 } },
        ],
        text: "ok",
      },
    ]);
    await brain.generate(turn("Ajoute Sam"));
    const [sam] = await store.listPeople("u1");
    await store.addIdeas("u1", [{ personId: sam.id, occasionKey: null, title: "Casque vélo", why: "", priceMin: 50, priceMax: 80 }]);

    const fake2 = fakeLlm([
      {
        calls: [
          {
            tool: "proposer_idees",
            input: {
              proche_id: sam.id,
              idees: [
                { titre: "Siège vélo enfant", pourquoi: "Rouler avec le bébé.", prix_min: 25, prix_max: 30 },
                { titre: "Home trainer", pourquoi: "Rouler à la maison.", prix_min: 150, prix_max: 200 },
                { titre: "casque vélo", pourquoi: "Sécurité.", prix_min: 20, prix_max: 30 },
                { titre: "Sacoche de cadre", pourquoi: "Pratique.", prix_min: 15, prix_max: 25 },
                { titre: "Gourde isotherme", pourquoi: "Utile.", prix_min: 10, prix_max: 20 },
                { titre: "Multi-outil", pourquoi: "Dépannage.", prix_min: 15, prix_max: 25 },
              ],
            },
          },
        ],
        text: "Voici trois idées pour Sam.",
      },
    ]);
    const brain2 = kdoHelpBrain(fake2.llm, { store });
    const generation = await brain2.generate(turn("Une idée pour Sam, 30 € max"));
    expect(generation.ideas.map((i) => i.title)).toEqual(["Siège vélo enfant", "Sacoche de cadre", "Gourde isotherme"]);
    expect(generation.problems).toEqual(["Home trainer (hors budget de 30 €)", "casque vélo (déjà proposée)", "Multi-outil (au-delà de 3 idées)"]);
    expect(generation.reply.text).toBe("Voici trois idées pour Sam.\n\n1. Siège vélo enfant — 25 à 30 €\n   Rouler avec le bébé.\n\n2. Sacoche de cadre — 15 à 25 €\n   Pratique.\n\n3. Gourde isotherme — 10 à 20 €\n   Utile.");
    expect((await store.listIdeas("u1", { personId: sam.id })).map((i) => i.title)).toEqual(["Gourde isotherme", "Sacoche de cadre", "Siège vélo enfant", "Casque vélo"]);
  });

  it("une suppression passe par une carte à valider, et peut être annulée", async () => {
    const { store, brain } = setup([
      { calls: [{ tool: "creer_proche", input: { nom: "Priya", lien: "collègue" } }], text: "ok" },
      { calls: [{ tool: "creer_occasion", input: { titre: "Pot de départ de Priya", type: "other", jour: 20, mois: 10, annee: 2026 } }], text: "ok" },
      { calls: [{ tool: "supprimer_proche", input: {} }], text: (r) => r[0] },
      { calls: [{ tool: "annuler_derniere_suppression", input: {} }], text: (r) => r[0] },
    ]);
    await brain.generate(turn("Ajoute ma collègue Priya"));
    const [priya] = await store.listPeople("u1");
    await brain.generate(turn("Son pot de départ est le 20 octobre"));
    const [event] = await store.listEvents("u1");
    await store.updateEvent("u1", event.id, { personId: priya.id });

    // Le faux modèle ne connaît pas l'identifiant : on le glisse dans l'appel prévu.
    const fake = fakeLlm([{ calls: [{ tool: "supprimer_proche", input: { id: priya.id } }], text: (r) => r[0] }, { calls: [{ tool: "annuler_derniere_suppression", input: {} }], text: (r) => r[0] }]);
    const brain2 = kdoHelpBrain(fake.llm, { store });
    const deletion = await brain2.generate(turn("Supprime Priya"));
    expect(deletion.reply.text).toContain("Confirmation demandée");
    expect(deletion.reply.proposals).toHaveLength(1);
    expect(deletion.reply.proposals[0].summary).toBe("Supprimer Priya et 1 occasion(s) (annulable pendant 30 jours)");
    expect(await store.listPeople("u1")).toHaveLength(1);

    await deletion.reply.proposals[0].execute();
    expect(await store.listPeople("u1")).toHaveLength(0);
    expect(await store.listEvents("u1")).toHaveLength(0);

    const undo = await brain2.generate(turn("Annule"));
    expect(undo.reply.text).toBe("Restauré : Priya.");
    expect(await store.listPeople("u1")).toHaveLength(1);
    expect(await store.listEvents("u1")).toHaveLength(1);
  });

  it("liste les occasions, règle et reporte, et marque une idée achetée", async () => {
    const { store, prefs, brain } = setup([
      { calls: [{ tool: "lister_occasions", input: { jours: 90 } }], text: (r) => r[0] },
      { calls: [{ tool: "regler_rappels", input: { canal: "whatsapp", heures_calmes_debut: "22:00" } }], text: (r) => r[0] },
    ]);
    const lea = await store.createPerson("u1", { name: "Léa", relationship: "fille", birthDay: 15, birthMonth: 10, birthYear: 2019 });
    await store.createEvent("u1", { title: "Noël", kind: "christmas", eventDay: 25, eventMonth: 12 });
    const listed = await brain.generate(turn("Quelles occasions arrivent ?"));
    const occasions = JSON.parse(listed.message);
    expect(occasions.map((o: { titre: string; dansJours: number; age: number | null }) => [o.titre, o.dansJours, o.age])).toEqual([
      ["Anniversaire de Léa", 8, 7],
      ["Noël", 79, null],
    ]);

    const [idea] = await store.addIdeas("u1", [{ personId: lea.id, occasionKey: `person:${lea.id}:2026`, title: "Kit de fouille", why: "", priceMin: 10, priceMax: 20 }]);
    const fake = fakeLlm([{ calls: [{ tool: "marquer_idee", input: { id: idea.id, statut: "purchased" } }], text: (r) => r[0] }]);
    const bought = await kdoHelpBrain(fake.llm, { store }).generate(turn("J'ai acheté le kit"));
    expect(bought.reply.text).toBe("Idée « Kit de fouille » : achetée.");
    expect(await store.listStates("u1")).toMatchObject([{ occasionKey: `person:${lea.id}:2026`, sortedAt: expect.any(String) }]);

    const prefsReply = await brain.generate(turn("Rappelle-moi sur WhatsApp, pas après 22h"));
    expect(prefsReply.reply.text).toBe("Rappels : canal whatsapp, heures calmes 22:00–08:00, fuseau Europe/Paris.");
    expect(await prefs.get("u1")).toMatchObject({ reminderChannel: "whatsapp", quietHoursStart: "22:00" });
  });

  it("transmet le canal, le rang et le profil inconnu", async () => {
    const { brain, lastPrompt } = setup([{ text: "Bonjour" }]);
    await brain.generate(turn("Salut", { channel: "whatsapp", context: { ...context(), rank: "core_guest" } }));
    expect(lastPrompt()).toContain("Canal : WhatsApp");
    expect(lastPrompt()).toContain("invité du compte");
    expect(lastPrompt()).toContain("Date du jour : 2026-10-07 (fuseau Europe/Paris)");

    const unknown = kdoHelpBrain(fakeLlm([]).llm, { store: new MemoryGiftStore(), userIdOf: async () => null });
    expect((await unknown.respond(turn("Salut"))).text).toContain("Je ne retrouve pas votre profil");
  });
});

describe("Digitorn simulé avec un agent local", () => {
  const request = (text: string, agentRef = KDO_HELP_REF, channel: "web" | "whatsapp" = "web") => ({ requestId: `r-${Math.random()}`, userRef: "camille", agentRef, text, context: context(), channel });

  it("répond par le cerveau, marque le canal et alimente le carnet de bord", async () => {
    const fake = fakeLlm([{ text: "Bonjour Camille." }]);
    const mock = new MockDigitorn({ replyDelayMs: 0, brains: [kdoHelpBrain(fake.llm, { store: new MemoryGiftStore() })] });
    await mock.submitRequest(request("Bonjour", KDO_HELP_REF, "whatsapp"));
    await mock.settle();

    const events = await mock.getConversation("camille", KDO_HELP_REF);
    expect(events.map((e) => e.type)).toEqual(["user_message", "agent_message"]);
    expect(events[0]).toMatchObject({ type: "user_message", channel: "whatsapp" });
    expect(events[1]).toMatchObject({ type: "agent_message", text: "Bonjour Camille." });
    expect(fake.lastPrompt()).toContain("Canal : WhatsApp");
    expect((await mock.fetchLogbook(new Date(0))).map((l) => l.type)).toEqual(["request"]);
  });

  it("une action de l'agent n'est exécutée qu'après validation de la carte", async () => {
    const store = new MemoryGiftStore();
    const sam = await store.createPerson("camille", { name: "Sam" });
    const fake = fakeLlm([{ calls: [{ tool: "supprimer_proche", input: { id: sam.id } }], text: "Validez la carte pour supprimer Sam." }]);
    const mock = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0, brains: [kdoHelpBrain(fake.llm, { store })] });
    await mock.submitRequest(request("Supprime Sam"));
    await mock.settle();

    const events = await mock.getConversation("camille", KDO_HELP_REF);
    expect(events.map((e) => e.type)).toEqual(["user_message", "agent_message", "action_proposal"]);
    const card = events[2];
    if (card.type !== "action_proposal") throw new Error("carte attendue");
    expect(card.proposal).toMatchObject({ kind: "other", status: "pending", summary: "Supprimer Sam (annulable pendant 30 jours)" });
    expect(await store.listPeople("camille")).toHaveLength(1);

    await expect(mock.decideAction({ proposalId: card.proposal.proposalId, userRef: "autre", decision: "validate" })).rejects.toThrow();
    const decided = await mock.decideAction({ proposalId: card.proposal.proposalId, userRef: "camille", decision: "validate" });
    expect(decided.status).toBe("executing");
    await mock.settle();
    expect(card.proposal.status).toBe("succeeded");
    expect(await store.listPeople("camille")).toHaveLength(0);
    expect((await mock.fetchLogbook(new Date(0))).map((l) => l.type)).toEqual(["request", "action_validated", "action_done"]);
  });

  it("un refus ne fait rien", async () => {
    const store = new MemoryGiftStore();
    const sam = await store.createPerson("camille", { name: "Sam" });
    const fake = fakeLlm([{ calls: [{ tool: "supprimer_proche", input: { id: sam.id } }], text: "Validez la carte." }]);
    const mock = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0, brains: [kdoHelpBrain(fake.llm, { store })] });
    await mock.submitRequest(request("Supprime Sam"));
    await mock.settle();
    const card = (await mock.getConversation("camille", KDO_HELP_REF)).find((e) => e.type === "action_proposal");
    if (!card || card.type !== "action_proposal") throw new Error("carte attendue");
    const decided = await mock.decideAction({ proposalId: card.proposal.proposalId, userRef: "camille", decision: "refuse" });
    expect(decided.status).toBe("refused");
    expect(await store.listPeople("camille")).toHaveLength(1);
  });

  it("affiche un message d'excuse si le modèle échoue, et laisse les autres agents au simulateur", async () => {
    const mock = new MockDigitorn({ replyDelayMs: 0, brains: [kdoHelpBrain(fakeLlm([]).llm, { store: new MemoryGiftStore() })] });
    await mock.submitRequest(request("Un cadeau"));
    await mock.submitRequest(request("Prends rendez-vous chez le dentiste", "admin_lib"));
    await mock.settle();
    expect((await mock.getConversation("camille", KDO_HELP_REF))[1]).toMatchObject({ type: "agent_message", text: BRAIN_FAILURE_MESSAGE });
    expect((await mock.getConversation("camille", "admin_lib")).map((e) => e.type)).toEqual(["user_message", "agent_message", "action_proposal"]);
  });
});
