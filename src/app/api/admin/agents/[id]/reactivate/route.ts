import { reactivateAgent } from "@/server/admin/agents";
import { requireAdmin } from "@/server/auth/http";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Réactive un agent bloqué (US-47). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    await reactivateAgent(ctx, session.user.id, id);
    return new Response(null, { status: 204 });
  });
});
