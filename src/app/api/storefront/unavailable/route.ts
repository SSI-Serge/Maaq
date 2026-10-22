import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { setUnavailableUntil, unavailableSchema } from "@/server/marketplace/service";

export const dynamic = "force-dynamic";

/** Indisponibilité temporaire jusqu'à une date (US-06 RF4) ; null pour l'annuler. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const { until } = await parseBody(request, unavailableSchema);
  return NextResponse.json(await setUnavailableUntil(ctx, session, until));
});
