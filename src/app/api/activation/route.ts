import { NextResponse } from "next/server";
import { z } from "zod";
import { activate, inspectActivation } from "@/server/accounts/activate";
import { ctx, openSession, rememberDevice, requestTimezone, userAgent } from "@/server/auth/http";
import { MESSAGES } from "@/server/auth/rules";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const EXPIRED = "Ce lien d'activation a expiré. Contactez MAAQ pour recevoir un nouveau lien.";
const INVALID = "Ce lien d'activation n'est pas valable ou a déjà été utilisé.";

/** État d'un lien d'activation et textes juridiques à accepter (US-64 RF5, RF6). */
export const GET = handler(async (request: Request) => {
  const token = new URL(request.url).searchParams.get("jeton") ?? "";
  const info = await inspectActivation(ctx(), token);
  if (info.kind === "expired") throw new Rejection("link_expired", EXPIRED, 410);
  if (info.kind === "invalid") throw new Rejection("link_invalid", INVALID, 404);
  return NextResponse.json(info);
});

const schema = z.object({
  token: z.string().min(1).max(200),
  accepted: z.boolean(),
  password: z.string().max(200),
  confirmation: z.string().max(200),
  timezone: z.string().max(64).optional(),
});

/** Active le compte : acceptation des textes, mot de passe, session ouverte sur cet appareil. */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  const context = ctx();
  const result = await activate(context, { ...body, timezone: await requestTimezone(body), userAgent: await userAgent() });
  switch (result.kind) {
    case "not_accepted":
      throw new Rejection("not_accepted", "Acceptez la politique de confidentialité et les conditions d'utilisation pour continuer.");
    case "weak":
      throw new Rejection("password_weak", MESSAGES.passwordWeak);
    case "mismatch":
      throw new Rejection("password_mismatch", MESSAGES.passwordMismatch);
    case "expired":
      throw new Rejection("link_expired", EXPIRED, 410);
    case "invalid":
      throw new Rejection("link_invalid", INVALID, 404);
    case "session":
      await openSession(result.token, result.expiresAt, result.sessionId, context.now);
      await rememberDevice(result.deviceId);
      return NextResponse.json({ next: "/schema/creer" });
  }
});
