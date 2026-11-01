import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { verifyDocument } from "@/server/contracts/process";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../../ids";

export const dynamic = "force-dynamic";

/** « Confirmer ce document » : le texte masqué est vérifié par l'utilisateur (US-137 RF4). */
export const POST = handler(async (request: Request, context: { params: Promise<{ docId: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => NextResponse.json(await verifyDocument(ctx, session, await numericParam(context.params, "docId"))));
});
