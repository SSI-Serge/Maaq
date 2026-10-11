import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { getContracts } from "@/server/contracts/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Onglet « Mes contrats » (US-32). `?auto=1` : relecture automatique, qui ne prolonge pas le déverrouillage (US-52). */
export const GET = handler(async (request: Request) => {
  const automatic = new URL(request.url).searchParams.get("auto") === "1";
  const { session, ctx } = await requireProfile({ passive: automatic });
  return NextResponse.json(await getContracts(ctx, session));
});
