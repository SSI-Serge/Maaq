import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";
import { agentInfoOverview } from "@/server/profile/agent-info";

export const dynamic = "force-dynamic";

/**
 * Informations d'un profil, agent par agent, avec les manques signalés (US-10 RF13, US-12 RF1).
 * ?profil= : un invité du compte, pour l'utilisateur principal (US-11 RF2).
 */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const target = new URL(request.url).searchParams.get("profil") ?? session.user.id;
  return NextResponse.json({ agents: await agentInfoOverview(ctx, session, target) });
});
