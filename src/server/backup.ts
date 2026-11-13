import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import type { Ctx } from "@/server/auth/service";
import { GcsStore, type ObjectStore } from "@/server/contracts/storage";

/**
 * Sauvegarde quotidienne automatique de la base (test « Friends and family ») : toutes les tables du schéma public, une liste de lignes par table, dans un fichier JSON
 * compressé déposé dans un bucket privé de l'Union européenne (BACKUP_BUCKET). Le bucket supprime lui-même les fichiers au bout de 14 jours (règle de cycle de vie).
 * Elle part la nuit, entre 1 h et 4 h (temps universel), une fois par jour. Le fichier contient des données personnelles : il ne quitte pas le bucket.
 * Sans BACKUP_BUCKET, rien ne se passe. Même format que `scripts/db-backup.ts`, la sauvegarde manuelle faite avant chaque changement de base.
 */

const KEY = /^sauvegarde-\d{4}-\d{2}-\d{2}\.json\.gz$/;
let lastDay: string | null = null;

export type BackupResult = { status: "off" | "not_due" | "already_done" } | { status: "done"; key: string; tables: number; rows: number; bytes: number };

export async function runDailyBackup(ctx: Ctx, options: { bucket?: string | undefined; store?: Pick<ObjectStore, "put"> } = {}): Promise<BackupResult> {
  const bucket = "bucket" in options ? options.bucket : process.env.BACKUP_BUCKET;
  if (!bucket && !options.store) return { status: "off" };
  const hour = ctx.now.getUTCHours();
  if (hour < 1 || hour >= 4) return { status: "not_due" };
  const day = ctx.now.toISOString().slice(0, 10);
  if (lastDay === day) return { status: "already_done" };

  const tables = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`.execute(ctx.db);
  const dump: Record<string, unknown[]> = {};
  let rows = 0;
  for (const { table_name } of tables.rows) {
    const found = await sql<{ rows: unknown[] }>`select coalesce(json_agg(t), '[]'::json) as rows from ${sql.table(`public.${table_name}`)} t`.execute(ctx.db);
    dump[table_name] = found.rows[0].rows;
    rows += found.rows[0].rows.length;
  }
  const version = await sql<{ version: string }>`select version()`.execute(ctx.db);
  const bytes = gzipSync(Buffer.from(JSON.stringify({ takenAt: ctx.now.toISOString(), server: version.rows[0].version, tables: dump })));
  const key = `sauvegarde-${day}.json.gz`;
  await (options.store ?? new GcsStore(bucket!, KEY)).put(key, bytes);
  lastDay = day;
  // Des chiffres seulement, jamais de contenu.
  console.info(JSON.stringify({ event: "daily_backup", key, tables: tables.rows.length, rows, bytes: bytes.length }));
  return { status: "done", key, tables: tables.rows.length, rows, bytes: bytes.length };
}

/** Pour les essais : oublie la sauvegarde du jour. */
export function resetDailyBackup(): void {
  lastDay = null;
}
