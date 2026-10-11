import { NextResponse } from "next/server";
import { actorOf, revokeDevice } from "@/server/devices/service";
import { closeSessionCookies, requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/**
 * Révoque un appareil (US-53). Révoquer « Cet appareil » équivaut à une déconnexion : les cookies de
 * session sont retirés dans la même réponse.
 */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Rejection("not_found", "Cet appareil n'existe plus.", 404);
  return idempotent(ctx, request, session.user.id, async () => {
    const result = await revokeDevice(ctx, actorOf(session), id);
    if (result.revokedCurrent) await closeSessionCookies();
    return NextResponse.json(result);
  });
});
