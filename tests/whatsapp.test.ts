import { createHmac } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockDigitorn } from "@/server/adapters/digitorn/mock";
import { cloudApiBody, parseWebhook, verifySignature } from "@/server/adapters/whatsapp/cloud";
import { MemoryWhatsApp } from "@/server/adapters/whatsapp/dev-outbox";
import { TEMPLATES } from "@/server/adapters/whatsapp/templates";
import type { InboundMessage } from "@/server/adapters/whatsapp/types";
import { kdoHelpBrain } from "@/server/agents/kdo-help";
import { createLinkCode, LINK_CODE_MINUTES } from "@/server/channels/linking";
import { clampButtons, renderAgentReply, splitText, toWhatsAppText } from "@/server/channels/render";
import { MESSAGES, requestIdFor, WhatsAppCore } from "@/server/channels/whatsapp-core";
import type { DB } from "@/server/db/schema.generated";
import { DbGiftStore } from "@/server/gifts/db-store";
import { DbPrefsStore } from "@/server/gifts/prefs";
import { runGiftReminders } from "@/server/gifts/reminders";
import { userIdOfRef } from "@/server/gifts/service";
import { fakeLlm, type ScriptStep } from "./helpers/fake-llm";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
let clock: Date;
let transport: MemoryWhatsApp;
let mock: MockDigitorn;
let core: WhatsAppCore;
let script: ScriptStep[];

/** Numéro de l'expéditeur, différent à chaque test : la base persiste d'un test à l'autre et un numéro ne se relie qu'à un profil. */
let WA = "";

beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

