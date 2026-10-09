import type { ActionProposal } from "@/server/adapters/digitorn/types";
import type { OutboundButton, OutboundMessage } from "@/server/adapters/whatsapp/types";

/**
 * Rendu d'une réponse d'agent pour WhatsApp : texte brut au format WhatsApp (gras *…*), 4 096 caractères au
 * plus par message, 3 boutons au plus de 20 caractères.
 */

export const WHATSAPP_TEXT_MAX = 4096;
export const WHATSAPP_BUTTONS_MAX = 3;
export const WHATSAPP_BUTTON_TITLE_MAX = 20;

/** Markdown léger → mise en forme WhatsApp ; pas de titre ni de tableau. */
export function toWhatsAppText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-•]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Découpe un texte trop long sur des sauts de ligne, sans dépasser la limite. */
export function splitText(text: string, max = WHATSAPP_TEXT_MAX): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function clampButtons(buttons: OutboundButton[]): OutboundButton[] {
  return buttons.slice(0, WHATSAPP_BUTTONS_MAX).map((b) => ({ id: b.id.slice(0, 256), title: b.title.length > WHATSAPP_BUTTON_TITLE_MAX ? `${b.title.slice(0, WHATSAPP_BUTTON_TITLE_MAX - 1)}…` : b.title }));
}

/** Charge utile des boutons de décision d'une carte d'action : « decide:<id>:validate|refuse ». */
export function decisionButtons(proposal: ActionProposal): OutboundButton[] {
  return [
    { id: `decide:${proposal.proposalId}:validate`, title: proposal.kind === "email" ? "Valider l'envoi" : "Valider" },
    { id: `decide:${proposal.proposalId}:refuse`, title: "Refuser" },
  ];
}

export function parseDecisionButton(id: string): { proposalId: string; decision: "validate" | "refuse" } | null {
  const match = /^decide:([^:]+):(validate|refuse)$/.exec(id);
  return match ? { proposalId: match[1], decision: match[2] as "validate" | "refuse" } : null;
}

export function describeProposal(proposal: ActionProposal): string {
  const lines = [`*Action proposée — validation requise*`, proposal.summary];
  if (proposal.when) lines.push(`Quand : ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(proposal.when))}`);
  if (proposal.place) lines.push(`Lieu : ${proposal.place}`);
  if (proposal.recipient) lines.push(`Destinataire : ${proposal.recipient}`);
  if (proposal.subject) lines.push(`Objet : ${proposal.subject}`);
  return lines.join("\n");
}

/**
 * Messages WhatsApp à envoyer pour une réponse d'agent : le texte (découpé au besoin), puis une carte à
 * boutons par action à valider.
 */
export function renderAgentReply(to: string, text: string, proposals: ActionProposal[]): OutboundMessage[] {
  const messages: OutboundMessage[] = splitText(toWhatsAppText(text)).map((part) => ({ kind: "text", to, text: part }));
  for (const proposal of proposals) {
    messages.push({ kind: "buttons", to, text: toWhatsAppText(describeProposal(proposal)).slice(0, 1024), buttons: clampButtons(decisionButtons(proposal)) });
  }
  return messages;
}
