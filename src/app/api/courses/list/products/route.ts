import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { addProduct, removeProduct } from "@/server/courses/list/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Ajoute un produit à la liste (couple et invité secondaire, US-158). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, z.object({ name: z.string().min(1).max(120), week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
  return NextResponse.json(await addProduct(ctx, session, body));
});

/** Retire un produit ajouté : l'invité secondaire retire les siens seulement. */
export const DELETE = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, z.object({ key: z.string().min(1).max(120), week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
  return NextResponse.json({ added: await removeProduct(ctx, session, body.key, body.week) });
});
