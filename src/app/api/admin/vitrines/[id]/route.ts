import { NextResponse } from "next/server";
import { getStorefrontDetail } from "@/server/admin/storefronts";
import { requireAdmin } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Détail d'une vitrine : champs, signalements, suggestions avec leur raison interne, journal, mises en relation. */
export const GET = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { ctx } = await requireAdmin();
  const { id } = await params;
  return NextResponse.json(await getStorefrontDetail(ctx, id));
});
