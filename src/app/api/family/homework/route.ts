import { NextResponse } from "next/server";
import { z } from "zod";
import { getHomeworkSetting, setHomeworkEnabled } from "@/server/assistant/homework/settings";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Aide Devoirs du foyer (US-118) : lisible par tout profil de la famille. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ setting: await getHomeworkSetting(ctx, session) });
});

const schema = z.object({ enabled: z.boolean(), confirmed: z.boolean().optional() });

/** Active ou désactive l'aide : les deux parents. */
export const PATCH = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ setting: await setHomeworkEnabled(ctx, session, body) });
});
