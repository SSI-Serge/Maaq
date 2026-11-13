import nodemailer from "nodemailer";
import type { Messenger, OutgoingEmail, OutgoingSms } from "./types";

/** Ce dont l'envoi a besoin du transport : permet de le remplacer dans les tests. */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; attachments?: OutgoingEmail["attachments"] }): Promise<unknown>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  password: string;
}

/**
 * Transport SMTP réel (Brevo, IONOS, Mailjet…). Le port 587 démarre en clair puis passe en chiffré (STARTTLS) ;
 * le port 465 est chiffré d'emblée. Les délais évitent qu'un serveur muet bloque une demande de l'utilisateur.
 */
export function createSmtpTransport(settings: SmtpSettings): MailTransport {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/**
 * Messagerie réelle pour les emails. Les SMS n'ont pas encore de fournisseur : ils restent confiés à `smsFallback`
 * (la boîte de test), et les codes de vérification passent donc par l'email.
 */
export class SmtpMessenger implements Messenger {
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
    private readonly smsFallback: Messenger,
  ) {}

  async sendEmail(message: OutgoingEmail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text, attachments: message.attachments });
  }

  sendSms(message: OutgoingSms): Promise<void> {
    return this.smsFallback.sendSms(message);
  }
}

/** Adresses et numéros des comptes internes, depuis une liste séparée par des virgules ou des espaces (DEV_OUTBOX_ALLOW). Vide : personne. */
export function internalRecipients(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean));
}

/**
 * Boîte de test d'une zone ouverte à des testeurs extérieurs : elle ne garde que les messages adressés aux comptes internes. Les emails et les SMS des autres profils
 * (liens d'activation, codes de connexion) n'y sont jamais écrits : détenir la clé des outils de test ne donne pas accès à leurs comptes.
 */
export class InternalOnlyOutbox implements Messenger {
  constructor(
    private readonly inner: Messenger,
    private readonly allowed: Set<string>,
  ) {}

  private internal(to: string): boolean {
    return this.allowed.has(to.trim().toLowerCase());
  }

  async sendEmail(message: OutgoingEmail): Promise<void> {
    if (this.internal(message.to)) await this.inner.sendEmail(message);
  }

  async sendSms(message: OutgoingSms): Promise<void> {
    if (this.internal(message.to)) await this.inner.sendSms(message);
  }
}

/**
 * Zone de test : chaque email part réellement, et une copie est aussi déposée dans la boîte de test (/dev/boite),
 * pour lire un code sans ouvrir sa messagerie. La copie ne fait jamais échouer l'envoi.
 */
export class MirroredMessenger implements Messenger {
  constructor(
    private readonly primary: Messenger,
    private readonly copy: Messenger,
  ) {}

  async sendEmail(message: OutgoingEmail): Promise<void> {
    await this.copy.sendEmail(message).catch((error) => console.error("Copie dans la boîte de test impossible :", error));
    await this.primary.sendEmail(message);
  }

  sendSms(message: OutgoingSms): Promise<void> {
    return this.primary.sendSms(message);
  }
}
