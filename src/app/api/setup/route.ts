import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";
import { getSetup } from "@/server/profile/setup";

export const dynamic = "force-dynamic";

/** État de la configuration initiale de l'utilisateur principal (US-10, US-11). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await getSetup(ctx, session));
});
