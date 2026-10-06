// Remplit les données de démonstration sur DATABASE_URL (sans effet si elles existent déjà).
import { Pool } from "pg";
import { poolOptions } from "../src/server/db/pool-options";
import { loadEnv } from "./lib/load-env";
import { seedDemo } from "./lib/seed-demo";

loadEnv();
const pool = new Pool(poolOptions());
try {
  console.log((await seedDemo(pool)) ? "Données de démonstration créées." : "Données déjà présentes.");
} finally {
  await pool.end();
}
