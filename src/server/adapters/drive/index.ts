import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Stockage des documents de contrats dans le Google Drive du compte (D7, D14).
 * Un document retiré dans MAAQ reste dans le Drive : il n'y a donc pas de suppression.
 */
export interface DriveStorage {
  upload(input: { accountId: string; fileName: string; mimeType: string; content: Buffer }): Promise<{ fileId: string }>;
  read(accountId: string, fileId: string): Promise<{ fileName: string; mimeType: string; content: Buffer }>;
}

interface StoredMeta {
  fileName: string;
  mimeType: string;
}

const SAFE_ID = /^[0-9a-f-]{36}$/;

/** Faux Google Drive pour le développement : un dossier par compte dans .data/drive. */
export class LocalDrive implements DriveStorage {
  constructor(private readonly root: string = path.join(process.cwd(), ".data", "drive")) {}

  async upload(input: { accountId: string; fileName: string; mimeType: string; content: Buffer }) {
    const fileId = randomUUID();
    const dir = this.accountDir(input.accountId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileId), input.content);
    const meta: StoredMeta = { fileName: input.fileName, mimeType: input.mimeType };
    await writeFile(path.join(dir, `${fileId}.json`), JSON.stringify(meta));
    return { fileId };
  }

  async read(accountId: string, fileId: string) {
    if (!SAFE_ID.test(fileId)) throw new Error("Identifiant de fichier invalide");
    const dir = this.accountDir(accountId);
    const meta = JSON.parse(await readFile(path.join(dir, `${fileId}.json`), "utf8")) as StoredMeta;
    return { ...meta, content: await readFile(path.join(dir, fileId)) };
  }

  private accountDir(accountId: string): string {
    if (!SAFE_ID.test(accountId)) throw new Error("Identifiant de compte invalide");
    return path.join(this.root, accountId);
  }
}

let instance: DriveStorage | undefined;

/** Stockage des documents. Seul le faux Drive local existe pour l'instant (DRIVE_MODE=local). */
export function drive(): DriveStorage {
  instance ??= new LocalDrive();
  return instance;
}
