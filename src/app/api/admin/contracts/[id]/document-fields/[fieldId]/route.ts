import { NextResponse } from "next/server";
import { z } from "zod";
import { getDocumentFields, moveDocumentField, removeDocumentField, updateDocumentField } from "@/server/admin/contracts";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; fieldId: string }> };

const schema = z.union([
  z.object({ move: z.enum(["up", "down"]) }),
  z.object({ name: z.string().max(200).optional(), help: z.string().max(400).nullable().optional(), required: z.boolean().optional() }),
]);

/** Renomme un champ, change son aide, son caractère obligatoire ou sa place (US-122 RF6, US-123). */
export const PATCH = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireAdmin();
  const { id, fieldId } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const body = await parseBody(request, schema);
    if ("move" in body && body.move) await moveDocumentField(ctx, session.user.id, id, fieldId, body.move);
    else if (!("move" in body)) await updateDocumentField(ctx, session.user.id, id, fieldId, body);
    return NextResponse.json(await getDocumentFields(ctx, id));
  });
});

/** Retire un champ ; les documents qui y sont déposés sont supprimés (US-122 RF5). */
export const DELETE = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireAdmin();
  const { id, fieldId } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const { deletedDocuments } = await removeDocumentField(ctx, session.user.id, id, fieldId);
    return NextResponse.json({ ...(await getDocumentFields(ctx, id)), deletedDocuments });
  });
});
