import { NextResponse } from "next/server";
import { z } from "zod";
import { ctx, readPending } from "@/server/auth/http";
import { sendRejection } from "@/server/auth/responses";
import { sendDeviceCode } from "@/server/auth/service";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ channel: z.enum(["email", "sms"]) });

/** Envoie (ou renvoie) le code de vérification d'appareil par email ou SMS (US-51 RF1, RF6). */
export const POST = handler(async (request: Request) => {
  const { channel } = await parseBody(request, schema);
  const context = ctx();
  const pending = await readPending(context.now);
  if (!pending) throw new Rejection("verification_expired", "La vérification a expiré. Reconnectez-vous.", 401);
  const result = await sendDeviceCode(context, pending, channel);
  if (result.kind !== "sent") throw sendRejection(result);
  return NextResponse.json({ resendAvailableAt: result.resendAvailableAt.toISOString() });
});
