import { sql } from "kysely";
import type { Ctx } from "@/server/auth/service";
import { runAutoConfirm, runEventNotices, type NoticesResult } from "@/server/assistant/notices";
import { completeSeries } from "@/server/assistant/series";
import { completeTaskSeries } from "@/server/assistant/task-series";
import { runTaskNotices, type TaskNoticesResult } from "@/server/assistant/task-notices";
import { runDigests, type DigestsResult } from "@/server/assistant/digest";
import { runReminders, type RemindersResult } from "@/server/assistant/reminders";
import { cleanupExports } from "@/server/compliance/exports";
import { runLifecycle, type LifecycleResult } from "@/server/compliance/lifecycle";
import { syncLogbook, type SyncResult } from "@/server/logbook/service";
import { describeError } from "@/server/safe-log";
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
  /** Rappels et relances de l'Assistant Famille envoyés, rendez-vous sans réponse passés à « Ignoré » (US-81, US-83). */
  reminders: RemindersResult;
  /** Notifications « RDV ajouté » et « RDV à confirmer » réservées et envoyées à l'autre parent (US-113). */
  notices: NoticesResult;
  /** Rappel quotidien des tâches et rappel d'une heure avant (US-97). */
  taskNotices: TaskNoticesResult;
  /** Point de la semaine : résumés préparés et notifications envoyées (US-98). */
  digests: DigestsResult;
}

/** Synchronise le carnet toutes les X heures (US-40 RT2) puis nettoie les données expirées (US-40 RT6, US-61 RT2, US-70 RT3). */
export async function runDueJobs(ctx: Ctx, options: { force?: boolean } = {}): Promise<JobsResult> {
  const hours = await integerSetting(ctx.db, "logbook_sync_interval_hours", 5);
  const last = await ctx.db.selectFrom("logbook_sync_runs").select("started_at").orderBy("started_at", "desc").limit(1).executeTakeFirst();
  const due = options.force || !last || ctx.now.getTime() - new Date(last.started_at).getTime() >= hours * 3_600_000;

  // Les suppressions arrivées à échéance et les exports ne dépendent pas de la fréquence du carnet : on les traite à chaque passage.
  const lifecycle = await runLifecycle(ctx);
  const exports = await cleanupExports(ctx);
  // Les rappels partent à l'heure dite : à chaque passage. Une panne de ce traitement ne doit pas bloquer les autres.
  // Ordre d'un passage de 5 minutes : notifications de RDV (la base les remet en accord avec l'état des RDV, les réserve, puis on les envoie), puis rappels et relances.
  // Séries de RDV : séances complétées vers l'avant, séries sans réponse fermées à leur première séance (US-109).
  await completeSeries(ctx.db, ctx.now).catch((error) => console.error(`Séries de RDV : ${describeError(error)}`));
  // Tâches récurrentes : occurrences créées 8 semaines à l'avance, et occurrences des nouvelles séances pour les tâches qui suivent une série de RDV (US-110 RT2).
  await completeTaskSeries(ctx.db, ctx.now).catch((error) => console.error(`Tâches récurrentes : ${describeError(error)}`));
  // Enregistrement sans réponse (AT-8) : éteint tant que AUTO_CONFIRM_MODE n'est pas « on ».
  await runAutoConfirm(ctx).catch((error) => console.error(`Enregistrement sans réponse : ${describeError(error)}`));
  const notices = await runEventNotices(ctx).catch((error) => {
    console.error(`Notifications de RDV : ${describeError(error)}`);
    return { planned: 0, sent: 0, failed: 0, abandoned: 0 };
  });
  const reminders = await runReminders(ctx).catch((error) => {
    console.error(`Rappels de l'Assistant Famille : ${describeError(error)}`);
    return { sent: 0, failed: 0, ignored: 0 };
  });
  const taskNotices = await runTaskNotices(ctx).catch((error) => {
    console.error(`Rappels de tâches : ${describeError(error)}`);
    return { daily: 0, dueSoon: 0, abandoned: 0, failed: 0 };
  });
  const digests = await runDigests(ctx).catch((error) => {
    console.error(`Point de la semaine : ${describeError(error)}`);
    return { prepared: 0, sent: 0, failed: 0 };
  });
  if (!due) return { logbook: "not_due", purged: null, lifecycle, exports, reminders, notices, taskNotices, digests };

  const logbook = await syncLogbook(ctx);
  return { logbook, purged: await purgeExpired(ctx), lifecycle, exports, reminders, notices, taskNotices, digests };
}

/** Supprime les données arrivées au bout de leur durée de conservation. */
export async function purgeExpired(ctx: Ctx): Promise<{ logbook: number; errorReports: number; technical: number }> {
  const logbook = await sql<{ n: string }>`select purge_expired_logbook() as n`.execute(ctx.db);
  const reports = await sql<{ n: string }>`select purge_expired_error_reports() as n`.execute(ctx.db);
  // Tables techniques : clés d'idempotence et demandes du tchat (24 h, `purge_expired_request_records`), compteurs de demandes (7 jours).
  const week = sql<Date>`${ctx.now.toISOString()}::date - 7`;
  const records = await sql<{ n: string }>`select purge_expired_request_records() as n`.execute(ctx.db);
  const c = await ctx.db.deleteFrom("daily_request_counters").where("request_date", "<", week).executeTakeFirst();
  // Traitements de la base à lancer régulièrement (FONCTIONS_PAR_LOT.md) : conversations de l'Assistant Famille (4 jours, D38, US-44), rendez-vous
  // annulés ou ignorés (30 jours, US-77 RT1) et passés (24 mois), images et mails bruts, compteurs journaliers, journal d'administration.
  let database = 0;
  for (const job of [
    "purge_expired_conversation_messages", "purge_expired_family_events", "purge_expired_attachments", "purge_expired_inbound_emails", "purge_old_daily_counters",
    "purge_admin_audit_log", "purge_expired_security_events", "purge_expired_family_tasks", "purge_expired_weekly_digests", "purge_old_scheduled_notifications",
  ]) {
    const done = await sql<{ n: string | null }>`select ${sql.ref(job)}() as n`.execute(ctx.db);
    database += Number(done.rows[0]?.n ?? 0);
  }
  return {
    logbook: Number(logbook.rows[0]?.n ?? 0),
    errorReports: Number(reports.rows[0]?.n ?? 0),
    technical: Number(records.rows[0]?.n ?? 0) + Number(c.numDeletedRows) + database,
  };
}
