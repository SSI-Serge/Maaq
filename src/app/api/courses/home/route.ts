import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { courseHome } from "@/server/courses/home";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Accueil de l'agent Courses et repas. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ home: await courseHome(ctx, session) });
});
