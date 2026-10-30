import { NextResponse } from "next/server";
import { ideaForm } from "@/server/assistant/outings/proposals";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Formulaire de RDV prérempli depuis une idée (US-120 RF1, RF2) avec l'avertissement de visibilité (US-121). `members` : identifiants séparés par des virgules. */
export const GET = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const members = new URL(request.url).searchParams.get("members");
  return NextResponse.json({ form: await ideaForm(ctx, session, (await context.params).id, members ? members.split(",").filter((m) => /^[0-9a-f-]{36}$/i.test(m)) : undefined) });
});
