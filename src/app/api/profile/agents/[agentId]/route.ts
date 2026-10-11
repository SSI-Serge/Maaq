import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { getAgentInfoForm, saveAgentInfo } from "@/server/profile/agent-info";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ agentId: string }> };

function targetOf(request: Request, fallback: string): string {
  return new URL(request.url).searchParams.get("profil") ?? fallback;
}

/** Formulaire « Informations nécessaires à [agent] » (US-10 RF12). */
export const GET = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await getAgentInfoForm(ctx, session, targetOf(request, session.user.id), (await params).agentId));
});

const schema = z.object({ values: z.record(z.string(), z.array(z.string().max(500)).max(100)) });

/** Enregistre les informations ; la dernière modification l'emporte (US-12 RF8). */
export const PUT = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireProfile();
  const { values } = await parseBody(request, schema);
  return NextResponse.json(await saveAgentInfo(ctx, session, targetOf(request, session.user.id), (await params).agentId, values));
});
