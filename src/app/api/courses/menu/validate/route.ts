import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { menuValidate } from "@/server/courses/menu/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const id = z.string().min(1).max(60);
const schema = z.object({ week: z.string().max(10).optional(), picks: z.array(id).min(1).max(2), dinners: z.array(id).length(7), express: z.array(id).max(4) });

/** Valide le menu de la semaine (US-156) : un menu par semaine, la nouvelle validation remplace l'ancienne. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ validated: await menuValidate(ctx, session, body) });
});
