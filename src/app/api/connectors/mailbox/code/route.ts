import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { resendMailboxCode } from "@/server/connectors/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ agentId: z.string().regex(/^\d{1,18}$/) });

/** Renvoie un code à l'adresse en cours de vérification. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await resendMailboxCode(ctx, session, await parseBody(request, schema)));
});
