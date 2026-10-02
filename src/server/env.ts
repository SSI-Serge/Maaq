import { z } from "zod";

const base64Key = z
  .string()
  .min(1, "clé manquante")
  .refine((v) => Buffer.from(v, "base64").length === 32, "doit faire 32 octets encodés en base64");

const schema = z.object({
  DATABASE_URL: z.string().url(),
  APP_URL: z.string().url().default("http://localhost:3000"),
  ENCRYPTION_KEY: base64Key,
  HMAC_KEY: base64Key,
  AUTH_SECRET: base64Key,
  DIGITORN_MODE: z.enum(["mock", "live"]).default("mock"),
  DIGITORN_API_URL: z.string().url().optional(),
  DIGITORN_API_KEY: z.string().optional(),
  MESSAGING_MODE: z.enum(["dev"]).default("dev"),
  DRIVE_MODE: z.enum(["local"]).default("local"),
  CRON_SECRET: z.string().min(16, "au moins 16 caractères"),
  /** Secret de l'outil de facturation qui signale désabonnements et réabonnements (US-58 RT2). Sans lui, ce point d'entrée est fermé. */
  BILLING_WEBHOOK_SECRET: z.string().min(16, "au moins 16 caractères").optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Variables d'environnement validées. Échoue tôt et clairement si une variable manque. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join(".")} : ${i.message}`).join("\n");
    throw new Error(`Configuration invalide (voir .env.example) :\n${details}`);
  }
  cached = parsed.data;
  return cached;
}
