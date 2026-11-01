import { NextResponse } from "next/server";
import { archiveContract, listContracts } from "@/server/admin/contracts";
import { requireAdmin } from "@/server/auth/http";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Archive une catégorie qui contient des contrats : elle n'est plus proposée, ses contrats restent en lecture (US-139, C-19). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    await archiveContract(ctx, session.user.id, id);
    return NextResponse.json({ contracts: await listContracts(ctx) });
  });
});
