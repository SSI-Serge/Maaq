import { env } from "@/server/env";
import { DevOutbox } from "./dev-outbox";
import { createSmtpTransport, MirroredMessenger, SmtpMessenger } from "./smtp";
import type { Messenger } from "./types";

let devInstance: DevOutbox | undefined;
let instance: Messenger | undefined;

/**
 * Messagerie de l'application, selon MESSAGING_MODE :
 *  - « dev » (par défaut) : boîte de test, rien ne part ;
 *  - « smtp » : les emails partent réellement ; les SMS restent dans la boîte de test (pas encore de fournisseur).
 * Dans une zone de test en ligne (MAAQ_ZONE=test), la boîte de test garde aussi une copie des emails.
 */
export function messenger(): Messenger {
  if (instance) return instance;
  const settings = env();
  if (settings.MESSAGING_MODE !== "smtp") {
    instance = devOutbox();
    return instance;
  }
  const smtp = new SmtpMessenger(
    createSmtpTransport({ host: settings.SMTP_HOST!, port: settings.SMTP_PORT, user: settings.SMTP_USER!, password: settings.SMTP_PASSWORD! }),
    settings.MAIL_FROM!,
    devOutbox(),
  );
  instance = process.env.MAAQ_ZONE === "test" ? new MirroredMessenger(smtp, devOutbox()) : smtp;
  return instance;
}

export function devOutbox(): DevOutbox {
  devInstance ??= new DevOutbox();
  return devInstance;
}

export type { Messenger, OutboxEntry, OutgoingEmail, OutgoingSms } from "./types";
