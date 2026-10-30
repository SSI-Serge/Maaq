import { NextResponse } from "next/server";
import { z } from "zod";
import { getWeek } from "@/server/assistant/homework/weeks";
import { requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";

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
