import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { currentReview } from "@/server/emotions/reviews";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Le dernier bilan du profil (consultable jusqu'au suivant) : vide hors couple ou avant le premier envoi. Ne l'ouvre pas : voir `POST /api/family/review/open`. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ review: await currentReview(ctx, session) });
});
