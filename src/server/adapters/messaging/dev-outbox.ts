import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Messenger, OutboxEntry, OutgoingEmail, OutgoingSms } from "./types";

/**
 * Boîte de test : en développement, rien ne part réellement. Chaque email ou SMS est
 * ajouté à .data/outbox.jsonl et consultable sur /dev/boite.
 */
export class DevOutbox implements Messenger {
  constructor(private readonly file: string = path.join(process.cwd(), ".data", "outbox.jsonl")) {}

  async sendEmail(message: OutgoingEmail): Promise<void> {
    await this.append({ channel: "email", to: message.to, subject: message.subject, text: message.text });
  }

  async sendSms(message: OutgoingSms): Promise<void> {
    await this.append({ channel: "sms", to: message.to, text: message.text });
  }

  /** Messages du plus récent au plus ancien. */
  async list(limit = 100): Promise<OutboxEntry[]> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OutboxEntry)
      .reverse()
      .slice(0, limit);
  }

  private async append(entry: Omit<OutboxEntry, "id" | "sentAt">): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const full: OutboxEntry = { id: randomUUID(), sentAt: new Date().toISOString(), ...entry };
    await appendFile(this.file, `${JSON.stringify(full)}\n`, "utf8");
  }
}
