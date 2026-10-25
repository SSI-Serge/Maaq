import type { Ctx, SessionContext } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { env } from "@/server/env";
import { decrypt, encrypt } from "@/server/security/crypto";
import { loadCalendarEvent } from "./calendar";
import { loadAgentDefinition, runAssistant, type AgentDefinition, type AgentLimits, type AgentSource } from "./agent";
import { ensureParentMembers, loadPseudoMembers, requireParent } from "./family";
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
    apiKey: (settings.ASSISTANT_PROVIDER === "foundry" ? settings.FOUNDRY_API_KEY : settings.ANTHROPIC_API_KEY)!,
    resource: settings.FOUNDRY_RESOURCE,
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

  await ensureParentMembers(ctx.db, accountId);
  const conversation = await ctx.db
    .insertInto("assistant_conversations")
    .values({ account_id: accountId, user_id: session.user.id, last_message_at: ctx.now })
    .onConflict((oc) => oc.column("user_id").doUpdateSet({ last_message_at: ctx.now }))
    .returning("id")
    .executeTakeFirstOrThrow();

  // Renvoi d'une demande déjà traitée : on rend la réponse donnée, sans rien refaire.
  const answered = await ctx.db
    .selectFrom("assistant_messages")
    .select("content_encrypted")
    .where("conversation_id", "=", conversation.id)
    .where("request_id", "=", input.requestId)
    .where("role", "=", "assistant")
    .executeTakeFirst();
  if (answered) {
    return { requestId: input.requestId, reply: decrypt(answered.content_encrypted, key()), failed: false, alreadyAnswered: true, events: [], proposals: 0, durationMs: 0 };
  }

  // Échanges récents, avant ce message : contexte d'une réponse à une question de l'assistant.
  const since = new Date(ctx.now.getTime() - HISTORY_HOURS * 3_600_000);
  const recent = (
    await ctx.db
      .selectFrom("assistant_messages")
      .select(["role", "source", "content_encrypted", "request_id", "created_at"])
      .where("conversation_id", "=", conversation.id)
      .where("created_at", ">=", since)
      .where("request_id", "<>", input.requestId)
      .orderBy("created_at", "desc")
      .limit(HISTORY_MESSAGES)
      .execute()
  ).reverse();

  await ctx.db
    .insertInto("assistant_messages")
    .values({ conversation_id: conversation.id, account_id: accountId, role: "user", source, request_id: input.requestId, content_encrypted: encrypt(text, key()), created_at: ctx.now })
    .onConflict((oc) => oc.doNothing())
    .execute();

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
    source,
    text,
    history: recent.map((m) => ({ role: m.role, text: decrypt(m.content_encrypted, key()), source: m.source })),
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
  await ctx.db
    .insertInto("assistant_messages")
    .values({ conversation_id: conversation.id, account_id: accountId, role: "assistant", source: "typed", request_id: input.requestId, content_encrypted: encrypt(result.reply, key()), created_at: answeredAt })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await ctx.db.updateTable("assistant_conversations").set({ last_message_at: answeredAt }).where("id", "=", conversation.id).execute();
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
  const conversation = await ctx.db.selectFrom("assistant_conversations").select("id").where("user_id", "=", session.user.id).executeTakeFirst();
  if (!conversation) return [];
  const since = new Date(ctx.now.getTime() - ASSISTANT_HISTORY_DAYS * 86_400_000);
  const rows = await ctx.db
    .selectFrom("assistant_messages")
    .select(["id", "request_id", "role", "content_encrypted", "created_at"])
    .where("conversation_id", "=", conversation.id)
    .where("created_at", ">=", since)
    .orderBy("created_at")
    .orderBy("role", "desc")
    .execute();
  const tz = session.device.timezone || "Europe/Paris";
  const out: AssistantMessageView[] = [];
  for (const row of rows) {
    const events: AssistantMessageView["events"] = [];
    if (row.role === "assistant") {
      const created = await ctx.db
        .selectFrom("family_events")
        .select("id")
        .where("account_id", "=", accountId)
        .where("source_ref", "like", `${row.request_id}:%`)
        .where("status", "in", ["provisional", "confirmed", "set_aside"])
        .execute();
      for (const c of created) {
        const e = await loadCalendarEvent(ctx.db, accountId, c.id);
        if (e) events.push({ id: e.id, title: e.title, start: utcToLocal(e.startsAt, tz), status: e.status });
      }
    }
    out.push({ id: row.id, requestId: row.request_id, role: row.role, text: decrypt(row.content_encrypted, key()), at: row.created_at.toISOString(), events });
  }
  return out;
}
