import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth/http";
import { revokeDevice } from "@/server/devices/service";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

/** Révoque l'appareil d'un profil depuis la console (US-53 RF7). */
export const POST = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Rejection("not_found", "Cet appareil n'existe plus.", 404);
  return NextResponse.json(await revokeDevice(ctx, { userId: session.user.id, role: "admin", accountId: null, currentDeviceId: null }, id));
});
