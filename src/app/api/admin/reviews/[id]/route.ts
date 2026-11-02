import { NextResponse } from "next/server";
import { getReview } from "@/server/admin/reviews";
import { requireAdmin } from "@/server/auth/http";
import { handler } from "@/server/http";
import { numericParam } from "../../../contracts/ids";

export const dynamic = "force-dynamic";

/** Ouvre une demande : catégorie, texte masqué, score de lecture (US-138 RF2). Chaque consultation est journalisée (RT3). */
export const GET = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const review = await getReview(ctx, session.user.id, await numericParam(context.params, "id"));
  return NextResponse.json(review, { headers: { "Cache-Control": "private, no-store" } });
});
