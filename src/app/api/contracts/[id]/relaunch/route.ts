import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { relaunchChannel } from "@/server/contracts/transmit";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../ids";

export const dynamic = "force-dynamic";

const schema = z.object({ channel: z.enum(["analysis", "challenge"]) });

/** « Relancer l'analyse » ou « Renvoyer » au challenge, tant que les documents existent (US-135). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { channel } = await parseBody(request, schema);
    return NextResponse.json(await relaunchChannel(ctx, session, await numericParam(context.params, "id"), channel));
  });
});
