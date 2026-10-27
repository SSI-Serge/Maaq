import { NextResponse } from "next/server";
import { z } from "zod";
import { removeEventTask, updateEventTask } from "@/server/assistant/event-tasks";
import { getEvent } from "@/server/assistant/events";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody, Rejection } from "@/server/http";
import { eventIdOf } from "../../../params";
import { eventTaskSchema } from "../schema";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; taskId: string }> };

async function taskIdOf(context: Context): Promise<string> {
  const { taskId } = await context.params;
  if (!z.uuid().safeParse(taskId).success) throw new Rejection("not_found", "Cette tâche n'existe plus.", 404);
  return taskId;
}

/** Modifie une tâche de la liste « À préparer » (US-95 RF3). Rend le RDV à jour. */
export const PATCH = handler(async (request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  const { version, ...input } = await parseBody(request, eventTaskSchema);
  const id = await eventIdOf(context);
  await updateEventTask(ctx, session, id, await taskIdOf(context), input, { expectedVersion: version });
  return NextResponse.json({ event: await getEvent(ctx, session, id) });
});

/** Retire une tâche de la liste « À préparer » (la croix, US-95 RF3). Rend le RDV à jour. */
export const DELETE = handler(async (request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  const version = Number(new URL(request.url).searchParams.get("version")) || undefined;
  const id = await eventIdOf(context);
  await removeEventTask(ctx, session, id, await taskIdOf(context), { expectedVersion: version });
  return NextResponse.json({ event: await getEvent(ctx, session, id) });
});
