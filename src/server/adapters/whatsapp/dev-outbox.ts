import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/server/data-dir";
import { renderTemplate } from "./templates";
import type { OutboundMessage, WhatsAppOutboxEntry, WhatsAppTransport } from "./types";

/** Aperçu lisible d'un message sortant. */
export function previewOf(message: OutboundMessage): string {
  switch (message.kind) {
    case "text":
      return message.text;
    case "buttons":
      return `${message.text}\n[${message.buttons.map((b) => b.title).join("] [")}]`;
    case "template":
      return renderTemplate(message.name, message.bodyParams);
  }
}

/**
 * Boîte de test WhatsApp : rien ne part, chaque message est ajouté à .data/whatsapp-outbox.jsonl et visible
 * sur /dev/whatsapp, qui permet aussi de simuler un message entrant.
 */
export class DevWhatsApp implements WhatsAppTransport {
  constructor(private readonly file: string = path.join(dataDir(), "whatsapp-outbox.jsonl")) {}

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    const entry: WhatsAppOutboxEntry = { id: randomUUID(), messageId: `wamid.dev-${randomUUID()}`, sentAt: new Date().toISOString(), message, preview: previewOf(message) };
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    return { messageId: entry.messageId };
  }

  /** Messages du plus récent au plus ancien. */
  async list(limit = 100): Promise<WhatsAppOutboxEntry[]> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WhatsAppOutboxEntry)
      .reverse()
      .slice(0, limit);
  }
}

/** Transport en mémoire pour les tests : garde les messages envoyés. */
export class MemoryWhatsApp implements WhatsAppTransport {
  readonly sent: OutboundMessage[] = [];
  /** Identifiants rendus, dans l'ordre d'envoi. */
  readonly ids: string[] = [];
  failNext = 0;

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("WhatsApp indisponible (test)");
    }
    this.sent.push(structuredClone(message));
    const messageId = `wamid.test-${randomUUID()}`;
    this.ids.push(messageId);
    return { messageId };
  }
}
