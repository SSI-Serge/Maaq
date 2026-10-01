import { requireProfile } from "@/server/auth/http";
import { removeAgent } from "@/server/catalog/service";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Retire un agent du dashboard du profil (US-28). */
export const DELETE = handler(async (request: Request, { params }: { params: Promise<{ agentId: string }> }) => {
  const { session, ctx } = await requireProfile();
  const { agentId } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    await removeAgent(ctx, session, agentId);
    return new Response(null, { status: 204 });
  });
});
