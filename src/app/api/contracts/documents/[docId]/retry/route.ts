import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { retryClassification } from "@/server/contracts/service";
import { handler } from "@/server/http";
import { numericParam } from "../../../ids";

export const dynamic = "force-dynamic";

/** Relance le classement d'un document en échec (US-34 RF14). */
export const POST = handler(async (_request: Request, context: { params: Promise<{ docId: string }> }) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await retryClassification(ctx, session, await numericParam(context.params, "docId")));
});
