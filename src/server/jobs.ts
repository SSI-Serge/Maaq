import { sql } from "kysely";
import { whatsapp } from "@/server/adapters/whatsapp";
import type { Ctx } from "@/server/auth/service";
import { cleanupExports } from "@/server/compliance/exports";
import { runLifecycle, type LifecycleResult } from "@/server/compliance/lifecycle";
import { anthropicLlm } from "@/server/agents/llm";
import { postToAgentChat } from "@/server/agents/proactive";
import { calendarSource } from "@/server/adapters/calendar";
import { env } from "@/server/env";
import { localDate } from "@/server/gifts/model";
import { runGiftReminders, type ReminderResult } from "@/server/gifts/reminders";
import { giftStore, prefsStore } from "@/server/gifts/service";
import { runAgendaScan, type AgendaScanResult } from "@/server/marketplace/agenda";
import { matchStore } from "@/server/marketplace/buyer-service";
import { expireIntroductions } from "@/server/marketplace/handoff";
import { appHandoffDeps } from "@/server/marketplace/handoff-app";
import { runRematch, type RematchResult } from "@/server/marketplace/rematch";
import { syncLogbook, type SyncResult } from "@/server/logbook/service";
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
  /** Marketplace silencieux : mises en relation expirées, puis (avec un modèle local) demandes réexaminées et agenda. */
  marketplace: { expired: number; rematch: RematchResult | "off"; agenda: AgendaScanResult | "off" };
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
  const marketplace = await runMarketplaceJobs(ctx);
  if (!due) return { logbook: "not_due", purged: null, lifecycle, exports, gifts, marketplace };

  const logbook = await syncLogbook(ctx);
  return { logbook, purged: await purgeExpired(ctx), lifecycle, exports, gifts, marketplace };
}

/** Expiration des mises en relation sans réponse, puis réexamen des demandes « me prévenir » et lecture des agendas (ces deux-là exigent un modèle local). */
export async function runMarketplaceJobs(ctx: Ctx): Promise<JobsResult["marketplace"]> {
  const expired = await expireIntroductions(appHandoffDeps(ctx.db, () => ctx.now));
  const { LOCAL_AGENTS_MODE, LOCAL_AGENTS_MODEL } = env();
  if (LOCAL_AGENTS_MODE === "off") return { expired, rematch: "off", agenda: "off" };
  const firstNameOf = async (userId: string) => (await ctx.db.selectFrom("users").select("first_name").where("id", "=", userId).executeTakeFirst())?.first_name ?? null;
  const store = matchStore(ctx.db);
  const llm = anthropicLlm({ model: LOCAL_AGENTS_MODEL });
  const today = localDate(ctx.now, "Europe/Paris");
  const postInApp = (userId: string, text: string) => postToAgentChat(ctx.db, userId, "coup_de_main", text);
  const rematch = await runRematch({ store, llm, now: ctx.now, today, postInApp }, firstNameOf);
  const agenda = await runAgendaScan({ store, calendar: calendarSource(), llm, now: ctx.now, today, postInApp });
  return { expired, rematch, agenda };
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
    postInApp: (userId, text) => postToAgentChat(ctx.db, userId, "kdo_help", text),
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
