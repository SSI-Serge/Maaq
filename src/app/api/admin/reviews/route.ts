import { NextResponse } from "next/server";
import { listReviews } from "@/server/admin/reviews";
import { requireAdmin } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** « Analyses à valider » : les demandes en attente, de la plus ancienne à la plus récente (US-138 RF1). Le nombre sert à l'entrée du menu. */
export const GET = handler(async () => {
  const { ctx } = await requireAdmin();
  const reviews = await listReviews(ctx);
  return NextResponse.json({ reviews, count: reviews.length }, { headers: { "Cache-Control": "private, no-store" } });
});
