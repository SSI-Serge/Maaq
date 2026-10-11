// Efface la base de développement (.data/pg) puis la recrée vide, migrée et remplie.
import { rm } from "node:fs/promises";
import { Pool } from "pg";
import { DEV_DB_DIR, devDbPort, loadEnv } from "./lib/load-env";
import { startEmbeddedDb } from "./lib/embedded-db";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "./lib/seed-demo";

loadEnv();
await rm(DEV_DB_DIR, { recursive: true, force: true });
const pg = await startEmbeddedDb({ dir: DEV_DB_DIR, port: devDbPort(), databases: ["maaq"] });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(pool);
  await seedDemo(pool);
  console.log("Base de développement réinitialisée.");
} finally {
  await pool.end();
  await pg.stop();
}
