import { NextResponse } from "next/server";
import { z } from "zod";
import { cancelEvent } from "@/server/assistant/events";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { eventIdOf } from "../../params";

export const dynamic = "force-dynamic";

const schema = z.object({ version: z.number().int().min(1).optional(), allowConflict: z.boolean().optional(), scope: z.enum(["this", "following", "all"]).optional() });

/** Annule un rendez-vous confirmé (US-80). Il disparaît du calendrier et ne peut pas être rétabli. */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ event: await cancelEvent(ctx, session, await eventIdOf(context), { expectedVersion: body.version, allowConflict: body.allowConflict, scope: body.scope }) });
});
