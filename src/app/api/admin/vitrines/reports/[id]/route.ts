import { NextResponse } from "next/server";
import { z } from "zod";
import { reviewReport } from "@/server/admin/storefronts";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(["reviewed", "dismissed"]), decision: z.string().trim().max(300).nullish() });

/** Décision sur un signalement (US-16, US-17). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const { status, decision } = await parseBody(request, schema);
    return NextResponse.json({ report: await reviewReport(ctx, session.user.id, id, status, decision ?? null) });
  });
});
