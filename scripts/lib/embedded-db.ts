import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

export interface EmbeddedDbOptions {
  /** Dossier des données PostgreSQL. */
  dir: string;
  port: number;
  /** Bases à créer si elles n'existent pas. */
  databases: string[];
  /** false = le dossier est effacé à l'arrêt (bases de test). */
  persistent?: boolean;
}

export const DEV_USER = "maaq";
export const DEV_PASSWORD = "maaq";

/** Démarre un vrai PostgreSQL embarqué (binaire téléchargé par npm), sans installation. */
export async function startEmbeddedDb(options: EmbeddedDbOptions): Promise<EmbeddedPostgres> {
  const pg = new EmbeddedPostgres({
    databaseDir: options.dir,
    port: options.port,
    user: DEV_USER,
    password: DEV_PASSWORD,
    persistent: options.persistent ?? true,
    // UTF-8 obligatoire : sous Windows, initdb choisirait sinon WIN1252.
    initdbFlags: ["--encoding=UTF8", "--locale-provider=icu", "--icu-locale=fr-FR", "--locale=C"],
    onLog: () => {},
    onError: (message) => {
      const text = String(message);
      if (/error|fatal/i.test(text)) console.error(`[postgres] ${text.trim()}`);
    },
  });

  if (!existsSync(path.join(options.dir, "PG_VERSION"))) {
    await pg.initialise();
  }
  await pg.start();

  const client = pg.getPgClient();
  await client.connect();
  try {
    for (const name of options.databases) {
      const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (!rowCount) await client.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await client.end();
  }
  return pg;
}
