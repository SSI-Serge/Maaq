import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { addWishToCalendar } from "@/server/emotions/wishes";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  title: z.string().max(300),
  place: z.string().max(400).nullable(),
  notes: z.string().max(5000).nullable(),
  type: z.enum(["school", "medical", "work", "family", "personal", "admin"]),
  memberIds: z.array(z.uuid()).max(12),
  start: z.string().max(16),
  end: z.string().max(16),
  allowConflict: z.boolean().optional(),
});

/** Enregistre le RDV issu d'une envie ; l'envie disparaît à l'enregistrement, dans la même transaction (US-151 RF2). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Cette envie n'existe plus.", 404);
  const body = await parseBody(request, schema);
  return NextResponse.json({ event: await addWishToCalendar(ctx, session, id, body) }, { status: 201 });
});
