import { sql } from "kysely";
import { digitorn } from "@/server/adapters/digitorn";
import type { MockDigitorn } from "@/server/adapters/digitorn/mock";
import { whatsapp } from "@/server/adapters/whatsapp";
import type { Ctx } from "@/server/auth/service";
import { cleanupExports } from "@/server/compliance/exports";
import { runLifecycle, type LifecycleResult } from "@/server/compliance/lifecycle";
import { runGiftReminders, type ReminderResult } from "@/server/gifts/reminders";
import { giftStore, prefsStore } from "@/server/gifts/service";
import { syncLogbook, type SyncResult } from "@/server/logbook/service";
import { ensureDigitornRef } from "@/server/profile/digitorn-ref";
import { integerSetting } from "@/server/settings";

/**
 * Traitements périodiques. Ils sont sans danger à relancer : chacun vérifie lui-même s'il est dû, donc un
 * planificateur externe peut appeler `/api/cron/run` aussi souvent qu'il veut (CRON_SECRET), et le serveur
 * de développement les déclenche seul (voir instrumentation.ts).
 */

/** Effacements doux de kdo_help (proches, occasions) gardés avant purge définitive. */
export const GIFT_UNDO_DAYS = 30;

export interface JobsResult {
  logbook: SyncResult | "not_due";
  purged: { logbook: number; errorReports: number; technical: number } | null;
  /** Suppressions de comptes, rappels, comptes jamais activés, réessais chez Digitorn (US-56, US-58, US-68). */
  lifecycle: LifecycleResult;
  exports: { expired: number; failed: number };
  /** Rappels d'occasions de kdo_help et purge de ses effacements doux. */
  gifts: { reminders: ReminderResult; purged: number };
}

/** Synchronise le carnet toutes les X heures (US-40 RT2) puis nettoie les données expirées (US-40 RT6, US-61 RT2, US-70 RT3). */
export async function runDueJobs(ctx: Ctx, options: { force?: boolean } = {}): Promise<JobsResult> {
  const hours = await integerSetting(ctx.db, "logbook_sync_interval_hours", 5);
  const last = await ctx.db.selectFrom("logbook_sync_runs").select("started_at").orderBy("started_at", "desc").limit(1).executeTakeFirst();
  const due = options.force || !last || ctx.now.getTime() - new Date(last.started_at).getTime() >= hours * 3_600_000;

  // Les suppressions arrivées à échéance, les exports et les rappels ne dépendent pas de la fréquence du carnet : on les traite à chaque passage.
  const lifecycle = await runLifecycle(ctx);
  const exports = await cleanupExports(ctx);
  const gifts = await runGiftJobs(ctx);
  if (!due) return { logbook: "not_due", purged: null, lifecycle, exports, gifts };

  const logbook = await syncLogbook(ctx);
  return { logbook, purged: await purgeExpired(ctx), lifecycle, exports, gifts };
}

/** Rappels d'occasions (dans l'application via le tchat de kdo_help, et sur WhatsApp) puis purge des effacements doux. */
export async function runGiftJobs(ctx: Ctx): Promise<JobsResult["gifts"]> {
  const store = giftStore(ctx.db);
  const reminders = await runGiftReminders({
    db: ctx.db,
    now: ctx.now,
    store,
    prefs: prefsStore(ctx.db),
    transport: whatsapp(),
    postInApp: async (userId, text) => {
      // En mode « live », le client réel expose le simulateur qui porte les agents locaux.
      const client = digitorn() as { simulator?: unknown };
      const simulator = (client.simulator ?? client) as Partial<MockDigitorn>;
      if (typeof simulator.postAgentMessage !== "function") throw new Error("Message proactif d'agent : pas encore disponible hors simulateur Digitorn.");
      simulator.postAgentMessage(await ensureDigitornRef(ctx.db, userId), "kdo_help", text);
    },
  });
  const purged = await store.purgeDeleted(new Date(ctx.now.getTime() - GIFT_UNDO_DAYS * 86_400_000));
  return { reminders, purged };
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
