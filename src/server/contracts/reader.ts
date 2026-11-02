import { env } from "@/server/env";
import type { DetectedEntity } from "./masking/engine";

/**
 * Lecture des documents de contrat (US-136 RT1) : le texte de chaque page et les noms propres repérés, par un service interne que nous hébergeons en Union européenne
 * (`services/contract-reader`, Cloud Run sans accès public). L'application lui confie les fichiers déchiffrés au moment de la lecture ; il ne garde rien.
 */

export interface ReadPage {
  text: string;
  /** Confiance de la lecture, de 0 à 100 : 100 pour le texte d'un PDF, la moyenne des mots reconnus pour une image. */
  confidence: number;
  method: "text" | "ocr";
  entities: DetectedEntity[];
  /** Mots lus avec peu de confiance (minuscules), pour surligner les passages mal lus dans l'aperçu de l'administrateur (US-138 RF2). */
  weak?: string[];
}

export interface ReadResult {
  /** Version de l'outil (service, OCR, modèle de langue), gardée avec le document sans valeur personnelle (US-136 RT4). */
  tool: string;
  pages: ReadPage[];
}

export interface ReadInput {
  name: string;
  mime: string;
  content: Buffer;
}

/** `unreadable` : fichier abîmé, protégé par mot de passe, trop long… (définitif, le document est « Illisible ») ; `unavailable` : le service n'a pas répondu (on réessaiera). */
export type ReaderFailure = "unreadable" | "unavailable";

export class ReaderError extends Error {
  constructor(
    readonly failure: ReaderFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface DocumentReader {
  read(files: ReadInput[]): Promise<ReadResult>;
}

/** Jeton d'identité du compte de service de Cloud Run pour appeler le service interne ; gardé jusqu'à peu avant sa fin de validité. */
const identity = new Map<string, { value: string; expiresAt: number }>();
async function identityToken(audience: string): Promise<string> {
  const known = identity.get(audience);
  if (known && known.expiresAt > Date.now() + 120_000) return known.value;
  const response = await fetch(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`, { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new ReaderError("unavailable", `Jeton d'identité indisponible (${response.status})`);
  const value = (await response.text()).trim();
  identity.set(audience, { value, expiresAt: Date.now() + 50 * 60_000 });
  return value;
}

class HttpReader implements DocumentReader {
  constructor(private readonly baseUrl: string) {}

  async read(files: ReadInput[]): Promise<ReadResult> {
    const form = new FormData();
    for (const file of files) form.append("files", new Blob([new Uint8Array(file.content)], { type: file.mime }), file.name);
    const headers: Record<string, string> = {};
    // Sur Cloud Run, le service interne n'est pas public : l'application se présente avec son identité.
    if (new URL(this.baseUrl).hostname.endsWith(".run.app")) headers.Authorization = `Bearer ${await identityToken(new URL(this.baseUrl).origin)}`;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/read`, { method: "POST", body: form, headers, signal: AbortSignal.timeout(290_000) });
    } catch (error) {
      throw new ReaderError("unavailable", `Service de lecture injoignable (${(error as Error).name})`);
    }
    if (response.status === 422) throw new ReaderError("unreadable", "Document illisible");
    if (!response.ok) throw new ReaderError("unavailable", `Service de lecture en erreur (${response.status})`);
    const body = (await response.json()) as ReadResult;
    if (!Array.isArray(body.pages)) throw new ReaderError("unavailable", "Réponse du service de lecture inattendue");
    return body;
  }
}

declare global {
  var __maaqContractReader: DocumentReader | null | undefined;
}

/** Le lecteur configuré (`CONTRACT_READER_URL`), ou null : sans lecteur, les documents restent « en attente » et rien n'est masqué. */
export function documentReader(): DocumentReader | null {
  if (globalThis.__maaqContractReader !== undefined) return globalThis.__maaqContractReader;
  const url = env().CONTRACT_READER_URL;
  return url ? new HttpReader(url.replace(/\/+$/, "")) : null;
}

/** Pour les tests : remplace le lecteur (null = aucun lecteur) ; sans argument, revient à la configuration. */
export function setDocumentReader(reader: DocumentReader | null | undefined): void {
  globalThis.__maaqContractReader = reader;
}
