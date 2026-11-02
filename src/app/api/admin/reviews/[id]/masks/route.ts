import { NextResponse } from "next/server";
import { z } from "zod";
import { addReviewMask } from "@/server/admin/reviews";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../../../contracts/ids";

export const dynamic = "force-dynamic";

/** « Masquer aussi ce mot » dans un document de la demande (US-138 RF3). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  return idempotent(ctx, request, session.user.id, async () => {
    const { field, word } = await parseBody(request, z.object({ field: z.string().min(1).max(200), word: z.string().min(1).max(200) }));
    return NextResponse.json(await addReviewMask(ctx, session.user.id, await numericParam(context.params, "id"), field, word));
  });
});