beforeEach(() => {
  clock = new Date("2026-10-07T10:00:00Z");
  WA = `336${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  transport = new MemoryWhatsApp();
  script = [];
  const fake = fakeLlm(script);
  const store = new DbGiftStore(db, () => clock);
  mock = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0, now: () => clock, brains: [kdoHelpBrain(fake.llm, { store, prefs: new DbPrefsStore(db), userIdOf: (ref) => userIdOfRef(db, ref) })] });
  globalThis.__maaqDigitorn = mock;
  core = new WhatsAppCore({ db, now: () => clock, transport, slowAfterMs: 0 });
});

/** Profil actif avec kdo_help sur son dashboard. */
async function profileWithKdoHelp() {
  const user = await createProfile(db);
  const category = await db.selectFrom("agent_categories").select("id").where("code", "=", "perso").executeTakeFirstOrThrow();
  await db
    .insertInto("agents")
    .values({ digitorn_agent_ref: "kdo_help", name: "kdo_help", category_id: category.id, short_description: "Cadeaux", full_description: "Cadeaux", cc_addresses_max_count: 0 })
    .onConflict((oc) => oc.column("digitorn_agent_ref").doNothing())
    .execute();
  const agent = await db.selectFrom("agents").select("id").where("digitorn_agent_ref", "=", "kdo_help").executeTakeFirstOrThrow();
  await db.insertInto("profile_agents").values({ user_id: user.id, agent_id: agent.id }).execute();
  return { user, agentId: agent.id };
}

function inbound(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { externalId: `wamid.${Math.random()}`, from: WA, profileName: "Camille", receivedAt: clock, type: "text", text, buttonId: null, buttonTitle: null, ...overrides };
}

async function receive(message: InboundMessage) {
  const result = await core.handleWebhook({ messages: [message], statuses: [] });
  await core.queue.settle();
  await mock.settle();
  return result;
}

const lastSent = () => transport.sent.at(-1)!;

async function linkNumber(userId: string, number = WA) {
  const offer = await createLinkCode({ db, now: clock }, await sessionFor(db, userId));
  await receive(inbound(offer.code, { from: number }));
  return offer;
}

describe("WhatsApp — Cloud API", () => {
  it("vérifie la signature du webhook", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifySignature(body, signature, "secret")).toBe(true);
    expect(verifySignature(body, signature, "autre")).toBe(false);
    expect(verifySignature(body, null, "secret")).toBe(false);
  });

  it("lit les messages texte, les réponses aux boutons, les vocaux et les accusés de remise", () => {
    const payload = parseWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: WA, profile: { name: "Camille" } }],
                messages: [
                  { id: "wamid.1", from: WA, timestamp: "1791367200", type: "text", text: { body: "Bonjour" } },
                  { id: "wamid.2", from: WA, timestamp: "1791367201", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "decide:x:validate", title: "Valider" } } },
                  { id: "wamid.3", from: WA, timestamp: "1791367202", type: "button", button: { payload: "ideas:person:1:2026", text: "Voir les idées" } },
                  { id: "wamid.4", from: WA, timestamp: "1791367203", type: "audio", audio: { id: "m" } },
                ],
                statuses: [{ id: "wamid.out", status: "delivered", timestamp: "1791367204" }],
              },
            },
          ],
        },
      ],
    });
    expect(payload.messages.map((m) => [m.type, m.text, m.buttonId, m.profileName])).toEqual([
      ["text", "Bonjour", null, "Camille"],
      ["button", "Valider", "decide:x:validate", "Camille"],
      ["button", "Voir les idées", "ideas:person:1:2026", "Camille"],
      ["audio", null, null, "Camille"],
    ]);
    expect(payload.statuses).toEqual([{ externalId: "wamid.out", status: "delivered", at: new Date(1791367204000) }]);
  });

  it("construit les corps d'envoi attendus par l'API", () => {
    expect(cloudApiBody({ kind: "text", to: WA, text: "Salut" })).toMatchObject({ messaging_product: "whatsapp", to: WA, type: "text", text: { body: "Salut" } });
    expect(cloudApiBody({ kind: "buttons", to: WA, text: "Ok ?", buttons: [{ id: "a", title: "Oui" }] })).toMatchObject({ type: "interactive", interactive: { type: "button", action: { buttons: [{ type: "reply", reply: { id: "a", title: "Oui" } }] } } });
    const template = cloudApiBody({ kind: "template", to: WA, name: "maaq_rappel_occasions", language: "fr", bodyParams: ["Camille", "Noël"], buttonPayloads: ["ideas:k", "snooze:k"] });
    expect(template).toMatchObject({ type: "template", template: { name: "maaq_rappel_occasions", language: { code: "fr" } } });
    expect((template.template as { components: unknown[] }).components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Camille" }, { type: "text", text: "Noël" }] },
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "ideas:k" }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "snooze:k" }] },
    ]);
  });
});

describe("WhatsApp — rendu", () => {
  it("respecte les limites : 4 096 caractères, 3 boutons de 20 caractères, mise en forme WhatsApp", () => {
    expect(toWhatsAppText("## Titre\n**gras**\n- puce")).toBe("Titre\n*gras*\n• puce");
    const long = Array.from({ length: 300 }, (_, i) => `Ligne ${i} ${"x".repeat(20)}`).join("\n");
    const parts = splitText(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
    expect(parts.join("\n")).toBe(long);
    expect(clampButtons([{ id: "1", title: "Un titre vraiment beaucoup trop long" }, { id: "2", title: "B" }, { id: "3", title: "C" }, { id: "4", title: "D" }])).toEqual([
      { id: "1", title: "Un titre vraiment b…" },
      { id: "2", title: "B" },
      { id: "3", title: "C" },
    ]);
  });

  it("rend une réponse avec une carte à valider en message à deux boutons", () => {
    const messages = renderAgentReply(WA, "Validez la carte.", [{ proposalId: "p1", kind: "other", summary: "Supprimer Sam", participants: [], status: "pending" }]);
    expect(messages).toEqual([
      { kind: "text", to: WA, text: "Validez la carte." },
      { kind: "buttons", to: WA, text: "*Action proposée — validation requise*\nSupprimer Sam", buttons: [{ id: "decide:p1:validate", title: "Valider" }, { id: "decide:p1:refuse", title: "Refuser" }] },
    ]);
  });
});

describe("WhatsApp — liaison et conversation", () => {
  it("un numéro inconnu reçoit la marche à suivre, sans accès à rien", async () => {
    await receive(inbound("Bonjour"));
    expect(transport.sent).toEqual([{ kind: "text", to: WA, text: MESSAGES.unknownNumber }]);
  });

  it("relie le numéro par un code valable 10 minutes, et refuse un code expiré ou un numéro déjà pris", async () => {
    const { user } = await profileWithKdoHelp();
    const offer = await createLinkCode({ db, now: clock }, await sessionFor(db, user.id));
    expect(offer.url).toContain(`wa.me/`);
    expect(offer.url).toContain(encodeURIComponent(offer.code));

    clock = new Date(clock.getTime() + (LINK_CODE_MINUTES + 1) * 60_000);
    await receive(inbound(offer.code));
    expect(lastSent()).toMatchObject({ kind: "text", text: MESSAGES.invalidCode });

    const fresh = await createLinkCode({ db, now: clock }, await sessionFor(db, user.id));
    await receive(inbound(`voici mon code ${fresh.code.toLowerCase()}`));
    expect(lastSent()).toMatchObject({ kind: "text", text: TEMPLATES.welcome.body.replace("{{1}}", "Camille") });
    const identity = await db.selectFrom("channel_identities").selectAll().where("user_id", "=", user.id).executeTakeFirstOrThrow();
    expect(identity).toMatchObject({ channel: "whatsapp", external_id: WA, opt_in: true, consent_version: "whatsapp-2026-10" });

    const other = await createProfile(db);
    const otherOffer = await createLinkCode({ db, now: clock }, await sessionFor(db, other.id));
    await receive(inbound(otherOffer.code));
    expect(lastSent()).toMatchObject({ text: MESSAGES.takenNumber });
  });

  it("relaie un message au tchat de kdo_help et renvoie la réponse, dans le même fil que l'application", async () => {
    const { user } = await profileWithKdoHelp();
    await linkNumber(user.id);
    script.push({ text: "Bonjour Camille, que puis-je faire ?" });

    const message = inbound("Bonjour");
    const first = await receive(message);
    expect(first).toEqual({ queued: 1, duplicates: 0, statuses: 0 });
    expect(lastSent()).toEqual({ kind: "text", to: WA, text: "Bonjour Camille, que puis-je faire ?" });

    const userRef = (await db.selectFrom("users").select("digitorn_user_ref").where("id", "=", user.id).executeTakeFirstOrThrow()).digitorn_user_ref!;
    const events = await mock.getConversation(userRef, "kdo_help");
    expect(events.map((e) => e.type)).toEqual(["user_message", "agent_message"]);
    expect(events[0]).toMatchObject({ type: "user_message", text: "Bonjour", channel: "whatsapp", requestId: requestIdFor(message.externalId) });

    // La relance de Meta renvoie le même message : rien ne repart.
    const again = await receive(message);
    expect(again).toEqual({ queued: 0, duplicates: 1, statuses: 0 });
    expect(transport.sent).toHaveLength(2);

    const rows = await db.selectFrom("channel_messages").select(["direction", "status", "request_id"]).where("user_id", "=", user.id).orderBy("created_at").execute();
    expect(rows).toEqual([{ direction: "outbound", status: "sent", request_id: null }, { direction: "outbound", status: "sent", request_id: requestIdFor(message.externalId) }]);
    await core.handleWebhook({ messages: [], statuses: [{ externalId: transport.ids[1], status: "read", at: clock }] });
    expect((await db.selectFrom("channel_messages").select("status").where("external_id", "=", transport.ids[1]).executeTakeFirstOrThrow()).status).toBe("read");
  });

  it("une suppression demandée depuis WhatsApp passe par des boutons, et n'a lieu qu'après l'appui sur Valider", async () => {
    const { user } = await profileWithKdoHelp();
    await linkNumber(user.id);
    const store = new DbGiftStore(db);
    const sam = await store.createPerson(user.id, { name: "Sam" });
    script.push({ calls: [{ tool: "supprimer_proche", input: { id: sam.id } }], text: "Validez pour supprimer Sam." });

    await receive(inbound("Supprime Sam"));
    const card = lastSent();
    expect(card.kind).toBe("buttons");
    if (card.kind !== "buttons") throw new Error("boutons attendus");
    expect(card.buttons.map((b) => b.title)).toEqual(["Valider", "Refuser"]);
    expect(await store.listPeople(user.id)).toHaveLength(1);

    await receive(inbound("Valider", { type: "button", buttonId: card.buttons[0].id, buttonTitle: "Valider" }));
    expect(lastSent()).toMatchObject({ text: MESSAGES.decided.validate });
    expect(await store.listPeople(user.id)).toHaveLength(0);

    await receive(inbound("Valider", { type: "button", buttonId: card.buttons[0].id, buttonTitle: "Valider" }));
    expect(lastSent()).toMatchObject({ text: "Cette action avait déjà reçu une réponse." });
  });

  it("STOP coupe les rappels, REPRENDRE les réactive, les vocaux reçoivent une réponse polie", async () => {
    const { user } = await profileWithKdoHelp();
    await linkNumber(user.id);
    await receive(inbound("STOP"));
    expect(lastSent()).toMatchObject({ text: MESSAGES.stopped });
    expect((await db.selectFrom("channel_identities").select("opt_in").where("user_id", "=", user.id).executeTakeFirstOrThrow()).opt_in).toBe(false);
    await receive(inbound("reprendre"));
    expect((await db.selectFrom("channel_identities").select("opt_in").where("user_id", "=", user.id).executeTakeFirstOrThrow()).opt_in).toBe(true);
    await receive(inbound("", { type: "audio", text: null }));
    expect(lastSent()).toMatchObject({ text: MESSAGES.audio });
  });

  it("refuse les messages sans kdo_help au dashboard, et limite le débit par numéro", async () => {
    const user = await createProfile(db);
    await linkNumber(user.id);
    await receive(inbound("Bonjour"));
    expect(lastSent()).toMatchObject({ text: MESSAGES.noAgent });

    for (let i = 0; i < 32; i++) await receive(inbound("STOP"));
    const texts = transport.sent.map((m) => (m.kind === "text" ? m.text : ""));
    expect(texts.filter((t) => t === MESSAGES.rateLimited)).toHaveLength(1);
    // 1 bienvenue + 1 « noAgent » + 28 STOP traités (30 par minute, deux déjà consommés) + 1 avertissement
    expect(texts.filter((t) => t === MESSAGES.stopped)).toHaveLength(28);
  });

  it("une panne d'envoi est journalisée sans bloquer la file", async () => {
    const { user } = await profileWithKdoHelp();
    await linkNumber(user.id);
    script.push({ text: "Réponse 1" }, { text: "Réponse 2" });
    transport.failNext = 1;
    await receive(inbound("Un"));
    await receive(inbound("Deux"));
    expect(transport.sent.map((m) => (m.kind === "text" ? m.text : "")).slice(-1)).toEqual(["Réponse 2"]);
  });
});

describe("Rappels d'occasions", () => {
  async function userWithBirthdayIn(days: number, name = "Léa") {
    const { user } = await profileWithKdoHelp();
    const store = new DbGiftStore(db, () => clock);
    const date = new Date(clock.getTime() + days * 86_400_000);
    await store.createPerson(user.id, { name, relationship: "fille", birthDay: date.getUTCDate(), birthMonth: date.getUTCMonth() + 1, birthYear: 2019 });
    return { user, store };
  }

  function deps(postInApp: (userId: string, text: string) => Promise<void> = async () => {}) {
    return { db, now: clock, store: new DbGiftStore(db, () => clock), prefs: new DbPrefsStore(db), transport, postInApp };
  }

  it("dépose un rappel dans l'application à T-7, une seule fois, et saute une occasion réglée", async () => {
    const { user, store } = await userWithBirthdayIn(6);
    const posted: string[] = [];
    const first = await runGiftReminders(deps(async (_, text) => void posted.push(text)));
    expect(first.sent).toBeGreaterThanOrEqual(1);
    expect(posted).toEqual([`Bonjour Camille, une date approche : l'anniversaire de Léa (7 ans) dans 6 jours (${new Date(clock.getTime() + 6 * 86_400_000).toISOString().slice(0, 10).split("-").reverse().join("/")}). Souhaitez-vous des idées de cadeaux ?`]);
    const rows = await db.selectFrom("gift_notifications").select(["reminder_point", "channel", "status"]).where("user_id", "=", user.id).execute();
    expect(rows).toEqual([{ reminder_point: "T-7", channel: "web", status: "sent" }]);

    await runGiftReminders(deps(async (_, text) => void posted.push(text)));
    expect(posted).toHaveLength(1);

    // Deux jours plus tard : T-2 est due ; mais l'occasion réglée n'envoie rien.
    clock = new Date(clock.getTime() + 4 * 86_400_000);
    const [occasionRow] = rows;
    void occasionRow;
    const key = (await db.selectFrom("gift_notifications").select("occasion_key").where("user_id", "=", user.id).executeTakeFirstOrThrow()).occasion_key;
    await store.setState(user.id, key, { sortedAt: clock.toISOString() });
    await runGiftReminders(deps(async (_, text) => void posted.push(text)));
    expect(posted).toHaveLength(1);
  });

  it("sur WhatsApp : modèle hors fenêtre de 24 h, message libre à boutons dans la fenêtre, rien pendant les heures calmes", async () => {
    const { user } = await userWithBirthdayIn(20);
    await linkNumber(user.id);
    await new DbPrefsStore(db).set(user.id, { reminderChannel: "whatsapp" });
    transport.sent.length = 0;

    // Dernier message reçu il y a 2 jours : fenêtre fermée → modèle approuvé.
    await db.updateTable("channel_identities").set({ last_inbound_at: new Date(clock.getTime() - 2 * 86_400_000) }).where("user_id", "=", user.id).execute();
    await runGiftReminders(deps());
    expect(lastSent()).toMatchObject({ kind: "template", to: WA, name: TEMPLATES.occasion_reminder.name, bodyParams: ["Camille", expect.stringContaining("l'anniversaire de Léa (7 ans) dans 20 jours")] });
    expect((lastSent() as { buttonPayloads: string[] }).buttonPayloads.map((p) => p.split(":")[0])).toEqual(["ideas", "snooze", "sorted"]);
    const rows = await db.selectFrom("gift_notifications").select(["reminder_point", "channel", "template_name"]).where("user_id", "=", user.id).execute();
    expect(rows).toEqual([{ reminder_point: "T-21", channel: "whatsapp", template_name: TEMPLATES.occasion_reminder.name }]);

    // 14 jours plus tard (T-7), fenêtre ouverte, mais 22 h à Paris : heures calmes.
    clock = new Date("2026-10-21T20:30:00Z");
    await db.updateTable("channel_identities").set({ last_inbound_at: clock }).where("user_id", "=", user.id).execute();
    const quiet = await runGiftReminders(deps());
    expect(quiet.quiet).toBe(1);
    expect(transport.sent).toHaveLength(1);

    // Le lendemain matin : message libre avec boutons.
    clock = new Date("2026-10-22T08:30:00Z");
    await db.updateTable("channel_identities").set({ last_inbound_at: clock }).where("user_id", "=", user.id).execute();
    await runGiftReminders(deps());
    expect(lastSent()).toMatchObject({ kind: "buttons", to: WA, buttons: [expect.objectContaining({ title: "Voir les idées" }), expect.objectContaining({ title: "Plus tard" }), expect.objectContaining({ title: "C'est réglé" })] });
  });

  it("retombe sur l'application quand WhatsApp est demandé sans numéro relié, et réessaie après une panne d'envoi", async () => {
    const { user } = await userWithBirthdayIn(1);
    await new DbPrefsStore(db).set(user.id, { reminderChannel: "whatsapp" });
    const posted: string[] = [];
    const result = await runGiftReminders(deps(async (_, text) => void posted.push(text)));
    expect(posted).toHaveLength(1);
    expect(result.quiet).toBe(1);

    const { user: other } = await userWithBirthdayIn(1, "Noé");
    await linkNumber(other.id, "33699999999");
    await new DbPrefsStore(db).set(other.id, { reminderChannel: "whatsapp" });
    transport.failNext = 1;
    const failed = await runGiftReminders(deps());
    expect(failed.failed).toBe(1);
    expect(await db.selectFrom("gift_notifications").selectAll().where("user_id", "=", other.id).execute()).toEqual([]);
    const retried = await runGiftReminders(deps());
    expect(retried.sent).toBe(1);
  });

  it("les boutons du rappel règlent ou reportent l'occasion", async () => {
    const { user, store } = await userWithBirthdayIn(5);
    await linkNumber(user.id);
    const [occasion] = await (await import("@/server/gifts/service")).occasionsFor(store, user.id, clock, "Europe/Paris", 30);
    await receive(inbound("C'est réglé", { type: "button", buttonId: `sorted:${occasion.key}`, buttonTitle: "C'est réglé" }));
    expect(lastSent()).toMatchObject({ text: MESSAGES.sorted });
    expect((await store.listStates(user.id))[0]).toMatchObject({ occasionKey: occasion.key, sortedAt: expect.any(String) });
    await receive(inbound("Plus tard", { type: "button", buttonId: `snooze:${occasion.key}`, buttonTitle: "Plus tard" }));
    expect((await store.listStates(user.id))[0].snoozedUntil).toBe("2026-10-10");
  });
});
