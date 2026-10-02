import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/server/data-dir";

/**
 * Stockage provisoire d'un document entre son envoi et son classement dans le Drive (US-34 RT1).
 * Le fichier est effacé dès que l'agent l'a classé.
 */
const SAFE_KEY = /^[0-9a-f-]{36}$/;

function fileOf(key: string): string {
  if (!SAFE_KEY.test(key)) throw new Error("Clé de stockage invalide");
  return path.join(dataDir(), "staging", key);
}

export async function stage(key: string, content: Buffer): Promise<void> {
  await mkdir(path.join(dataDir(), "staging"), { recursive: true });
  await writeFile(fileOf(key), content);
}

export function readStaged(key: string): Promise<Buffer> {
  return readFile(fileOf(key));
}

export async function unstage(key: string | null): Promise<void> {
  if (key) await rm(fileOf(key), { force: true });
}
