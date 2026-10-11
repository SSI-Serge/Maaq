/** Message sortant (email ou SMS). Le contenu est en texte brut. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

export interface OutgoingSms {
  to: string;
  text: string;
}

export interface Messenger {
  sendEmail(message: OutgoingEmail): Promise<void>;
  sendSms(message: OutgoingSms): Promise<void>;
}

export interface OutboxEntry {
  id: string;
  channel: "email" | "sms";
  to: string;
  subject?: string;
  text: string;
  sentAt: string;
}
