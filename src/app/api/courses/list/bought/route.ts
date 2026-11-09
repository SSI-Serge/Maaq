import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { setBought } from "@/server/courses/list/mine";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Coche un produit « acheté » en magasin, ou annule (couple seulement). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, z.object({ key: z.string().min(1).max(120), bought: z.boolean(), late: z.boolean(), week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
  await setBought(ctx, session, body);
  return NextResponse.json({ ok: true });
});
