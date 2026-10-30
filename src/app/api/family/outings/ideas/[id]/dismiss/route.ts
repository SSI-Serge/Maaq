import { NextResponse } from "next/server";
import { z } from "zod";
import { dismissIdea } from "@/server/assistant/outings/proposals";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ restore: z.boolean().optional() });

/** « Pas cette fois » : retire cette seule idée (ou la remet, `restore`) ; la dernière idée retirée retire la proposition (US-116 RF2). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  await dismissIdea(ctx, session, (await context.params).id, body.restore === true);
  return NextResponse.json({ ok: true });
});
