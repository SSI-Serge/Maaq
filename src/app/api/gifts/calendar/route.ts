import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { monthView } from "@/server/gifts/calendar";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Calendrier des occasions de kdo_help pour un mois : `?year=2026&month=10`. */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const url = new URL(request.url);
  return NextResponse.json(await monthView(ctx, session, Number(url.searchParams.get("year")), Number(url.searchParams.get("month"))));
});
