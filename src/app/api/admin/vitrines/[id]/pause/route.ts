import { z } from "zod";
import { setAdminPause } from "@/server/admin/storefronts";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

const schema = z.object({ paused: z.boolean(), reason: z.string().trim().max(300).nullish() });

/** Suspension ou levée par l'administrateur (US-17). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const { paused, reason } = await parseBody(request, schema);
    await setAdminPause(ctx, session.user.id, id, paused, reason ?? null);
    return new Response(null, { status: 204 });
  });
});
