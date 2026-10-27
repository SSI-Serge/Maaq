import { NextResponse } from "next/server";
import { addEventTask } from "@/server/assistant/event-tasks";
import { getEvent } from "@/server/assistant/events";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { eventIdOf } from "../../params";
import { eventTaskSchema } from "./schema";

export const dynamic = "force-dynamic";

/** Ajoute une tâche à la liste « À préparer » d'un RDV (US-95 RF3, RF8). Rend le RDV à jour, avec sa nouvelle version. */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const { version, ...input } = await parseBody(request, eventTaskSchema);
  const id = await eventIdOf(context);
  await addEventTask(ctx, session, id, input, { expectedVersion: version });
  return NextResponse.json({ event: await getEvent(ctx, session, id) }, { status: 201 });
});
