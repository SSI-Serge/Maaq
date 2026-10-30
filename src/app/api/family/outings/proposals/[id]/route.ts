import { NextResponse } from "next/server";
import { getProposal } from "@/server/assistant/outings/proposals";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** L'écran « Idées de sorties » (US-115 RF5) : réservé au parent qui a reçu la proposition ; pour tout autre profil, « introuvable » (US-117 CA 1.2). */
export const GET = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ proposal: await getProposal(ctx, session, (await context.params).id) });
});
