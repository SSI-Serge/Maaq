import { NextResponse } from "next/server";
import { listPublishableAgents } from "@/server/admin/agents";
import { requireAdmin } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Agents hébergés chez Digitorn et pas encore publiés (US-45 RF2, RT2). */
export const GET = handler(async () => {
  const { ctx } = await requireAdmin();
  return NextResponse.json({ agents: await listPublishableAgents(ctx) });
});
