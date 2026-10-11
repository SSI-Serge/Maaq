import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { cancelDeletion } from "@/server/compliance/lifecycle";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** « Annuler la suppression » pendant le délai de grâce (US-59). */
export const POST = handler(async () => {
  const { session, ctx } = await requireProfile({ allowGrace: true });
  return NextResponse.json(await cancelDeletion(ctx, session));
});
