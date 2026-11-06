import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { menuPropose } from "@/server/courses/menu/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ picks: z.array(z.string().min(1).max(60)).min(1).max(2), week: z.string().max(10).optional() });

/** Étape 2 : le menu proposé autour des 1 ou 2 plats plaisir (US-156). Rien n'est enregistré. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ menu: await menuPropose(ctx, session, body) });
});
