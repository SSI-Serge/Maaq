import { refuseChildChat } from "@/server/assistant/profile-member";
import type { Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { decrypt } from "@/server/security/crypto";
import { courseError, requireAccess } from "../household/settings";
import { MONTH_PREFIX } from "../menu-ia/cards";
import { exchangesOf } from "./exchanges";
import { courseAgentId } from "./service";

/**
 * Effacer des échanges du tchat de Courses et repas (US-179, CR-70, CR-71). Un échange est une demande du profil et les réponses de l'agent qui la suivent, cartes comprises ; un message de l'agent sans
 * demande juste avant (carte « ingrédients manquants » après un ticket, message isolé) forme un échange à lui seul. Chaque profil n'efface que son propre tchat. Vraie suppression en base : l'écran
 * n'appelle ces fonctions qu'après le délai d'annulation de 5 secondes. Seuls les messages partent : menus validés, listes, tickets, « Mes plats », réglages, budget et compteur de menus restent.
 * La proposition du « Menu du mois dans le budget », rangée dans le même fil sans y être affichée, n'est jamais effacée ici.
 */

/** Délai pendant lequel une demande sans réponse est tenue pour « en cours » (le modèle a 100 secondes, plus la marge du flux). */
export const REPLY_IN_PROGRESS_MS = 150_000;
const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

interface Row {
  id: string;
  sender: string;
  at: Date;
  text: string;
}

/** Les messages visibles du tchat de ce profil, du plus ancien au plus récent (la proposition cachée du menu du mois n'en fait pas partie). */
async function visible(db: Kysely<DB>, userId: string): Promise<{ conversationId: string; rows: Row[] } | null> {
  const conversation = await db.selectFrom("agent_conversations").select("id").where("user_id", "=", userId).where("agent_id", "=", await courseAgentId(db)).executeTakeFirst();
  if (!conversation) return null;
  const rows = await db.selectFrom("agent_conversation_messages").select(["id", "sender", "content", "created_at"]).where("conversation_id", "=", conversation.id).where("content", "is not", null).orderBy("created_at").orderBy("id").execute();
  return {
    conversationId: conversation.id,
    rows: rows.map((r) => ({ id: String(r.id), sender: r.sender, at: r.created_at, text: decrypt(r.content!, key()) })).filter((r) => !r.text.startsWith(MONTH_PREFIX)),
  };
}

/** Efface l'échange qui contient ce message. Refusé pour le tchat d'un autre profil (message introuvable) et tant que la réponse à la demande n'est pas finie. */
export async function eraseExchange(ctx: Ctx, session: SessionContext, messageId: string): Promise<{ deleted: number }> {
  await requireAccess(ctx, session, "list");
  await refuseChildChat(ctx.db, session.user.id);
  const thread = /^\d{1,18}$/.test(messageId) ? await visible(ctx.db, session.user.id) : null;
  const exchanges = thread ? exchangesOf(thread.rows) : new Map<string, string>();
  const exchange = exchanges.get(messageId);
  if (!thread || !exchange) throw courseError("message_not_found", "Cet échange n'existe plus.", 404);
  const rows = thread.rows.filter((r) => exchanges.get(r.id) === exchange);
  // une demande sans réponse, toute récente : la réponse est en cours (US-179 RF6)
  const first = rows[0];
  if (first.sender !== "agent" && rows.length === 1 && ctx.now.getTime() - first.at.getTime() < REPLY_IN_PROGRESS_MS) {
    throw courseError("reply_in_progress", "La réponse est en cours : vous pourrez effacer cet échange quand elle sera finie.", 409);
  }
  const done = await ctx.db.deleteFrom("agent_conversation_messages").where("conversation_id", "=", thread.conversationId).where("id", "in", rows.map((r) => r.id) as never[]).executeTakeFirst();
  return { deleted: Number(done.numDeletedRows) };
}

/** « Effacer la conversation » : tous les échanges visibles de ce profil ; la proposition cachée du menu du mois reste. Une réponse en cours fait refuser l'effacement. */
export async function eraseConversation(ctx: Ctx, session: SessionContext): Promise<{ deleted: number }> {
  await requireAccess(ctx, session, "list");
  await refuseChildChat(ctx.db, session.user.id);
  const thread = await visible(ctx.db, session.user.id);
  if (!thread || !thread.rows.length) return { deleted: 0 };
  const last = thread.rows[thread.rows.length - 1];
  if (last.sender !== "agent" && ctx.now.getTime() - last.at.getTime() < REPLY_IN_PROGRESS_MS) {
    throw courseError("reply_in_progress", "La réponse est en cours : vous pourrez effacer la conversation quand elle sera finie.", 409);
  }
  const done = await ctx.db.deleteFrom("agent_conversation_messages").where("conversation_id", "=", thread.conversationId).where("id", "in", thread.rows.map((r) => r.id) as never[]).executeTakeFirst();
  return { deleted: Number(done.numDeletedRows) };
}
