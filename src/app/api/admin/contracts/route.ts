import { NextResponse } from "next/server";
import { z } from "zod";
import { addContract, listContracts } from "@/server/admin/contracts";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Liste des contrats obligatoires, dans leur ordre d'affichage (US-48 RF1). */
export const GET = handler(async () => {
  const { ctx } = await requireAdmin();
  return NextResponse.json({ contracts: await listContracts(ctx) });
});

const schema = z.object({ name: z.string().max(200) });

/** Ajoute un contrat en fin de liste (US-48 RF2). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireAdmin();
  return idempotent(ctx, request, session.user.id, async () => {
    const { name } = await parseBody(request, schema);
    await addContract(ctx, session.user.id, name);
    return NextResponse.json({ contracts: await listContracts(ctx) }, { status: 201 });
  });
});
