import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { setHeart } from "@/server/emotions/hearts";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ kind: z.enum(["task", "event"]), id: z.uuid(), on: z.boolean() });

/** Pose (`on`) ou retire le cœur de remerciement du profil sur une tâche ou un RDV (US-141). Réservé au couple ; aucune notification. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ heart: await setHeart(ctx, session, { kind: body.kind, id: body.id }, body.on) });
});
