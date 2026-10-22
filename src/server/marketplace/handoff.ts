import { TEMPLATES } from "@/server/adapters/whatsapp/templates";
import type { OutboundMessage, WhatsAppTransport } from "@/server/adapters/whatsapp/types";
import { frenchDate } from "@/server/gifts/model";
import { supplierNotice } from "./introduction";
import type { Introduction, MatchStore } from "./match-store";
import { CONTACT_LABEL, type Storefront } from "./model";
import { INTRODUCTION_EXPIRY_DAYS } from "./rules";
import type { StorefrontStore } from "./store";

/**
 * Transfert d'une mise en relation au fournisseur et retour vers l'acheteur (phase 3, US-07, US-08, US-15).
 * Le fournisseur accepte, refuse ou pose une question depuis son tchat vitrine (carte à valider) ou depuis les
 * boutons WhatsApp ; MAAQ met le statut à jour et prévient l'acheteur dans son tchat coup_de_main. Accepter
 * échange les contacts choisis et clôt la mise en relation comme « connected » : aucune coordonnée ne circule
 * avant. Sans réponse sous INTRODUCTION_EXPIRY_DAYS, elle expire.
 */

export const COUP_DE_MAIN_AGENT = "coup_de_main";
export const VITRINE_AGENT = "vitrine";

export interface BuyerContact {
  firstName: string;
  email: string;
  phone: string | null;
}

/** Identité WhatsApp reliée d'un profil, pour un envoi hors application. */
export interface WhatsAppIdentity {
  waId: string;
  optIn: boolean;
  /** Dernier message reçu de la personne : ouvre la fenêtre de 24 h des messages libres. */
  lastInboundAt: string | null;
}

export interface HandoffDeps {
  store: MatchStore;
  storefronts: StorefrontStore;
  now: () => Date;
  /** Dépose un message d'un agent (coup_de_main ou vitrine) dans le tchat d'un profil. */
  postInApp: (userId: string, agentRef: string, text: string) => Promise<void>;
  buyerContactOf: (userId: string) => Promise<BuyerContact | null>;
  supplierFirstNameOf?: (userId: string) => Promise<string | null>;
  /** WhatsApp du fournisseur, facultatif : sans transport ou sans identité reliée, l'application suffit. */
  whatsapp?: { transport: WhatsAppTransport; identityOf: (userId: string) => Promise<WhatsAppIdentity | null>; record?: (userId: string, messageId: string) => Promise<void> };
}

export type SupplierResponse = "accept" | "decline" | "question";

export class HandoffRefused extends Error {
  constructor(
    readonly code: "not_found" | "not_yours" | "already_answered" | "message_required",
    message: string,
  ) {
    super(message);
    this.name = "HandoffRefused";
  }
}

const WINDOW_24H_MS = 24 * 3_600_000;

export function introductionButtons(introductionId: string) {
  return [
    { id: `intro:${introductionId}:accept`, title: "Accepter" },
    { id: `intro:${introductionId}:decline`, title: "Refuser" },
    { id: `intro:${introductionId}:question`, title: "Question" },
  ];
}

export function parseIntroductionButton(id: string): { introductionId: string; response: SupplierResponse } | null {
  const match = /^intro:([^:]+):(accept|decline|question)$/.exec(id);
  return match ? { introductionId: match[1], response: match[2] as SupplierResponse } : null;
}

