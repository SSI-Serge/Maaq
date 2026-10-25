import { NextResponse } from "next/server";
import { z } from "zod";
import { setAsideEvent } from "@/server/assistant/events";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { eventIdOf } from "../../params";

export const dynamic = "force-dynamic";

const schema = z.object({ version: z.number().int().min(1).optional(), allowConflict: z.boolean().optional() });

/** Ignore un rendez-vous provisoire : il est écarté, visible en gris et barré jusqu'à la relance suivante (US-77). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ event: await setAsideEvent(ctx, session, await eventIdOf(context), { expectedVersion: body.version, allowConflict: body.allowConflict }) });
});
