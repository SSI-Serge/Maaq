import type { Ctx, SessionContext } from "@/server/auth/service";
import { capReachedMessage, localDay } from "@/server/chat/service";
import { Rejection } from "@/server/http";
import { env } from "@/server/env";
import { decrypt, encrypt } from "@/server/security/crypto";
import type { DB } from "@/server/db/schema.generated";
import { sql, type Kysely } from "kysely";
import { loadCalendarEvent } from "./calendar";
import { loadAgentDefinition, runAssistant, type AgentDefinition, type AgentLimits, type AgentSource } from "./agent";
import { loadPseudoMembers, requireParent } from "./family";
import { familyTimeZone } from "./reminders";
import { createModel, type AssistantModel } from "./model";
import { utcToLocal } from "./local-time";

/**
 * Message d'un parent à l'Assistant Famille : normalise, appelle l'agent, range l'échange (chiffré). Le calendrier de référence est dans
 * MAAQ : l'assistant n'y écrit que des rendez-vous provisoires et des propositions, qu'un parent valide ensuite.
 */

export const MAX_ASSISTANT_TEXT = 4000;
/** Échanges conservés dans le contexte du modèle : les 6 derniers messages des 24 dernières heures. */
const HISTORY_MESSAGES = 6;
const HISTORY_HOURS = 24;
const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

let configured: AssistantModel | undefined;

/** Le modèle configuré par l'environnement ; l'assistant est fermé tant que ASSISTANT_MODE n'est pas « live ». */
export function configuredModel(): AssistantModel {
  const settings = env();
  if (settings.ASSISTANT_MODE !== "live") throw new Rejection("assistant_unavailable", "L'Assistant Famille n'est pas encore ouvert.", 503);
  configured ??= createModel({
    provider: settings.ASSISTANT_PROVIDER,
    apiKey: settings.ANTHROPIC_API_KEY!,
    model: settings.ASSISTANT_MODEL,
    effort: settings.ASSISTANT_EFFORT,
  });
  return configured;
}

export interface AssistantEventView {
  id: string;
  title: string;
  type: string;
  status: string;
  start: string;
  end: string;
}

export interface AssistantReply {
  requestId: string;
  reply: string;
  /** Vrai quand l'assistant n'a pas pu répondre : rien n'est conservé, le même envoi peut être refait. */
  failed: boolean;
  alreadyAnswered: boolean;
  /** Rendez-vous provisoires créés par cette demande, à confirmer dans l'application. */
  events: AssistantEventView[];
  /** Modifications et annulations proposées, en attente de validation. */
  proposals: number;
  durationMs: number;
}

export interface AssistantDeps {
  model?: AssistantModel;
  definition?: AgentDefinition;
  limits?: Partial<AgentLimits>;
}

