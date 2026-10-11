import { z } from "zod";
import { blockAgent } from "@/server/admin/agents";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

const schema = z.object({ message: z.string().max(200) });

/** Bloque l'agent pour maintenance (US-46). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const { message } = await parseBody(request, schema);
    await blockAgent(ctx, session.user.id, id, message);
    return new Response(null, { status: 204 });
  });
});
