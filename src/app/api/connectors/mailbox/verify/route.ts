import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { verifyMailbox } from "@/server/connectors/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ agentId: z.string().regex(/^\d{1,18}$/), code: z.string().trim().regex(/^\d{6}$/) });

/** Vérifie le code reçu : la boîte de validation devient active (US-15 RF4). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await verifyMailbox(ctx, session, await parseBody(request, schema)));
});
