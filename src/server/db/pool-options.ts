import type { PoolConfig } from "pg";

/**
 * Réglages de connexion à PostgreSQL. Une base hébergée (Supabase, Cloud SQL…) exige une connexion chiffrée :
 * DATABASE_SSL=require l'active. Le certificat n'est pas vérifié (les bases managées utilisent leur propre autorité),
 * la connexion reste chiffrée. Ne pas mettre `sslmode` dans l'adresse : pg le lirait en priorité sur ce réglage.
 */
export function poolOptions(url: string | undefined = process.env.DATABASE_URL): PoolConfig {
  const mode = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (mode !== "require") return { connectionString: url };
  let connectionString = url;
  if (url) {
    const parsed = new URL(url);
    parsed.searchParams.delete("sslmode");
    parsed.searchParams.delete("ssl");
    connectionString = parsed.toString();
  }
  return { connectionString, ssl: { rejectUnauthorized: false } };
}
