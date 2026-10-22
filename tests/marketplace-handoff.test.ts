import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockDigitorn } from "@/server/adapters/digitorn/mock";
import { useWhatsAppTransport } from "@/server/adapters/whatsapp";
import { MemoryWhatsApp } from "@/server/adapters/whatsapp/dev-outbox";
import { TEMPLATES } from "@/server/adapters/whatsapp/templates";
import type { InboundMessage } from "@/server/adapters/whatsapp/types";
import { vitrineBrain } from "@/server/agents/vitrine";
import type { AgentTurnInput } from "@/server/agents/types";
import { createLinkCode } from "@/server/channels/linking";
import { MESSAGES, WhatsAppCore } from "@/server/channels/whatsapp-core";
import type { DB } from "@/server/db/schema.generated";
import { DbStorefrontStore } from "@/server/marketplace/db-store";
import { answerSupplierQuestion, expireIntroductions, HandoffRefused, introductionButtons, notifySupplierOfIntroduction, parseIntroductionButton, respondToIntroduction, type HandoffDeps } from "@/server/marketplace/handoff";
import { appHandoffDeps } from "@/server/marketplace/handoff-app";
import { DbMatchStore } from "@/server/marketplace/match-db-store";
import { MemoryMatchStore } from "@/server/marketplace/match-store";
import type { StorefrontFields } from "@/server/marketplace/model";
import { COOLDOWN_DAYS, INTRODUCTION_EXPIRY_DAYS } from "@/server/marketplace/rules";
import { MemoryStorefrontStore, type StorefrontStore } from "@/server/marketplace/store";
import { ensureDigitornRef } from "@/server/profile/digitorn-ref";
import { fakeLlm } from "./helpers/fake-llm";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

const NOW = new Date("2026-10-22T09:00:00Z");

async function publish(store: StorefrontStore, userId: string, fields: Partial<StorefrontFields> = {}) {
  const groups = ["displayName", "category", "services", "description", "area", "availability", "price", "languages", "notice", "qualifications", "contact"];
  await store.save(userId, { displayName: "Sarah Tresses", categoryCode: "coiffure", services: ["tresses"], description: "Tresses.", postcode: "69007", city: "Lyon", modes: ["at_supplier"], availabilityMode: "by_arrangement", contactMethod: "whatsapp", contactValue: "0612345678", ...fields }, Object.fromEntries(groups.map((g) => [g, "confirmed" as const])));
  return store.setState(userId, { status: "published", publishedAt: "2026-10-01T10:00:00Z", lastConfirmedAt: "2026-10-01T10:00:00Z" });
}

function memory(clock: () => Date = () => NOW) {
  const storefronts = new MemoryStorefrontStore(clock);
  const store = new MemoryMatchStore(storefronts, clock);
  const posted: { userId: string; agent: string; text: string }[] = [];
  const transport = new MemoryWhatsApp();
  let identity: { waId: string; optIn: boolean; lastInboundAt: string | null } | null = null;
  const deps: HandoffDeps = {
    store,
    storefronts,
    now: clock,
    postInApp: async (userId, agent, text) => void posted.push({ userId, agent, text }),
    buyerContactOf: async (userId) => (userId === "camille" ? { firstName: "Camille", email: "camille@maaq.test", phone: "+33612345678" } : null),
    supplierFirstNameOf: async () => "Sarah",
    whatsapp: { transport, identityOf: async () => identity },
  };
  return { storefronts, store, posted, transport, deps, setIdentity: (value: typeof identity) => void (identity = value) };
}

async function requested(m: ReturnType<typeof memory>) {
  const sf = await publish(m.storefronts, "sarah");
  const request = await m.store.createRequest("camille", { text: "des tresses", categoryCode: "coiffure", postcode: "69007" });
  const [suggestion] = await m.store.addSuggestions([{ requestId: request.id, buyerUserId: "camille", storefrontId: sf.id, reason: "Tresses.", internalReason: "test", score: 0.9, fit: "strong" }]);
  const introduction = await m.store.createIntroduction({ suggestionId: suggestion.id, buyerUserId: "camille", storefrontId: sf.id, sharedText: "Camille, membre de MAAQ, cherche : des tresses\nQuand : samedi\nOù : code postal 69007 (département 69)" });
  return { sf, introduction };
}

function turn(text: string, userRef = "sarah"): AgentTurnInput {
  return { userRef, text, context: { rank: "primary_user", autoParticipants: [], ccAddresses: [], info: {} }, history: [], today: NOW, timezone: "Europe/Paris", channel: "web" };
}

