import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";
import { adminView, removePresentation, savePresentation, type Deposit } from "@/server/presentation/service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Ce qui est configuré pour la vidéo de présentation, et ce qui manque (US-140 RF9). */
export const GET = handler(async () => {
  await requireAdmin();
  return NextResponse.json(await adminView(), { headers: { "Cache-Control": "private, no-store" } });
});

const fileOf = async (form: FormData, name: string): Promise<Buffer | undefined> => {
  const value = form.get(name);
  return value instanceof File && value.size > 0 ? Buffer.from(await value.arrayBuffer()) : undefined;
};
const textOf = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
};

/** Dépose ou remplace la vidéo, ses sous-titres, l'image d'aperçu, la durée affichée et la transcription (US-140 RF9) : sans livraison de l'application. */
export const POST = handler(async (request: Request) => {
  const { session } = await requireAdmin();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new Rejection("invalid_body", "Requête invalide.", 400);
  }
  const deposit: Deposit = {
    video: await fileOf(form, "video"),
    captions: await fileOf(form, "captions"),
    poster: await fileOf(form, "poster"),
    durationLabel: textOf(form, "durationLabel"),
    transcript: textOf(form, "transcript"),
  };
  await savePresentation(session.user.id, deposit);
  return NextResponse.json(await adminView());
});

/** Retire la présentation : l'écran n'est plus proposé. */
export const DELETE = handler(async () => {
  await requireAdmin();
  await removePresentation();
  return NextResponse.json(await adminView());
});
