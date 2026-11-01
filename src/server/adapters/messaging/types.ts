/** Message sortant (email ou SMS). Le contenu est en texte brut. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  /** Pièces jointes (challenge des contrats, C-03). La boîte de test n'en garde que le nom et la taille : jamais le contenu. */
  attachments?: { filename: string; content: Buffer; contentType: string }[];
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
