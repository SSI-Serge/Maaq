import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { emotionsHome } from "@/server/emotions/home";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Ce que l'accueil de l'Assistant Famille montre pour le couple : bilan, envies. Vide pour un profil hors couple. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json(await emotionsHome(ctx, session));
});
