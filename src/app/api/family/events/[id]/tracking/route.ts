import { NextResponse } from "next/server";
import { z } from "zod";
import { setTracking } from "@/server/assistant/travel";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { eventIdOf } from "../../params";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const position = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });

/** « Suivre mon trajet » (US-107 RF4) : active le suivi de ce RDV, ou de toute sa série, pour le profil connecté seulement. La position lue à l'activation est facultative. */
export const PUT = handler(async (request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, z.object({ scope: z.enum(["event", "series"]).default("event"), position: position.optional() }));
  return NextResponse.json({ travel: await setTracking(ctx, session, await eventIdOf(context), { enabled: true, scope: body.scope, position: body.position }) });
});

/** Retire le suivi de ce RDV (ou, avec `?scope=series`, de toute la série). Sur une séance d'une série suivie, la séance est écartée du suivi. */
export const DELETE = handler(async (request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  const scope = new URL(request.url).searchParams.get("scope") === "series" ? "series" : "event";
  return NextResponse.json({ travel: await setTracking(ctx, session, await eventIdOf(context), { enabled: false, scope }) });
});
