import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Kysely } from "kysely";
import { dataDir } from "@/server/data-dir";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { describeError } from "@/server/safe-log";
import { decryptBytes, encryptBytes } from "@/server/security/crypto";

/**
 * Stockage des documents de contrat (C-01, US-126 RT1). Les fichiers sont chiffrés par l'application (AES-256-GCM, clé de l'application) AVANT d'être confiés au stockage : le
 * stockage ne voit jamais un document en clair. Seule la clé d'objet est en base. En test et en développement, les fichiers vont dans le dossier de données local ; sur la
 * zone de test en ligne, dans un bucket Cloud Storage en Union européenne (`CONTRACT_STORAGE=gcs`, `CONTRACT_BUCKET`). La suppression passe par la file de la base
 * (`storage_deletion_queue`, alimentée par les déclencheurs) : un fichier n'est jamais effacé avant que la base ait supprimé sa ligne.
 */

export const KEY_PREFIX = "contract-documents/";
const SAFE_KEY = /^contract-documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

export interface ObjectStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

function checkKey(key: string, safe: RegExp = SAFE_KEY): string {
  if (!safe.test(key)) throw new Error("Clé de stockage invalide");
  return key;
}

/** Stockage dans le dossier de données local (essais et développement). Réutilisé, avec ses propres clés admises, par les fichiers de la vidéo de présentation. */
export class LocalStore implements ObjectStore {
  constructor(
    private readonly safe: RegExp = SAFE_KEY,
    private readonly folder = "contract-documents",
    private readonly prefix = KEY_PREFIX,
  ) {}
  private file = (key: string) => path.join(dataDir(), this.folder, ...checkKey(key, this.safe).slice(this.prefix.length).split("/"));
  async put(key: string, bytes: Buffer) {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  get(key: string) {
    return readFile(this.file(key));
  }
  async remove(key: string) {
    await rm(this.file(key), { force: true });
  }
}

/** Jeton d'accès du compte de service de Cloud Run, demandé au serveur de métadonnées de Google et gardé jusqu'à sa fin de validité. */
let token: { value: string; expiresAt: number } | null = null;
export async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error(`Jeton Google indisponible (${response.status})`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return token.value;
}

/** Stockage dans un bucket Cloud Storage de l'Union européenne, par l'API REST et le jeton du compte de service de Cloud Run. */
export class GcsStore implements ObjectStore {
  constructor(
    private readonly bucket: string,
    private readonly safe: RegExp = SAFE_KEY,
  ) {}
  private async call(url: string, init: RequestInit = {}) {
    const response = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await accessToken()}` } });
    return response;
  }
  async put(key: string, bytes: Buffer) {
    const response = await this.call(`https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=media&name=${encodeURIComponent(checkKey(key, this.safe))}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) throw new Error(`Dépôt dans le stockage refusé (${response.status})`);
  }
  async get(key: string) {
    const response = await this.call(`https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(checkKey(key, this.safe))}?alt=media`);
    if (!response.ok) throw new Error(`Lecture du stockage refusée (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  async remove(key: string) {
    const response = await this.call(`https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(checkKey(key, this.safe))}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`Suppression du stockage refusée (${response.status})`);
  }
}

declare global {
  var __maaqContractStore: ObjectStore | undefined;
}

export function objectStore(): ObjectStore {
  globalThis.__maaqContractStore ??= env().CONTRACT_STORAGE === "gcs" ? new GcsStore(env().CONTRACT_BUCKET!) : new LocalStore();
  return globalThis.__maaqContractStore;
}

const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

/** Chiffre le document et le dépose ; retourne la clé d'objet à garder en base. */
export async function storeDocument(accountId: string, plain: Buffer): Promise<string> {
  const objectKey = `${KEY_PREFIX}${accountId}/${randomUUID()}`;
  await objectStore().put(objectKey, encryptBytes(plain, key()));
  return objectKey;
}

export async function loadDocument(objectKey: string): Promise<Buffer> {
  return decryptBytes(await objectStore().get(objectKey), key());
}

/**
 * Vide la file de suppression : efface les fichiers de contrat dont la ligne a disparu de la base. Un échec est noté (essais, dernière erreur) et repris au passage suivant ;
 * les clés d'une autre origine sont laissées à leur propriétaire. Retourne le nombre de fichiers effacés.
 */
export async function drainStorageDeletions(db: Kysely<DB>, limit = 200): Promise<{ deleted: number; failed: number }> {
  const rows = await db.selectFrom("storage_deletion_queue").select(["id", "storage_key"]).where("status", "=", "pending").where("storage_key", "like", `${KEY_PREFIX}%`).orderBy("id").limit(limit).execute();
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await objectStore().remove(row.storage_key);
      await db.updateTable("storage_deletion_queue").set({ status: "done", completed_at: new Date() }).where("id", "=", row.id).execute();
      deleted += 1;
    } catch (error) {
      failed += 1;
      await db
        .updateTable("storage_deletion_queue")
        .set((eb) => ({ attempts: eb("attempts", "+", 1), last_error: describeError(error).slice(0, 300) }))
        .where("id", "=", row.id)
        .execute();
    }
  }
  return { deleted, failed };
}
