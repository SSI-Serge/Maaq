import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { getDashboard } from "@/server/catalog/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Dashboard du profil : agents Pro et Perso avec leur statut calculé par le serveur (US-22). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await getDashboard(ctx, session));
});
