import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { menuStart } from "@/server/courses/menu/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Étape 1 du menu : plats que le foyer peut choisir, semaine préparée (US-155). Réservé au couple. */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const week = new URL(request.url).searchParams.get("week") ?? undefined;
  return NextResponse.json({ start: await menuStart(ctx, session, week) });
});
