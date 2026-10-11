import { sql } from "kysely";
import { digitorn, type AgentCard } from "@/server/adapters/digitorn";
import type { Ctx } from "@/server/auth/service";
import { asRejection } from "@/server/digitorn-errors";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { encrypt } from "@/server/security/crypto";
import { APP_REF_PREFIX, cleanAppUrl, refFromAppUrl } from "./agent-ref";
import { adminName, logAdminAction } from "./audit";

/** Administration des agents du catalogue (US-45, US-46, US-47). */

export type CategoryCode = "pro" | "perso" | "contracts";
export type ConnectorCode = "google_drive" | "google_calendar" | "validation_mailbox";
export type OwnerScope = "each_profile" | "primary_user" | "account";
export type InfoDataType = "text" | "phone" | "postal_code" | "past_date" | "email";

export interface AgentRow {
  id: string;
  name: string;
  digitornRef: string;
  category: CategoryCode;
  categoryLabel: string;
  shortDescription: string;
  status: "available" | "blocked";
  maintenanceMessage: string | null;
  blockedAt: string | null;
  blockedBy: string | null;
  publishedAt: string;
  /** L'agent a un projet Digitorn réel (clé enregistrée). */
  digitornProject: boolean;
  /**
   * Tchat de l'agent : « identified » (clé du projet : Digitorn reconnaît la personne), « visitor » (adresse de l'application
   * seule : visiteur anonyme) ou « simulated » (tchat construit par MAAQ).
   */
  chat: "identified" | "visitor" | "simulated";
}

/** Liste filtrée par nom, description ou rubrique (US-45 RF1). */
export async function listAgents(ctx: Ctx, search = ""): Promise<AgentRow[]> {
  let query = ctx.db
    .selectFrom("agents as a")
    .innerJoin("agent_categories as c", "c.id", "a.category_id")
    .leftJoin("users as b", "b.id", "a.blocked_by_user_id")
    .select([
      "a.id",
      "a.name",
      "a.digitorn_agent_ref",
      "c.code",
      "c.label",
      "a.short_description",
      "a.status",
      "a.maintenance_message",
      "a.blocked_at",
      "a.published_at",
      "a.digitorn_app_url",
      sql<boolean>`a.digitorn_api_key_encrypted is not null`.as("has_project"),
      "b.first_name as blocker_first",
      "b.last_name as blocker_last",
    ])
    .orderBy("c.sort_order")
    .orderBy("a.name");
  const term = search.trim();
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    query = query.where((eb) =>
      eb.or([eb("a.name", "ilike", like), eb("a.short_description", "ilike", like), eb("c.label", "ilike", like)]),
    );
  }
  const rows = await query.execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    digitornRef: r.digitorn_agent_ref,
    category: r.code as CategoryCode,
    categoryLabel: r.label,
    shortDescription: r.short_description,
    status: r.status,
    maintenanceMessage: r.maintenance_message,
    blockedAt: r.blocked_at ? new Date(r.blocked_at).toISOString() : null,
    blockedBy: r.blocked_at ? adminName(r.blocker_first, r.blocker_last) : null,
    publishedAt: new Date(r.published_at).toISOString(),
    digitornProject: r.has_project,
    chat: r.has_project ? "identified" : r.digitorn_app_url ? "visitor" : "simulated",
  }));
}

/** Clé secrète d'un projet Digitorn : une clé publique (pk_…) ou mal formée est refusée avant tout appel. */
function cleanKey(raw: string | null | undefined): string | undefined {
  const key = raw?.trim();
  if (!key) return undefined;
  if (key.startsWith("pk_")) throw new Rejection("invalid_key", "Cette clé est publique (pk_…). Il faut la clé secrète du projet (sk_…).", 422);
  if (!/^sk_[A-Za-z0-9_\-]{8,200}$/.test(key)) throw new Rejection("invalid_key", "La clé secrète d'un projet Digitorn commence par sk_.", 422);
  return key;
}

