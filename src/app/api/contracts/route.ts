import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { addContract, getContracts } from "@/server/contracts/service";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Onglet « Mes contrats » (US-32, US-124). `?auto=1` : relecture automatique, qui ne prolonge pas le déverrouillage (US-52). */
export const GET = handler(async (request: Request) => {
  const automatic = new URL(request.url).searchParams.get("auto") === "1";
  const { session, ctx } = await requireProfile({ passive: automatic });
  return NextResponse.json(await getContracts(ctx, session));
});

const schema = z.object({ categoryId: z.string().regex(/^\d{1,18}$/), name: z.string().max(200) });

/** Ajoute un contrat complémentaire dans une catégorie (US-124 RF2, US-125). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { categoryId, name } = await parseBody(request, schema);
    return NextResponse.json(await addContract(ctx, session, categoryId, name), { status: 201 });
  });
});
