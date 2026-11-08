import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { decrypt, encrypt } from "@/server/security/crypto";
import type { MenuProposal } from "./proposal";

/**
 * Carte de menu dans le tchat (CR-42 : « Valider le menu » sous la carte). La proposition est gardée côté serveur, chiffrée, dans le fil du profil : le bouton valide exactement ce
 * qui est affiché, jamais un texte renvoyé par le navigateur. Conservée comme les autres messages du tchat (4 jours) ; une fois validée, le menu vit dans « meal_menus ».
 */

export const CARD_PREFIX = '{"card":"menu"';
const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

export interface MenuCardEnvelope {
  card: "menu";
  proposal: MenuProposal;
  validatedAt: string | null;
}

export function isCard(text: string): boolean {
  return text.startsWith(CARD_PREFIX);
}

export function parseCard(text: string): MenuCardEnvelope | null {
  if (!isCard(text)) return null;
  try {
    const parsed = JSON.parse(text) as MenuCardEnvelope;
    return parsed.card === "menu" && parsed.proposal?.id ? parsed : null;
  } catch {
    return null;
  }
}

export const encodeCard = (envelope: MenuCardEnvelope): string => JSON.stringify(envelope);

export async function saveMenuCard(db: Kysely<DB>, conversationId: string, proposal: MenuProposal, at: Date): Promise<string> {
  const row = await db
    .insertInto("agent_conversation_messages")
    .values({ conversation_id: conversationId, sender: "agent", kind: "text", content: encrypt(encodeCard({ card: "menu", proposal, validatedAt: null }), key()), created_at: at })
    .returning("id")
    .executeTakeFirstOrThrow();
  return String(row.id);
}

export async function loadCard(db: Kysely<DB>, userId: string, messageId: string): Promise<{ id: string; conversationId: string; envelope: MenuCardEnvelope } | null> {
  if (!/^\d{1,18}$/.test(messageId)) return null;
  const row = await db
    .selectFrom("agent_conversation_messages as m")
    .innerJoin("agent_conversations as c", "c.id", "m.conversation_id")
    .select(["m.id", "m.content", "m.conversation_id"])
    .where("m.id", "=", messageId as never)
    .where("c.user_id", "=", userId)
    .where("m.content", "is not", null)
    .executeTakeFirst();
  if (!row?.content) return null;
  const envelope = parseCard(decrypt(row.content, key()));
  return envelope ? { id: String(row.id), conversationId: row.conversation_id, envelope } : null;
}

export async function markValidated(db: Kysely<DB>, messageId: string, envelope: MenuCardEnvelope, at: Date): Promise<void> {
  await db
    .updateTable("agent_conversation_messages")
    .set({ content: encrypt(encodeCard({ ...envelope, validatedAt: at.toISOString() }), key()) })
    .where("id", "=", messageId as never)
    .execute();
}

/** Une carte plus récente du même fil porte-t-elle la même semaine ? (alors celle-ci est « Menu remplacé ») */
export async function hasNewerCard(db: Kysely<DB>, conversationId: string, messageId: string, week: string): Promise<boolean> {
  const rows = await db.selectFrom("agent_conversation_messages").select("content").where("conversation_id", "=", conversationId).where("id", ">", messageId as never).where("content", "is not", null).execute();
  return rows.some((r) => parseCard(decrypt(r.content!, key()))?.proposal.week === week);
}

export type CardStatus = "open" | "validated" | "replaced" | "incomplete";

/** État affiché sous la carte : « Menu remplacé » dès qu'une carte plus récente existe pour la même semaine ; pas de bouton si le menu est incomplet ou en conflit d'allergie. */
export function statusOf(envelope: MenuCardEnvelope, newerSameWeek: boolean): CardStatus {
  if (envelope.validatedAt) return "validated";
  if (newerSameWeek) return "replaced";
  return envelope.proposal.complete && !envelope.proposal.blocked ? "open" : "incomplete";
}

/** Résumé du menu en cours donné au modèle pour qu'il le corrige (noms des plats seulement). */
export function summaryForModel(proposal: MenuProposal): string {
  const names = (list: MenuProposal["dinners"]) => list.map((d, i) => `${i + 1}. ${d.name}`).join(" ; ");
  return `Menu en cours (semaine du ${proposal.week}) — dîners : ${names(proposal.dinners)}${proposal.express.length ? ` — express : ${names(proposal.express)}` : ""}.`;
}

/** Ce que le navigateur reçoit d'une carte : la proposition affichable et son état. */
export interface CardView {
  messageId: string;
  proposal: MenuProposal;
  status: CardStatus;
  /** Un menu est déjà validé pour cette semaine : « Valider » demande confirmation, la liste sera refaite (CR-45). */
  replacesValidated: boolean;
}

export const cardView = (messageId: string, envelope: MenuCardEnvelope, newerSameWeek: boolean, replacesValidated: boolean): CardView => ({
  messageId,
  proposal: envelope.proposal,
  status: statusOf(envelope, newerSameWeek),
  replacesValidated,
});

const localDay = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);

/** Semaines (lundis) du foyer qui ont déjà un menu validé, parmi celles demandées. */
export async function validatedWeeks(db: Kysely<DB>, accountId: string, weeks: string[]): Promise<Set<string>> {
  if (!weeks.length) return new Set();
  const rows = await db.selectFrom("meal_menus").select("week_start").where("account_id", "=", accountId).where("week_start", "in", weeks as never[]).execute();
  return new Set(rows.map((r) => localDay(r.week_start as Date | string)));
}

/** Le menu proposé et pas encore validé le plus récent du fil, dans les dernières 24 h (résumé pour le modèle). */
export async function menuInProgress(db: Kysely<DB>, conversationId: string, since: Date): Promise<MenuCardEnvelope | null> {
  const rows = await db
    .selectFrom("agent_conversation_messages")
    .select("content")
    .where("conversation_id", "=", conversationId)
    .where("created_at", ">=", since)
    .where("content", "is not", null)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(12)
    .execute();
  for (const r of rows) {
    const card = parseCard(decrypt(r.content!, key()));
    if (card) return card.validatedAt ? null : card;
  }
  return null;
}
