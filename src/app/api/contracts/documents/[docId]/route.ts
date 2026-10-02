import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { readDocument, removeDocument } from "@/server/contracts/service";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../ids";

export const dynamic = "force-dynamic";

/** Aperçu d'un document, réservé au noyau du compte (US-34 RF6). */
export const GET = handler(async (_request: Request, context: { params: Promise<{ docId: string }> }) => {
  const { session, ctx } = await requireProfile();
  const file = await readDocument(ctx, session, await numericParam(context.params, "docId"));
  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});

/** Retire un document du contrat ; il reste dans le Google Drive (US-35 RF2). */
export const DELETE = handler(async (request: Request, context: { params: Promise<{ docId: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => NextResponse.json(await removeDocument(ctx, session, await numericParam(context.params, "docId"))));
});
