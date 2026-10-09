import type { Kysely } from "kysely";
import { TEMPLATES } from "@/server/adapters/whatsapp/templates";
import type { OutboundMessage, WhatsAppTransport } from "@/server/adapters/whatsapp/types";
import type { DB } from "@/server/db/schema.generated";
import { dueReminderPoint, frenchDate, inQuietHours, localDate, REMINDER_POINTS, type Occasion } from "./model";
import type { PrefsStore } from "./prefs";
import { occasionsFor } from "./service";
import type { GiftStore } from "./store";

/**
 * Rappels d'occasions (T-21, T-7, T-2). Un seul envoi par (profil, occasion, échéance, canal), jamais pendant
 * les heures calmes, rien pour une occasion réglée ou reportée, et un seul message par passage quand plusieurs
 * dates tombent ensemble. Sur WhatsApp, hors de la fenêtre de 24 h ouverte par un message de la personne, seul
 * un modèle approuvé peut partir.
 */

export const WINDOW_24H_MS = 24 * 3_600_000;

export interface ReminderDeps {
  db: Kysely<DB>;
  now: Date;
  store: GiftStore;
  prefs: PrefsStore;
  transport: WhatsAppTransport;
  /** Dépose un message de l'agent dans le tchat de l'application (rappel visible à l'ouverture). */
  postInApp: (userId: string, text: string) => Promise<void>;
}

export interface ReminderResult {
  users: number;
  sent: number;
  failed: number;
  /** Passages reportés : heures calmes, ou WhatsApp demandé sans numéro relié (envoyé dans l'application à la place). */
  quiet: number;
}

interface Due {
  occasion: Occasion;
  point: string;
}

