import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { getChannels } from "@/server/channels/linking";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Canaux reliés au profil (WhatsApp) et préférences de rappel. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await getChannels(ctx, session));
});
