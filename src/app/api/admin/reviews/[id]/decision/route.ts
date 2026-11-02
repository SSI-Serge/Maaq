import { NextResponse } from "next/server";
import { z } from "zod";
import { decideReview } from "@/server/admin/reviews";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../../../contracts/ids";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** « Poursuivre l'analyse » ou « Ne pas poursuivre » (US-138 RF4) ; la décision est inscrite dans le journal d'administration (RF8). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  return idempotent(ctx, request, session.user.id, async () => {
    const { decision } = await parseBody(request, z.object({ decision: z.enum(["continue", "stop"]) }));
    return NextResponse.json(await decideReview(ctx, session.user.id, await numericParam(context.params, "id"), decision));
  });
});
