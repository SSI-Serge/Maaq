import { sql } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { pushConfigured, sendPush } from "@/server/push/service";
import { describeError } from "@/server/safe-log";
import { loadCalendarEvent } from "./calendar";
import { requireFamilyProfile } from "./family";
import { eventAddedBody, eventToConfirmBody } from "./reminder-text";
import { familyTimeZone, pendingConfirmations } from "./reminders";

/**
 * Prévenir l'autre parent quand un RDV est ajouté (US-113). Les règles — qui est prévenu, de quoi, quand, une seule fois — sont celles de la base :
 * `plan_event_notices` réserve les envois dus (une ligne par RDV et par destinataire), `revalidate_event_notices` les remet en accord avec l'état du RDV
 * avant l'envoi, `shift_to_morning` reporte à 8 h ce qui tombe la nuit. Ce module envoie les notifications réservées et ne fait rien d'autre :
 * jamais d'email (AF-3), le contenu est composé par MAAQ sans appel à l'agent (RT3).
 */

const NOTICE_KINDS = ["event_added", "event_to_confirm"] as const;
/** Attente maximale de la tentative immédiate après une confirmation : au-delà, le planificateur prend le relais (RT1). */
export const IMMEDIATE_WAIT_MS = 3000;

export interface NoticesResult {
  planned: number;
  sent: number;
  failed: number;
  abandoned: number;
}

/**
 * Un passage : remet les réservations en accord avec les RDV, réserve celles qui sont dues, puis envoie les notifications arrivées à échéance.
 * Sans danger à relancer : un envoi déjà fait n'est jamais refait. `eventId` limite la réservation et l'envoi à un RDV (tentative immédiate).
 */
export async function runEventNotices(ctx: Ctx, options: { eventId?: string } = {}): Promise<NoticesResult> {
  const totals: NoticesResult = { planned: 0, sent: 0, failed: 0, abandoned: 0 };
  await sql`select revalidate_event_notices()`.execute(ctx.db);
  const planned = await sql<{ n: number }>`select plan_event_notices(${options.eventId ?? null}::uuid) as n`.execute(ctx.db);
  totals.planned = Number(planned.rows[0]?.n ?? 0);

  // Un RDV commencé n'a plus de raison d'être annoncé (RF16 : réessayé tant qu'il n'a pas commencé).
  const gone = await sql`
    update scheduled_notifications n set status = 'abandoned'
      from family_events e
     where e.id = n.event_id and n.status = 'scheduled' and n.kind in ('event_added', 'event_to_confirm') and e.starts_at <= ${ctx.now}
       ${options.eventId ? sql`and n.event_id = ${options.eventId}::uuid` : sql``}`.execute(ctx.db);
  totals.abandoned = Number(gone.numAffectedRows ?? 0);

  // L'échéance a été posée avec l'horloge de la base (report à 8 h la nuit compris) : c'est elle qui la juge.
  const due = await ctx.db
    .selectFrom("scheduled_notifications")
    .select("id")
    .where("kind", "in", [...NOTICE_KINDS])
    .where("status", "=", "scheduled")
    .where(sql<boolean>`due_at <= now()`)
    .$if(Boolean(options.eventId), (qb) => qb.where("event_id", "=", options.eventId!))
    .orderBy("due_at")
    .limit(500)
    .execute();
  for (const row of due) await deliver(ctx, row.id, totals);
  return totals;
}

/**
 * Envoie une notification réservée. La ligne est verrouillée pour toute la durée de l'envoi : un second passage (tentative immédiate et planificateur
 * en même temps) la saute au lieu de l'envoyer deux fois (RF16, CA 16.1). Rien n'est joint : la ligne reste en attente et sera reprise (CA 16.2).
 */
