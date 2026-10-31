import { z } from "zod";
import { updateAgentAddress } from "@/server/admin/agents";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

const schema = z.object({ appUrl: z.string().trim().min(1).max(600) });

/** Change l'adresse de l'application Digitorn d'un agent publié par adresse seule. */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const { appUrl } = await parseBody(request, schema);
    await updateAgentAddress(ctx, id, appUrl);
    return new Response(null, { status: 204 });
  });
});
