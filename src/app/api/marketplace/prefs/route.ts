import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { getPrefsView, prefsPatchSchema, updatePrefs } from "@/server/marketplace/buyer-service";

export const dynamic = "force-dynamic";

/** Réglages › Suggestions de services : consentement, catégories coupées, texte du consentement (US-09, US-10). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await getPrefsView(ctx, session));
});

export const PATCH = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await updatePrefs(ctx, session, await parseBody(request, prefsPatchSchema)));
});
