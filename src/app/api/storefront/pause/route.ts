import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { pauseSchema, pauseStorefront } from "@/server/marketplace/service";

export const dynamic = "force-dynamic";

/** Pause ou reprise des suggestions, sans supprimer la vitrine (US-06 RF2, RF3). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const { paused } = await parseBody(request, pauseSchema);
  return NextResponse.json(await pauseStorefront(ctx, session, paused));
});
