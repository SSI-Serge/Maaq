import { NextResponse } from "next/server";
import { z } from "zod";
import { getWeek, redoWeek } from "@/server/assistant/homework/weeks";
import { itemSchema } from "../../schemas";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

/** Identifiant dans l'adresse : tout ce qui n'est pas un identifiant est une semaine introuvable. */
export async function weekIdOf(context: { params: Promise<{ id: string }> }): Promise<string> {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Cette semaine n'existe plus ou ne vous est pas accessible.", 404);
  return id;
}

/** L'écran « Semaine de devoirs » (US-119 RF4) : les deux parents. */
export const GET = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ week: await getWeek(ctx, session, await weekIdOf(context)) });
});

const redo = z.object({ workDays: z.array(z.number().int()).max(7), children: z.array(z.object({ memberId: z.uuid(), items: z.array(itemSchema).max(120) })).max(12) });

/** « Refaire » la semaine des enfants choisis (US-119 RF12) : leurs éléments à venir sont remplacés, ce qui est fait est gardé. */
export const PUT = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, redo);
  return NextResponse.json(await redoWeek(ctx, session, await weekIdOf(context), body));
});
