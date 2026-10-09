import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { digitorn, type ActionProposal, type ChatEvent } from "@/server/adapters/digitorn";
import { whatsapp } from "@/server/adapters/whatsapp";
import { TEMPLATES } from "@/server/adapters/whatsapp/templates";
import type { InboundMessage, InboundStatus, OutboundMessage, WebhookPayload, WhatsAppTransport } from "@/server/adapters/whatsapp/types";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { decideAction, sendMessage } from "@/server/chat/service";
import { db as appDb } from "@/server/db/client";
import type { DB } from "@/server/db/schema.generated";
import { frenchDate } from "@/server/gifts/model";
import { giftStore, occasionsFor, prefsStore } from "@/server/gifts/service";
import { Rejection } from "@/server/http";
import { ensureDigitornRef } from "@/server/profile/digitorn-ref";
import { consumeLinkCode, extractLinkCode, setOptIn } from "./linking";
import { KeyedQueue } from "./queue";
import { parseDecisionButton, renderAgentReply, toWhatsAppText } from "./render";

/**
 * Cœur de conversation côté WhatsApp : identifie la personne, fait passer sa demande par le même tchat que
 * l'application (plafond, agent bloqué, carnet de bord, historique partagé), puis renvoie la réponse sur
 * WhatsApp. Les réponses repartent toujours vers le canal d'origine.
 */

export const KDO_HELP_AGENT_REF = "kdo_help";
/** Messages acceptés par numéro et par minute, pour borner le coût et les abus. */
export const RATE_LIMIT_PER_MINUTE = 30;
/** Attente maximale d'une réponse de l'agent avant d'abandonner (le modèle avec outils peut prendre 20 à 30 s). */
const REPLY_TIMEOUT_MS = 90_000;
const REPLY_POLL_MS = 400;
const STOP_WORDS = new Set(["stop", "arret", "arrêt", "arrêter", "desabonner", "désabonner", "stopp"]);
const START_WORDS = new Set(["start", "reprendre", "reprise"]);

export const MESSAGES = {
  unknownNumber:
    "Bonjour ! Ce numéro n'est pas encore relié à un compte MAAQ. Dans l'application MAAQ : Réglages › WhatsApp et rappels › Connecter WhatsApp, puis envoyez-moi le code affiché.",
  invalidCode: "Ce code de liaison n'est pas valable ou a expiré (10 minutes). Générez-en un nouveau dans MAAQ : Réglages › WhatsApp et rappels.",
  takenNumber: "Ce numéro est déjà relié à un autre compte MAAQ. Déliez-le d'abord depuis cet autre compte.",
  stopped: "C'est noté : vous ne recevrez plus de rappels sur WhatsApp. Répondez REPRENDRE pour les réactiver. Vous pouvez toujours m'écrire ici.",
  resumed: "Les rappels WhatsApp sont réactivés.",
  audio: "Je ne sais pas encore écouter les messages vocaux : écrivez-moi votre demande en quelques mots.",
  unsupported: "Je ne sais pas encore lire ce type de message. Écrivez-moi votre demande en quelques mots.",
  noAgent: "Pour m'écrire ici, ajoutez d'abord l'agent kdo_help à votre dashboard dans l'application MAAQ.",
  inactive: "Votre compte MAAQ n'est pas actif pour le moment. Ouvrez l'application pour en savoir plus.",
  slow: "Je m'en occupe, un instant…",
  timeout: "Je n'ai pas réussi à répondre à temps. Réessayez dans un instant, ou ouvrez le tchat dans MAAQ.",
  decided: { validate: "C'est validé.", refuse: "C'est refusé : rien n'a été fait." },
  rateLimited: "Vous m'avez envoyé beaucoup de messages d'un coup. Attendez une minute avant de continuer.",
  sorted: "C'est noté : plus de rappel pour cette occasion.",
  snoozed: (date: string) => `C'est noté : je vous en reparle le ${date}.`,
};

/**
 * Identifiant de demande du tchat (UUID) dérivé de l'identifiant WhatsApp du message : stable, donc une
 * relance de Meta ne crée pas une seconde demande.
 */
