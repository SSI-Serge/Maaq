import { NextResponse } from "next/server";
import { z } from "zod";
import { createExercisePage, listExercisePages, MAX_LESSON_TEXT } from "@/server/assistant/homework/pages";
import { MAX_PHOTO_BYTES, PHOTO_TYPES, type PhotoType } from "@/server/assistant/homework/photos";
import { configuredModel } from "@/server/assistant/service";
import { requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Dossier « Exercices » (US-180 RF7) pour un parent, « Mes exercices » des 30 derniers jours pour le profil d'un enfant (RF5). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ folder: await listExercisePages(ctx, session) });
});

const fields = z.object({ memberId: z.uuid().nullable(), text: z.string().max(MAX_LESSON_TEXT + 500).nullable() });

/**
 * Crée une page d'exercices à partir d'une leçon (US-180) : une photo, ou le texte collé. La photo est lue en mémoire, transmise au modèle, puis oubliée : elle n'est écrite
 * nulle part (RT3).
 */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const form = await request.formData().catch(() => null);
  const file = form?.get("photo");
  const parsed = fields.safeParse({ memberId: form?.get("memberId") || null, text: form?.get("text") || null });
  if (!form || !parsed.success || (file !== null && file !== undefined && !(file instanceof File))) throw new Rejection("invalid_lesson", "La demande est incomplète.", 422);
  let photo: { mediaType: PhotoType; data: Buffer } | null = null;
  if (file instanceof File) {
    if (file.size > MAX_PHOTO_BYTES) throw new Rejection("invalid_photo", "La photo est trop lourde (6 Mo au plus).", 422);
    const mediaType = file.type as PhotoType;
    if (!PHOTO_TYPES.includes(mediaType)) throw new Rejection("invalid_photo", "Envoyez une photo au format JPEG, PNG ou WebP.", 422);
    photo = { mediaType, data: Buffer.from(await file.arrayBuffer()) };
  }
  return NextResponse.json({ result: await createExercisePage(ctx, session, { memberId: parsed.data.memberId, text: parsed.data.text, photo }, configuredModel()) }, { status: 201 });
});
