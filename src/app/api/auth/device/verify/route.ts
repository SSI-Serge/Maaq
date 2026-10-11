import { NextResponse } from "next/server";
import { z } from "zod";
import { clearPending, ctx, openSession, readPending, rememberDevice, userAgent } from "@/server/auth/http";
import { codeRejection } from "@/server/auth/responses";
import { verifyDevice } from "@/server/auth/service";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "6 chiffres") });

/** Vérifie le code : l'appareil devient reconnu et la session s'ouvre (US-51 RF3). */
export const POST = handler(async (request: Request) => {
  const { code } = await parseBody(request, schema);
  const context = ctx();
  const pending = await readPending(context.now);
  if (!pending) throw new Rejection("verification_expired", "La vérification a expiré. Reconnectez-vous.", 401);

  const result = await verifyDevice(context, pending, code, await userAgent());
  if (result.kind !== "session") throw codeRejection(result.kind);

  await clearPending();
  await openSession(result.token, result.expiresAt, result.sessionId, context.now);
  await rememberDevice(result.deviceId);
  return NextResponse.json({ next: result.next });
});
