import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { myList } from "@/server/courses/list/mine";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** « Ma liste de courses » (US-158) : la liste validée, par magasin et par rayon. */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ list: await myList(ctx, session, new URL(request.url).searchParams.get("week")) });
});
