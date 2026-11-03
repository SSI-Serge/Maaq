import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { restoreWish } from "@/server/emotions/wishes";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

/** « Annuler » après « Retirer » (US-150 RF2). */
export const POST = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Cette envie n'existe plus.", 404);
  return NextResponse.json({ wish: await restoreWish(ctx, session, id) });
});
