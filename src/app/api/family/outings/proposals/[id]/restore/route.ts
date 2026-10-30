import { NextResponse } from "next/server";
import { restoreProposal } from "@/server/assistant/outings/proposals";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** « Annuler » du message « Proposition retirée » (10 secondes) : la proposition revient (US-116 RF1). */
export const POST = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  await restoreProposal(ctx, session, (await context.params).id);
  return NextResponse.json({ ok: true });
});
