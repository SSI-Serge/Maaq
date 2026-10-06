import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { clearContract, saveDetails } from "@/server/contracts/service";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../ids";

export const dynamic = "force-dynamic";

const schema = z.object({ values: z.record(z.string().regex(/^\d{1,18}$/), z.string().max(2000)) });

/** Enregistre les détails d'un contrat (US-33). */
export const PUT = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { values } = await parseBody(request, schema);
    return NextResponse.json(await saveDetails(ctx, session, await numericParam(context.params, "id"), values));
  });
});

/** Supprime tous les détails et documents d'un contrat (US-35). */
export const DELETE = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => NextResponse.json(await clearContract(ctx, session, await numericParam(context.params, "id"))));
});
