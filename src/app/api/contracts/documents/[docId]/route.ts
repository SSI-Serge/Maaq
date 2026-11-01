import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { readDocument, removeDocument } from "@/server/contracts/service";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../ids";

export const dynamic = "force-dynamic";

/** Aperçu d'un document (`?page=N` pour une page de photos), réservé au noyau du compte (US-126 RF4). */
export const GET = handler(async (request: Request, context: { params: Promise<{ docId: string }> }) => {
  const { session, ctx } = await requireProfile();
  const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
  const file = await readDocument(ctx, session, await numericParam(context.params, "docId"), Number.isInteger(page) ? page : 1);
  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});

/** Retire un document du contrat ; refusé pendant les 48 h qui suivent sa transmission (US-126 RF4, RF8). */
export const DELETE = handler(async (request: Request, context: { params: Promise<{ docId: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => NextResponse.json(await removeDocument(ctx, session, await numericParam(context.params, "docId"))));
});
