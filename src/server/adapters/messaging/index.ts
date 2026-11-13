import { env } from "@/server/env";
import { DevOutbox } from "./dev-outbox";
import { createSmtpTransport, InternalOnlyOutbox, internalRecipients, MirroredMessenger, SmtpMessenger } from "./smtp";
import type { Messenger } from "./types";

let devInstance: DevOutbox | undefined;
let instance: Messenger | undefined;

/**
 * Messagerie de l'application, selon MESSAGING_MODE :
 *  - « dev » (par défaut) : boîte de test, rien ne part ;
 *  - « smtp » : les emails partent réellement ; les SMS restent dans la boîte de test (pas encore de fournisseur).
 * Dans une zone de test en ligne (MAAQ_ZONE=test), la boîte de test garde aussi une copie des emails, mais seulement de ceux adressés aux comptes internes
 * (DEV_OUTBOX_ALLOW : adresses et numéros séparés par des virgules). Sans cette liste, rien n'est copié : les messages des testeurs extérieurs n'y entrent jamais.
 */
export function messenger(): Messenger {
  if (instance) return instance;
  const settings = env();
  if (settings.MESSAGING_MODE !== "smtp") {
    instance = devOutbox();
    return instance;
  }
  // Les SMS n'ont pas de fournisseur : ils ne sont gardés (boîte de test) que pour les comptes internes.
  const box = new InternalOnlyOutbox(devOutbox(), internalRecipients(process.env.DEV_OUTBOX_ALLOW));
  const smtp = new SmtpMessenger(
    createSmtpTransport({ host: settings.SMTP_HOST!, port: settings.SMTP_PORT, user: settings.SMTP_USER!, password: settings.SMTP_PASSWORD! }),
    settings.MAIL_FROM!,
    box,
  );
  instance = process.env.MAAQ_ZONE === "test" ? new MirroredMessenger(smtp, box) : smtp;
  return instance;
}

export function devOutbox(): DevOutbox {
  devInstance ??= new DevOutbox();
  return devInstance;
}

export type { Messenger, OutboxEntry, OutgoingEmail, OutgoingSms } from "./types";
