import { NextResponse } from "next/server";
import { homeCard } from "@/server/assistant/outings/proposals";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** La carte « L'heure de penser à vous » de l'accueil (US-115 RF5) : la proposition prête de ce parent, jamais celle de l'autre (US-117). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  // Un invité secondaire n'a pas de sorties (S-02) : pas de carte, sans erreur.
  const card = session.user.role === "primary_user" || session.user.guestRank === "core" ? await homeCard(ctx, session) : null;
  return NextResponse.json({ card });
});
