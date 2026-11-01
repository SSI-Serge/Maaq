import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { transmitContract } from "@/server/contracts/transmit";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../ids";

export const dynamic = "force-dynamic";

/** Transmet les documents du contrat pour analyse, pour challenge ou pour les deux, selon les interrupteurs actifs (US-129). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => NextResponse.json(await transmitContract(ctx, session, await numericParam(context.params, "id"))));
});