export function requestIdFor(externalId: string): string {
  const hex = createHash("sha256").update(externalId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface CoreDeps {
  db?: Kysely<DB>;
  now?: () => Date;
  transport?: WhatsAppTransport;
  /** Délai avant le message « un instant » quand l'agent est lent ; 0 pour le désactiver. */
  slowAfterMs?: number;
}

interface LinkedUser {
  id: string;
  firstName: string;
  role: "primary_user" | "guest";
  optIn: boolean;
}

export class WhatsAppCore {
  readonly queue = new KeyedQueue();
  private readonly buckets = new Map<string, number[]>();
  private readonly dbRef: Kysely<DB> | undefined;
  private readonly nowFn: () => Date;
  private readonly transportRef: WhatsAppTransport | undefined;
  private readonly slowAfterMs: number;

  constructor(deps: CoreDeps = {}) {
    this.dbRef = deps.db;
    this.nowFn = deps.now ?? (() => new Date());
    this.transportRef = deps.transport;
    this.slowAfterMs = deps.slowAfterMs ?? 5_000;
  }

  private get db(): Kysely<DB> {
    return this.dbRef ?? appDb();
  }

  private get transport(): WhatsAppTransport {
    return this.transportRef ?? whatsapp();
  }

  private ctx(): Ctx {
    return { db: this.db, now: this.nowFn() };
  }

  /** Point d'entrée du webhook : accusés de remise tout de suite, messages en file par numéro. */
  async handleWebhook(payload: WebhookPayload): Promise<{ queued: number; duplicates: number; statuses: number }> {
    let statuses = 0;
    for (const status of payload.statuses) {
      await this.recordStatus(status);
      statuses++;
    }
    let queued = 0;
    let duplicates = 0;
    for (const message of payload.messages) {
      const fresh = await this.recordInbound(message);
      if (!fresh) {
        duplicates++;
        continue;
      }
      queued++;
      void this.queue.enqueue(message.from, () => this.processInbound(message));
    }
    return { queued, duplicates, statuses };
  }

  /** Vrai si le message n'avait jamais été vu (les relances de Meta renvoient le même wamid). */
  private async recordInbound(message: InboundMessage): Promise<boolean> {
    const inserted = await this.db
      .insertInto("channel_messages")
      .values({ channel: "whatsapp", external_id: message.externalId, direction: "inbound", status: "received", created_at: this.nowFn(), updated_at: this.nowFn() })
      .onConflict((oc) => oc.columns(["channel", "external_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    return Boolean(inserted);
  }

  private async recordStatus(status: InboundStatus): Promise<void> {
    await this.db.updateTable("channel_messages").set({ status: status.status, updated_at: this.nowFn() }).where("channel", "=", "whatsapp").where("external_id", "=", status.externalId).execute();
  }

  private allowed(waId: string): boolean {
    const now = this.nowFn().getTime();
    const recent = (this.buckets.get(waId) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.buckets.set(waId, recent);
    return recent.length <= RATE_LIMIT_PER_MINUTE;
  }

  /** Envoie et consigne un message sortant ; une panne d'envoi est journalisée, jamais propagée à la file. */
  async deliver(userId: string | null, message: OutboundMessage, requestId: string | null = null): Promise<boolean> {
    try {
      const { messageId } = await this.transport.send(message);
      await this.db
        .insertInto("channel_messages")
        .values({ user_id: userId, channel: "whatsapp", external_id: messageId, direction: "outbound", status: "sent", request_id: requestId, created_at: this.nowFn(), updated_at: this.nowFn() })
        .onConflict((oc) => oc.columns(["channel", "external_id"]).doNothing())
        .execute();
      return true;
    } catch (error) {
      console.error("[whatsapp] envoi échoué :", error);
      return false;
    }
  }

  private text(to: string, text: string, userId: string | null = null, requestId: string | null = null): Promise<boolean> {
    return this.deliver(userId, { kind: "text", to, text }, requestId);
  }

  private async linkedUser(waId: string): Promise<LinkedUser | null> {
    const row = await this.db
      .selectFrom("channel_identities as c")
      .innerJoin("users as u", "u.id", "c.user_id")
      .select(["u.id", "u.first_name", "u.role", "c.opt_in"])
      .where("c.channel", "=", "whatsapp")
      .where("c.external_id", "=", waId)
      .executeTakeFirst();
    if (!row || row.role === "admin") return null;
    return { id: row.id, firstName: row.first_name, role: row.role, optIn: row.opt_in };
  }

  /** Traitement d'un message reçu, dans l'ordre d'arrivée pour ce numéro. */
  async processInbound(message: InboundMessage): Promise<void> {
    const waId = message.from;
    if (!this.allowed(waId)) {
      // Un seul avertissement par fenêtre, sinon on nourrit l'abus.
      if ((this.buckets.get(waId)?.length ?? 0) === RATE_LIMIT_PER_MINUTE + 1) await this.text(waId, MESSAGES.rateLimited);
      return;
    }

    const code = extractLinkCode(message.text);
    if (code) {
      const outcome = await consumeLinkCode(this.db, this.nowFn(), code, waId);
      if (outcome.status === "linked") {
        await this.deliver(outcome.userId, { kind: "text", to: waId, text: TEMPLATES.welcome.body.replace("{{1}}", outcome.firstName) });
      } else {
        await this.text(waId, outcome.status === "taken" ? MESSAGES.takenNumber : MESSAGES.invalidCode);
      }
      return;
    }

    const user = await this.linkedUser(waId);
    if (!user) {
      await this.text(waId, MESSAGES.unknownNumber);
      return;
    }
    await this.db.updateTable("channel_identities").set({ last_inbound_at: this.nowFn() }).where("channel", "=", "whatsapp").where("external_id", "=", waId).execute();

    const word = message.text?.trim().toLowerCase() ?? "";
    if (STOP_WORDS.has(word)) {
      await setOptIn(this.db, this.nowFn(), waId, false);
      await this.text(waId, MESSAGES.stopped, user.id);
      return;
    }
    if (START_WORDS.has(word)) {
      await setOptIn(this.db, this.nowFn(), waId, true);
      await this.text(waId, MESSAGES.resumed, user.id);
      return;
    }
    if (message.type === "audio") {
      await this.text(waId, MESSAGES.audio, user.id);
      return;
    }
    if (message.type !== "text" && message.type !== "button") {
      await this.text(waId, MESSAGES.unsupported, user.id);
      return;
    }

    const session = await this.sessionFor(user.id);
    if (!session) {
      await this.text(waId, MESSAGES.inactive, user.id);
      return;
    }
    const agentId = await this.kdoHelpAgentId(user.id);
    if (!agentId) {
      await this.text(waId, MESSAGES.noAgent, user.id);
      return;
    }

    if (message.type === "button" && message.buttonId) {
      await this.handleButton(waId, user, session, agentId, message.buttonId);
      return;
    }
    await this.relayText(waId, user, session, agentId, requestIdFor(message.externalId), message.text ?? "");
  }

  private async handleButton(waId: string, user: LinkedUser, session: SessionContext, agentId: string, buttonId: string): Promise<void> {
    const decision = parseDecisionButton(buttonId);
    if (decision) {
      try {
        const result = await decideAction(this.ctx(), session, { agentId, proposalId: decision.proposalId, decision: decision.decision });
        const text = result.alreadyDecided ? "Cette action avait déjà reçu une réponse." : MESSAGES.decided[decision.decision];
        await this.text(waId, text, user.id);
      } catch (error) {
        await this.text(waId, error instanceof Rejection ? error.message : "Je n'ai pas pu enregistrer votre réponse. Réessayez depuis l'application.", user.id);
      }
      return;
    }

    const [action, key] = buttonId.split(":", 2);
    const occasionKey = buttonId.slice(action.length + 1);
    if (action === "sorted" && key) {
      await giftStore(this.db).setState(user.id, occasionKey, { sortedAt: this.nowFn().toISOString() });
      await this.text(waId, MESSAGES.sorted, user.id);
      return;
    }
    if (action === "snooze" && key) {
      const until = new Date(this.nowFn().getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
      await giftStore(this.db).setState(user.id, occasionKey, { snoozedUntil: until });
      await this.text(waId, MESSAGES.snoozed(frenchDate(until)), user.id);
      return;
    }
    if (action === "ideas" && key) {
      const prefs = await prefsStore(this.db).get(user.id);
      const occasion = (await occasionsFor(giftStore(this.db), user.id, this.nowFn(), prefs.timezone, 366)).find((o) => o.key === occasionKey);
      const text = occasion ? `Des idées de cadeau pour ${occasion.title} (le ${frenchDate(occasion.date)}) ?` : "Des idées de cadeau pour l'occasion qui approche ?";
      await this.relayText(waId, user, session, agentId, requestIdFor(`${buttonId}:${this.nowFn().getTime()}`), text);
      return;
    }
    await this.text(waId, MESSAGES.unsupported, user.id);
  }

  /** La demande suit exactement le chemin de l'application, puis la réponse repart sur WhatsApp. */
  private async relayText(waId: string, user: LinkedUser, session: SessionContext, agentId: string, requestId: string, text: string): Promise<void> {
    const ctx = this.ctx();
    try {
      await sendMessage(ctx, session, { agentId, requestId, text, channel: "whatsapp" });
    } catch (error) {
      if (!(error instanceof Rejection)) console.error("[whatsapp] transmission au tchat échouée :", error);
      await this.text(waId, error instanceof Rejection ? error.message : "Je n'ai pas pu transmettre votre demande. Réessayez dans un instant.", user.id);
      return;
    }

    const userRef = await ensureDigitornRef(this.db, user.id);
    const reply = await this.awaitReply(userRef, requestId, waId, user.id);
    if (!reply) {
      await this.text(waId, MESSAGES.timeout, user.id, requestId);
      return;
    }
    for (const outbound of renderAgentReply(waId, reply.text, reply.proposals)) await this.deliver(user.id, outbound, requestId);
  }

  /** Relit la conversation jusqu'à la réponse de l'agent (traitement asynchrone côté Digitorn). */
  private async awaitReply(userRef: string, requestId: string, waId: string, userId: string): Promise<{ text: string; proposals: ActionProposal[] } | null> {
    const started = this.nowFn().getTime();
    let warned = this.slowAfterMs <= 0;
    for (;;) {
      const events = await digitorn().getConversation(userRef, KDO_HELP_AGENT_REF);
      const mine = events.filter((e) => e.requestId === requestId && e.type !== "user_message");
      const answer = mine.find((e): e is Extract<ChatEvent, { type: "agent_message" }> => e.type === "agent_message");
      if (answer) {
        const proposals = mine.filter((e): e is Extract<ChatEvent, { type: "action_proposal" }> => e.type === "action_proposal").map((e) => e.proposal);
        return { text: answer.text, proposals };
      }
      const elapsed = this.nowFn().getTime() - started;
      if (elapsed > REPLY_TIMEOUT_MS) return null;
      if (!warned && elapsed > this.slowAfterMs) {
        warned = true;
        await this.text(waId, MESSAGES.slow, userId, requestId);
      }
      await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));
    }
  }

  /** Session « canal » d'un profil actif : même forme que la session de l'application, sans cookie ni appareil. */
  async sessionFor(userId: string): Promise<SessionContext | null> {
    const u = await this.db
      .selectFrom("users")
      .select(["id", "account_id", "role", "guest_rank", "first_name", "last_name", "email", "initial_setup_step", "status", "timezone"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!u || u.role === "admin" || u.status !== "active") return null;
    return {
      sessionId: `whatsapp:${u.id}`,
      user: {
        id: u.id,
        accountId: u.account_id,
        role: u.role,
        guestRank: u.guest_rank,
        firstName: u.first_name,
        lastName: u.last_name,
        email: u.email,
        setupCompleted: u.initial_setup_step === null || u.initial_setup_step === "completed",
        inGracePeriod: false,
      },
      device: { id: "whatsapp", type: "other", timezone: u.timezone, hasPattern: false, patternLocked: false },
    };
  }

  /** Identifiant de kdo_help s'il est sur le dashboard du profil. */
  async kdoHelpAgentId(userId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("profile_agents as pa")
      .innerJoin("agents as a", "a.id", "pa.agent_id")
      .select("a.id")
      .where("pa.user_id", "=", userId)
      .where("pa.removed_at", "is", null)
      .where("a.digitorn_agent_ref", "=", KDO_HELP_AGENT_REF)
      .executeTakeFirst();
    return row?.id ?? null;
  }
}

declare global {
  var __maaqWhatsAppCore: WhatsAppCore | undefined;
}

export function whatsappCore(): WhatsAppCore {
  globalThis.__maaqWhatsAppCore ??= new WhatsAppCore();
  return globalThis.__maaqWhatsAppCore;
}

export { toWhatsAppText };
