// `npm run deploy:secrets` : génère les secrets d'un environnement en ligne (zone de test ou production).
// Les valeurs sont affichées une seule fois : à copier tout de suite dans le gestionnaire de secrets.
// Ne jamais réutiliser celles de .env (elles sont propres à ton poste).
import { randomBytes } from "node:crypto";

const base64 = () => randomBytes(32).toString("base64");
const hex = () => randomBytes(24).toString("hex");

const secrets: Record<string, string> = {
  ENCRYPTION_KEY: base64(),
  HMAC_KEY: base64(),
  AUTH_SECRET: base64(),
  CRON_SECRET: hex(),
  BILLING_WEBHOOK_SECRET: hex(),
  MAAQ_DEV_TOOLS_KEY: hex(),
};
for (const [name, value] of Object.entries(secrets)) console.log(`${name}=${value}`);
