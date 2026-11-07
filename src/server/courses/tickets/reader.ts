import { identityToken } from "@/server/contracts/reader";
import { env } from "@/server/env";

/**
 * Lecture d'un ticket de caisse (US-161 RF2, RT1) par un service interne hébergé en Union européenne (`services/ticket-reader`, moteur RapidOCR, Tesseract en secours, CR-36),
 * Cloud Run sans accès public. Les photos lui sont confiées en mémoire, il ne garde rien ; l'application ne conserve aucune photo (CR-05). Le texte rendu est masqué par
 * `maskTicketText` avant d'aller où que ce soit.
 */

export interface TicketImage {
  name: string;
  mime: string;
  content: Buffer;
}

export interface TicketReading {
  text: string;
  /** Confiance moyenne de la lecture, de 0 à 100. */
  confidence: number;
  /** Version du service et du moteur, gardée sans valeur personnelle. */
  tool: string;
}

/** `unreadable` : photo abîmée ou sans texte ; `unavailable` : le service n'a pas répondu. */
export class TicketReaderError extends Error {
  constructor(
    readonly failure: "unreadable" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface TicketReader {
  read(images: TicketImage[]): Promise<TicketReading>;
}

class HttpTicketReader implements TicketReader {
  constructor(private readonly baseUrl: string) {}

  async read(images: TicketImage[]): Promise<TicketReading> {
    const form = new FormData();
    for (const image of images) form.append("files", new Blob([new Uint8Array(image.content)], { type: image.mime }), image.name);
    const headers: Record<string, string> = {};
    if (new URL(this.baseUrl).hostname.endsWith(".run.app")) headers.Authorization = `Bearer ${await identityToken(new URL(this.baseUrl).origin)}`;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/read`, { method: "POST", body: form, headers, signal: AbortSignal.timeout(90_000) });
    } catch (error) {
      throw new TicketReaderError("unavailable", `Service de lecture des tickets injoignable (${(error as Error).name})`);
    }
    if (response.status === 422) throw new TicketReaderError("unreadable", "Ticket illisible");
    if (!response.ok) throw new TicketReaderError("unavailable", `Service de lecture des tickets en erreur (${response.status})`);
    const body = (await response.json()) as Partial<TicketReading>;
    if (typeof body.text !== "string") throw new TicketReaderError("unavailable", "Réponse du service de lecture des tickets inattendue");
    return { text: body.text, confidence: Number(body.confidence ?? 0), tool: String(body.tool ?? "") };
  }
}

declare global {
  var __maaqTicketReader: TicketReader | null | undefined;
}

/** Le lecteur configuré (`TICKET_READER_URL`), ou null : sans lecteur, la lecture d'un ticket répond « indisponible ». */
export function ticketReader(): TicketReader | null {
  if (globalThis.__maaqTicketReader !== undefined) return globalThis.__maaqTicketReader;
  const url = env().TICKET_READER_URL;
  return url ? new HttpTicketReader(url.replace(/\/+$/, "")) : null;
}

/** Pour les tests : remplace le lecteur (null = aucun lecteur) ; sans argument, revient à la configuration. */
export function setTicketReader(reader: TicketReader | null | undefined): void {
  globalThis.__maaqTicketReader = reader;
}