/** Message au fournisseur, dans son tchat vitrine et, si relié et consentant, sur WhatsApp (modèle ou boutons). */
export async function notifySupplierOfIntroduction(deps: HandoffDeps, introduction: Introduction, storefront: Pick<Storefront, "userId" | "displayName">): Promise<{ whatsapp: boolean }> {
  await deps.postInApp(storefront.userId, VITRINE_AGENT, supplierNotice(introduction, storefront));
  if (!deps.whatsapp) return { whatsapp: false };
  const identity = await deps.whatsapp.identityOf(storefront.userId);
  if (!identity?.optIn) return { whatsapp: false };
  const firstName = (await deps.supplierFirstNameOf?.(storefront.userId)) ?? "";
  const inWindow = identity.lastInboundAt !== null && deps.now().getTime() - new Date(identity.lastInboundAt).getTime() < WINDOW_24H_MS;
  const name = storefront.displayName ?? "Sans nom";
  const message: OutboundMessage = inWindow
    ? { kind: "buttons", to: identity.waId, text: TEMPLATES.introduction_request.body.replace("{{1}}", firstName).replace("{{2}}", name).replace("{{3}}", introduction.sharedText).slice(0, 1024), buttons: introductionButtons(introduction.id) }
    : { kind: "template", to: identity.waId, name: TEMPLATES.introduction_request.name, language: TEMPLATES.introduction_request.language, bodyParams: [firstName, name, introduction.sharedText], buttonPayloads: introductionButtons(introduction.id).map((b) => b.id) };
  try {
    const { messageId } = await deps.whatsapp.transport.send(message);
    await deps.whatsapp.record?.(storefront.userId, messageId);
    return { whatsapp: true };
  } catch (error) {
    console.error("[marketplace] WhatsApp au fournisseur échoué (l'application suffit) :", error);
    return { whatsapp: false };
  }
}

/** Ce que l'acheteur lit quand le fournisseur accepte : le contact choisi sur la vitrine, rien de plus. */
export function contactForBuyer(storefront: Pick<Storefront, "displayName" | "contactMethod" | "contactValue">, buyer: BuyerContact | null): string {
  const name = storefront.displayName ?? "Le fournisseur";
  const how = storefront.contactMethod ? CONTACT_LABEL[storefront.contactMethod] : "Contact";
  const shared = buyer ? `Vos coordonnées (prénom, ${buyer.phone ? "email et téléphone" : "email"}) lui ont été transmises en retour.` : "";
  return `${name} a accepté votre demande. Voici comment le joindre — ${how} : ${storefront.contactValue ?? "non renseigné"}. ${shared} À vous de prendre contact ; MAAQ n'intervient plus.`.replace(/\s+/g, " ").trim();
}

/** Ce que le fournisseur lit quand il accepte : les coordonnées de l'acheteur. */
export function contactForSupplier(buyer: BuyerContact): string {
  return `Vous avez accepté : ${buyer.firstName} peut maintenant vous joindre avec le contact de votre vitrine. Ses coordonnées : ${buyer.email}${buyer.phone ? `, ${buyer.phone}` : ""}. Vous pouvez aussi la contacter directement.`;
}

export interface RespondInput {
  supplierUserId: string;
  introductionId: string;
  response: SupplierResponse;
  /** Question ou mot d'explication du fournisseur, transmis tel quel à l'acheteur. */
  message?: string | null;
}

