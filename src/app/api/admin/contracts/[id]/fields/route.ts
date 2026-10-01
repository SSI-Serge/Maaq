import { NextResponse } from "next/server";
import { z } from "zod";
import { addContractField, getContractFields } from "@/server/admin/contracts";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Champs de détail d'un contrat (US-48 RF10). */
export const GET = handler(async (_request: Request, { params }: Params) => {
  const { ctx } = await requireAdmin();
  return NextResponse.json(await getContractFields(ctx, (await params).id));
});

const schema = z.object({
  label: z.string().max(200),
  type: z.enum(["text", "date", "amount", "choice"]),
  required: z.boolean(),
  options: z.array(z.string().max(120)).max(50),
});

/** Ajoute un champ, appliqué immédiatement à tous les clients. */
export const POST = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const input = await parseBody(request, schema);
    await addContractField(ctx, session.user.id, id, input);
    return NextResponse.json(await getContractFields(ctx, id), { status: 201 });
  });
});
