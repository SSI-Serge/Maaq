import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { getOverview } from "@/server/connectors/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Connecteurs du profil, agent par agent, avec leurs statuts (US-13). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await getOverview(ctx, session));
});
