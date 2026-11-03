import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { undoHandOver } from "@/server/emotions/handover";
import { handler, parseBody } from "@/server/http";
import { taskIdOf } from "../../../params";

export const dynamic = "force-dynamic";

const schema = z.object({ version: z.number().int().min(1).optional() });

/** « Annuler » après « Confier à » : la tâche revient, la notification retenue ne part pas. */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ task: await undoHandOver(ctx, session, await taskIdOf(context), body.version) });
});
