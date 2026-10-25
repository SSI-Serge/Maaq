import { NextResponse } from "next/server";
import { z } from "zod";
import { listEvents } from "@/server/assistant/events";
import { requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const query = z.object({ from: z.iso.date(), to: z.iso.date() });

/** Rendez-vous du calendrier familial que ce profil a le droit de voir, sur la période demandée (US-78). */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const url = new URL(request.url);
  const parsed = query.safeParse({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
  if (!parsed.success) throw new Rejection("invalid_range", "La période demandée est invalide.", 422);
  return NextResponse.json({ events: await listEvents(ctx, session, parsed.data) });
});
