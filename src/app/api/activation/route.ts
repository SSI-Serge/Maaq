import { NextResponse } from "next/server";
import { z } from "zod";
import { activate, inspectActivation } from "@/server/accounts/activate";
import { ctx, openSession, rememberDevice, requestTimezone, userAgent } from "@/server/auth/http";
import { MESSAGES } from "@/server/auth/rules";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

// Lien inconnu : aussi le cas d'un compte ou d'un invité jamais activé, supprimé depuis (US-68 RF5). On ne sait plus qui l'avait invité.
const INVALID = "Ce lien a expiré. Demandez à la personne qui vous a invité de vous renvoyer une invitation, ou contactez MAAQ pour recevoir un nouveau lien.";

/** Lien expiré, remplacé ou dont l'invité a été supprimé (US-4 RF6, RF8 ; US-64 RF6). */
function expired(linkKind: string, host: string | null | undefined): Rejection {
  const message =
    linkKind === "guest_invitation"
      ? `Ce lien d'invitation a expiré. Demandez à ${host ?? "la personne qui vous a invité"} de vous renvoyer une invitation.`
      : "Ce lien d'activation a expiré. Contactez MAAQ pour recevoir un nouveau lien.";
  return new Rejection("link_expired", message, 410);
}

const used = () => new Rejection("link_used", "Votre accès est déjà activé", 409);

/** État d'un lien d'activation, coordonnées du profil et textes juridiques à accepter (US-4 RF4, US-64 RF5). */
export const GET = handler(async (request: Request) => {
  const token = new URL(request.url).searchParams.get("jeton") ?? "";
  const info = await inspectActivation(ctx(), token);
  if (info.kind === "expired") throw expired(info.linkKind, info.host);
  if (info.kind === "used") throw used();
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

/** Active l'accès : acceptation des textes, mot de passe, session ouverte sur cet appareil (US-4 RF5). */
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
    case "used":
      throw used();
    case "expired":
      throw expired(result.linkKind, result.host);
    case "invalid":
      throw new Rejection("link_invalid", INVALID, 404);
    case "session":
      await openSession(result.token, result.expiresAt, result.sessionId, context.now);
      await rememberDevice(result.deviceId);
      return NextResponse.json({ next: "/schema/creer" });
  }
});
