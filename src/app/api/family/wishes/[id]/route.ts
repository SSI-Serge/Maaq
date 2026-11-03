import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { removeWish, updateWish } from "@/server/emotions/wishes";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function idOf(context: Context): Promise<string> {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Cette envie n'existe plus.", 404);
  return id;
}

const schema = z.object({ title: z.string().max(300).optional(), description: z.string().max(1000).nullable().optional(), horizon: z.enum(["soon", "this_year", "someday"]).nullable().optional() });

/** Modifie une envie (US-148 RF4) : l'un ou l'autre parent ; personne n'est prévenu. */
export const PATCH = handler(async (request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ wish: await updateWish(ctx, session, await idOf(context), body) });
});

/** « Retirer » (US-150) : l'envie disparaît, « Annuler » la remet pendant 10 secondes. */
export const DELETE = handler(async (_request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await removeWish(ctx, session, await idOf(context)));
});
