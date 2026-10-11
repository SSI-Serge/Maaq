import { messenger } from "@/server/adapters/messaging";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import pkg from "../../../package.json";

/** Contact du support par message écrit ou dicté (US-62, US-63). */

export const SUPPORT_MIN = 10;
export const SUPPORT_MAX = 2000;
export const APP_VERSION: string = pkg.version;

const ROLE_LABEL = { primary_user: "Utilisateur principal", guest: "Invité", admin: "Administrateur" } as const;
const DEVICE_LABEL = { android: "Android", iphone: "iPhone", desktop: "Ordinateur", other: "Autre appareil" } as const;

/**
 * Transmet le message à la boîte du support avec le prénom, l'email, le rôle, le type d'appareil et la
 * version de l'application (US-62 RF4), puis en envoie une copie au profil (RF5). Un message dicté arrive
 * sous forme de texte transcrit, sans fichier audio (US-63 RF6).
 */
export async function sendSupportMessage(ctx: Ctx, session: SessionContext, input: { text: string; channel: "written" | "dictated" }): Promise<void> {
  const text = input.text.trim();
  if (text.length < SUPPORT_MIN) throw new Rejection("message_too_short", `Votre message doit compter au moins ${SUPPORT_MIN} caractères.`, 422);
  if (text.length > SUPPORT_MAX) throw new Rejection("message_too_long", `Votre message ne peut pas dépasser ${SUPPORT_MAX} caractères.`, 422);

  const setting = await ctx.db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", "support_email").executeTakeFirst();
  if (!setting?.value_text) throw new Rejection("support_unavailable", "Le support n'est pas joignable pour le moment. Réessayez plus tard.", 503);

  const { user, device } = session;
  const lines = [
    `Prénom : ${user.firstName}`,
    `Email : ${user.email}`,
    `Rôle : ${ROLE_LABEL[user.role]}`,
    `Appareil : ${DEVICE_LABEL[device.type]}`,
    `Version de l'application : ${APP_VERSION}`,
    `Canal : ${input.channel === "dictated" ? "message dicté (texte transcrit)" : "message écrit"}`,
  ];
  await messenger().sendEmail({
    to: setting.value_text,
    subject: `Support MAAQ — ${user.firstName}`,
    text: `${lines.join("\n")}\n\nMessage :\n${text}\n`,
  });
  // La copie au profil ne doit pas faire échouer un message déjà transmis au support.
  try {
    await messenger().sendEmail({
      to: user.email,
      subject: "Copie de votre message au support MAAQ",
      text: `Bonjour ${user.firstName},\n\nVoici la copie du message transmis au support :\n\n${text}\n\nL'équipe MAAQ vous répondra rapidement.\n`,
    });
  } catch (error) {
    console.error("Message transmis au support, copie non envoyée :", error);
  }
}
