import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { cancelTask } from "@/server/assistant/tasks";
import { scopeSchema } from "../../schemas";
import { taskIdOf } from "../../params";

export const dynamic = "force-dynamic";

const schema = z.object({ version: z.number().int().min(1).optional(), scope: scopeSchema.optional() });

/** « Annuler la tâche » ; sur une tâche récurrente, avec la portée choisie (US-110 RF5). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ result: await cancelTask(ctx, session, await taskIdOf(context), { expectedVersion: body.version, scope: body.scope }) });
});
