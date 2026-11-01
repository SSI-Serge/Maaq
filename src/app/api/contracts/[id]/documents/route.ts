import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { addDocument } from "@/server/contracts/service";
import { handler, Rejection } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../ids";

export const dynamic = "force-dynamic";

/** Dépose ou remplace le document d'un champ : un PDF, ou de 1 à 10 photos (champ `file`, répété) qui forment un seul document (US-126, C-09). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new Rejection("invalid_body", "Requête invalide.", 400);
    }
    const fieldId = form.get("fieldId");
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (typeof fieldId !== "string" || !/^\d{1,18}$/.test(fieldId) || files.length === 0) throw new Rejection("invalid_body", "Requête invalide.", 400);
    const uploaded = await Promise.all(files.map(async (f) => ({ name: f.name, content: Buffer.from(await f.arrayBuffer()) })));
    return NextResponse.json(await addDocument(ctx, session, await numericParam(context.params, "id"), fieldId, uploaded), { status: 201 });
  });
});
