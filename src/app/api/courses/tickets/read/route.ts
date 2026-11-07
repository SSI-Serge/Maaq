import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { courseError } from "@/server/courses/household/settings";
import { readTicket } from "@/server/courses/tickets/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Lit un ticket de caisse (1 à 3 photos) : texte masqué puis mis en forme, à corriger avant de confirmer (US-161). Aucune photo n'est conservée. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const form = await request.formData().catch(() => null);
  const files = (form?.getAll("files") ?? []).filter((f): f is File => f instanceof File);
  if (!files.length) throw courseError("invalid_photos", "Envoyez de 1 à 3 photos du ticket.", 422);
  const images = await Promise.all(files.map(async (f, i) => ({ name: `ticket-${i + 1}`, mime: f.type, content: Buffer.from(await f.arrayBuffer()) })));
  return NextResponse.json({ ticket: await readTicket(ctx, session, images) });
});
