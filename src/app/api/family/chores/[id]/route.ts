import { NextResponse } from "next/server";
import { z } from "zod";
import { choreDetail, saveChoreTask } from "@/server/assistant/chores";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function taskIdOf(params: Params["params"]): Promise<number> {
  const { id } = await params;
  if (!/^\d{1,9}$/.test(id)) throw new Rejection("not_found", "Cette tâche n'existe pas.", 404);
  return Number(id);
}

/** Pas à pas d'une tâche ménagère guidée (US-182) : pour tout profil du foyer. */
export const GET = handler(async (_request: Request, { params }: Params) => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ detail: await choreDetail(ctx, session, await taskIdOf(params)) });
});

const schema = z.object({
  enabled: z.boolean(),
  days: z.array(z.number().int()).max(7).optional(),
  memberId: z.uuid().nullable().optional(),
  bins: z.array(z.object({ binId: z.number().int(), collectionDay: z.number().int().min(1).max(7).nullable() })).max(20).optional(),
  binTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
});

/** Active, règle ou désactive une tâche ménagère du foyer (US-181 RF1 à RF6) : les deux parents. */
export const PUT = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ setting: await saveChoreTask(ctx, session, await taskIdOf(params), body) });
});