/** Réponse du fournisseur : transition, message à l'acheteur, échange des contacts sur acceptation. */
export async function respondToIntroduction(deps: HandoffDeps, input: RespondInput): Promise<Introduction> {
  const introduction = await deps.store.getIntroduction(input.introductionId);
  if (!introduction) throw new HandoffRefused("not_found", "Cette mise en relation est introuvable.");
  const storefront = await deps.storefronts.getById(introduction.storefrontId);
  if (!storefront || storefront.userId !== input.supplierUserId) throw new HandoffRefused("not_yours", "Cette mise en relation ne concerne pas votre vitrine.");
  if (introduction.status !== "requested" && introduction.status !== "question") throw new HandoffRefused("already_answered", `Cette mise en relation est déjà ${describeStatus(introduction.status)}.`);
  const message = input.message?.trim() || null;
  if (input.response === "question" && !message) throw new HandoffRefused("message_required", "Écrivez la question à transmettre.");
  const at = deps.now().toISOString();
  const name = storefront.displayName ?? "Le fournisseur";

  if (input.response === "accept") {
    const updated = await deps.store.updateIntroduction(introduction.id, { status: "connected", answeredAt: at, connectedAt: at, supplierMessage: message });
    const buyer = await deps.buyerContactOf(introduction.buyerUserId);
    await deps.postInApp(introduction.buyerUserId, COUP_DE_MAIN_AGENT, `${contactForBuyer(storefront, buyer)}${message ? `\nMot de ${name} : « ${message} »` : ""}`);
    if (buyer) await deps.postInApp(storefront.userId, VITRINE_AGENT, contactForSupplier(buyer));
    return updated;
  }
  if (input.response === "decline") {
    const updated = await deps.store.updateIntroduction(introduction.id, { status: "declined", answeredAt: at, supplierMessage: message });
    await deps.postInApp(introduction.buyerUserId, COUP_DE_MAIN_AGENT, `${name} a décliné votre demande${message ? ` : « ${message} »` : ""}. Je ne vous reproposerai pas cette vitrine avant 90 jours ; dites-moi si vous voulez que je cherche quelqu'un d'autre.`);
    return updated;
  }
  const updated = await deps.store.updateIntroduction(introduction.id, { status: "question", answeredAt: at, supplierMessage: message });
  await deps.postInApp(introduction.buyerUserId, COUP_DE_MAIN_AGENT, `${name} a une question avant de répondre : « ${message} ». Répondez-moi ici et je lui transmets.`);
  return updated;
}

/** Réponse de l'acheteur à la question du fournisseur, transmise telle quelle dans le tchat vitrine. */
export async function answerSupplierQuestion(deps: HandoffDeps, input: { buyerUserId: string; introductionId: string; text: string }): Promise<Introduction> {
  const introduction = await deps.store.getIntroduction(input.introductionId);
  if (!introduction || introduction.buyerUserId !== input.buyerUserId) throw new HandoffRefused("not_found", "Cette mise en relation est introuvable.");
  if (introduction.status !== "question") throw new HandoffRefused("already_answered", `Cette mise en relation est ${describeStatus(introduction.status)} : pas de question en attente.`);
  const text = input.text.trim();
  if (!text) throw new HandoffRefused("message_required", "Écrivez la réponse à transmettre.");
  const storefront = await deps.storefronts.getById(introduction.storefrontId);
  if (!storefront) throw new HandoffRefused("not_found", "La vitrine de cette mise en relation est introuvable.");
  const buyer = await deps.buyerContactOf(introduction.buyerUserId);
  await deps.postInApp(storefront.userId, VITRINE_AGENT, `Réponse de ${buyer?.firstName ?? "la personne"} (réf. ${introduction.id.slice(0, 8)}) : « ${text} ». Vous pouvez maintenant accepter, refuser ou poser une autre question.`);
  return introduction;
}

export function describeStatus(status: Introduction["status"]): string {
  return { requested: "en attente", accepted: "acceptée", declined: "refusée", question: "en question", connected: "faite (contacts échangés)", expired: "expirée" }[status];
}

/** Expiration : sans réponse après INTRODUCTION_EXPIRY_DAYS, l'acheteur est prévenu et le couple entre en carence. */
export async function expireIntroductions(deps: HandoffDeps, days = INTRODUCTION_EXPIRY_DAYS): Promise<number> {
  const before = new Date(deps.now().getTime() - days * 86_400_000).toISOString();
  let expired = 0;
  for (const introduction of await deps.store.listIntroductionsToExpire(before)) {
    await deps.store.updateIntroduction(introduction.id, { status: "expired", answeredAt: deps.now().toISOString() });
    await deps.postInApp(introduction.buyerUserId, COUP_DE_MAIN_AGENT, `Votre demande de mise en relation du ${frenchDate(introduction.requestedAt.slice(0, 10))} est restée sans réponse pendant ${days} jours : elle a expiré. Dites-moi si vous voulez que je cherche quelqu'un d'autre.`);
    expired++;
  }
  return expired;
}
