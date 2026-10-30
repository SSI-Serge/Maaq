// Charge le catalogue de l'aide Devoirs (US-119 RT4) sur DATABASE_URL : 375 exercices de maths (France, Singapour, Chine, CP à CM2) et 60 activités.
// Rejouable : une ligne existante est mise à jour, jamais supprimée (les progrès des enfants la désignent).
//   npx tsx scripts/load-homework-catalog.ts
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { loadHomeworkCatalog } from "../src/server/assistant/homework/catalog";
import type { DB } from "../src/server/db/schema.generated";
import { poolOptions } from "../src/server/db/pool-options";
import { loadEnv } from "./lib/load-env";

loadEnv();
const pool = new Pool(poolOptions());
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
try {
  const done = await loadHomeworkCatalog(db);
  console.log(`Catalogue Devoirs chargé : ${done.exercises} exercices, ${done.activities} lignes d'activités (une par âge).`);
} finally {
  await db.destroy();
}
