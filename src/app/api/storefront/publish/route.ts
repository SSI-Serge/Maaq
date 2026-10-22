import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";
import { publishStorefront } from "@/server/marketplace/service";

export const dynamic = "force-dynamic";

/** Publication explicite (US-05 RF3) : refusée avec la liste de ce qui manque tant que la vitrine est incomplète. */
export const POST = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await publishStorefront(ctx, session));
});
