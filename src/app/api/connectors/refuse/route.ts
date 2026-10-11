import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { refuseConnection } from "@/server/connectors/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  agentId: z.string().regex(/^\d{1,18}$/),
  connector: z.enum(["google_drive", "google_calendar"]),
  email: z.string().max(254),
});

/** Refus du panneau de permissions (US-14 RF4). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  await refuseConnection(ctx, session, await parseBody(request, schema));
  return new Response(null, { status: 204 });
});
