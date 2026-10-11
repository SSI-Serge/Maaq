import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { decideAction } from "@/server/chat/service";
import { handler, parseBody } from "@/server/http";
import { agentIdOf } from "../params";

export const dynamic = "force-dynamic";

const schema = z.object({ proposalId: z.string().min(1).max(100), decision: z.enum(["validate", "refuse"]) });

/** Valide ou refuse une action proposée par l'agent (US-39). */
export const POST = handler(async (request: Request, context: { params: Promise<{ agentId: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json(await decideAction(ctx, session, { agentId: await agentIdOf(context), ...body }));
});
