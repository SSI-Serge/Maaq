import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmEvent } from "@/server/assistant/events";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { eventIdOf } from "../../params";

export const dynamic = "force-dynamic";

const schema = z.object({ version: z.number().int().min(1).optional(), allowConflict: z.boolean().optional(), withoutTasks: z.boolean().optional() });

/** Confirme un rendez-vous provisoire, ou écarté et encore visible (US-75, US-77 RF4). Un conflit demande allowConflict. */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ event: await confirmEvent(ctx, session, await eventIdOf(context), { expectedVersion: body.version, allowConflict: body.allowConflict, withoutTasks: body.withoutTasks }) });
});
