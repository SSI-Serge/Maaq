import { sql, type Kysely } from "kysely";
import { familyTimeZone } from "@/server/assistant/reminders";
import { createModel, type AssistantModel } from "@/server/assistant/model";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { capReachedMessage, localDay } from "@/server/chat/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { decrypt, encrypt } from "@/server/security/crypto";
import { courseError, loadSettings, requireAccess } from "../household/settings";
import { addableDishes, cardView, isCard, menuInProgress, parseCard, saveMenuCard, summaryForModel, validatedWeeks, type CardView } from "../menu-ia/cards";
import { runCourseAgent, type CourseAgentResult } from "./agent";
import { toolContext } from "./tools";

/**
 * Tchat de l'agent « Courses et repas » : le message est rangé chiffré, l'agent répond en s'appuyant sur les outils de MAAQ, la réponse est rangée à son tour. Mêmes règles que
 * l'Assistant Famille : plafond quotidien de demandes, une demande renvoyée n'est pas refaite, conversations consultables 4 jours. Le modèle ne voit ni allergies, ni régimes, ni prénoms.
 */

export const MAX_COURSE_TEXT = 2000;
const HISTORY_MESSAGES = 6;
const HISTORY_HOURS = 24;
export const COURSE_HISTORY_DAYS = 4;
/** Un menu complet (7 dîners, express, recettes, déroulé) demande beaucoup de texte : délai long, comme la lecture des tickets. */
const MODEL_TIMEOUT_MS = 100_000;
const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

let configured: AssistantModel | undefined;
/** Le modèle configuré par l'environnement ; l'agent est fermé tant que ASSISTANT_MODE n'est pas « live ». */
export function courseModel(): AssistantModel {
  const settings = env();
  if (settings.ASSISTANT_MODE !== "live") throw new Rejection("assistant_unavailable", "Le tchat de Courses et repas n'est pas encore ouvert. Les écrans de l'agent restent disponibles.", 409);
  configured ??= createModel({ provider: settings.ASSISTANT_PROVIDER, apiKey: settings.ANTHROPIC_API_KEY!, model: settings.ASSISTANT_MODEL, effort: "low", timeoutMs: MODEL_TIMEOUT_MS, maxTokens: 12_000 });
  return configured;
}

export async function courseAgentId(db: Kysely<DB>): Promise<string> {
  const row = await db.selectFrom("agents").select("id").where("platform", "=", "anthropic").where("platform_agent_ref", "=", "courses-repas").executeTakeFirst();
  if (!row) throw courseError("agent_missing", "L'agent Courses et repas n'est pas déclaré.", 503);
  return row.id;
}

async function conversationOf(db: Kysely<DB>, accountId: string, userId: string, now: Date): Promise<{ id: string }> {
  return db
    .insertInto("agent_conversations")
    .values({ account_id: accountId, user_id: userId, agent_id: await courseAgentId(db), last_message_at: now })
    .onConflict((oc) => oc.columns(["user_id", "agent_id"]).doUpdateSet({ last_message_at: now }))
    .returning("id")
    .executeTakeFirstOrThrow();
}

export interface CourseReply {
  requestId: string;
  reply: string;
  failed: boolean;
  alreadyAnswered: boolean;
  /** Menu composé dans cette demande, à afficher sous la réponse. */
  card?: CardView;
}

export interface CourseDeps {
  model?: AssistantModel;
}

