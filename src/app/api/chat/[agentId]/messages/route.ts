import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { sendMessage } from "@/server/chat/service";
import { handler, parseBody } from "@/server/http";
import { agentIdOf } from "../params";

export const dynamic = "force-dynamic";

const schema = z.object({ requestId: z.uuid(), text: z.string().max(5000) });

/**
 * Envoie une demande à l'agent (US-38). L'identifiant de la demande, choisi par l'écran, rend le
 * renvoi sans danger : la demande n'est ni comptée ni exécutée deux fois.
 */
export const POST = handler(async (request: Request, context: { params: Promise<{ agentId: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json(await sendMessage(ctx, session, { agentId: await agentIdOf(context), ...body }), { status: 201 });
});
