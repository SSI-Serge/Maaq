import { z } from "zod";
import { remapCategory } from "@/server/admin/storefronts";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

const schema = z.object({ categoryCode: z.string().regex(/^[a-z0-9_]+$/) });

/** Correction de la catégorie d'une vitrine (US-17). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const { categoryCode } = await parseBody(request, schema);
    await remapCategory(ctx, session.user.id, id, categoryCode);
    return new Response(null, { status: 204 });
  });
});