describe("transfert — notification du fournisseur", () => {
  it("prévient dans le tchat vitrine, et sur WhatsApp seulement si relié et consentant : modèle hors fenêtre, boutons dedans", async () => {
    const m = memory();
    const { sf, introduction } = await requested(m);
    expect(await notifySupplierOfIntroduction(m.deps, introduction, sf)).toEqual({ whatsapp: false });
    expect(m.posted).toEqual([{ userId: "sarah", agent: "vitrine", text: expect.stringContaining("Nouvelle demande de mise en relation pour votre vitrine « Sarah Tresses »") }]);
    expect(m.posted[0].text).not.toContain("0612345678");
    expect(m.transport.sent).toEqual([]);

    m.setIdentity({ waId: "33600000001", optIn: false, lastInboundAt: null });
    expect((await notifySupplierOfIntroduction(m.deps, introduction, sf)).whatsapp).toBe(false);

    m.setIdentity({ waId: "33600000001", optIn: true, lastInboundAt: null });
    expect((await notifySupplierOfIntroduction(m.deps, introduction, sf)).whatsapp).toBe(true);
    const template = m.transport.sent.at(-1)!;
    expect(template).toMatchObject({ kind: "template", to: "33600000001", name: TEMPLATES.introduction_request.name, bodyParams: ["Sarah", "Sarah Tresses", introduction.sharedText], buttonPayloads: [`intro:${introduction.id}:accept`, `intro:${introduction.id}:decline`, `intro:${introduction.id}:question`] });
    expect(TEMPLATES.introduction_request.buttons).toEqual(["Accepter", "Refuser", "Question"]);

    m.setIdentity({ waId: "33600000001", optIn: true, lastInboundAt: new Date(NOW.getTime() - 3_600_000).toISOString() });
    await notifySupplierOfIntroduction(m.deps, introduction, sf);
    const buttons = m.transport.sent.at(-1)!;
    expect(buttons.kind).toBe("buttons");
    if (buttons.kind !== "buttons") throw new Error("boutons attendus");
    expect(buttons.buttons).toEqual(introductionButtons(introduction.id));
    expect(buttons.text).toContain("Accepter transmet au membre le contact indiqué sur votre vitrine");
    expect(parseIntroductionButton(`intro:${introduction.id}:decline`)).toEqual({ introductionId: introduction.id, response: "decline" });
    expect(parseIntroductionButton("decide:x:validate")).toBeNull();
  });
});