export interface AgentLookup {
  agent: AgentCard;
  /** Déjà publié dans le catalogue MAAQ : il ne peut pas l'être une seconde fois. */
  alreadyPublished: boolean;
}

/**
 * Cherche un agent chez Digitorn à partir de son nom (US-45 RF2, RT2). Un projet Digitorn par agent : la clé secrète du
 * projet est nécessaire avec l'API réelle. La clé n'est enregistrée qu'à la publication.
 */
export async function lookupAgent(ctx: Ctx, input: { name: string; apiKey?: string | null }): Promise<AgentLookup> {
  const name = input.name.trim();
  if (!name) throw new Rejection("invalid_name", "Saisissez le nom de l'agent à publier.", 422);
  const apiKey = cleanKey(input.apiKey);
  const agent = await digitorn()
    .lookupAgent({ name, apiKey })
    .catch((error) => {
      throw asRejection(error);
    });
  const published = await ctx.db.selectFrom("agents").select("id").where("digitorn_agent_ref", "=", agent.ref).executeTakeFirst();
  return { agent, alreadyPublished: published !== undefined };
}

export interface PublishInput {
  digitornRef: string;
  /** Clé secrète du projet Digitorn de l'agent (avec l'API réelle) ; chiffrée avant d'être rangée. */
  digitornApiKey?: string | null;
  /** Domaine personnalisé de l'application publiée, facultatif. */
  digitornAppUrl?: string | null;
  name: string;
  category: CategoryCode;
  shortDescription: string;
  fullDescription: string;
  examples: string[];
  suggestions: string[];
  connectors: { code: ConnectorCode; scope: OwnerScope }[];
  infoFields: { label: string; dataType: InfoDataType; required: boolean; maxItems: number; sharedKey: string | null }[];
  ccMaxCount: number;
  validatedActions: string[];
}

