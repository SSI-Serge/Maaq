import { NextResponse } from "next/server";
import { z } from "zod";
import { getLocationConsent, grantLocationConsent, withdrawLocationConsent } from "@/server/assistant/location-consent";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Le consentement à la position de cet appareil, avec le texte à montrer avant de le demander (US-107 RF11, CA 11.1). Propre à chaque appareil, ouvert à tout profil de la famille. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ consent: await getLocationConsent(ctx, session) });
});

/** Autorise la position sur cet appareil, pour la version du texte que l'écran vient de montrer. Inscrit au journal des consentements par la base. */
export const PUT = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const { noticeVersion } = await parseBody(request, z.object({ noticeVersion: z.string().min(1).max(20) }));
  return NextResponse.json({ consent: await grantLocationConsent(ctx, session, noticeVersion) });
});

/** Retire l'autorisation à tout moment : la dernière position est effacée aussitôt et le retrait est inscrit au journal. */
export const DELETE = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json({ consent: await withdrawLocationConsent(ctx, session) });
});
