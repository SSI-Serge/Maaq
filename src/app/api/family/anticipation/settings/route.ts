import { NextResponse } from "next/server";
import { z } from "zod";
import { setAnticipationEnabled, setSituationAnswer } from "@/server/assistant/anticipation";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  enabled: z.boolean().optional(),
  situation: z.object({ key: z.string().regex(/^[a-z_]+$/).max(40), answer: z.boolean().nullable() }).optional(),
});

/** Réglages de l'anticipation pour la famille (US-102 RF2, RF9) : interrupteur du catalogue et questionnaire « Situation de la famille ». Parents seulement. */
export const PATCH = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  const out: { enabled?: boolean; situation?: Awaited<ReturnType<typeof setSituationAnswer>> } = {};
  if (body.enabled !== undefined) out.enabled = (await setAnticipationEnabled(ctx, session, body.enabled)).enabled;
  if (body.situation) out.situation = await setSituationAnswer(ctx, session, body.situation.key, body.situation.answer);
  return NextResponse.json(out);
});
