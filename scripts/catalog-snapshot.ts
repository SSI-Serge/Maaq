// Instantané du catalogue d'une base (tables, colonnes, contraintes, index, déclencheurs, fonctions, valeurs énumérées), pour comparer deux bases : par exemple la zone de test,
// migrée au fil des lots, et une base neuve migrée d'un coup (contrôle de dérive). Lecture seule : uniquement des SELECT sur le catalogue.
//   DATABASE_URL=… npx tsx scripts/catalog-snapshot.ts sortie.json
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { poolOptions } from "../src/server/db/pool-options";

const target = process.argv[2];
if (!target) {
  console.error("Indiquez le fichier de sortie : npx tsx scripts/catalog-snapshot.ts sortie.json");
  process.exit(1);
}

const pool = new Pool(poolOptions());
const q = async (sql: string) => (await pool.query(sql)).rows as Record<string, unknown>[];
try {
  const snapshot = {
    columns: await q(`select table_name, column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length from information_schema.columns where table_schema='public' order by 1,2`),
    constraints: await q(`select conrelid::regclass::text as t, conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where connamespace='public'::regnamespace order by 1,2`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname='public' order by 1,2`),
    triggers: await q(`select event_object_table as t, trigger_name, action_timing, event_manipulation, action_statement from information_schema.triggers where trigger_schema='public' order by 1,2,4`),
    functions: await q(`select p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as body from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in ('f','p') order by 1,2`),
    enums: await q(`select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels from pg_type t join pg_enum e on e.enumtypid=t.oid where t.typnamespace='public'::regnamespace group by 1 order by 1`),
    views: await q(`select viewname, md5(definition) as def from pg_views where schemaname='public' order by 1`),
    policies: await q(`select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname='public' order by 1,2`),
    rls: await q(`select tablename, rowsecurity from pg_tables where schemaname='public' order by 1`),
  };
  writeFileSync(target, JSON.stringify(snapshot, null, 1));
  console.log(`Instantané écrit : ${Object.entries(snapshot).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
} finally {
  await pool.end();
}
