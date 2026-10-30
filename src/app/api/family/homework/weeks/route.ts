import { NextResponse } from "next/server";
import { z } from "zod";
import { listWeeks, prepareWeek } from "@/server/assistant/homework/weeks";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { itemSchema } from "../schemas";

export const dynamic = "force-dynamic";

/** Semaines de devoirs préparées et lundis à venir (US-119 RF9) : les deux parents. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json(await listWeeks(ctx, session));
});

const schema = z.object({
  weekStart: z.iso.date(),
  workDays: z.array(z.number().int()).max(7),
  children: z.array(z.object({ memberId: z.uuid(), items: z.array(itemSchema).max(120) })).max(12),
});

/** Prépare la semaine choisie : semaine, éléments et tâches, en une transaction (US-119 RF4, RF10). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json(await prepareWeek(ctx, session, body), { status: 201 });
});
