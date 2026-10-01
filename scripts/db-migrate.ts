// Applique les migrations en attente sur DATABASE_URL.
import { Pool } from "pg";
import { loadEnv } from "./lib/load-env";
import { migrate } from "../src/server/db/migrate";

loadEnv();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Migrations appliquées : ${applied.join(", ")}` : "Base déjà à jour.");
} finally {
  await pool.end();
}
