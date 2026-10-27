import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { setTaskDone } from "@/server/assistant/tasks";
import { taskIdOf } from "../../params";

export const dynamic = "force-dynamic";

const schema = z.object({ done: z.boolean(), version: z.number().int().min(1).optional() });

/** Coche la tâche (« Faite par [prénom] »), ou annule le cochage (US-110 RF7). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ task: await setTaskDone(ctx, session, await taskIdOf(context), body.done, { expectedVersion: body.version }) });
});
