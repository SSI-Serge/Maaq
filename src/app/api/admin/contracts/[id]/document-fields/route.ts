import { NextResponse } from "next/server";
import { z } from "zod";
import { addDocumentField, getDocumentFields } from "@/server/admin/contracts";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Champs de documents attendus d'une catégorie (US-122). */
export const GET = handler(async (_request: Request, { params }: Params) => {
  const { ctx } = await requireAdmin();
  return NextResponse.json(await getDocumentFields(ctx, (await params).id));
});

const schema = z.object({ name: z.string().max(200), help: z.string().max(400).nullish(), required: z.boolean().optional() });

/** Ajoute un champ de documents, appliqué immédiatement à toutes les familles (US-122 RF4, RF8). */
export const POST = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const input = await parseBody(request, schema);
    await addDocumentField(ctx, session.user.id, id, input);
    return NextResponse.json(await getDocumentFields(ctx, id), { status: 201 });
  });
});
