import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { getAgentSheet } from "@/server/catalog/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Fiche descriptive d'un agent (US-24). */
export const GET = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) return NextResponse.json({ error: { code: "not_found", message: "Cet agent n'existe pas." } }, { status: 404 });
  return NextResponse.json(await getAgentSheet(ctx, session, id));
});
