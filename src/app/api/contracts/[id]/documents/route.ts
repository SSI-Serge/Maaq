import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { addDocument, classifyInBackground } from "@/server/contracts/service";
import { handler, Rejection } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../ids";

export const dynamic = "force-dynamic";

/** Ajoute un document scanné à un contrat (US-34) ; le classement dans le Drive se fait ensuite en arrière-plan. */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new Rejection("invalid_body", "Requête invalide.", 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new Rejection("invalid_body", "Requête invalide.", 400);
    const { contract, documentId } = await addDocument(ctx, session, await numericParam(context.params, "id"), {
      fileName: file.name,
      content: Buffer.from(await file.arrayBuffer()),
    });
    classifyInBackground(ctx.db, documentId);
    return NextResponse.json({ contract, documentId }, { status: 201 });
  });
});
