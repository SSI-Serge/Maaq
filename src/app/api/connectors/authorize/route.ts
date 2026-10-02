import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { authorizeConnection } from "@/server/connectors/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  agentId: z.string().regex(/^\d{1,18}$/),
  connector: z.enum(["google_drive", "google_calendar"]),
  email: z.string().max(254).optional(),
});

/** Démarre le consentement Google pour un connecteur (US-13 RF5, US-14 RF3, RF11). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await authorizeConnection(ctx, session, await parseBody(request, schema)));
});
