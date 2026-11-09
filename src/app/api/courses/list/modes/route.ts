import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { saveLightChoices } from "@/server/courses/list/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Retient la version standard ou allégée de chaque plat (US-157 RF9). */
export const PUT = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, z.object({ modes: z.record(z.string().max(160), z.enum(["standard", "light"])), week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
  await saveLightChoices(ctx, session, body.modes, body.week);
  return NextResponse.json({ ok: true });
});
