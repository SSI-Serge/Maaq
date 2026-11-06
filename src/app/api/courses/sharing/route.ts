import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { setSharing } from "@/server/courses/household/settings";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Active ou désactive le partage anonyme des prix (US-154) ; la preuve de consentement est inscrite avant le changement. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const { share } = await parseBody(request, z.object({ share: z.boolean() }));
  return NextResponse.json({ settings: await setSharing(ctx, session, share) });
});
