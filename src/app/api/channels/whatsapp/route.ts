import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { unlinkWhatsApp } from "@/server/channels/linking";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Délie le numéro WhatsApp du profil et retire le consentement. */
export const DELETE = handler(async () => {
  const { session, ctx } = await requireProfile();
  await unlinkWhatsApp(ctx, session);
  return NextResponse.json({ unlinked: true });
});
