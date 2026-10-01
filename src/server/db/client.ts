import { Kysely, PostgresDialect } from "kysely";
import { Pool, types } from "pg";
import { env } from "@/server/env";
import type { DB } from "./schema.generated";

// bigint (int8) : renvoyé en chaîne par défaut ; nos identifiants tiennent dans un number.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

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