describe("transfert — réponse du fournisseur", () => {
  it("aucun contact ne circule avant l'acceptation ; accepter échange les contacts et clôt la mise en relation", async () => {
    const m = memory();
    const { introduction } = await requested(m);
    await notifySupplierOfIntroduction(m.deps, introduction, (await m.storefronts.get("sarah"))!);
    expect(JSON.stringify(m.posted)).not.toContain("camille@maaq.test");
    expect(JSON.stringify(m.posted)).not.toContain("0612345678");

    await expect(respondToIntroduction(m.deps, { supplierUserId: "autre", introductionId: introduction.id, response: "accept" })).rejects.toMatchObject({ code: "not_yours" });
    await expect(respondToIntroduction(m.deps, { supplierUserId: "sarah", introductionId: "00000000-0000-4000-8000-000000000000", response: "accept" })).rejects.toMatchObject({ code: "not_found" });

    const accepted = await respondToIntroduction(m.deps, { supplierUserId: "sarah", introductionId: introduction.id, response: "accept", message: "Avec plaisir, samedi matin ?" });
    expect(accepted).toMatchObject({ status: "connected", answeredAt: NOW.toISOString(), connectedAt: NOW.toISOString(), supplierMessage: "Avec plaisir, samedi matin ?" });
    const toBuyer = m.posted.find((p) => p.userId === "camille")!;
    expect(toBuyer.agent).toBe("coup_de_main");
    expect(toBuyer.text).toContain("Sarah Tresses a accepté votre demande. Voici comment le joindre — WhatsApp, après accord : 0612345678.");
    expect(toBuyer.text).toContain("Vos coordonnées (prénom, email et téléphone) lui ont été transmises en retour.");
    expect(toBuyer.text).toContain("Mot de Sarah Tresses : « Avec plaisir, samedi matin ? »");
    const toSupplier = m.posted.filter((p) => p.userId === "sarah").at(-1)!;
    expect(toSupplier.text).toContain("Ses coordonnées : camille@maaq.test, +33612345678");

    await expect(respondToIntroduction(m.deps, { supplierUserId: "sarah", introductionId: introduction.id, response: "decline" })).rejects.toMatchObject({ code: "already_answered" });
    // Une mise en relation faite bloque le couple pendant la carence.
    expect((await m.store.blockedStorefronts("camille", COOLDOWN_DAYS)).get(introduction.storefrontId)).toContain("déjà faite");
  });

  it("refuser prévient l'acheteur sans rien transmettre ; une question exige un message et attend la réponse de l'acheteur", async () => {
    const m = memory();
    const { introduction } = await requested(m);
    await expect(respondToIntroduction(m.deps, { supplierUserId: "sarah", introductionId: introduction.id, response: "question" })).rejects.toMatchObject({ code: "message_required" });
    const asked = await respondToIntroduction(m.deps, { supplierUserId: "sarah", introductionId: introduction.id, response: "question", message: "Cheveux longs ou courts ?" });
    expect(asked).toMatchObject({ status: "question", supplierMessage: "Cheveux longs ou courts ?" });
    expect(m.posted.at(-1)).toEqual({ userId: "camille", agent: "coup_de_main", text: "Sarah Tresses a une question avant de répondre : « Cheveux longs ou courts ? ». Répondez-moi ici et je lui transmets." });

    await expect(answerSupplierQuestion(m.deps, { buyerUserId: "autre", introductionId: introduction.id, text: "Longs" })).rejects.toBeInstanceOf(HandoffRefused);
    await answerSupplierQuestion(m.deps, { buyerUserId: "camille", introductionId: introduction.id, text: "Longs, jusqu'aux épaules" });
    expect(m.posted.at(-1)).toEqual({ userId: "sarah", agent: "vitrine", text: expect.stringContaining("Réponse de Camille") });
    expect(m.posted.at(-1)!.text).toContain("« Longs, jusqu'aux épaules »");
    expect(JSON.stringify(m.posted)).not.toContain("camille@maaq.test");

    const declined = await respondToIntroduction(m.deps, { supplierUserId: "sarah", introductionId: introduction.id, response: "decline", message: "Complet ce mois-ci" });
    expect(declined.status).toBe("declined");
    expect(m.posted.at(-1)!.text).toBe("Sarah Tresses a décliné votre demande : « Complet ce mois-ci ». Je ne vous reproposerai pas cette vitrine avant 90 jours ; dites-moi si vous voulez que je cherche quelqu'un d'autre.");
    expect(JSON.stringify(m.posted)).not.toContain("0612345678");
    await expect(answerSupplierQuestion(m.deps, { buyerUserId: "camille", introductionId: introduction.id, text: "x" })).rejects.toMatchObject({ code: "already_answered" });
    expect((await m.store.blockedStorefronts("camille", COOLDOWN_DAYS)).get(introduction.storefrontId)).toContain("refusée");
  });

  it("sans réponse après le délai, la mise en relation expire et l'acheteur est prévenu", async () => {
    const m = memory();
    const { introduction } = await requested(m);
    expect(await expireIntroductions(m.deps)).toBe(0);
    const later = { ...m.deps, now: () => new Date(NOW.getTime() + (INTRODUCTION_EXPIRY_DAYS + 1) * 86_400_000) };
    expect(await expireIntroductions(later)).toBe(1);
    expect((await m.store.getIntroduction(introduction.id))!.status).toBe("expired");
    expect(m.posted.at(-1)).toEqual({ userId: "camille", agent: "coup_de_main", text: expect.stringContaining("est restée sans réponse pendant 7 jours : elle a expiré") });
    expect(await expireIntroductions(later)).toBe(0);
    // Un second couple peut s'ouvrir après expiration, et la carence s'applique.
    expect((await m.store.blockedStorefronts("camille", COOLDOWN_DAYS)).get(introduction.storefrontId)).toContain("expirée");
  });

  it("dans le tchat vitrine, la réponse passe par une carte : rien ne change avant sa validation", async () => {
    const m = memory();
    const { introduction } = await requested(m);
    const fake = fakeLlm([]);
    const brain = vitrineBrain(fake.llm, { store: m.storefronts, matches: m.store, handoff: m.deps });

    fake.steps.push({ calls: [{ tool: "lister_introductions", input: {} }], text: (r) => r[0] });
    const listed = await brain.generate(turn("Qui m'a demandé ?"));
    expect(listed.reply.text).toContain(`[mise en relation ${introduction.id}] demandée le 2026-10-22, en attente de votre réponse`);
    expect(listed.reply.text).toContain("Texte du membre : « Camille, membre de MAAQ, cherche : des tresses");
    expect(fake.lastPrompt()).toContain("Mises en relation en attente de votre réponse :");

    fake.steps.push({ calls: [{ tool: "repondre_introduction", input: { introduction_id: introduction.id, reponse: "question" } }, { tool: "repondre_introduction", input: { introduction_id: introduction.id, reponse: "accepter", message: "Samedi 10h ?" } }], text: (r) => r.join("\n") });
    const answer = await brain.generate(turn("J'accepte"));
    expect(answer.reply.text).toContain("Refusé : écrivez la question à transmettre.");
    expect(answer.reply.text).toContain("Carte de validation affichée : Accepter la mise en relation");
    expect(answer.reply.proposals).toHaveLength(1);
    const card = answer.reply.proposals[0];
    expect(card.summary).toContain("MAAQ transmet au membre votre contact « WhatsApp, après accord — 0612345678 » et vous transmet le sien");
    expect(card.summary).toContain("Votre mot : « Samedi 10h ? »");
    expect((await m.store.getIntroduction(introduction.id))!.status).toBe("requested");
    expect(m.posted.filter((p) => p.userId === "camille")).toEqual([]);

    await card.execute();
    expect((await m.store.getIntroduction(introduction.id))!.status).toBe("connected");
    expect(m.posted.find((p) => p.userId === "camille")!.text).toContain("0612345678");
    // Double validation : sans effet.
    await card.execute();
    expect(m.posted.filter((p) => p.userId === "camille")).toHaveLength(1);
  });
});