/** Phrase décrivant les occasions dues : « l'anniversaire de Léa dans 8 jours (15/10) et Noël dans 20 jours (25/12) ». */
export function describeDue(due: Due[]): string {
  const parts = due.map(({ occasion }) => {
    const label = occasion.kind === "birthday" && occasion.personName ? `l'anniversaire de ${occasion.personName}${occasion.age !== null ? ` (${occasion.age} ans)` : ""}` : occasion.title;
    const when = occasion.daysRemaining === 0 ? "aujourd'hui" : occasion.daysRemaining === 1 ? "demain" : `dans ${occasion.daysRemaining} jours`;
    return `${label} ${when} (${frenchDate(occasion.date)})`;
  });
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} et ${parts.at(-1)}`;
}

export function reminderButtons(first: Occasion) {
  return [
    { id: `ideas:${first.key}`, title: "Voir les idées" },
    { id: `snooze:${first.key}`, title: "Plus tard" },
    { id: `sorted:${first.key}`, title: "C'est réglé" },
  ];
}

export function reminderText(firstName: string, due: Due[]): string {
  return `Bonjour ${firstName}, une date approche : ${describeDue(due)}. Souhaitez-vous des idées de cadeaux ?`;
}

export async function runGiftReminders(deps: ReminderDeps): Promise<ReminderResult> {
  const result: ReminderResult = { users: 0, sent: 0, failed: 0, quiet: 0 };
  const users = await deps.db
    .selectFrom("users as u")
    .select(["u.id", "u.first_name"])
    .where("u.status", "=", "active")
    .where("u.role", "in", ["primary_user", "guest"])
    .where((eb) => eb.or([eb.exists(eb.selectFrom("gift_people").select("id").whereRef("user_id", "=", "u.id").where("deleted_at", "is", null)), eb.exists(eb.selectFrom("gift_events").select("id").whereRef("user_id", "=", "u.id").where("deleted_at", "is", null))]))
    .execute();

  for (const user of users) {
    result.users++;
    const prefs = await deps.prefs.get(user.id);
    const today = localDate(deps.now, prefs.timezone);
    const occasions = await occasionsFor(deps.store, user.id, deps.now, prefs.timezone, Math.max(...REMINDER_POINTS));

    const sentRows = await deps.db.selectFrom("gift_notifications").select(["occasion_key", "reminder_point"]).where("user_id", "=", user.id).where("status", "in", ["sent", "queued"]).execute();
    const sentPoints = new Map<string, Set<string>>();
    for (const row of sentRows) sentPoints.set(row.occasion_key, (sentPoints.get(row.occasion_key) ?? new Set()).add(row.reminder_point));

    const due: Due[] = [];
    for (const occasion of occasions) {
      if (occasion.sorted) continue;
      if (occasion.snoozedUntil && occasion.snoozedUntil > today) continue;
      const point = dueReminderPoint(occasion.daysRemaining, sentPoints.get(occasion.key) ?? new Set());
      if (point) due.push({ occasion, point });
    }
    if (due.length === 0) continue;

    if (inQuietHours(deps.now, prefs.timezone, prefs.quietHoursStart, prefs.quietHoursEnd)) {
      result.quiet++;
      continue;
    }

    const identity = await deps.db.selectFrom("channel_identities").select(["external_id", "opt_in", "last_inbound_at"]).where("user_id", "=", user.id).where("channel", "=", "whatsapp").executeTakeFirst();
    const wantsWhatsApp = prefs.reminderChannel !== "app";
    const canWhatsApp = Boolean(identity?.opt_in);
    // En base, le canal « application » s'appelle « web » (type channel_kind).
    const channels: ("web" | "whatsapp")[] = [];
    if (prefs.reminderChannel !== "whatsapp" || !canWhatsApp) channels.push("web");
    if (wantsWhatsApp && canWhatsApp) channels.push("whatsapp");
    if (wantsWhatsApp && !canWhatsApp) result.quiet++;

    for (const channel of channels) {
      // Réservation des lignes : une autre exécution simultanée ne renverra pas le même rappel.
      const claimed: Due[] = [];
      for (const item of due) {
        const row = await deps.db
          .insertInto("gift_notifications")
          .values({ user_id: user.id, occasion_key: item.occasion.key, reminder_point: item.point, channel, template_name: null, status: "queued", scheduled_for: deps.now, created_at: deps.now })
          .onConflict((oc) => oc.columns(["user_id", "occasion_key", "reminder_point", "channel"]).doNothing())
          .returning("id")
          .executeTakeFirst();
        if (row) claimed.push(item);
      }
      if (claimed.length === 0) continue;

      const text = reminderText(user.first_name, claimed);
      let ok = true;
      let templateName: string | null = null;
      try {
        if (channel === "web") {
          await deps.postInApp(user.id, text);
        } else {
          const inWindow = identity!.last_inbound_at !== null && deps.now.getTime() - new Date(identity!.last_inbound_at).getTime() < WINDOW_24H_MS;
          const first = claimed[0].occasion;
          const message: OutboundMessage = inWindow
            ? { kind: "buttons", to: identity!.external_id, text, buttons: reminderButtons(first) }
            : {
                kind: "template",
                to: identity!.external_id,
                name: TEMPLATES.occasion_reminder.name,
                language: TEMPLATES.occasion_reminder.language,
                bodyParams: [user.first_name, describeDue(claimed)],
                buttonPayloads: reminderButtons(first).map((b) => b.id),
              };
          if (!inWindow) templateName = TEMPLATES.occasion_reminder.name;
          await deps.transport.send(message);
        }
      } catch (error) {
        ok = false;
        console.error(`[rappels] envoi ${channel} échoué pour ${user.id} :`, error);
      }

      for (const item of claimed) {
        await deps.db
          .updateTable("gift_notifications")
          .set({ status: ok ? "sent" : "failed", sent_at: ok ? deps.now : null, template_name: templateName })
          .where("user_id", "=", user.id)
          .where("occasion_key", "=", item.occasion.key)
          .where("reminder_point", "=", item.point)
          .where("channel", "=", channel)
          .execute();
      }
      // Un envoi raté se retentera au passage suivant : la réservation est libérée.
      if (!ok) {
        await deps.db.deleteFrom("gift_notifications").where("user_id", "=", user.id).where("channel", "=", channel).where("status", "=", "failed").execute();
        result.failed++;
      } else {
        result.sent++;
      }
    }
  }
  return result;
}
