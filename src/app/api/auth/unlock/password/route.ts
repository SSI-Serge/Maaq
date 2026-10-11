import { NextResponse } from "next/server";
import { z } from "zod";
import { ctx, currentSession, markUnlocked } from "@/server/auth/http";
import { lockedRejection } from "@/server/auth/responses";
import { homeFor, unlockWithPassword } from "@/server/auth/service";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ password: z.string().min(1).max(200) });

/** Déverrouillage de l'administrateur par mot de passe après inactivité (US-52 RF8). */
export const POST = handler(async (request: Request) => {
  const { password } = await parseBody(request, schema);
  const context = ctx();
  const session = await currentSession(context);
  if (!session) throw new Rejection("unauthenticated", "Votre session a expiré. Reconnectez-vous.", 401);
  if (session.user.role !== "admin") throw new Rejection("forbidden", "Déverrouillez avec votre schéma tactile.", 403);

  const result = await unlockWithPassword(context, session, password);
  if (result.kind === "locked") throw lockedRejection(result.until);
  if (result.kind === "invalid") throw new Rejection("password_incorrect", "Mot de passe incorrect", 401);
  await markUnlocked(session.sessionId, context.now);
  return NextResponse.json({ next: homeFor(session) });
});
