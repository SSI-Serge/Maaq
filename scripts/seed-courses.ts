// Charge le catalogue de départ de Courses et repas (60 plats, références, semaines types…) dans la base indiquée par DATABASE_URL.
// Ne fait rien si le catalogue existe déjà. Usage : npx tsx scripts/seed-courses.ts [AAAA-MM-JJ : date des prix du classeur, par défaut aujourd'hui]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { poolOptions } from "../src/server/db/pool-options";
import type { DB } from "../src/server/db/schema.generated";
import { seedCoursesCatalog, type SeedData } from "../src/server/courses/catalog/seed";
import { loadEnv } from "./lib/load-env";

loadEnv();
const priceDate = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const data = JSON.parse(await readFile(path.join(process.cwd(), "db", "seed", "courses", "catalog.json"), "utf8")) as SeedData;
const pool = new Pool(poolOptions());
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
try {
  const report = await seedCoursesCatalog(db, data, { priceDate });
  console.log(report.skipped ? "Catalogue déjà chargé : rien à faire." : `Catalogue chargé : ${JSON.stringify(report)}`);
} finally {
  await db.destroy();
}
