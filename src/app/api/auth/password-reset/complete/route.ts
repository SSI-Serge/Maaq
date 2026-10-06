import { NextResponse } from "next/server";
import { z } from "zod";
import { clearGrant, ctx, readGrant, requestTimezone, setGrant } from "@/server/auth/http";
import { MESSAGES } from "@/server/auth/rules";
import { completePasswordReset } from "@/server/auth/service";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  password: z.string().max(200),
  confirmation: z.string().max(200),
  timezone: z.string().max(64).optional(),
});

/** Enregistre le nouveau mot de passe (US-66 RF6 à RF10). */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  const context = ctx();
  const grant = await readGrant(context.now);
  if (!grant || grant.purpose !== "password_reset") {
    throw new Rejection("reset_expired", "Le délai est dépassé. Recommencez la réinitialisation.", 401);
  }

  const result = await completePasswordReset(context, {
    userId: grant.userId,
    deviceId: grant.deviceId,
    password: body.password,
    confirmation: body.confirmation,
    timezone: await requestTimezone(body),
  });
  if (result.kind === "weak") throw new Rejection("password_weak", MESSAGES.passwordWeak);
  if (result.kind === "mismatch") throw new Rejection("password_mismatch", MESSAGES.passwordMismatch);

  // Le schéma reste proposé, sans obligation, sur un appareil déjà reconnu (US-66 RF7).
  if (result.offerPattern) await setGrant({ ...grant, purpose: "pattern_after_reset" }, context.now);
  else await clearGrant();
  return NextResponse.json({ offerPattern: result.offerPattern });
});
