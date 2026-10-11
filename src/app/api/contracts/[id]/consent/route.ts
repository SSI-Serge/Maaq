import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { setConsent } from "@/server/contracts/service";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../ids";

export const dynamic = "force-dynamic";

const schema = z.object({ active: z.boolean(), accepted: z.boolean().optional() });

/** Donne ou retire le consentement au challenge d'un contrat (US-36). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const body = await parseBody(request, schema);
    return NextResponse.json(await setConsent(ctx, session, await numericParam(context.params, "id"), body));
  });
});
