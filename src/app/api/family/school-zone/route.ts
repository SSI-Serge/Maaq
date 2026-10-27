import { NextResponse } from "next/server";
import { z } from "zod";
import { getSchoolZone, setSchoolZone } from "@/server/assistant/school-zone";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Zone scolaire de la famille (US-109 RF4) : lisible par tout profil de la famille. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ setting: await getSchoolZone(ctx, session) });
});

const schema = z.object({ zone: z.enum(["A", "B", "C"]).nullable() });

/** Règle la zone scolaire : les parents seuls. */
export const PATCH = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ setting: await setSchoolZone(ctx, session, body.zone) });
});
