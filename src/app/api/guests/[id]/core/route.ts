import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { designateCoreGuest, listGuests, requirePrimary } from "@/server/guests/service";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Désigne un invité comme invité 1 quand le compte n'en a plus (US-20 RF11). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    await designateCoreGuest(ctx, session, id);
    return NextResponse.json(await listGuests(ctx, requirePrimary(session)));
  });
});
