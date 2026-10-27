import { sql, type Kysely } from "kysely";
import { messenger } from "@/server/adapters/messaging";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { pushConfigured, sendPush } from "@/server/push/service";
import { describeError } from "@/server/safe-log";
import { loadCalendarEvent, type EventType } from "./calendar";
import { requireFamilyProfile } from "./family";
import { autoConfirmedEmail, autoConfirmedHeadline, eventAddedAutoBody, eventAddedBody, eventToConfirmBody } from "./reminder-text";
import { familyTimeZone, pendingConfirmations } from "./reminders";

/**
 * Prévenir l'autre parent quand un RDV est ajouté (US-113). Les règles — qui est prévenu, de quoi, quand, une seule fois — sont celles de la base :
 * `plan_event_notices` réserve les envois dus (une ligne par RDV et par destinataire), `revalidate_event_notices` les remet en accord avec l'état du RDV
 * avant l'envoi, `shift_to_morning` reporte à 8 h ce qui tombe la nuit. Ce module envoie les notifications réservées et ne fait rien d'autre :
 * jamais d'email (AF-3), le contenu est composé par MAAQ sans appel à l'agent (RT3).
 */

/** « Ajouté » et « à confirmer » (US-113), et l'avis aux parents d'un enregistrement sans réponse (AT-8, `auto_confirmed`). */
const NOTICE_KINDS = ["event_added", "event_to_confirm", "auto_confirmed"] as const;
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
     where e.id = n.event_id and n.status = 'scheduled' and n.kind in ('event_added', 'event_to_confirm', 'auto_confirmed') and e.starts_at <= ${ctx.now}
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
      if (row.kind === "auto_confirmed") {
        await deliverAutoConfirmed(ctx, trx, row, notified, timeZone, meta.account_id, totals);
        return;
      }
      // Le lieu n'est jamais repris : une notification s'affiche sur l'écran verrouillé (D31, RF8).
      // Un invité secondaire concerné par un RDV enregistré d'office reçoit un texte sans demandeur (RF10).
      const auto = await trx.selectFrom("family_events").select("auto_confirmed").where("id", "=", row.event_id).executeTakeFirstOrThrow();
      const body = row.kind === "event_to_confirm" ? eventToConfirmBody(notified, name, timeZone, ctx.now) : auto.auto_confirmed ? eventAddedAutoBody(notified, timeZone, ctx.now) : eventAddedBody(notified, name, timeZone, ctx.now);
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

/**
 * Avis aux parents d'un RDV enregistré d'office, « RDV ajouté automatiquement » (AT-8, US-113 RF7) : par notification sur leurs appareils, par email à défaut
 * (c'est le seul moyen de savoir que le RDV est entré dans le calendrier). La ligne est déjà verrouillée par l'appelant ; si rien ne part, elle reste en attente.
 */
async function deliverAutoConfirmed(
  ctx: Ctx,
  trx: Kysely<DB>,
  row: { id: string; recipient_user_id: string; attempts: number },
  event: { id: string; title: string; type: EventType; place: string | null; startsAt: Date; allDay: boolean },
  timeZone: string,
  accountId: string,
  totals: NoticesResult,
): Promise<void> {
  const to = await trx.selectFrom("users").select(["first_name", "email"]).where("id", "=", row.recipient_user_id).executeTakeFirst();
  const badge = pushConfigured() ? await pendingConfirmations(trx, accountId, ctx.now) : 0;
  const pushed = (await sendPush(ctx, row.recipient_user_id, { title: "Assistant Famille", body: autoConfirmedHeadline(event, timeZone), url: `/calendrier/rdv/${event.id}`, tag: `auto-${event.id}`, badge })).delivered;
  let emailed = false;
  if (pushed === 0 && to?.email) {
    await messenger().sendEmail(autoConfirmedEmail({ firstName: to.first_name, to: to.email, event, timeZone, appUrl: env().APP_URL.replace(/\/$/, "") }));
    emailed = true;
  }
  if (pushed > 0 || emailed) {
    await trx.updateTable("scheduled_notifications").set({ status: "sent", push_sent_at: pushed > 0 ? ctx.now : null, email_sent_at: emailed ? ctx.now : null, attempts: row.attempts + 1 }).where("id", "=", row.id).execute();
    totals.sent += 1;
  } else {
    await trx.updateTable("scheduled_notifications").set({ attempts: row.attempts + 1, last_error: "aucun moyen de joindre le destinataire" }).where("id", "=", row.id).execute();
    totals.failed += 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Enregistrement sans réponse (AT-8, D49)
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Confirme d'office, au nom de « MAAQ (sans réponse) », les RDV provisoires dont l'échéance est atteinte (`auto_confirm_family_events`) : 72 h après la proposition,
 * ou 2 h avant le début ; jamais pour un RDV en conflit, sans membre précisé, écarté, issu d'un mail ou d'un partage, ni pour une série. Toléré 60 minutes après
 * l'échéance. Livré éteint : sans `AUTO_CONFIRM_MODE=on`, rien n'est confirmé. Retourne le nombre de RDV confirmés.
 */
export async function runAutoConfirm(ctx: Ctx, options: { enabled?: boolean } = {}): Promise<number> {
  if (!(options.enabled ?? env().AUTO_CONFIRM_MODE === "on")) return 0;
  const done = await sql<{ n: number }>`select auto_confirm_family_events() as n`.execute(ctx.db);
  return Number(done.rows[0]?.n ?? 0);
}
