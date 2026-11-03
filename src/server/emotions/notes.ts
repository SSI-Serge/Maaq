import type { Ctx, SessionContext } from "@/server/auth/service";
import { open, seal } from "@/server/assistant/fields";
import { asProfile } from "@/server/assistant/outings/profile";
import { emotionError, requireCouple, translateEmotionError } from "./couple";

/**
 * Le mot libre (US-143, E-07) : un message d'un parent à l'autre, écrit à tout moment de la semaine et lu par le partenaire dans son bilan. Chiffré, jamais envoyé à l'agent ni utilisé dans
 * un résumé, jamais écrit dans un journal, hors carnet de bord. Le destinataire ne sait pas qu'un mot l'attend. L'auteur peut relire, modifier ou retirer ses mots jusqu'à l'ouverture
 * du bilan du destinataire : à ce moment la base les rattache à ce bilan et les fige. Un mot jamais lu est supprimé 4 semaines après son écriture (E-22).
 */

export const MAX_NOTE = 500;

export interface NoteView {
  id: string;
  text: string;
  createdAt: string;
  /** Lu par le partenaire : le mot ne peut plus être modifié ni retiré (RF4). */
  frozen: boolean;
}

const countChars = (text: string) => [...text].length;

function checkText(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw emotionError("invalid_note", "Écrivez quelques mots pour votre partenaire.", 422);
  if (countChars(text) > MAX_NOTE) throw emotionError("invalid_note", `Un mot fait ${MAX_NOTE} caractères au plus.`, 422);
  return text;
}

const view = (row: { id: string; body: Buffer; created_at: Date; weekly_review_id: string | null }): NoteView => ({ id: row.id, text: open(row.body), createdAt: row.created_at.toISOString(), frozen: row.weekly_review_id !== null });

/** Les mots que ce profil a écrits pour son partenaire (les plus anciens d'abord). */
export async function listMyNotes(ctx: Ctx, session: SessionContext): Promise<{ partner: string; notes: NoteView[] }> {
  const couple = await requireCouple(ctx, session);
  const rows = await asProfile(ctx.db, couple.userId, (trx) =>
    trx.selectFrom("partner_notes").select(["id", "body", "created_at", "weekly_review_id"]).where("account_id", "=", couple.accountId).where("author_user_id", "=", couple.userId).orderBy("created_at").execute(),
  );
  return { partner: couple.partner.firstName, notes: rows.map(view) };
}

export async function addNote(ctx: Ctx, session: SessionContext, raw: unknown): Promise<NoteView> {
  const couple = await requireCouple(ctx, session);
  const text = checkText(raw);
  try {
    const row = await asProfile(ctx.db, couple.userId, (trx) =>
      trx
        .insertInto("partner_notes")
        .values({ account_id: couple.accountId, author_user_id: couple.userId, recipient_user_id: couple.partner.id, body: seal(text), created_at: ctx.now, updated_at: ctx.now })
        .returning(["id", "body", "created_at", "weekly_review_id"])
        .executeTakeFirstOrThrow(),
    );
    return view(row);
  } catch (error) {
    throw translateEmotionError(error);
  }
}

async function ownNote(ctx: Ctx, userId: string, id: string) {
  const row = await asProfile(ctx.db, userId, (trx) => trx.selectFrom("partner_notes").select(["id", "weekly_review_id"]).where("id", "=", id).where("author_user_id", "=", userId).executeTakeFirst());
  if (!row) throw emotionError("not_found", "Ce mot n'existe plus.", 404);
  if (row.weekly_review_id) throw emotionError("note_frozen", "Ce mot a déjà été lu : il ne peut plus être modifié.", 409);
  return row;
}

export async function updateNote(ctx: Ctx, session: SessionContext, id: string, raw: unknown): Promise<NoteView> {
  const couple = await requireCouple(ctx, session);
  const text = checkText(raw);
  await ownNote(ctx, couple.userId, id);
  try {
    const row = await asProfile(ctx.db, couple.userId, (trx) =>
      trx.updateTable("partner_notes").set({ body: seal(text), updated_at: ctx.now }).where("id", "=", id).where("author_user_id", "=", couple.userId).returning(["id", "body", "created_at", "weekly_review_id"]).executeTakeFirstOrThrow(),
    );
    return view(row);
  } catch (error) {
    throw translateEmotionError(error);
  }
}

export async function removeNote(ctx: Ctx, session: SessionContext, id: string): Promise<void> {
  const couple = await requireCouple(ctx, session);
  await ownNote(ctx, couple.userId, id);
  try {
    await asProfile(ctx.db, couple.userId, (trx) => trx.deleteFrom("partner_notes").where("id", "=", id).where("author_user_id", "=", couple.userId).execute());
  } catch (error) {
    throw translateEmotionError(error);
  }
}
