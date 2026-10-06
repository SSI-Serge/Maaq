import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { acceptCurrent } from "@/server/compliance/legal";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Accepte les versions en vigueur des deux documents (US-54 RF3, RF4, RT1). */
export const POST = handler(async () => {
  const { session, ctx } = await requireProfile({ allowLegalPending: true });
  await acceptCurrent(ctx, session);
  return NextResponse.json({ accepted: true });
});
