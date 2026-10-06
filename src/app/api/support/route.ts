import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { sendSupportMessage } from "@/server/support/service";

export const dynamic = "force-dynamic";

const schema = z.object({ text: z.string().max(5000), channel: z.enum(["written", "dictated"]) });

/** Transmet un message au support (US-62, US-63). Ouvert à l'administrateur comme aux autres profils. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    await sendSupportMessage(ctx, session, await parseBody(request, schema));
    return NextResponse.json({ sent: true }, { status: 201 });
  });
});
