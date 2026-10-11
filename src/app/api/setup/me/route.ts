import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { getSetup, saveMyInfo } from "@/server/profile/setup";

export const dynamic = "force-dynamic";

const schema = z.object({ firstName: z.string().max(100), lastName: z.string().max(100) });

/** Étape 1 « Mes informations » (US-10). Renvoyer les mêmes valeurs est sans effet de bord. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  await saveMyInfo(ctx, session, await parseBody(request, schema));
  return NextResponse.json(await getSetup(ctx, session));
});
