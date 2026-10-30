import { NextResponse } from "next/server";
import { z } from "zod";
import { addItem } from "@/server/assistant/homework/weeks";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { itemSchema } from "../../../schemas";
import { weekIdOf } from "../route";

export const dynamic = "force-dynamic";

const schema = z.object({ memberId: z.uuid(), item: itemSchema });

/** Ajoute un élément à une semaine préparée (US-119 RF4). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  await addItem(ctx, session, await weekIdOf(context), body.memberId, body.item);
  return NextResponse.json({ ok: true }, { status: 201 });
});
