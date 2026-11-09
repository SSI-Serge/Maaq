import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { validateGroup, validateList } from "@/server/courses/list/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const line = z.object({
  name: z.string().min(1).max(120),
  qty: z.number().min(1).max(99),
  store: z.string().max(80).nullable(),
  ref: z.string().max(160).nullable(),
  price: z.number().min(0).max(10000).nullable(),
  priceUnit: z.enum(["unit", "kg", "l"]).optional(),
  source: z.enum(["menu", "added", "habit"]),
  need: z.object({ amount: z.number().positive().max(1_000_000), unit: z.enum(["kg", "l", "piece"]) }).nullable().optional(),
  weight: z.number().positive().max(1_000_000).nullable().optional(),
  toCheck: z.boolean().optional(),
  pantry: z.boolean().optional(),
});

/** Valide le scénario choisi : la liste passe dans « Ma liste de courses » (US-157 RF7, couple seulement). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, z.object({ scenario: z.union([z.literal(1), z.literal(2), z.literal(3)]), lines: z.array(line).min(1).max(400), week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), weeks: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(2).max(5).optional() }));
  // « Valider la liste du mois » : plusieurs semaines regroupées, un seul scénario (CR-56)
  if (body.weeks) return NextResponse.json({ validated: await validateGroup(ctx, session, { weeks: body.weeks, scenario: body.scenario, lines: body.lines }) });
  return NextResponse.json({ validated: await validateList(ctx, session, body) });
});