/** Met un agent à disposition dans une seule rubrique ; il apparaît aussitôt dans le catalogue (US-45 RF3, RF4). */
export async function publishAgent(ctx: Ctx, adminId: string, input: PublishInput): Promise<string> {
  const apiKey = cleanKey(input.digitornApiKey);
  const rawUrl = input.digitornAppUrl?.trim() || null;
  const appUrl = rawUrl ? cleanAppUrl(rawUrl) : null;
  if (rawUrl && !appUrl) throw new Rejection("invalid_app_url", "L'adresse de l'application doit commencer par https://.", 422);

  // Sans clé secrète, MAAQ ne peut pas interroger Digitorn : l'adresse de l'application publiée tient lieu d'identité.
  let card: unknown;
  if (input.digitornRef.startsWith(APP_REF_PREFIX)) {
    if (!appUrl || apiKey || input.digitornRef !== refFromAppUrl(appUrl)) {
      throw new Rejection("agent_unavailable", "L'adresse de l'application ne correspond pas à cet agent.", 409);
    }
    card = true;
  } else {
    card = await digitorn()
      .getAgent({ ref: input.digitornRef, apiKey })
      .catch((error) => {
        throw asRejection(error);
      });
  }
  const taken = await ctx.db.selectFrom("agents").select("id").where("digitorn_agent_ref", "=", input.digitornRef).executeTakeFirst();
  if (!card || taken) {
    throw new Rejection("agent_unavailable", "Cet agent n'est pas disponible chez Digitorn ou est déjà publié.", 409);
  }
  const labels = input.infoFields.map((f) => f.label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) {
    throw new Rejection("duplicate_field", "Deux champs d'information portent le même libellé.");
  }

  return ctx.db.transaction().execute(async (trx) => {
    const category = await trx
      .selectFrom("agent_categories")
      .select("id")
      .where("code", "=", input.category)
      .executeTakeFirstOrThrow();

    const agent = await trx
      .insertInto("agents")
      .values({
        digitorn_agent_ref: input.digitornRef,
        digitorn_api_key_encrypted: apiKey ? encrypt(apiKey, Buffer.from(env().ENCRYPTION_KEY, "base64")) : null,
        digitorn_app_url: appUrl,
        name: input.name.trim(),
        category_id: category.id,
        short_description: input.shortDescription.trim(),
        full_description: input.fullDescription.trim(),
        cc_addresses_max_count: input.ccMaxCount,
        published_at: ctx.now,
        published_by_user_id: adminId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const prompts = [
      ...input.examples.map((content, i) => ({ agent_id: agent.id, kind: "example" as const, content, sort_order: i + 1 })),
      ...input.suggestions.map((content, i) => ({ agent_id: agent.id, kind: "first_suggestion" as const, content, sort_order: i + 1 })),
    ];
    if (prompts.length) await trx.insertInto("agent_sample_prompts").values(prompts).execute();

    if (input.validatedActions.length) {
      await trx
        .insertInto("agent_validated_actions")
        .values(input.validatedActions.map((label, i) => ({ agent_id: agent.id, label, sort_order: i + 1 })))
        .execute();
    }

    if (input.connectors.length) {
      const types = await trx
        .selectFrom("connector_types")
        .select(["id", "code"])
        .where("code", "in", input.connectors.map((c) => c.code))
        .execute();
      await trx
        .insertInto("agent_requirements")
        .values(
          input.connectors.map((c) => ({
            agent_id: agent.id,
            connector_type_id: types.find((t) => t.code === c.code)!.id,
            owner_scope: c.scope,
          })),
        )
        .execute();
    }

    if (input.infoFields.length) {
      await trx
        .insertInto("agent_info_fields")
        .values(
          input.infoFields.map((f, i) => ({
            agent_id: agent.id,
            label: f.label.trim(),
            data_type: f.dataType,
            is_required: f.required,
            max_items: f.maxItems,
            shared_key: f.sharedKey,
            sort_order: i + 1,
          })),
        )
        .execute();
    }

    await logAdminAction(trx, {
      adminId,
      action: "agent_published",
      entityType: "agent",
      entityId: agent.id,
      details: { name: input.name.trim(), category: input.category },
      now: ctx.now,
    });
    return agent.id;
  });
}

/** Bloque un agent pour maintenance, pour tous les profils (US-46). Géré par MAAQ seul (RT1). */
export async function blockAgent(ctx: Ctx, adminId: string, agentId: string, message: string): Promise<void> {
  const text = message.trim();
  if (!text || text.length > 200) {
    throw new Rejection("invalid_message", "Le message de maintenance est obligatoire (200 caractères au maximum).");
  }
  await ctx.db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("agents")
      .set({ status: "blocked", maintenance_message: text, blocked_at: ctx.now, blocked_by_user_id: adminId, updated_at: ctx.now })
      .where("id", "=", agentId)
      .where("status", "=", "available")
      .returning("name")
      .executeTakeFirst();
    if (!updated) throw new Rejection("not_available", "Cet agent n'est pas disponible : il est peut-être déjà bloqué.", 409);
    await logAdminAction(trx, {
      adminId,
      action: "agent_blocked",
      entityType: "agent",
      entityId: agentId,
      details: { message: text },
      now: ctx.now,
    });
  });
}

/** Réactive un agent bloqué ; le message de maintenance est effacé (US-47 RF3). */
export async function reactivateAgent(ctx: Ctx, adminId: string, agentId: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("agents")
      .set({ status: "available", maintenance_message: null, blocked_at: null, blocked_by_user_id: null, updated_at: ctx.now })
      .where("id", "=", agentId)
      .where("status", "=", "blocked")
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw new Rejection("not_blocked", "Cet agent n'est pas bloqué.", 409);
    await logAdminAction(trx, { adminId, action: "agent_reactivated", entityType: "agent", entityId: agentId, now: ctx.now });
  });
}