export async function sendAssistantMessage(
  ctx: Ctx,
  session: SessionContext,
  input: { requestId: string; text: string; source?: AgentSource },
  deps: AssistantDeps = {},
): Promise<AssistantReply> {
  const accountId = requireParent(session);
  const text = input.text.trim();
  if (!text) throw new Rejection("empty_request", "Écrivez votre demande avant de l'envoyer.", 422);
  if (text.length > MAX_ASSISTANT_TEXT) throw new Rejection("request_too_long", `Votre demande dépasse ${MAX_ASSISTANT_TEXT} caractères.`, 422);
  const model = deps.model ?? configuredModel();
  const source = input.source ?? "typed";

  const conversation = await conversationOf(ctx.db, accountId, session.user.id, ctx.now);

  // Renvoi d'une demande déjà traitée : on rend la réponse donnée, sans rien refaire.
  const answered = await ctx.db
    .selectFrom("assistant_requests as r")
    .innerJoin("agent_conversation_messages as m", "m.id", "r.reply_message_id")
    .select("m.content")
    .where("r.conversation_id", "=", conversation.id)
    .where("r.request_id", "=", input.requestId)
    .executeTakeFirst();
  if (answered?.content) {
    return { requestId: input.requestId, reply: decrypt(answered.content, key()), failed: false, alreadyAnswered: true, events: [], proposals: 0, durationMs: 0 };
  }

  // Échanges récents, avant ce message : contexte d'une réponse à une question de l'assistant.
  const since = new Date(ctx.now.getTime() - HISTORY_HOURS * 3_600_000);
  const recent = (
    await ctx.db
      .selectFrom("agent_conversation_messages as m")
      .leftJoin("assistant_requests as r", "r.user_message_id", "m.id")
      .select(["m.id", "m.sender", "m.kind", "m.content", "m.created_at", "r.request_id as own_request"])
      .where("m.conversation_id", "=", conversation.id)
      .where("m.created_at", ">=", since)
      .where("m.content", "is not", null)
      .orderBy("m.created_at", "desc")
      .orderBy("m.id", "desc")
      .limit(HISTORY_MESSAGES + 1)
      .execute()
  )
    .filter((m) => m.own_request !== input.requestId)
    .slice(0, HISTORY_MESSAGES)
    .reverse();

  // Message du parent : conservé chiffré (vrais prénoms), puis relié à sa demande. Une demande renvoyée avant sa réponse retrouve le même message.
  let userMessageId = (await ctx.db.selectFrom("assistant_requests").select("user_message_id").where("conversation_id", "=", conversation.id).where("request_id", "=", input.requestId).executeTakeFirst())?.user_message_id;
  if (userMessageId === undefined) {
    // Première fois que cette demande arrive : elle compte dans le plafond quotidien du profil (US-70, AF-7). Un renvoi (« Réessayer ») ne recompte pas.
    // Le jour est celui du fuseau de la famille (AF-2), comme pour les rappels et les heures de nuit.
    const day = localDay(ctx.now, await familyTimeZone(ctx.db, accountId));
    const accepted = await sql<{ accepted: boolean }>`select register_agent_request(${session.user.id}::uuid, ${day}::date) as accepted`.execute(ctx.db);
    if (!accepted.rows[0]?.accepted) {
      const { daily_request_limit: limit } = await ctx.db.selectFrom("accounts").select("daily_request_limit").where("id", "=", accountId).executeTakeFirstOrThrow();
      throw new Rejection("daily_cap_reached", capReachedMessage(limit), 429, { limit });
    }
    try {
      userMessageId = (
        await ctx.db
          .insertInto("agent_conversation_messages")
          .values({ conversation_id: conversation.id, sender: "profile", kind: source === "dictation" ? "voice_transcript" : "text", content: encrypt(text, key()), created_at: ctx.now })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
      await ctx.db.insertInto("assistant_requests").values({ conversation_id: conversation.id, request_id: input.requestId, user_message_id: userMessageId }).execute();
    } catch (error) {
      // La demande n'a pas pu être enregistrée (la même est déjà en cours chez un autre appareil) : elle ne compte pas.
      await ctx.db.updateTable("daily_request_counters").set({ request_count: sql`greatest(request_count - 1, 0)` }).where("user_id", "=", session.user.id).where("request_date", "=", sql<Date>`${day}::date`).execute();
      if (userMessageId !== undefined) await ctx.db.deleteFrom("agent_conversation_messages").where("id", "=", userMessageId).execute();
      if ((error as { code?: string }).code === "23505") throw new Rejection("request_in_progress", "Cette demande est déjà en cours de traitement.", 409);
      throw error;
    }
  }

  const members = await loadPseudoMembers(ctx.db, accountId);
  const author = await ctx.db.selectFrom("family_members").select("id").where("account_id", "=", accountId).where("user_id", "=", session.user.id).executeTakeFirst();
  const result = await runAssistant({
    db: ctx.db,
    model,
    definition: deps.definition ?? loadAgentDefinition(),
    accountId,
    userId: session.user.id,
    members,
    authorMemberId: author?.id ?? null,
    timeZone: session.device.timezone || "Europe/Paris",
    now: ctx.now,
    requestId: input.requestId,
    sourceMessageId: Number(userMessageId),
    source,
    text,
    history: recent.map((m) => ({ role: m.sender === "agent" ? ("assistant" as const) : ("user" as const), text: decrypt(m.content!, key()), source: m.kind === "voice_transcript" ? ("dictation" as const) : ("typed" as const) })),
    limits: deps.limits,
  });

  const tz = session.device.timezone || "Europe/Paris";
  const events: AssistantEventView[] = [];
  for (const id of result.createdEventIds) {
    const e = await loadCalendarEvent(ctx.db, accountId, id);
    if (e) events.push({ id: e.id, title: e.title, type: e.type, status: e.status, start: utcToLocal(e.startsAt, tz), end: utcToLocal(e.endsAt, tz) });
  }
  events.sort((a, b) => a.start.localeCompare(b.start));

  if (result.status !== "ok") {
    return { requestId: input.requestId, reply: result.reply, failed: true, alreadyAnswered: false, events, proposals: result.proposalIds.length, durationMs: result.durationMs };
  }
  const answeredAt = new Date(ctx.now.getTime() + result.durationMs);
  const reply = await ctx.db
    .insertInto("agent_conversation_messages")
    .values({ conversation_id: conversation.id, sender: "agent", kind: "text", content: encrypt(result.reply, key()), created_at: answeredAt })
    .returning("id")
    .executeTakeFirstOrThrow();
  await ctx.db.updateTable("assistant_requests").set({ reply_message_id: reply.id }).where("conversation_id", "=", conversation.id).where("request_id", "=", input.requestId).execute();
  await ctx.db.updateTable("agent_conversations").set({ last_message_at: answeredAt }).where("id", "=", conversation.id).execute();
  return { requestId: input.requestId, reply: result.reply, failed: false, alreadyAnswered: false, events, proposals: result.proposalIds.length, durationMs: result.durationMs };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Historique du fil (écran de saisie)
// ---------------------------------------------------------------------------------------------------------------------------

/** Les conversations restent consultables 4 jours au plus (D38, US-44). */
export const ASSISTANT_HISTORY_DAYS = 4;

export interface AssistantMessageView {
  id: string;
  requestId: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  /** Rendez-vous provisoires créés par la demande, pour le lien « Voir la proposition de RDV ». */
  events: { id: string; title: string; start: string; status: string }[];
}

/** Messages récents du fil de ce parent, du plus ancien au plus récent. */
export async function listAssistantMessages(ctx: Ctx, session: SessionContext): Promise<AssistantMessageView[]> {
  const accountId = requireParent(session);
  const conversation = await ctx.db
    .selectFrom("agent_conversations")
    .select("id")
    .where("user_id", "=", session.user.id)
    .where("agent_id", "=", await familyAgentId(ctx.db))
    .executeTakeFirst();
  if (!conversation) return [];
  const since = new Date(ctx.now.getTime() - ASSISTANT_HISTORY_DAYS * 86_400_000);
  // Un message du parent et la réponse qui lui correspond partagent l'identifiant de la demande.
  const rows = await ctx.db
    .selectFrom("agent_conversation_messages as m")
    .leftJoin("assistant_requests as ru", "ru.user_message_id", "m.id")
    .leftJoin("assistant_requests as ra", "ra.reply_message_id", "m.id")
    .select(["m.id", "m.sender", "m.content", "m.created_at", "ru.request_id as user_request", "ra.request_id as reply_request", "ra.user_message_id as origin"])
    .where("m.conversation_id", "=", conversation.id)
    .where("m.created_at", ">=", since)
    .where("m.content", "is not", null)
    .orderBy("m.created_at")
    .orderBy("m.id")
    .execute();
  const tz = session.device.timezone || "Europe/Paris";
  const out: AssistantMessageView[] = [];
  for (const row of rows) {
    const events: AssistantMessageView["events"] = [];
    if (row.sender === "agent" && row.origin !== null) {
      const created = await ctx.db
        .selectFrom("family_events")
        .select("id")
        .where("account_id", "=", accountId)
        .where("source_message_id", "=", row.origin)
        .where("status", "in", ["provisional", "confirmed", "set_aside"])
        .execute();
      for (const c of created) {
        const e = await loadCalendarEvent(ctx.db, accountId, c.id);
        if (e) events.push({ id: e.id, title: e.title, start: utcToLocal(e.startsAt, tz), status: e.status });
      }
    }
    out.push({ id: String(row.id), requestId: row.user_request ?? row.reply_request ?? "", role: row.sender === "agent" ? "assistant" : "user", text: decrypt(row.content!, key()), at: row.created_at.toISOString(), events });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------------------------------------------------------

/** Ligne de l'Assistant Famille dans la table des agents (créée avec la base) : les conversations du tchat de MAAQ s'y rattachent. */
export async function familyAgentId(db: Kysely<DB>): Promise<string> {
  return (await db.selectFrom("agents").select("id").where("platform", "=", "anthropic").where("platform_agent_ref", "=", "assistant-famille").executeTakeFirstOrThrow()).id;
}

/** Une conversation par parent (agent_conversations : un profil, un agent). */
async function conversationOf(db: Kysely<DB>, accountId: string, userId: string, now: Date): Promise<{ id: string }> {
  return db
    .insertInto("agent_conversations")
    .values({ account_id: accountId, user_id: userId, agent_id: await familyAgentId(db), last_message_at: now })
    .onConflict((oc) => oc.columns(["user_id", "agent_id"]).doUpdateSet({ last_message_at: now }))
    .returning("id")
    .executeTakeFirstOrThrow();
}
