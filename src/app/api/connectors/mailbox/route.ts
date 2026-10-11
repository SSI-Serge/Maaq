import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { saveMailbox } from "@/server/connectors/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ agentId: z.string().regex(/^\d{1,18}$/), email: z.string().max(254) });

/** Enregistre l'adresse de la boîte de validation et envoie le code de vérification (US-15 RF2 à RF4). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await saveMailbox(ctx, session, await parseBody(request, schema)));
});
