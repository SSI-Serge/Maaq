import { NextResponse } from "next/server";
import { listUpcoming } from "@/server/assistant/events";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Prochains rendez-vous (confirmés et provisoires) de l'accueil de l'Assistant Famille (US-79 RF1). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ events: await listUpcoming(ctx, session) });
});
