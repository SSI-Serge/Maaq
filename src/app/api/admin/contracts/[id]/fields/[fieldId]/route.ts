import { NextResponse } from "next/server";
import { archiveContractField, getContractFields } from "@/server/admin/contracts";
import { requireAdmin } from "@/server/auth/http";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Retire un champ d'un contrat (US-48 RF10). */
export const DELETE = handler(async (request: Request, { params }: { params: Promise<{ id: string; fieldId: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { id, fieldId } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    await archiveContractField(ctx, session.user.id, id, fieldId);
    return NextResponse.json(await getContractFields(ctx, id));
  });
});
