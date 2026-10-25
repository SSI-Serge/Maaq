import { NextResponse } from "next/server";
import { eraseMember } from "@/server/assistant/family";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";
import { memberIdOf } from "../../params";

export const dynamic = "force-dynamic";

/** Efface définitivement un membre sans compte, retiré ou non : irréversible (D34, US-93 RF13). */
export const POST = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await eraseMember(ctx, session, await memberIdOf(context)));
});
