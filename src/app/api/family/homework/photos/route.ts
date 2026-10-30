import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeHomeworkPhoto, MAX_PHOTO_BYTES, PHOTO_TYPES, type PhotoType } from "@/server/assistant/homework/photos";
import { configuredModel } from "@/server/assistant/service";
import { requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const fields = z.object({ memberId: z.uuid(), weekId: z.uuid().nullable() });

/**
 * Photo du travail d'un enfant (US-119 RF5). Le fichier est lu en mémoire, transmis au modèle pour analyse, puis oublié : il n'est écrit nulle part. Seuls les exercices
 * réussis sans aide sont enregistrés comme validés.
 */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const form = await request.formData().catch(() => null);
  const file = form?.get("photo");
  const parsed = fields.safeParse({ memberId: form?.get("memberId"), weekId: form?.get("weekId") || null });
  if (!form || !(file instanceof File) || !parsed.success) throw new Rejection("invalid_photo", "La demande est incomplète : choisissez un enfant et une photo.", 422);
  if (file.size > MAX_PHOTO_BYTES) throw new Rejection("invalid_photo", "La photo est trop lourde (6 Mo au plus).", 422);
  const mediaType = file.type as PhotoType;
  if (!PHOTO_TYPES.includes(mediaType)) throw new Rejection("invalid_photo", "Envoyez une photo au format JPEG, PNG ou WebP.", 422);
  const data = Buffer.from(await file.arrayBuffer());
  return NextResponse.json({ result: await analyzeHomeworkPhoto(ctx, session, { memberId: parsed.data.memberId, weekId: parsed.data.weekId, mediaType, data }, configuredModel()) });
});
