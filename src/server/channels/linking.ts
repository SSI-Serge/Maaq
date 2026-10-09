import { randomInt } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { prefsStore } from "@/server/gifts/service";
import { Rejection } from "@/server/http";

/**
 * Liaison d'un numéro WhatsApp à un profil MAAQ. Jamais sur le seul numéro : la personne obtient un code
 * dans l'application et l'envoie depuis son WhatsApp ; c'est ce message qui prouve qu'elle tient les deux.
 */

type Db = Kysely<DB> | Transaction<DB>;

export const LINK_CODE_MINUTES = 10;
/** Version du texte de consentement affiché dans l'application au moment de la liaison. */
export const WHATSAPP_CONSENT_VERSION = "whatsapp-2026-10";
export const WHATSAPP_CONSENT_TEXT = "J'accepte de recevoir sur WhatsApp les rappels d'occasions et les réponses de kdo_help. Je peux arrêter à tout moment en répondant STOP ou en déliant mon numéro.";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /\bLINK-([A-Z2-9]{6})\b/i;

export function newLinkCode(): string {
  let code = "LINK-";
  for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Code de liaison lu dans un message, normalisé, ou null. */
export function extractLinkCode(text: string | null): string | null {
  const match = text ? CODE_PATTERN.exec(text) : null;
  return match ? `LINK-${match[1].toUpperCase()}` : null;
}

export interface LinkOffer {
  code: string;
  url: string;
  expiresAt: string;
}

/** Nouveau code pour le profil connecté ; les précédents non utilisés sont invalidés. */
export async function createLinkCode(ctx: Ctx, session: SessionContext): Promise<LinkOffer> {
  if (session.user.role === "admin") throw new Rejection("forbidden", "Un administrateur ne relie pas de WhatsApp.", 403);
  const code = newLinkCode();
  const expiresAt = new Date(ctx.now.getTime() + LINK_CODE_MINUTES * 60_000);
  await ctx.db.deleteFrom("channel_link_codes").where("user_id", "=", session.user.id).where("used_at", "is", null).execute();
  await ctx.db.insertInto("channel_link_codes").values({ code, user_id: session.user.id, channel: "whatsapp", expires_at: expiresAt, created_at: ctx.now }).execute();
  return { code, url: `https://wa.me/${env().WHATSAPP_BUSINESS_NUMBER}?text=${encodeURIComponent(code)}`, expiresAt: expiresAt.toISOString() };
}

export type LinkOutcome = { status: "linked"; userId: string; firstName: string } | { status: "invalid" } | { status: "taken" };

/** Consomme un code reçu depuis un numéro WhatsApp et relie ce numéro au profil. */
export async function consumeLinkCode(db: Db, now: Date, code: string, waId: string): Promise<LinkOutcome> {
  const pending = await db.selectFrom("channel_link_codes").select(["code", "user_id", "expires_at"]).where("code", "=", code).where("used_at", "is", null).executeTakeFirst();
  if (!pending || new Date(pending.expires_at) < now) return { status: "invalid" };

  const other = await db.selectFrom("channel_identities").select("user_id").where("channel", "=", "whatsapp").where("external_id", "=", waId).executeTakeFirst();
  if (other && other.user_id !== pending.user_id) return { status: "taken" };

  await db.updateTable("channel_link_codes").set({ used_at: now }).where("code", "=", code).execute();
  // Un profil n'a qu'un numéro : relier un nouveau numéro remplace l'ancien.
  await db.deleteFrom("channel_identities").where("user_id", "=", pending.user_id).where("channel", "=", "whatsapp").execute();
  await db
    .insertInto("channel_identities")
    .values({ user_id: pending.user_id, channel: "whatsapp", external_id: waId, opt_in: true, opt_in_at: now, consent_version: WHATSAPP_CONSENT_VERSION, last_inbound_at: now, linked_at: now })
    .execute();
  const user = await db.selectFrom("users").select("first_name").where("id", "=", pending.user_id).executeTakeFirstOrThrow();
  return { status: "linked", userId: pending.user_id, firstName: user.first_name };
}

export interface ChannelsView {
  whatsapp: { linked: false } | { linked: true; numberMasked: string; optIn: boolean; linkedAt: string };
  prefs: { timezone: string; quietHoursStart: string; quietHoursEnd: string; reminderChannel: "app" | "whatsapp" | "both" };
  consentText: string;
  businessNumber: string;
}

export function maskNumber(waId: string): string {
  return waId.length > 4 ? `${"•".repeat(Math.max(waId.length - 4, 2))}${waId.slice(-4)}` : waId;
}

export async function getChannels(ctx: Ctx, session: SessionContext): Promise<ChannelsView> {
  const identity = await ctx.db.selectFrom("channel_identities").select(["external_id", "opt_in", "linked_at"]).where("user_id", "=", session.user.id).where("channel", "=", "whatsapp").executeTakeFirst();
  return {
    whatsapp: identity ? { linked: true, numberMasked: maskNumber(identity.external_id), optIn: identity.opt_in, linkedAt: new Date(identity.linked_at).toISOString() } : { linked: false },
    prefs: await prefsStore(ctx.db as Kysely<DB>).get(session.user.id),
    consentText: WHATSAPP_CONSENT_TEXT,
    businessNumber: env().WHATSAPP_BUSINESS_NUMBER,
  };
}

/** Délie le numéro et retire le consentement ; plus aucun envoi proactif. */
export async function unlinkWhatsApp(ctx: Ctx, session: SessionContext): Promise<void> {
  await ctx.db.deleteFrom("channel_identities").where("user_id", "=", session.user.id).where("channel", "=", "whatsapp").execute();
  await ctx.db.deleteFrom("channel_link_codes").where("user_id", "=", session.user.id).where("used_at", "is", null).execute();
}

export async function setOptIn(db: Db, now: Date, waId: string, optIn: boolean): Promise<boolean> {
  const updated = await db
    .updateTable("channel_identities")
    .set({ opt_in: optIn, opt_in_at: optIn ? now : null, consent_version: optIn ? WHATSAPP_CONSENT_VERSION : null })
    .where("channel", "=", "whatsapp")
    .where("external_id", "=", waId)
    .returning("id")
    .executeTakeFirst();
  return Boolean(updated);
}
