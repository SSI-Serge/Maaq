import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { setChannel } from "@/server/contracts/service";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../ids";

export const dynamic = "force-dynamic";

const schema = z.object({ channel: z.enum(["analysis", "challenge"]), enabled: z.boolean(), accepted: z.boolean().optional() });

/** Active ou désactive l'analyse IA ou le challenge d'un contrat, avec la preuve du consentement (US-127, US-128, CT-4). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { channel, ...body } = await parseBody(request, schema);
    return NextResponse.json(await setChannel(ctx, session, await numericParam(context.params, "id"), channel, body));
  });
});
