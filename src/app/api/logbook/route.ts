import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";
import { listLogbookAgents } from "@/server/logbook/service";

export const dynamic = "force-dynamic";

/** Agents proposés dans le sélecteur du carnet de bord (US-40 RF1, US-50). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json({ agents: await listLogbookAgents(ctx, session) });
});
