// `npm run dev` : démarre la base embarquée, applique les migrations, remplit les données
// de démonstration si la base est vide, puis lance Next.js. Ctrl-C arrête tout.
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { DEV_DB_DIR, devDbPort, loadEnv } from "./lib/load-env";
import { startEmbeddedDb } from "./lib/embedded-db";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "./lib/seed-demo";

loadEnv();
const pg = await startEmbeddedDb({ dir: DEV_DB_DIR, port: devDbPort(), databases: ["maaq"] });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const applied = await migrate(pool);
  if (applied.length) console.log(`Migrations appliquées : ${applied.join(", ")}`);
  const seeded = await seedDemo(pool);
  if (seeded) console.log("Données de démonstration créées (voir docs/comptes-de-test.md).");
} finally {
  await pool.end();
}

const next = spawn("npx", ["next", "dev"], { stdio: "inherit", shell: true });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  next.kill();
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
next.on("exit", stop);
