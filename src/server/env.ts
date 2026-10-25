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
  /**
   * « mock » : simulateur seul. « live » : appels réels pour tout ce que l'API de Digitorn documente (agents, tchat
   * embarqué, utilisateurs) ; le reste reste simulé tant que Digitorn ne l'a pas livré. Les clés secrètes sont par
   * agent, dans la base (console d'administration), pas dans l'environnement.
   */
  DIGITORN_MODE: z.enum(["mock", "live"]).default("mock"),
  DIGITORN_API_URL: z.string().url().default("https://api.digitorn.ai/v1"),
  /** « dev » : boîte de test, rien ne part. « smtp » : les emails partent réellement (SMTP_*), les SMS restent simulés. */
  MESSAGING_MODE: z.enum(["dev", "smtp"]).default("dev"),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  /** Expéditeur des emails, par exemple « MAAQ <ne-pas-repondre@maaq.fr> ». */
  MAIL_FROM: z.string().min(3).optional(),
  DRIVE_MODE: z.enum(["local"]).default("local"),
  CRON_SECRET: z.string().min(16, "au moins 16 caractères"),
  /** Secret de l'outil de facturation qui signale désabonnements et réabonnements (US-58 RT2). Sans lui, ce point d'entrée est fermé. */
  BILLING_WEBHOOK_SECRET: z.string().min(16, "au moins 16 caractères").optional(),
  /**
   * Assistant Famille (rendez-vous et tâches). « off » : l'assistant est fermé. « live » : MAAQ appelle Claude, par l'API Anthropic
   * (tests) ou par Microsoft Foundry (pilote), et exécute lui-même les outils. Les clés se rangent dans Secret Manager.
   */
  ASSISTANT_MODE: z.enum(["off", "live"]).default("off"),
  ASSISTANT_PROVIDER: z.enum(["anthropic", "foundry"]).default("anthropic"),
  ASSISTANT_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  ASSISTANT_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  FOUNDRY_RESOURCE: z.string().regex(/^[a-z0-9-]+$/i, "nom de ressource Foundry invalide").optional(),
  FOUNDRY_API_KEY: z.string().min(1).optional(),
});

const checked = schema.superRefine((value, ctx) => {
  if (value.MESSAGING_MODE === "smtp") {
    for (const name of ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM"] as const) {
      if (!value[name]) ctx.addIssue({ code: "custom", path: [name], message: "obligatoire avec MESSAGING_MODE=smtp" });
    }
  }
  if (value.ASSISTANT_MODE === "live") {
    const needed = value.ASSISTANT_PROVIDER === "foundry" ? (["FOUNDRY_RESOURCE", "FOUNDRY_API_KEY"] as const) : (["ANTHROPIC_API_KEY"] as const);
    for (const name of needed) {
      if (!value[name]) ctx.addIssue({ code: "custom", path: [name], message: `obligatoire avec ASSISTANT_MODE=live et ASSISTANT_PROVIDER=${value.ASSISTANT_PROVIDER}` });
    }
  }
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Variables d'environnement validées. Échoue tôt et clairement si une variable manque. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Valide une configuration ; échoue avec la liste des variables en cause. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = checked.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join(".")} : ${i.message}`).join("\n");
    throw new Error(`Configuration invalide (voir .env.example) :\n${details}`);
  }
  return parsed.data;
}
