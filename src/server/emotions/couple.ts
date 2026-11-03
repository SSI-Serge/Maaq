import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";

/**
 * Le couple (MMF « Émotions », E-03, E-21) : l'utilisateur principal et l'invité 1, tous deux actifs. La règle est celle de la base (`emotion_partner_of`) : un invité secondaire,
 * un administrateur, ou une famille sans invité 1 actif n'ont pas de partenaire, donc ni cœur, ni mot, ni bilan, ni envies.
 */

export interface Partner {
  id: string;
  firstName: string;
}

export const emotionError = (code: string, message: string, status = 409, details?: unknown) => new Rejection(code, message, status, details);

/** L'autre parent du couple de ce profil, ou `null` quand le profil n'est pas dans un couple. */
export async function partnerOf(db: Kysely<DB>, userId: string): Promise<Partner | null> {
  const found = await sql<{ id: string | null }>`select emotion_partner_of(${userId}::uuid) as id`.execute(db);
  const id = found.rows[0]?.id;
  if (!id) return null;
  const user = await db.selectFrom("users").select(["id", "first_name"]).where("id", "=", id).executeTakeFirst();
  return user ? { id: user.id, firstName: user.first_name } : null;
}

export interface CoupleViewer {
  accountId: string;
  userId: string;
  partner: Partner;
}

/** Le profil connecté et son partenaire ; refuse un profil hors couple (les objets « Émotions » n'existent pas pour lui). */
export async function requireCouple(ctx: Ctx, session: SessionContext): Promise<CoupleViewer> {
  const accountId = session.user.accountId;
  if (!accountId || session.user.role === "admin") throw emotionError("forbidden", "Cette fonction est réservée aux deux parents du couple.", 403);
  const partner = await partnerOf(ctx.db, session.user.id);
  if (!partner) throw emotionError("forbidden", "Cette fonction est réservée aux deux parents du couple.", 403);
  return { accountId, userId: session.user.id, partner };
}

/** Le profil est-il dans un couple ? (sans erreur : sert à décider ce qu'on montre.) */
export async function inCouple(ctx: Ctx, session: SessionContext): Promise<boolean> {
  if (!session.user.accountId || session.user.role === "admin") return false;
  return (await partnerOf(ctx.db, session.user.id)) !== null;
}

/** Messages des gardes de la base (déclencheurs) traduits pour l'utilisateur ; le reste remonte tel quel. */
export function translateEmotionError(error: unknown): unknown {
  const e = error as { code?: string; message?: string };
  if (e?.code !== "23514" || !e.message) return error;
  if (/réservé aux deux parents|Un mot s'écrit|réservées au couple|ajoutée par l'un des deux/.test(e.message)) return emotionError("forbidden", "Cette fonction est réservée aux deux parents du couple.", 403);
  if (/Ce mot est figé/.test(e.message)) return emotionError("note_frozen", "Ce mot a déjà été lu : il ne peut plus être modifié.", 409);
  const wishes = /Une famille a (\d+) envies au plus/.exec(e.message);
  if (wishes) return emotionError("wish_limit", "Vous avez beaucoup d'envies ! Faites-en disparaître une pour en ajouter une nouvelle.", 409, { max: Number(wishes[1]) });
  if (/cœur se pose|Un cœur/.test(e.message)) return emotionError("heart_not_allowed", "Vous ne pouvez pas poser de cœur ici.", 409);
  return error;
}
