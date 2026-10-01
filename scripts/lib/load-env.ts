import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

const root = process.cwd();
const envPath = path.join(root, ".env");

/** Secrets générés localement s'ils sont absents ou vides (jamais commités). */
const GENERATED_SECRETS: Record<string, () => string> = {
  ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
  HMAC_KEY: () => randomBytes(32).toString("base64"),
  AUTH_SECRET: () => randomBytes(32).toString("base64"),
  CRON_SECRET: () => randomBytes(24).toString("hex"),
};

/**
 * Charge .env. Au premier lancement, le crée à partir de .env.example ; ensuite, complète
 * les secrets ajoutés depuis (nouvelle version) pour que `npm run dev` marche tout de suite.
 */
export function loadEnv(): void {
  const created = !existsSync(envPath);
  let content = created ? readFileSync(path.join(root, ".env.example"), "utf8") : readFileSync(envPath, "utf8");
  const added: string[] = [];

  for (const [name, generate] of Object.entries(GENERATED_SECRETS)) {
    const line = new RegExp(`^${name}=(.*)$`, "m");
    const match = content.match(line);
    if (match && match[1].trim()) continue;
    content = match ? content.replace(line, `${name}=${generate()}`) : `${content.trimEnd()}\n${name}=${generate()}\n`;
    added.push(name);
  }

  if (created || added.length) {
    writeFileSync(envPath, content);
    console.log(created ? "Fichier .env créé avec des clés locales générées." : `Clés ajoutées à .env : ${added.join(", ")}.`);
  }
  config({ path: envPath, quiet: true });
}

export function devDbPort(): number {
  return Number(process.env.DEV_DB_PORT ?? 5433);
}

export const DEV_DB_DIR = path.join(root, ".data", "pg");
