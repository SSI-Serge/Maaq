import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth/http";
import { consoleSummary, NAV } from "@/server/courses/console";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Objets de la console du catalogue « Courses et repas » et leurs compteurs. */
export const GET = handler(async () => {
  const { session, ctx } = await requireAdmin();
  return NextResponse.json({ nav: NAV, summary: await consoleSummary({ ctx, adminId: session.user.id }) });
});
