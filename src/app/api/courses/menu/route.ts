import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { weekMenuView } from "@/server/courses/menu-week";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** « Menu de la semaine » : le menu validé complet d'une semaine (cette semaine ou la suivante), réservé au couple (CR-72). */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const asked = new URL(request.url).searchParams.get("week");
  return NextResponse.json({ view: await weekMenuView(ctx, session, asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : null) });
});
