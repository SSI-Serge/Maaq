import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { prepareList } from "@/server/courses/list/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Préparation de la liste de courses (US-157). Le couple voit tout ; un invité secondaire voit seulement les produits ajoutés (CR-10). */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ list: await prepareList(ctx, session, new URL(request.url).searchParams.get("week")) });
});
