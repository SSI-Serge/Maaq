import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { listDevices } from "@/server/devices/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Appareils du compte, réservés à l'utilisateur principal (US-53). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await listDevices(ctx, session));
});
