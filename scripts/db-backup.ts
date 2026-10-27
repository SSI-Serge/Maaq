// Sauvegarde logique de DATABASE_URL : toutes les tables du schéma public, une ligne JSON par table, dans un fichier horodaté.
// À lancer AVANT toute migration sur une base qui contient des données (zone de test comprise) :
//   npx tsx scripts/db-backup.ts "C:\chemin\vers\un\dossier\hors\du\projet"
// Le fichier contient des données personnelles : il ne doit jamais être versé dans le dépôt.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { poolOptions } from "../src/server/db/pool-options";
import { loadEnv } from "./lib/load-env";

loadEnv();
const target = process.argv[2];
if (!target) {
  console.error("Indiquez le dossier de destination : npx tsx scripts/db-backup.ts <dossier>");
  process.exit(1);
}

const pool = new Pool(poolOptions());
try {
  const { rows: tables } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const dump: Record<string, unknown[]> = {};
  let total = 0;
  for (const { table_name } of tables) {
    // Les colonnes binaires (champs chiffrés) sortent en hexadécimal, les dates en ISO : le fichier se relit tel quel.
    const { rows } = await pool.query<{ rows: unknown[] }>(`SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM public."${table_name}" t`);
    dump[table_name] = rows[0].rows;
    total += rows[0].rows.length;
  }
  const { rows: version } = await pool.query<{ version: string }>("SELECT version()");
  await mkdir(target, { recursive: true });
  const file = path.join(target, `sauvegarde-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ takenAt: new Date().toISOString(), server: version[0].version, tables: dump }));
  console.log(`Sauvegarde écrite : ${file} (${tables.length} tables, ${total} lignes).`);
} finally {
  await pool.end();
}