async function deliver(ctx: Ctx, id: string, totals: NoticesResult): Promise<void> {
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("scheduled_notifications").selectAll().where("id", "=", id).where("status", "=", "scheduled").forUpdate().skipLocked().executeTakeFirst();
      if (!row?.event_id) return;
      const meta = await trx.selectFrom("family_events").select(["account_id", "requested_by_user_id"]).where("id", "=", row.event_id).executeTakeFirst();
      if (!meta) return;
      const event = await loadCalendarEvent(trx, meta.account_id, row.event_id);
      if (!event) return;
      const requester = meta.requested_by_user_id ? (await trx.selectFrom("users").select("first_name").where("id", "=", meta.requested_by_user_id).executeTakeFirst())?.first_name : null;
      const timeZone = await familyTimeZone(trx, meta.account_id);
      const notified = { id: event.id, title: event.title, type: event.type, place: event.place, startsAt: event.startsAt, allDay: event.allDay };
      const name = requester ?? "Un parent";
      // Le lieu n'est jamais repris : une notification s'affiche sur l'écran verrouillé (D31, RF8).
      const body = row.kind === "event_to_confirm" ? eventToConfirmBody(notified, name, timeZone, ctx.now) : eventAddedBody(notified, name, timeZone, ctx.now);
      const badge = pushConfigured() ? await pendingConfirmations(trx, meta.account_id, ctx.now) : 0;
      const sent = await sendPush(ctx, row.recipient_user_id, { title: "Assistant Famille", body, url: `/calendrier/rdv/${event.id}`, tag: `notice-${event.id}`, badge });
      if (sent.delivered > 0) {
        await trx.updateTable("scheduled_notifications").set({ status: "sent", push_sent_at: ctx.now, attempts: row.attempts + 1 }).where("id", "=", id).execute();
        totals.sent += 1;
      } else {
        await trx.updateTable("scheduled_notifications").set({ attempts: row.attempts + 1, last_error: "aucun appareil joint" }).where("id", "=", id).execute();
        totals.failed += 1;
      }
    });
  } catch (error) {
    console.error(`Notification de RDV non envoyée : ${describeError(error)}`);
    totals.failed += 1;
  }
}

/**
 * Tentative immédiate après la confirmation d'un RDV, une fois la transaction terminée (RT1). Attente de 3 secondes au plus ; en cas d'échec ou de
 * délai dépassé, le planificateur envoie la notification à son passage suivant : les deux passent par la même réservation, sans doublon.
 */
export async function notifyAfterConfirmation(ctx: Ctx, eventId: string): Promise<void> {
  const attempt = runEventNotices(ctx, { eventId }).catch((error) => console.error(`Notification immédiate abandonnée : ${describeError(error)}`));
  await Promise.race([attempt, new Promise<void>((resolve) => setTimeout(resolve, IMMEDIATE_WAIT_MS))]);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Réglage personnel (US-113 RF14, D58)
// ---------------------------------------------------------------------------------------------------------------------------

export interface PersonalSettings {
  /** « Être prévenu des RDV ajoutés par l'autre parent » (parent) ou « …qui me concernent » (invité secondaire). Actif par défaut. */
  notifyEventsAdded: boolean;
  audience: "parent" | "guest";
}

/** Chaque profil de la famille, invités secondaires compris, règle ses propres notifications. */
export async function getPersonalSettings(ctx: Ctx, session: SessionContext): Promise<PersonalSettings> {
  const { parent } = requireFamilyProfile(session);
  const row = await ctx.db.selectFrom("user_assistant_settings").select("notify_events_added").where("user_id", "=", session.user.id).executeTakeFirst();
  return { notifyEventsAdded: row?.notify_events_added ?? true, audience: parent ? "parent" : "guest" };
}

export async function setPersonalSettings(ctx: Ctx, session: SessionContext, input: { notifyEventsAdded: boolean }): Promise<PersonalSettings> {
  const { accountId, parent } = requireFamilyProfile(session);
  if (typeof input.notifyEventsAdded !== "boolean") throw new Rejection("invalid_setting", "Ce réglage est invalide.", 422);
  await ctx.db
    .insertInto("user_assistant_settings")
    .values({ user_id: session.user.id, account_id: accountId, notify_events_added: input.notifyEventsAdded })
    .onConflict((oc) => oc.column("user_id").doUpdateSet({ notify_events_added: input.notifyEventsAdded }))
    .execute();
  return { notifyEventsAdded: input.notifyEventsAdded, audience: parent ? "parent" : "guest" };
}
