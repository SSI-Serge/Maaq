import { NextResponse } from "next/server";
import { z } from "zod";
import { clearPending, ctx, knownDeviceIds, openSession, rememberDevice, requestTimezone, setPending } from "@/server/auth/http";
import { lockedRejection } from "@/server/auth/responses";
import { MESSAGES } from "@/server/auth/rules";
import { login } from "@/server/auth/service";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
  timezone: z.string().max(64).optional(),
});

/** Connexion par email et mot de passe (US-3). */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  const context = ctx();
  const timezone = await requestTimezone(body);
  const result = await login(context, {
    email: body.email,
    password: body.password,
    knownDeviceIds: await knownDeviceIds(),
    timezone,
  });

  switch (result.kind) {
    case "invalid":
      throw new Rejection("invalid_credentials", MESSAGES.invalidCredentials, 401);
    case "locked":
      throw lockedRejection(result.until);
    case "verify":
      await setPending({ userId: result.userId, deviceIdentifier: result.deviceIdentifier, timezone }, context.now);
      return NextResponse.json({ next: "/verification" });
    case "session":
      await clearPending();
      await openSession(result.token, result.expiresAt, result.sessionId, context.now);
      await rememberDevice(result.deviceId);
      return NextResponse.json({ next: result.next });
  }
});
