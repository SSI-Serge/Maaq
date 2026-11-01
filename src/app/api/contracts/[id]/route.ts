import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { clearContract, deleteContract, renameContract, saveDetails } from "@/server/contracts/service";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../ids";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const details = z.object({ values: z.record(z.string().regex(/^\d{1,18}$/), z.string().max(2000)) });

/** Enregistre les détails d'un contrat (US-33). */
export const PUT = handler(async (request: Request, context: Params) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { values } = await parseBody(request, details);
    return NextResponse.json(await saveDetails(ctx, session, await numericParam(context.params, "id"), values));
  });
});

const rename = z.object({ name: z.string().max(200) });

/** Renomme un contrat (US-125 RF3). */
export const PATCH = handler(async (request: Request, context: Params) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { name } = await parseBody(request, rename);
    return NextResponse.json(await renameContract(ctx, session, await numericParam(context.params, "id"), name));
  });
});

/**
 * Sans paramètre : supprime tous les détails et documents d'un contrat, qui reste dans la liste (US-35). Avec `?delete=1` : supprime un contrat complémentaire, avec ses
 * détails, ses documents et son rapport (US-133) ; le contrat de base ne se supprime pas.
 */
export const DELETE = handler(async (request: Request, context: Params) => {
  const { session, ctx } = await requireProfile();
  const remove = new URL(request.url).searchParams.get("delete") === "1";
  return idempotent(ctx, request, session.user.id, async () => {
    const id = await numericParam(context.params, "id");
    if (remove) return NextResponse.json(await deleteContract(ctx, session, id));
    return NextResponse.json(await clearContract(ctx, session, id));
  });
});
