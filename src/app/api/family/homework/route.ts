import { NextResponse } from "next/server";
import { z } from "zod";
import { getHomeworkSetting, setHomeworkDays, setHomeworkEnabled } from "@/server/assistant/homework/settings";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

/** Aide Devoirs du foyer (US-118) : lisible par tout profil de la famille. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ setting: await getHomeworkSetting(ctx, session) });
});

const schema = z.object({ enabled: z.boolean().optional(), confirmed: z.boolean().optional(), days: z.array(z.number().int()).max(7).optional() });

/** Active ou désactive l'aide, ou change les jours de devoirs (US-118 RF7) : les deux parents. */
export const PATCH = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  if (body.days !== undefined) return NextResponse.json({ setting: await setHomeworkDays(ctx, session, body.days) });
  if (body.enabled === undefined) throw new Rejection("invalid_body", "La demande est incomplète.", 422);
  return NextResponse.json({ setting: await setHomeworkEnabled(ctx, session, { enabled: body.enabled, confirmed: body.confirmed }) });
});
