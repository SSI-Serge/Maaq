import type { Kysely } from "kysely";
import { safeTimezone } from "@/server/auth/format";
import type { DB } from "@/server/db/schema.generated";

/** Préférences de rappel d'un profil (fuseau, heures calmes, canal). */

export type ReminderChannel = "app" | "whatsapp" | "both";

export interface ReminderPrefs {
  timezone: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  reminderChannel: ReminderChannel;
}

export interface PrefsStore {
  get(userId: string): Promise<ReminderPrefs>;
  set(userId: string, patch: Partial<ReminderPrefs>): Promise<ReminderPrefs>;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function checkTime(value: string): string {
  if (!TIME.test(value)) throw new Error(`Heure invalide : ${value} (attendu HH:MM)`);
  return value;
}

function hm(value: string | Date): string {
  const text = typeof value === "string" ? value : value.toISOString().slice(11, 16);
  return text.slice(0, 5);
}

export class DbPrefsStore implements PrefsStore {
  constructor(private readonly db: Kysely<DB>) {}

  async get(userId: string): Promise<ReminderPrefs> {
    const row = await this.db.selectFrom("users").select(["timezone", "quiet_hours_start", "quiet_hours_end", "reminder_channel"]).where("id", "=", userId).executeTakeFirstOrThrow();
    return { timezone: row.timezone, quietHoursStart: hm(row.quiet_hours_start), quietHoursEnd: hm(row.quiet_hours_end), reminderChannel: row.reminder_channel as ReminderChannel };
  }

  async set(userId: string, patch: Partial<ReminderPrefs>): Promise<ReminderPrefs> {
    await this.db
      .updateTable("users")
      .set({
        ...(patch.timezone !== undefined ? { timezone: safeTimezone(patch.timezone) } : {}),
        ...(patch.quietHoursStart !== undefined ? { quiet_hours_start: checkTime(patch.quietHoursStart) } : {}),
        ...(patch.quietHoursEnd !== undefined ? { quiet_hours_end: checkTime(patch.quietHoursEnd) } : {}),
        ...(patch.reminderChannel !== undefined ? { reminder_channel: patch.reminderChannel } : {}),
      })
      .where("id", "=", userId)
      .execute();
    return this.get(userId);
  }
}

export class MemoryPrefsStore implements PrefsStore {
  private readonly prefs = new Map<string, ReminderPrefs>();

  async get(userId: string): Promise<ReminderPrefs> {
    return { ...(this.prefs.get(userId) ?? { timezone: "Europe/Paris", quietHoursStart: "21:00", quietHoursEnd: "08:00", reminderChannel: "app" }) };
  }

  async set(userId: string, patch: Partial<ReminderPrefs>): Promise<ReminderPrefs> {
    const next = { ...(await this.get(userId)), ...patch };
    if (patch.quietHoursStart) checkTime(patch.quietHoursStart);
    if (patch.quietHoursEnd) checkTime(patch.quietHoursEnd);
    this.prefs.set(userId, next);
    return { ...next };
  }
}
