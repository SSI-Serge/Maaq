import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handOverTask } from "@/server/emotions/handover";
import { handler, parseBody } from "@/server/http";
import { taskIdOf } from "../../params";

export const dynamic = "force-dynamic";

const schema = z.object({ version: z.number().int().min(1).optional() });

/** « Confier à [prénom] » (US-146) : réassigne la tâche à l'autre parent ; la notification est retenue le temps de pouvoir annuler. */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json(await handOverTask(ctx, session, await taskIdOf(context), body.version));
});
