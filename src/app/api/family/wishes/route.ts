import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { addWish, listWishes } from "@/server/emotions/wishes";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** « Nos envies » du couple (US-147). Réservé à l'utilisateur principal et à l'invité 1. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json(await listWishes(ctx, session));
});

const schema = z.object({ title: z.string().max(300), description: z.string().max(1000).nullable().optional(), horizon: z.enum(["soon", "this_year", "someday"]).nullable().optional() });

/** Ajoute une envie par le bouton « + » (US-148) ; l'autre parent est prévenu, sans le titre (US-149). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ wish: await addWish(ctx, session, body) }, { status: 201 });
});
