import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundMessage, InboundStatus, OutboundMessage, WebhookPayload, WhatsAppTransport } from "./types";

/**
 * WhatsApp Business Platform (Cloud API de Meta) : envoi des messages et lecture des webhooks.
 * Référence : https://developers.facebook.com/docs/whatsapp/cloud-api
 */

export interface CloudApiOptions {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}

/** Corps JSON attendu par POST /{phone_number_id}/messages pour chacun de nos messages. */
export function cloudApiBody(message: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: message.to };
  switch (message.kind) {
    case "text":
      return { ...base, type: "text", text: { preview_url: true, body: message.text } };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: message.text },
          action: { buttons: message.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        },
      };
    case "template": {
      const components: unknown[] = [];
      if (message.bodyParams.length) components.push({ type: "body", parameters: message.bodyParams.map((text) => ({ type: "text", text })) });
      (message.buttonPayloads ?? []).forEach((payload, index) => {
        components.push({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] });
      });
      return { ...base, type: "template", template: { name: message.name, language: { code: message.language }, components } };
    }
  }
}

export class CloudApiTransport implements WhatsAppTransport {
  constructor(private readonly options: CloudApiOptions) {}

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(`https://graph.facebook.com/${this.options.apiVersion}/${this.options.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(cloudApiBody(message)),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`WhatsApp : envoi refusé (${response.status}) ${detail.slice(0, 300)}`);
    }
    const data = (await response.json()) as { messages?: { id: string }[] };
    const messageId = data.messages?.[0]?.id;
    if (!messageId) throw new Error("WhatsApp : réponse sans identifiant de message");
    return { messageId };
  }
}

/** Vérifie l'en-tête X-Hub-Signature-256 (HMAC-SHA256 du corps brut avec le secret de l'application). */
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex"));
  const given = Buffer.from(header.slice("sha256=".length));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface RawMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  button?: { payload: string; text: string };
}

interface RawValue {
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: RawMessage[];
  statuses?: { id: string; status: string; timestamp: string }[];
}

/** Lit un événement de webhook (messages reçus et accusés de remise). Tout ce qui est inconnu est ignoré. */
export function parseWebhook(body: unknown): WebhookPayload {
  const payload: WebhookPayload = { messages: [], statuses: [] };
  const entries = (body as { entry?: { changes?: { field?: string; value?: RawValue }[] }[] })?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
      for (const m of value.messages ?? []) {
        if (!m.id || !m.from) continue;
        payload.messages.push(normalizeMessage(m, names.get(m.from) ?? null));
      }
      for (const s of value.statuses ?? []) {
        if (!s.id || !["sent", "delivered", "read", "failed"].includes(s.status)) continue;
        payload.statuses.push({ externalId: s.id, status: s.status as InboundStatus["status"], at: new Date(Number(s.timestamp) * 1000) });
      }
    }
  }
  return payload;
}

function normalizeMessage(m: RawMessage, profileName: string | null): InboundMessage {
  const base = { externalId: m.id, from: m.from, profileName, receivedAt: new Date(Number(m.timestamp) * 1000), text: null, buttonId: null, buttonTitle: null };
  switch (m.type) {
    case "text":
      return { ...base, type: "text", text: m.text?.body ?? "" };
    case "interactive": {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return reply ? { ...base, type: "button", buttonId: reply.id, buttonTitle: reply.title, text: reply.title } : { ...base, type: "other" };
    }
    case "button":
      return { ...base, type: "button", buttonId: m.button?.payload ?? null, buttonTitle: m.button?.text ?? null, text: m.button?.text ?? null };
    case "audio":
      return { ...base, type: "audio" };
    case "image":
      return { ...base, type: "image" };
    default:
      return { ...base, type: "other" };
  }
}
