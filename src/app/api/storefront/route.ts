import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { getStorefrontView, storefrontPatchSchema, updateStorefront } from "@/server/marketplace/service";

export const dynamic = "force-dynamic";

/** Vitrine du profil connecté : champs, provenance, ce qui manque avant publication, aperçu côté acheteur. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await getStorefrontView(ctx, session));
});

/** Modification d'un ou plusieurs champs depuis l'écran de relecture (US-05 RF2). */
export const PATCH = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await updateStorefront(ctx, session, await parseBody(request, storefrontPatchSchema)));
});
