import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { env } from "@/server/env";
import type { DB } from "./schema.generated";

// Les identifiants bigint restent des chaînes (comportement de pg, reflété par les types générés).

declare global {
  // Une seule instance en développement malgré le rechargement à chaud de Next.js.
  var __maaqDb: Kysely<DB> | undefined;
}

export function db(): Kysely<DB> {
  if (!globalThis.__maaqDb) {
    globalThis.__maaqDb = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: env().DATABASE_URL, max: 10 }),
      }),
    });
  }
  return globalThis.__maaqDb;
}
