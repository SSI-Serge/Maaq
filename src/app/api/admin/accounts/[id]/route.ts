import { NextResponse } from "next/server";
import { z } from "zod";
import { getAccount, updateDailyLimit } from "@/server/admin/accounts";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Fiche d'un compte (US-64 RF6, US-69). */
export const GET = handler(async (_request: Request, { params }: Params) => {
  const { ctx } = await requireAdmin();
  return NextResponse.json(await getAccount(ctx, (await params).id));
});

const schema = z.object({ dailyRequestLimit: z.number() });

/** Modifie le plafond quotidien de demandes (US-69). Renvoyer la même valeur est sans effet. */
export const PATCH = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireAdmin();
  const { id } = await params;
  const { dailyRequestLimit } = await parseBody(request, schema);
  await updateDailyLimit(ctx, session.user.id, id, dailyRequestLimit);
  return NextResponse.json(await getAccount(ctx, id));
});
