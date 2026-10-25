import { NextResponse } from "next/server";
import { removeMember } from "@/server/assistant/family";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";
import { memberIdOf } from "../../params";

export const dynamic = "force-dynamic";

/** Retire un membre sans compte : ses rendez-vous gardent son prénom, il ne se restaure pas (US-93). */
export const POST = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  await removeMember(ctx, session, await memberIdOf(context));
  return NextResponse.json({ removed: true });
});
