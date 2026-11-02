import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";
import { markPresentationSeen } from "@/server/presentation/seen";

export const dynamic = "force-dynamic";

/** « Passer », fin de la vidéo ou « Continuer » après un échec : l'écran « Découvrir MAAQ » n'est plus proposé à ce profil (US-140 RF4). */
export const POST = handler(async () => {
  const { session, ctx } = await requireProfile();
  await markPresentationSeen(ctx, session);
  return NextResponse.json({ seen: true });
});
