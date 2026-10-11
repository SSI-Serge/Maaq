import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { addAgent } from "@/server/catalog/service";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

const schema = z.object({ agentId: z.string().regex(/^\d{1,18}$/) });

/** Ajoute un agent au dashboard du profil (US-26). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { agentId } = await parseBody(request, schema);
    return NextResponse.json(await addAgent(ctx, session, agentId), { status: 201 });
  });
});
