import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { releaseHandOver } from "@/server/emotions/handover";
import { handler } from "@/server/http";
import { taskIdOf } from "../../../params";

export const dynamic = "force-dynamic";

/** Fin du délai d'annulation : envoie la notification retenue (le planificateur le fait aussi, au plus tard à son passage suivant). */
export const POST = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await releaseHandOver(ctx, session, await taskIdOf(context)));
});
