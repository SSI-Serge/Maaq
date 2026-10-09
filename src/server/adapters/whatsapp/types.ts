/**
 * Contrat entre MAAQ et WhatsApp (WhatsApp Business Platform, Cloud API de Meta). Implémenté par
 * cloud.ts (vraie API) et dev-outbox.ts (boîte de test). Un autre fournisseur (BSP) se brancherait ici.
 */

export interface OutboundButton {
  /** Charge utile renvoyée telle quelle quand la personne appuie (ex. « decide:<id>:validate »). */
  id: string;
  /** 20 caractères au plus (limite WhatsApp). */
  title: string;
}

export type OutboundMessage =
  | { kind: "text"; to: string; text: string }
  | { kind: "buttons"; to: string; text: string; buttons: OutboundButton[] }
  | {
      kind: "template";
      to: string;
      name: string;
      language: string;
      /** Valeurs des {{1}}, {{2}}… du corps. */
      bodyParams: string[];
      /** Charges utiles des boutons de réponse rapide, dans l'ordre du modèle. */
      buttonPayloads?: string[];
    };

export interface WhatsAppTransport {
  send(message: OutboundMessage): Promise<{ messageId: string }>;
}

export type InboundType = "text" | "button" | "audio" | "image" | "other";

export interface InboundMessage {
  /** Identifiant WhatsApp (wamid) : sert au dédoublonnage. */
  externalId: string;
  /** wa_id de l'expéditeur : numéro E.164 sans « + ». */
  from: string;
  /** Prénom affiché dans WhatsApp, quand il est fourni. */
  profileName: string | null;
  receivedAt: Date;
  type: InboundType;
  text: string | null;
  /** Réponse à un bouton (interactif ou de modèle) : identifiant et libellé. */
  buttonId: string | null;
  buttonTitle: string | null;
}

export interface InboundStatus {
  externalId: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: Date;
}

export interface WebhookPayload {
  messages: InboundMessage[];
  statuses: InboundStatus[];
}

/** Message sortant consigné dans la boîte de test. */
export interface WhatsAppOutboxEntry {
  id: string;
  messageId: string;
  sentAt: string;
  message: OutboundMessage;
  /** Texte tel que la personne le lirait (modèles rendus). */
  preview: string;
}
