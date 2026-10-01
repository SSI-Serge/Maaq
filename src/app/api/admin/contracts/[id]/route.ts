import { NextResponse } from "next/server";
import { z } from "zod";
import { archiveContract, listContracts, moveContract, renameContract } from "@/server/admin/contracts";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const schema = z.union([z.object({ name: z.string().max(200) }), z.object({ move: z.enum(["up", "down"]) })]);

/** Renomme ou déplace un contrat (US-48 RF3). */
export const PATCH = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const body = await parseBody(request, schema);
    if ("name" in body) await renameContract(ctx, session.user.id, id, body.name);
    else await moveContract(ctx, session.user.id, id, body.move);
    return NextResponse.json({ contracts: await listContracts(ctx) });
  });
});

/** Retire un contrat de la liste (US-48 RF4). */
export const DELETE = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    await archiveContract(ctx, session.user.id, id);
    return NextResponse.json({ contracts: await listContracts(ctx) });
  });
});
