import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { maskedPreview } from "@/server/contracts/process";
import { handler } from "@/server/http";
import { numericParam } from "../../../ids";

export const dynamic = "force-dynamic";

/** Aperçu du texte masqué d'un document, page par page, avec les masques posés à la main (US-137 RF2). */
export const GET = handler(async (_request: Request, context: { params: Promise<{ docId: string }> }) => {
  const { session, ctx } = await requireProfile();
  const preview = await maskedPreview(ctx, session, await numericParam(context.params, "docId"));
  return NextResponse.json(preview, { headers: { "Cache-Control": "private, no-store" } });
});
