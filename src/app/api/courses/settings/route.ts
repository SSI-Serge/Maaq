import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Réglages du foyer (US-153) : communs au couple ; un invité secondaire n'y a pas accès (CR-10). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ settings: await getSettings(ctx, session) });
});

const schema = z.object({
  city: z.string().max(80).nullable().optional(),
  householdSize: z.number().int().min(1).max(12).nullable().optional(),
  shoppingDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  goals: z.object({ time: z.boolean().optional(), ownDishes: z.boolean().optional(), season: z.boolean().optional() }).optional(),
  repeatWeeks: z.number().int().min(1).max(4).nullable().optional(),
  replacementSource: z.enum(["own", "cuisine"]).optional(),
  replacementCuisineId: z.number().int().nullable().optional(),
  budgetDay: z.number().int().min(1).max(31).optional(),
  cuisineIds: z.array(z.number().int()).max(50).optional(),
  stores: z.array(z.object({ chain: z.string().max(80), city: z.string().max(80) })).max(30).optional(),
  diets: z.array(z.string().max(80)).max(20).optional(),
  allergens: z.array(z.string().max(80)).max(20).optional(),
  allergyText: z.string().max(500).optional(),
});

export const PUT = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ settings: await saveSettings(ctx, session, body) });
});
