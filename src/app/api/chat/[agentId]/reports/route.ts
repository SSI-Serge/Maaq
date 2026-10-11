import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { reportError } from "@/server/chat/service";
import { handler, parseBody } from "@/server/http";
import { agentIdOf } from "../params";

export const dynamic = "force-dynamic";

const schema = z.object({
  messageRef: z.string().min(1).max(100),
  category: z.enum(["incorrect_response", "wrong_action", "other"]),
  comment: z.string().max(5000).optional(),
});

/** Signale une réponse ou une action erronée (US-61). */
export const POST = handler(async (request: Request, context: { params: Promise<{ agentId: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json(await reportError(ctx, session, { agentId: await agentIdOf(context), ...body }), { status: 201 });
});
