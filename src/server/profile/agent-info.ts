import { digitorn } from "@/server/adapters/digitorn";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { normalizePhone } from "@/server/phone";
import { decrypt, encrypt } from "@/server/security/crypto";

/**
 * Informations propres à chaque agent (US-10 RF2, RF12, RF13 ; US-11 RF2 ; US-12) : définies par
 * l'administrateur à la publication, saisies par le profil (ou par l'utilisateur principal pour ses
 * invités), chiffrées en base (US-10 RT1). Une valeur saisie pour un autre agent sous la même clé
 * commune est proposée pré-remplie ; la valeur confirmée reste une copie propre à l'agent (D15).
 */

export type InfoDataType = "text" | "phone" | "postal_code" | "past_date" | "email";

export interface InfoField {
  id: string;
  label: string;
  dataType: InfoDataType;
  required: boolean;
  maxItems: number;
  values: string[];
  /** Valeur reprise d'un autre agent, à confirmer ou modifier. */
  prefill: { values: string[]; sourceAgent: string } | null;
}

export interface AgentInfoForm {
  agent: { id: string; name: string };
  profile: { id: string; firstName: string; isSelf: boolean };
  fields: InfoField[];
  complete: boolean;
}

const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

/** Le profil lui-même, ou l'utilisateur principal pour un invité de son compte (US-11 RF2, US-12 RF6). */
async function authorizeTarget(ctx: Ctx, viewer: SessionContext, targetUserId: string) {
  const target = await ctx.db
    .selectFrom("users")
    .select(["id", "first_name", "account_id", "role", "digitorn_user_ref"])
    .where("id", "=", targetUserId)
    .where("status", "in", ["pending_activation", "active"])
    .executeTakeFirst();
  const allowed =
    target &&
    (target.id === viewer.user.id ||
      (viewer.user.role === "primary_user" && target.role === "guest" && target.account_id === viewer.user.accountId));
  if (!allowed) throw new Rejection("forbidden", "Vous ne pouvez pas consulter ces informations.", 403);
  return target;
}

async function agentInDashboard(ctx: Ctx, userId: string, agentId: string) {
  const agent = await ctx.db
    .selectFrom("profile_agents as pa")
    .innerJoin("agents as a", "a.id", "pa.agent_id")
    .select(["a.id", "a.name", "a.digitorn_agent_ref"])
    .where("pa.user_id", "=", userId)
    .where("pa.agent_id", "=", agentId)
    .where("pa.removed_at", "is", null)
    .executeTakeFirst();
  if (!agent) throw new Rejection("not_found", "Cet agent n'est pas sur ce dashboard.", 404);
  return agent;
}

async function storedValues(ctx: Ctx, userId: string, fieldIds: string[]) {
  if (!fieldIds.length) return new Map<string, string[]>();
  const rows = await ctx.db
    .selectFrom("user_agent_info_values")
    .select(["info_field_id", "item_position", "value_encrypted"])
    .where("user_id", "=", userId)
    .where("info_field_id", "in", fieldIds)
    .orderBy("item_position")
    .execute();
  const values = new Map<string, string[]>();
  for (const row of rows) {
    const list = values.get(row.info_field_id) ?? [];
    list.push(decrypt(Buffer.from(row.value_encrypted), key()));
    values.set(row.info_field_id, list);
  }
  return values;
}

export async function getAgentInfoForm(ctx: Ctx, viewer: SessionContext, targetUserId: string, agentId: string): Promise<AgentInfoForm> {
  const target = await authorizeTarget(ctx, viewer, targetUserId);
  const agent = await agentInDashboard(ctx, target.id, agentId);
  const fields = await ctx.db
    .selectFrom("agent_info_fields")
    .select(["id", "label", "data_type", "is_required", "max_items", "shared_key"])
    .where("agent_id", "=", agentId)
    .orderBy("sort_order")
    .orderBy("id")
    .execute();
  const values = await storedValues(ctx, target.id, fields.map((f) => f.id));

  // Pré-remplissage : même clé commune et même type, saisi pour un autre agent (dernière valeur modifiée).
  const prefills = new Map<string, InfoField["prefill"]>();
  for (const field of fields) {
    if (!field.shared_key || values.has(field.id)) continue;
    const source = await ctx.db
      .selectFrom("user_agent_info_values as v")
      .innerJoin("agent_info_fields as f", "f.id", "v.info_field_id")
      .innerJoin("agents as a", "a.id", "f.agent_id")
      .select(["f.id as field_id", "a.name"])
      .where("v.user_id", "=", target.id)
      .where("f.shared_key", "=", field.shared_key)
      .where("f.data_type", "=", field.data_type)
      .where("f.id", "<>", field.id)
      .orderBy("v.updated_at", "desc")
      .executeTakeFirst();
    if (!source) continue;
    const sourceValues = (await storedValues(ctx, target.id, [source.field_id])).get(source.field_id) ?? [];
    if (sourceValues.length) prefills.set(field.id, { values: sourceValues.slice(0, field.max_items), sourceAgent: source.name });
  }

  const result = fields.map<InfoField>((f) => ({
    id: f.id,
    label: f.label,
    dataType: f.data_type,
    required: f.is_required,
    maxItems: f.max_items,
    values: values.get(f.id) ?? [],
    prefill: prefills.get(f.id) ?? null,
  }));
  return {
    agent: { id: agent.id, name: agent.name },
    profile: { id: target.id, firstName: target.first_name, isSelf: target.id === viewer.user.id },
    fields: result,
    complete: result.every((f) => !f.required || f.values.length > 0),
  };
}

