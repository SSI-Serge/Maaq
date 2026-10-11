import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { finalizeConnection } from "@/server/connectors/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ state: z.string().min(10).max(2000) });

/** Retour de la page Google : finalise la connexion (US-14 RF3 à RF8). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const { state } = await parseBody(request, schema);
  return NextResponse.json(await finalizeConnection(ctx, session, state));
});
