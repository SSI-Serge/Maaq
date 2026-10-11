import { messenger } from "@/server/adapters/messaging";
import { DEVICE_LABEL, formatDateTime, type DeviceKind } from "./format";

/** Emails et SMS des parcours de connexion. Les heures sont dans le fuseau de l'appareil (D21). */

const SIGNATURE = "\n\nL'équipe MAAQ";

export async function sendCode(params: {
  channel: "email" | "sms";
  to: string;
  firstName: string;
  code: string;
  ttlMinutes: number;
  reason: "device" | "recovery" | "password";
}): Promise<void> {
  const purpose = {
    device: "confirmer votre identité sur un nouvel appareil",
    recovery: "recréer votre schéma tactile",
    password: "réinitialiser votre mot de passe",
  }[params.reason];

  if (params.channel === "sms") {
    await messenger().sendSms({
      to: params.to,
      text: `MAAQ : votre code pour ${purpose} est ${params.code}. Il est valable ${params.ttlMinutes} minutes.`,
    });
    return;
  }
  await messenger().sendEmail({
    to: params.to,
    subject: `Votre code MAAQ : ${params.code}`,
    text:
      `Bonjour ${params.firstName},\n\n` +
      `Voici votre code pour ${purpose} : ${params.code}\n\n` +
      `Il est valable ${params.ttlMinutes} minutes et ne peut servir qu'une fois. ` +
      `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre compte reste protégé.` +
      SIGNATURE,
  });
}

export async function sendNewDeviceAlert(to: string, firstName: string, device: DeviceKind, at: Date, timeZone: string) {
  await messenger().sendEmail({
    to,
    subject: "Nouvel appareil connecté à votre compte",
    text:
      `Bonjour ${firstName},\n\n` +
      `Un nouvel appareil (${DEVICE_LABEL[device]}) a été connecté à votre compte MAAQ le ${formatDateTime(at, timeZone)}.\n\n` +
      `Si ce n'est pas vous, révoquez cet appareil depuis les Réglages et changez votre mot de passe.` +
      SIGNATURE,
  });
}

export async function sendPatternLockedAlert(to: string, firstName: string, device: DeviceKind, at: Date, timeZone: string) {
  await messenger().sendEmail({
    to,
    subject: "Accès par schéma tactile verrouillé",
    text:
      `Bonjour ${firstName},\n\n` +
      `Après 3 schémas incorrects, l'accès par schéma tactile a été verrouillé sur votre ${DEVICE_LABEL[device]} ` +
      `le ${formatDateTime(at, timeZone)}.\n\n` +
      `Pour le rétablir, utilisez « Récupérer mon accès » dans l'application. ` +
      `Si ce n'est pas vous, changez votre mot de passe.` +
      SIGNATURE,
  });
}

export async function sendPatternChangedConfirmation(to: string, firstName: string, at: Date, timeZone: string) {
  await messenger().sendEmail({
    to,
    subject: "Votre schéma tactile a été modifié",
    text:
      `Bonjour ${firstName},\n\n` +
      `Votre schéma tactile a été redéfini le ${formatDateTime(at, timeZone)}.\n\n` +
      `Si ce n'est pas vous, changez votre mot de passe sans attendre.` +
      SIGNATURE,
  });
}

export async function sendPasswordChangedConfirmation(to: string, firstName: string, at: Date, timeZone: string) {
  await messenger().sendEmail({
    to,
    subject: "Votre mot de passe a été modifié",
    text:
      `Bonjour ${firstName},\n\n` +
      `Votre mot de passe MAAQ a été modifié le ${formatDateTime(at, timeZone)}. ` +
      `Vos sessions ouvertes sur vos autres appareils ont été fermées.\n\n` +
      `Si ce n'est pas vous, contactez le support MAAQ sans attendre.` +
      SIGNATURE,
  });
}