/** Contrôle et normalisation d'une valeur selon son type (US-10 RF4). Renvoie la valeur ou une erreur. */
export function checkValue(type: InfoDataType, raw: string, today: Date = new Date()): { value: string } | { error: string } {
  const value = raw.trim();
  switch (type) {
    case "text":
      return value.length <= 500 ? { value } : { error: "500 caractères au maximum" };
    case "phone": {
      const phone = normalizePhone(value);
      return phone ? { value: phone } : { error: "Numéro de téléphone invalide" };
    }
    case "postal_code":
      return /^\d{5}$/.test(value) ? { value } : { error: "Format invalide — 5 chiffres" };
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? { value } : { error: "Adresse email invalide" };
    case "past_date": {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
      const valid = date && date.toISOString().slice(0, 10) === value;
      if (!valid) return { error: "Date invalide" };
      return date < today ? { value } : { error: "La date doit être passée" };
    }
  }
}

/**
 * Enregistre les informations d'un profil pour un agent. Un champ obligatoire ne peut pas rester
 * vide (US-12 RF3) ; la dernière modification l'emporte (US-12 RF8). Les nouvelles valeurs sont
 * transmises aussitôt à Digitorn (US-12 RF5, D11).
 */
export async function saveAgentInfo(
  ctx: Ctx,
  viewer: SessionContext,
  targetUserId: string,
  agentId: string,
  input: Record<string, string[]>,
): Promise<AgentInfoForm> {
  const target = await authorizeTarget(ctx, viewer, targetUserId);
  const agent = await agentInDashboard(ctx, target.id, agentId);
  const fields = await ctx.db
    .selectFrom("agent_info_fields")
    .select(["id", "label", "data_type", "is_required", "max_items"])
    .where("agent_id", "=", agentId)
    .execute();

  const errors: Record<string, string> = {};
  const clean = new Map<string, string[]>();
  for (const field of fields) {
    const raw = (input[field.id] ?? []).map((v) => v.trim()).filter(Boolean);
    if (raw.length > field.max_items) {
      errors[field.id] = `${field.max_items} élément${field.max_items > 1 ? "s" : ""} au maximum`;
      continue;
    }
    if (field.is_required && raw.length === 0) {
      errors[field.id] = "Ce champ est obligatoire";
      continue;
    }
    const values: string[] = [];
    for (const item of raw) {
      const checked = checkValue(field.data_type, item, ctx.now);
      if ("error" in checked) {
        errors[field.id] = checked.error;
        break;
      }
      values.push(checked.value);
    }
    clean.set(field.id, values);
  }
  if (Object.keys(errors).length) throw new Rejection("invalid_info", "Certaines informations sont à corriger.", 422, errors);

  await ctx.db.transaction().execute(async (trx) => {
    for (const [fieldId, values] of clean) {
      await trx
        .deleteFrom("user_agent_info_values")
        .where("user_id", "=", target.id)
        .where("info_field_id", "=", fieldId)
        .where("item_position", ">", values.length)
        .execute();
      for (const [index, value] of values.entries()) {
        await trx
          .insertInto("user_agent_info_values")
          .values({
            user_id: target.id,
            info_field_id: fieldId,
            item_position: index + 1,
            value_encrypted: encrypt(value, key()),
            updated_by_user_id: viewer.user.id,
            updated_at: ctx.now,
          })
          .onConflict((oc) =>
            oc.columns(["user_id", "info_field_id", "item_position"]).doUpdateSet({
              value_encrypted: (eb) => eb.ref("excluded.value_encrypted"),
              updated_by_user_id: viewer.user.id,
              updated_at: ctx.now,
            }),
          )
          .execute();
      }
    }
  });

  if (target.digitorn_user_ref) {
    const info = Object.fromEntries(
      fields.map((f) => [f.label, f.max_items > 1 ? (clean.get(f.id) ?? []) : (clean.get(f.id)?.[0] ?? "")]),
    );
    await digitorn().updateProfileInfo(target.digitorn_user_ref, agent.digitorn_agent_ref, info);
  }
  return getAgentInfoForm(ctx, viewer, targetUserId, agentId);
}

export interface AgentInfoStatus {
  agentId: string;
  agentName: string;
  fields: number;
  status: "complete" | "missing" | "none";
}

/** Informations d'un profil, agent par agent, avec les manques signalés (US-10 RF12, RF13 ; US-12 RF1). */
export async function agentInfoOverview(ctx: Ctx, viewer: SessionContext, targetUserId: string): Promise<AgentInfoStatus[]> {
  const target = await authorizeTarget(ctx, viewer, targetUserId);
  const agents = await ctx.db
    .selectFrom("profile_agents as pa")
    .innerJoin("agents as a", "a.id", "pa.agent_id")
    .select(["a.id", "a.name"])
    .where("pa.user_id", "=", target.id)
    .where("pa.removed_at", "is", null)
    .orderBy("pa.added_at")
    .execute();
  const overview: AgentInfoStatus[] = [];
  for (const agent of agents) {
    const fields = await ctx.db
      .selectFrom("agent_info_fields as f")
      .select([
        "f.id",
        "f.is_required",
        (eb) =>
          eb
            .exists(
              eb
                .selectFrom("user_agent_info_values as v")
                .select("v.id")
                .whereRef("v.info_field_id", "=", "f.id")
                .where("v.user_id", "=", target.id),
            )
            .as("filled"),
      ])
      .where("f.agent_id", "=", agent.id)
      .execute();
    overview.push({
      agentId: agent.id,
      agentName: agent.name,
      fields: fields.length,
      status: fields.length === 0 ? "none" : fields.every((f) => !f.is_required || f.filled) ? "complete" : "missing",
    });
  }
  return overview;
}
