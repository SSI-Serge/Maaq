import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth/http";
import { listAccountDevices } from "@/server/devices/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Appareils des profils d'un compte, pour la console (US-53 RF7). */
export const GET = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { ctx } = await requireAdmin();
  return NextResponse.json({ people: await listAccountDevices(ctx, (await params).id) });
});
