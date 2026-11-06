import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { createDish, dishForm } from "@/server/courses/menu/dishes";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Les cuisines et les plats du foyer (« Mes plats », US-159). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ form: await dishForm(ctx, session) });
});

const schema = z.object({
  name: z.string().max(120),
  cuisineId: z.number().int().min(0),
  ingredients: z.array(z.string().max(120)).max(60),
  minutes: z.number().int().nullable().optional(),
  recipe: z.string().max(5000).nullable().optional(),
});

/** Ajoute un plat du foyer. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ dish: await createDish(ctx, session, body) });
});
