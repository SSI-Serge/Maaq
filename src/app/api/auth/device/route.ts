import { NextResponse } from "next/server";
import { ctx, readPending } from "@/server/auth/http";
import { verificationTargets } from "@/server/auth/service";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

/** Destinataires possibles du code de vérification, masqués (US-51, maquette Vérification). */
export const GET = handler(async () => {
  const context = ctx();
  const pending = await readPending(context.now);
  const targets = pending ? await verificationTargets(context, pending) : null;
  if (!targets) throw new Rejection("verification_expired", "La vérification a expiré. Reconnectez-vous.", 401);
  return NextResponse.json(targets);
});
