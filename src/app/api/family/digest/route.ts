import { NextResponse } from "next/server";
import { getDigest } from "@/server/assistant/digest";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Le point de la semaine du profil connecté (US-98) : sans `?week=AAAA-MM-JJ` (un lundi), celui de son dernier envoi, consultable jusqu'au suivant (RF8). Les listes suivent la
 * visibilité du profil (D26) ; le résumé de l'agent est réservé aux parents.
 */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const week = new URL(request.url).searchParams.get("week") ?? undefined;
  return NextResponse.json({ digest: await getDigest(ctx, session, week) });
});
