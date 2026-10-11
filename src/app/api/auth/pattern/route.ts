import { NextResponse } from "next/server";
import { z } from "zod";
import { clearGrant, ctx, currentSession, isUnlocked, markUnlocked, readGrant } from "@/server/auth/http";
import { MESSAGES } from "@/server/auth/rules";
import { homeFor, isValidPattern, setPattern, type Ctx, type PatternMode } from "@/server/auth/service";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

type Authorization = { userId: string; deviceId: string; mode: PatternMode; viaGrant: boolean };

/**
 * Qui peut enregistrer un schéma sur cet appareil :
 *  - un profil connecté et déverrouillé (création après la première connexion, US-6 RF1, US-7 RF4) ;
 *  - un profil qui vient de valider un code de récupération (US-8 RF5) ou de réinitialiser son mot de passe (US-66 RF7).
 */
async function authorize(context: Ctx): Promise<Authorization | null> {
  const grant = await readGrant(context.now);
  if (grant && grant.deviceId && grant.purpose !== "password_reset") {
    return {
      userId: grant.userId,
      deviceId: grant.deviceId,
      mode: grant.purpose === "pattern_recovery" ? "recovery" : "after_reset",
      viaGrant: true,
    };
  }
  const session = await currentSession(context);
  if (session && session.user.role !== "admin" && (await isUnlocked(session, context.now))) {
    return { userId: session.user.id, deviceId: session.device.id, mode: "first", viaGrant: false };
  }
  return null;
}

export const GET = handler(async () => {
  const authorization = await authorize(ctx());
  return NextResponse.json({ allowed: authorization !== null, mode: authorization?.mode ?? null });
});

const schema = z.object({
  points: z.array(z.number().int()).max(9),
  confirmation: z.array(z.number().int()).max(9),
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  if (!isValidPattern(body.points)) throw new Rejection("pattern_too_short", MESSAGES.patternTooShort);
  if (body.points.join("-") !== body.confirmation.join("-")) throw new Rejection("pattern_mismatch", MESSAGES.patternMismatch);

  const context = ctx();
  const authorization = await authorize(context);
  if (!authorization) throw new Rejection("unauthenticated", "Votre session a expiré. Reconnectez-vous.", 401);

  const saved = await setPattern(context, { ...authorization, points: body.points });
  if (!saved) throw new Rejection("device_unknown", "Cet appareil n'est plus reconnu. Reconnectez-vous.", 401);
  if (authorization.viaGrant) await clearGrant();

  // Une session mémorisée sur cet appareil est déverrouillée par le nouveau schéma.
  const session = await currentSession(context);
  if (session && session.user.id === authorization.userId && session.device.id === authorization.deviceId) {
    await markUnlocked(session.sessionId, context.now);
    return NextResponse.json({ next: homeFor(session) });
  }
  return NextResponse.json({ next: "/connexion" });
});
