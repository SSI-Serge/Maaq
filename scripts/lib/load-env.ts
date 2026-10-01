import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";

const root = process.cwd();
const envPath = path.join(root, ".env");

/**
 * Charge .env. Au premier lancement, le crée à partir de .env.example en générant
 * des clés aléatoires locales (jamais commitées) pour que `npm run dev` marche tout de suite.
 */
export function loadEnv(): void {
  if (!existsSync(envPath)) {
    const template = readFileSync(path.join(root, ".env.example"), "utf8");
    const filled = template
      .replace(/^ENCRYPTION_KEY=$/m, `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`)
      .replace(/^HMAC_KEY=$/m, `HMAC_KEY=${randomBytes(32).toString("base64")}`)
      .replace(/^CRON_SECRET=$/m, `CRON_SECRET=${randomBytes(24).toString("hex")}`);
    writeFileSync(envPath, filled);
    console.log("Fichier .env créé avec des clés locales générées.");
  }
  config({ path: envPath, quiet: true });
}

export function devDbPort(): number {
  return Number(process.env.DEV_DB_PORT ?? 5433);
}

export const DEV_DB_DIR = path.join(root, ".data", "pg");