describe("transfert — base et boutons WhatsApp", () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = testDb();
  });
  afterAll(async () => {
    await db.destroy();
  });

  it("les boutons WhatsApp du fournisseur font la même transition que la carte, sans passer par kdo_help", async () => {
    const clock = new Date("2026-10-22T10:00:00Z");
    const buyer = await createProfile(db);
    const supplier = await createProfile(db);
    const transport = new MemoryWhatsApp();
    // Les dépendances de l'application lisent le transport global : on le remplace le temps du test.
    useWhatsAppTransport(transport);
    const mock = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0, now: () => clock });
    globalThis.__maaqDigitorn = mock;
    const core = new WhatsAppCore({ db, now: () => clock, transport, slowAfterMs: 0 });
    const WA = `337${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const inbound = (overrides: Partial<InboundMessage>): InboundMessage => ({ externalId: `wamid.${Math.random()}`, from: WA, profileName: "Sarah", receivedAt: clock, type: "text", text: null, buttonId: null, buttonTitle: null, ...overrides });
    const receive = async (message: InboundMessage) => {
      await core.handleWebhook({ messages: [message], statuses: [] });
      await core.queue.settle();
    };
    const offer = await createLinkCode({ db, now: clock }, await sessionFor(db, supplier.id));
    await receive(inbound({ text: offer.code }));

    const storefronts = new DbStorefrontStore(db, undefined, () => clock);
    const sf = await publish(storefronts, supplier.id, { displayName: `Sarah ${supplier.id.slice(0, 4)}` });
    const store = new DbMatchStore(db, () => clock);
    const introduction = await store.createIntroduction({ suggestionId: null, buyerUserId: buyer.id, storefrontId: sf.id, sharedText: "Camille cherche des tresses." });
    const deps = appHandoffDeps(db, () => clock);
    expect((await notifySupplierOfIntroduction(deps, introduction, sf)).whatsapp).toBe(true);
    const sent = transport.sent.at(-1)!;
    expect(sent.kind).toBe("buttons"); // le code de liaison vient d'ouvrir la fenêtre de 24 h
    if (sent.kind !== "buttons") throw new Error("boutons attendus");
    const supplierRef = await ensureDigitornRef(db, supplier.id);
    expect((await mock.getConversation(supplierRef, "vitrine")).map((e) => e.type)).toEqual(["agent_message"]);

    await receive(inbound({ type: "button", buttonId: sent.buttons[2].id, buttonTitle: "Question" }));
    expect(transport.sent.at(-1)).toMatchObject({ text: MESSAGES.introduction.question });
    expect((await store.getIntroduction(introduction.id))!.status).toBe("requested");

    await receive(inbound({ type: "button", buttonId: sent.buttons[0].id, buttonTitle: "Accepter" }));
    expect(transport.sent.at(-1)).toMatchObject({ text: MESSAGES.introduction.accept });
    expect((await store.getIntroduction(introduction.id))!).toMatchObject({ status: "connected", connectedAt: clock.toISOString() });
    const buyerRef = await ensureDigitornRef(db, buyer.id);
    const toBuyer = await mock.getConversation(buyerRef, "coup_de_main");
    expect(toBuyer).toHaveLength(1);
    expect(toBuyer[0]).toMatchObject({ type: "agent_message", text: expect.stringContaining("0612345678") });
    expect((await mock.getConversation(supplierRef, "vitrine")).at(-1)).toMatchObject({ type: "agent_message", text: expect.stringContaining(buyer.email) });

    await receive(inbound({ type: "button", buttonId: sent.buttons[1].id, buttonTitle: "Refuser" }));
    expect(transport.sent.at(-1)).toMatchObject({ text: "Cette mise en relation est déjà faite (contacts échangés)." });
    expect((await db.selectFrom("channel_messages").select("direction").where("user_id", "=", supplier.id).where("direction", "=", "outbound").execute()).length).toBeGreaterThanOrEqual(2);
    useWhatsAppTransport(undefined);
  });
});
