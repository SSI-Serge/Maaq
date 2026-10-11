import { resendActivation } from "@/server/admin/accounts";
import { requireAdmin } from "@/server/auth/http";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Renvoie un nouveau lien d'activation ; le précédent ne fonctionne plus (US-64 RF6). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    await resendActivation(ctx, session.user.id, id);
    return new Response(null, { status: 204 });
  });
});
