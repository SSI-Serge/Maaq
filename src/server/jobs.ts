import { sql } from "kysely";
import type { Ctx } from "@/server/auth/service";
import { cleanupExports } from "@/server/compliance/exports";
import { runLifecycle, type LifecycleResult } from "@/server/compliance/lifecycle";
import { syncLogbook, type SyncResult } from "@/server/logbook/service";
import { integerSetting } from "@/server/settings";

/**
 * Traitements périodiques. Ils sont sans danger à relancer : chacun vérifie lui-même s'il est dû, donc un
 * planificateur externe peut appeler `/api/cron/run` aussi souvent qu'il veut (CRON_SECRET), et le serveur
 * de développement les déclenche seul (voir instrumentation.ts).
 */

export interface JobsResult {
  logbook: SyncResult | "not_due";
  purged: { logbook: number; errorReports: number; technical: number } | null;
  /** Suppressions de comptes, rappels, comptes jamais activés, réessais chez Digitorn (US-56, US-58, US-68). */
  lifecycle: LifecycleResult;
  exports: { expired: number; failed: number };
}

/** Synchronise le carnet toutes les X heures (US-40 RT2) puis nettoie les données expirées (US-40 RT6, US-61 RT2, US-70 RT3). */
export async function runDueJobs(ctx: Ctx, options: { force?: boolean } = {}): Promise<JobsResult> {
  const hours = await integerSetting(ctx.db, "logbook_sync_interval_hours", 5);
  const last = await ctx.db.selectFrom("logbook_sync_runs").select("started_at").orderBy("started_at", "desc").limit(1).executeTakeFirst();
  const due = options.force || !last || ctx.now.getTime() - new Date(last.started_at).getTime() >= hours * 3_600_000;

  // Les suppressions arrivées à échéance et les exports ne dépendent pas de la fréquence du carnet : on les traite à chaque passage.
  const lifecycle = await runLifecycle(ctx);
  const exports = await cleanupExports(ctx);
  if (!due) return { logbook: "not_due", purged: null, lifecycle, exports };

  const logbook = await syncLogbook(ctx);
  return { logbook, purged: await purgeExpired(ctx), lifecycle, exports };
}

/** Supprime les données arrivées au bout de leur durée de conservation. */
export async function purgeExpired(ctx: Ctx): Promise<{ logbook: number; errorReports: number; technical: number }> {
  const logbook = await sql<{ n: string }>`select purge_expired_logbook() as n`.execute(ctx.db);
  const reports = await sql<{ n: string }>`select purge_expired_error_reports() as n`.execute(ctx.db);
  // Tables techniques : clés d'idempotence et demandes du tchat (24 h), compteurs de demandes (7 jours).
  const day = new Date(ctx.now.getTime() - 24 * 3_600_000);
  const week = sql<Date>`${ctx.now.toISOString()}::date - 7`;
  const a = await ctx.db.deleteFrom("idempotency_keys").where("created_at", "<", day).executeTakeFirst();
  const b = await ctx.db.deleteFrom("chat_requests").where("created_at", "<", day).executeTakeFirst();
  const c = await ctx.db.deleteFrom("daily_request_counters").where("request_date", "<", week).executeTakeFirst();
  return {
    logbook: Number(logbook.rows[0]?.n ?? 0),
    errorReports: Number(reports.rows[0]?.n ?? 0),
    technical: Number(a.numDeletedRows) + Number(b.numDeletedRows) + Number(c.numDeletedRows),
  };
}