export async function sendCourseMessage(ctx: Ctx, session: SessionContext, input: { requestId: string; text: string }, deps: CourseDeps = {}): Promise<CourseReply> {
  const who = await requireAccess(ctx, session, "list");
  const text = input.text.trim();
  if (!text) throw new Rejection("empty_request", "Écrivez votre demande avant de l'envoyer.", 422);
  if (text.length > MAX_COURSE_TEXT) throw new Rejection("request_too_long", `Votre demande dépasse ${MAX_COURSE_TEXT} caractères.`, 422);
  const model = deps.model ?? courseModel();
  const conversation = await conversationOf(ctx.db, who.accountId, session.user.id, ctx.now);

  const answered = await ctx.db
    .selectFrom("assistant_requests as r")
    .innerJoin("agent_conversation_messages as m", "m.id", "r.reply_message_id")
    .select("m.content")
    .where("r.conversation_id", "=", conversation.id)
    .where("r.request_id", "=", input.requestId)
    .executeTakeFirst();
  if (answered?.content) return { requestId: input.requestId, reply: decrypt(answered.content, key()), failed: false, alreadyAnswered: true };

  const since = new Date(ctx.now.getTime() - HISTORY_HOURS * 3_600_000);
  const recent = (
    await ctx.db
      .selectFrom("agent_conversation_messages as m")
      .leftJoin("assistant_requests as r", "r.user_message_id", "m.id")
      .select(["m.sender", "m.content", "r.request_id as own_request"])
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

  let userMessageId = (await ctx.db.selectFrom("assistant_requests").select("user_message_id").where("conversation_id", "=", conversation.id).where("request_id", "=", input.requestId).executeTakeFirst())?.user_message_id;
  if (userMessageId === undefined) {
    const day = localDay(ctx.now, await familyTimeZone(ctx.db, who.accountId));
    const accepted = await sql<{ accepted: boolean }>`select register_agent_request(${session.user.id}::uuid, ${day}::date) as accepted`.execute(ctx.db);
    if (!accepted.rows[0]?.accepted) {
      const { daily_request_limit: limit } = await ctx.db.selectFrom("accounts").select("daily_request_limit").where("id", "=", who.accountId).executeTakeFirstOrThrow();
      throw new Rejection("daily_cap_reached", capReachedMessage(limit), 429, { limit });
    }
    try {
      userMessageId = (
        await ctx.db
          .insertInto("agent_conversation_messages")
          .values({ conversation_id: conversation.id, sender: "profile", kind: "text", content: encrypt(text, key()), created_at: ctx.now })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
      await ctx.db.insertInto("assistant_requests").values({ conversation_id: conversation.id, request_id: input.requestId, user_message_id: userMessageId }).execute();
    } catch (error) {
      await ctx.db.updateTable("daily_request_counters").set({ request_count: sql`greatest(request_count - 1, 0)` }).where("user_id", "=", session.user.id).where("request_date", "=", sql<Date>`${day}::date`).execute();
      if (userMessageId !== undefined) await ctx.db.deleteFrom("agent_conversation_messages").where("id", "=", userMessageId).execute();
      if ((error as { code?: string }).code === "23505") throw new Rejection("request_in_progress", "Cette demande est déjà en cours de traitement.", 409);
      throw error;
    }
  }

  const settings = who.access === "couple" ? await loadSettings(ctx.db, who.accountId) : null;
  const timeZone = session.device.timezone || "Europe/Paris";
  const tool = await toolContext(ctx, session);
  const open = who.access === "couple" ? await menuInProgress(ctx.db, conversation.id, since) : null;
  const result: CourseAgentResult = await runCourseAgent({
    model,
    tool,
    facts: { now: ctx.now, timeZone, budgetDay: !!settings && ctx.now.getDate() === settings.budgetDay, missingSettings: settings?.missing ?? [], access: who.access, menuInProgress: open ? summaryForModel(open.proposal) : null },
    text,
    history: recent
      .map((m) => ({ role: m.sender === "agent" ? ("assistant" as const) : ("user" as const), text: decrypt(m.content!, key()) }))
      // une carte de menu n'est pas du texte à relire : le menu en cours est donné au modèle par le contexte
      .filter((m) => !isCard(m.text)),
    deadlineMs: MODEL_TIMEOUT_MS,
  });

  if (result.status !== "ok") return { requestId: input.requestId, reply: result.reply, failed: true, alreadyAnswered: false };
  const answeredAt = new Date(ctx.now.getTime() + result.durationMs);
  const reply = await ctx.db
    .insertInto("agent_conversation_messages")
    .values({ conversation_id: conversation.id, sender: "agent", kind: "text", content: encrypt(result.reply, key()), created_at: answeredAt })
    .returning("id")
    .executeTakeFirstOrThrow();
  await ctx.db.updateTable("assistant_requests").set({ reply_message_id: reply.id }).where("conversation_id", "=", conversation.id).where("request_id", "=", input.requestId).execute();
  await ctx.db.updateTable("agent_conversations").set({ last_message_at: answeredAt }).where("id", "=", conversation.id).execute();
  // le menu composé s'affiche sous la réponse : la carte est rangée juste après elle (un menu plus récent de la même semaine rend les précédents « remplacés »)
  let card: CardView | undefined;
  if (tool.menu.proposal) {
    const cardId = await saveMenuCard(ctx.db, conversation.id, tool.menu.proposal, new Date(answeredAt.getTime() + 1));
    card = cardView(cardId, { card: "menu", proposal: tool.menu.proposal, validatedAt: null }, false, (await validatedWeeks(ctx.db, who.accountId, [tool.menu.proposal.week])).size > 0);
  }
  return { requestId: input.requestId, reply: result.reply, failed: false, alreadyAnswered: false, card };
}

export interface CourseMessageView {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  /** Menu composé par l'IA : carte sous le fil, avec « Valider le menu » tant qu'elle est ouverte. */
  card?: CardView;
}

/** Messages récents du fil de ce profil (4 jours au plus), du plus ancien au plus récent. */
export async function listCourseMessages(ctx: Ctx, session: SessionContext): Promise<CourseMessageView[]> {
  const who = await requireAccess(ctx, session, "list");
  const conversation = await ctx.db.selectFrom("agent_conversations").select("id").where("user_id", "=", session.user.id).where("agent_id", "=", await courseAgentId(ctx.db)).executeTakeFirst();
  if (!conversation) return [];
  const since = new Date(ctx.now.getTime() - COURSE_HISTORY_DAYS * 86_400_000);
  const rows = await ctx.db
    .selectFrom("agent_conversation_messages")
    .select(["id", "sender", "content", "created_at"])
    .where("conversation_id", "=", conversation.id)
    .where("created_at", ">=", since)
    .where("content", "is not", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const decoded = rows.map((r) => ({ r, text: decrypt(r.content!, key()) }));
  const weeks = decoded.map((d) => parseCard(d.text)?.proposal.week ?? null);
  const validated = await validatedWeeks(ctx.db, who.accountId, [...new Set(weeks.filter((w): w is string => !!w))]);
  const addable = new Map<string, Awaited<ReturnType<typeof addableDishes>>>();
  for (const [i, d] of decoded.entries()) {
    const card = parseCard(d.text);
    if (card?.validatedAt && !card.addAnswered && weeks[i] && !addable.has(weeks[i]!)) addable.set(weeks[i]!, await addableDishes(ctx.db, who.accountId, weeks[i]!));
  }
  return decoded.map(({ r, text }, i): CourseMessageView => {
    const base = { id: String(r.id), role: r.sender === "agent" ? ("assistant" as const) : ("user" as const), at: r.created_at.toISOString() };
    const envelope = parseCard(text);
    if (!envelope) return { ...base, text };
    return { ...base, text: "", card: cardView(String(r.id), envelope, decoded.some((other, k) => k !== i && BigInt(other.r.id) > BigInt(r.id) && weeks[k] === envelope.proposal.week), validated.has(envelope.proposal.week), addable.get(envelope.proposal.week) ?? []) };
  });
}
