import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { disconnect } from "@/server/connectors/service";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

const schema = z.object({
  agentId: z.string().regex(/^\d{1,18}$/),
  connector: z.enum(["google_drive", "google_calendar", "validation_mailbox"]),
});

/** Déconnecte un connecteur après confirmation (US-13 RF9, US-15 RF7, US-67 RF10). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    await disconnect(ctx, session, await parseBody(request, schema));
    return new Response(null, { status: 204 });
  });
});
