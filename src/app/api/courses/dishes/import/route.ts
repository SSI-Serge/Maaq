import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { courseError } from "@/server/courses/household/settings";
import { importDishes } from "@/server/courses/menu/dishes";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;

/** Importe plusieurs plats (CSV ou xlsx) : le fichier est vérifié en entier, une seule ligne invalide le refuse. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw courseError("file_required", "Choisissez un fichier CSV ou xlsx.", 422);
  if (file.size > MAX_BYTES) throw courseError("file_too_large", "Le fichier est trop gros (2 Mo au plus).", 413);
  return NextResponse.json(await importDishes(ctx, session, { name: file.name, content: Buffer.from(await file.arrayBuffer()) }));
});
