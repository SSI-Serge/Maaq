import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { wishForm } from "@/server/emotions/wishes";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

/** Formulaire de RDV prérempli depuis une envie (US-151 RF1). */
export const GET = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Cette envie n'existe plus.", 404);
  return NextResponse.json({ form: await wishForm(ctx, session, id) });
});
