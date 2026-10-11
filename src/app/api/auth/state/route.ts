import { NextResponse } from "next/server";
import { maskEmail } from "@/server/auth/format";
import { pendingAcceptance } from "@/server/compliance/legal";
import { accessRemoved, ctx, currentSession, isUnlocked, readPending } from "@/server/auth/http";
import { homeFor } from "@/server/auth/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** État de connexion de cet appareil : sert au démarrage (US-2 RF3) et à l'écran de déverrouillage (US-6 RF5). */
export const GET = handler(async () => {
  const context = ctx();
  const session = await currentSession(context);
  if (!session) {
    return NextResponse.json({
      authenticated: false,
      pendingVerification: (await readPending(context.now)) !== null,
      accessRemoved: await accessRemoved(context),
    });
  }
  // Textes à accepter avant tout accès, sauf quand un écran prioritaire s'impose déjà (US-54 RF4).
  let home = homeFor(session);
  const legalPending = (await pendingAcceptance(context.db, session.user.id, session.user.role, context.now)).length > 0;
  if (legalPending && home !== "/schema/creer" && home !== "/reprise-compte") home = "/conditions";
  return NextResponse.json({
    authenticated: true,
    unlocked: await isUnlocked(session, context.now),
    user: {
      firstName: session.user.firstName,
      maskedEmail: maskEmail(session.user.email),
      role: session.user.role,
      guestRank: session.user.guestRank,
    },
    device: { hasPattern: session.device.hasPattern, patternLocked: session.device.patternLocked },
    home,
  });
});
