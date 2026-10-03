import type { Kysely } from "kysely";
import { messenger, type Messenger } from "@/server/adapters/messaging";
import { activationUrl, ACTIVATION_TTL_MINUTES } from "@/server/accounts/activation";
import type { DB } from "@/server/db/schema.generated";

/** 1 envoi + 3 nouvelles tentatives automatiques avant « Échec d'envoi » (US-18 RF12). */
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

export interface InvitationContent {
  token: string;
  guestFirstName: string;
  hostFirstName: string;
  hostLastName: string;
  email: string;
  phone: string | null;
}

/** Texte de l'invitation : qui invite, MAAQ en une phrase, lien personnel valable 30 minutes (US-4 RF2). */
export function invitationMessages(content: InvitationContent) {
  const host = `${content.hostFirstName} ${content.hostLastName}`;
  const url = activationUrl(content.token);
  return {
    email: {
      to: content.email,
      subject: `${host} vous invite sur MAAQ`,
      text:
        `Bonjour ${content.guestFirstName},\n\n` +
        `${host} vous invite à rejoindre MAAQ, l'application d'agents IA qui s'occupent de l'administratif et du quotidien, en toute transparence.\n\n` +
        `Pour activer votre accès, ouvrez ce lien personnel :\n\n${url}\n\n` +
        `Il est valable ${ACTIVATION_TTL_MINUTES} minutes et ne peut servir qu'une fois. ` +
        `Passé ce délai, demandez à ${content.hostFirstName} de vous renvoyer une invitation.\n\nL'équipe MAAQ`,
    },
    sms: content.phone
      ? {
          to: content.phone,
          text: `${host} vous invite sur MAAQ. Activez votre accès (lien valable ${ACTIVATION_TTL_MINUTES} min) : ${url}`,
        }
      : null,
  };
}

/**
 * Envoie l'invitation par email, et par SMS si un numéro est connu (US-4 RF1). Traitement en
 * arrière-plan (CC-10) : le statut passe de « Envoi en cours » à « Invitation envoyée », ou à
 * « Échec d'envoi » après 3 nouvelles tentatives (US-18 RF7, RF12).
 */
export async function deliverInvitation(
  db: Kysely<DB>,
  linkId: string,
  content: InvitationContent,
  options: { sender?: Messenger; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
): Promise<"sent" | "failed"> {
  const sender = options.sender ?? messenger();
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const messages = invitationMessages(content);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await sender.sendEmail(messages.email);
      if (messages.sms) await sender.sendSms(messages.sms);
      await db
        .updateTable("activation_links")
        .set({ delivery_status: "sent", delivery_attempts: attempt, sent_at: now() })
        .where("id", "=", linkId)
        .execute();
      return "sent";
    } catch {
      await db.updateTable("activation_links").set({ delivery_attempts: attempt }).where("id", "=", linkId).execute();
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  await db.updateTable("activation_links").set({ delivery_status: "failed" }).where("id", "=", linkId).execute();
  return "failed";
}
