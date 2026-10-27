import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { getTask, updateTask } from "@/server/assistant/tasks";
import { scopeSchema } from "../schemas";
import { taskIdOf } from "../params";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, context: Context) => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ task: await getTask(ctx, session, await taskIdOf(context)) });
});

const schema = z.object({
  version: z.number().int().min(1),
  scope: scopeSchema.optional(),
  title: z.string().max(300),
  note: z.string().max(5000).nullable().optional(),
  due: z.string().max(10),
  dueTime: z.string().max(5).nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
});

/** Modifie une tâche à faire ; sur une tâche récurrente, avec la portée choisie (US-110 RF5). */
export const PATCH = handler(async (request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  const { version, scope, ...changes } = await parseBody(request, schema);
  return NextResponse.json({ task: await updateTask(ctx, session, await taskIdOf(context), changes, { expectedVersion: version, scope }) });
});
