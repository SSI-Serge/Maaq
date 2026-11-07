import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { confirmTicket } from "@/server/courses/tickets/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  store: z.string().min(1).max(80),
  city: z.string().max(80).nullable(),
  date: z.string().max(10),
  lines: z.array(z.object({ product: z.string().max(120), reference: z.string().max(160).nullable(), total: z.number(), qty: z.number(), aisle: z.string().max(60) })).min(1).max(100),
});

/** Enregistre le ticket corrigé et confirmé (US-161 RF5). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ result: await confirmTicket(ctx, session, body) });
});
