import type { Ctx } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { adminName } from "./audit";

/** Délais et limites de la plateforme, réglables sans nouvelle version (US-65). */

export interface Setting {
  key: string;
  type: "integer" | "email";
  value: string | null;
  min: number | null;
  max: number | null;
}

export interface SettingChange {
  key: string;
  before: string | null;
  after: string | null;
  admin: string;
  at: string;
}

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function listSettings(ctx: Ctx): Promise<Setting[]> {
  const rows = await ctx.db
    .selectFrom("platform_settings")
    .select(["setting_key", "value_type", "value_text", "min_value", "max_value"])
    .orderBy("setting_key")
    .execute();
  return rows.map((r) => ({ key: r.setting_key, type: r.value_type, value: r.value_text, min: r.min_value, max: r.max_value }));
}

export async function settingHistory(ctx: Ctx, limit = 50): Promise<SettingChange[]> {
  const rows = await ctx.db
    .selectFrom("platform_setting_changes as c")
    .leftJoin("users as u", "u.id", "c.changed_by_user_id")
    .select(["c.setting_key", "c.old_value", "c.new_value", "c.changed_at", "u.first_name", "u.last_name"])
    .orderBy("c.changed_at", "desc")
    .orderBy("c.id", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    key: r.setting_key,
    before: r.old_value,
    after: r.new_value,
    admin: adminName(r.first_name, r.last_name),
    at: new Date(r.changed_at).toISOString(),
  }));
}

/** Contrôle d'une valeur selon son type et ses bornes ; renvoie le message d'erreur ou null (RF2). */
export function validateSetting(setting: Setting, raw: string): string | null {
  const value = raw.trim();
  if (setting.type === "email") {
    if (value === "") return null; // adresse non renseignée : autorisé
    return EMAIL_FORMAT.test(value) ? null : "Adresse email invalide";
  }
  if (!/^\d{1,9}$/.test(value)) return "Indiquez un nombre entier.";
  const n = Number(value);
  if (setting.min !== null && n < setting.min) return `La valeur doit être au moins ${setting.min}.`;
  if (setting.max !== null && n > setting.max) return `La valeur doit être au plus ${setting.max}.`;
  return null;
}

/**
 * Enregistre les valeurs modifiées et les inscrit à l'historique (RF4). Tout ou rien : une valeur
 * invalide n'enregistre rien et les valeurs précédentes restent en vigueur (RF6).
 */
export async function updateSettings(ctx: Ctx, adminId: string, values: Record<string, string>): Promise<number> {
  const settings = await listSettings(ctx);
  const errors: Record<string, string> = {};
  const changes: { setting: Setting; next: string | null }[] = [];

  for (const [key, raw] of Object.entries(values)) {
    const setting = settings.find((s) => s.key === key);
    if (!setting) {
      errors[key] = "Paramètre inconnu.";
      continue;
    }
    const error = validateSetting(setting, raw);
    if (error) {
      errors[key] = error;
      continue;
    }
    const next = raw.trim() === "" ? null : raw.trim();
    if (next !== setting.value) changes.push({ setting, next });
  }
  if (Object.keys(errors).length) throw new Rejection("invalid_settings", "Certaines valeurs sont à corriger.", 422, errors);

  await ctx.db.transaction().execute(async (trx) => {
    for (const { setting, next } of changes) {
      await trx
        .updateTable("platform_settings")
        .set({ value_text: next, updated_at: ctx.now, updated_by_user_id: adminId })
        .where("setting_key", "=", setting.key)
        .execute();
      await trx
        .insertInto("platform_setting_changes")
        .values({ setting_key: setting.key, old_value: setting.value, new_value: next, changed_by_user_id: adminId, changed_at: ctx.now })
        .execute();
    }
  });
  return changes.length;
}
