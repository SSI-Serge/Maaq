import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";
import { getLogbook } from "@/server/logbook/service";

export const dynamic = "force-dynamic";

/** Entrées du carnet d'un agent, 20 par page (US-40 RF2, RF9). */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const params = new URL(request.url).searchParams;
  const agent = params.get("agent") ?? "";
  const offset = Number(params.get("offset") ?? "0");
  if (!/^\d{1,18}$/.test(agent) || !Number.isInteger(offset) || offset < 0) throw new Rejection("invalid_query", "Requête invalide.", 400);
  return NextResponse.json(await getLogbook(ctx, session, agent, offset));
});
