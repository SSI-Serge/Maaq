import { NextResponse } from "next/server";
import { z } from "zod";
import { moveItem, removeItem, setItemChecked } from "@/server/assistant/homework/weeks";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

async function itemIdOf(context: { params: Promise<{ id: string }> }): Promise<string> {
  const { id } = await context.params;
  if (!/^\d{1,18}$/.test(id)) throw new Rejection("not_found", "Cet élément n'existe plus.", 404);
  return id;
}

const schema = z.object({ checked: z.boolean().optional(), day: z.number().int().optional() });

/** Coche ou décoche un élément (« fait », sans valider : seules les photos valident), ou le déplace vers un autre jour de la semaine (US-119 RF4, RF6). */
export const PATCH = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  const id = await itemIdOf(context);
  if (body.checked !== undefined) await setItemChecked(ctx, session, id, body.checked);
  if (body.day !== undefined) await moveItem(ctx, session, id, body.day);
  return NextResponse.json({ ok: true });
});

/** Retire un élément de la semaine. */
export const DELETE = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  await removeItem(ctx, session, await itemIdOf(context));
  return NextResponse.json({ ok: true });
});
