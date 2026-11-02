import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";
import { getPresentation } from "@/server/presentation/service";

export const dynamic = "force-dynamic";

/** La vidéo de présentation, pour l'écran « Découvrir MAAQ » et « Revoir la présentation » (US-140) : `presentation` est null tant qu'aucune vidéo n'est configurée. */
export const GET = handler(async () => {
  const { session } = await requireProfile();
  const presentation = await getPresentation();
  // Un invité secondaire voit la même vidéo, avec une phrase finale : certaines fonctions sont réservées aux parents (RF7).
  const secondaryGuest = session.user.role === "guest" && session.user.guestRank === "secondary";
  return NextResponse.json({ presentation, secondaryGuest }, { headers: { "Cache-Control": "private, no-store" } });
});
