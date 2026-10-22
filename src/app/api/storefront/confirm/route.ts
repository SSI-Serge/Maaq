import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { confirmSchema, confirmStorefront } from "@/server/marketplace/service";

export const dynamic = "force-dynamic";

/** Le fournisseur confirme des groupes de champs proposés par l'agent ou critiques (zone, tarif, contact). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const { groups } = await parseBody(request, confirmSchema);
  return NextResponse.json(await confirmStorefront(ctx, session, groups));
});
