import { NextResponse } from "next/server";
import { z } from "zod";
import { getPersonalSettings, setPersonalSettings } from "@/server/assistant/notices";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Réglages personnels de l'Assistant Famille, ouverts à tout profil de la famille, invités secondaires compris (US-113 RF14, D58). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ settings: await getPersonalSettings(ctx, session) });
});

const schema = z.object({ notifyEventsAdded: z.boolean() });

/** Enregistré dès qu'on touche l'interrupteur ; ne modifie que les choix du profil connecté. */
export const PATCH = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ settings: await setPersonalSettings(ctx, session, body) });
});
