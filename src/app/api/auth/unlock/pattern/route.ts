import { NextResponse } from "next/server";
import { z } from "zod";
import { ctx, currentSession, markUnlocked } from "@/server/auth/http";
import { patternRemainingMessage } from "@/server/auth/rules";
import { homeFor, unlockWithPattern } from "@/server/auth/service";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ points: z.array(z.number().int()).max(9) });

/** Déverrouillage par schéma tactile (US-6, US-7, US-52). */
export const POST = handler(async (request: Request) => {
  const { points } = await parseBody(request, schema);
  const context = ctx();
  const session = await currentSession(context);
  if (!session) throw new Rejection("unauthenticated", "Votre session a expiré. Reconnectez-vous.", 401);

  const result = await unlockWithPattern(context, session, points);
  switch (result.kind) {
    case "ok":
      await markUnlocked(session.sessionId, context.now);
      return NextResponse.json({ next: homeFor(session) });
    case "incorrect":
      throw new Rejection("pattern_incorrect", patternRemainingMessage(result.remaining), 401, { remaining: result.remaining });
    case "locked":
      throw new Rejection("pattern_locked", "Schéma tactile verrouillé.", 423);
    case "no_pattern":
      throw new Rejection("no_pattern", "Aucun schéma n'est enregistré sur cet appareil.", 409);
  }
});
