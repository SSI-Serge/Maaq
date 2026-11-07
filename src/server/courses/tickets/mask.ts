/**
 * Masquage du texte d'un ticket de caisse, fait par MAAQ avant que quoi que ce soit parte vers l'agent (US-161 RF2, CR-05) : numéro de carte de fidélité ou bancaire, nom du
 * client, prénom du caissier, adresse email, téléphone. La photo elle-même n'est jamais transmise ; seul ce texte masqué l'est. Règles du ticket seulement (le masquage des
 * contrats est un autre moteur).
 */

export const MASK = "[masqué]";

const LOYALTY = /(carte|fid[ée]lit[ée]|cagnotte|client|adh[ée]rent|porteur|titulaire|membre|n°\s*compte|compte\s+n)/i;
// Une ligne de paiement garde son montant : seuls les numéros y sont masqués
const PAYMENT = /(bancaire|\bcb\b|visa|mastercard|paiement|\btotal\b|esp[èe]ces|\bsans\s+contact)/i;
// Au moins 9 chiffres d'affilée, avec des espaces ou des tirets entre les groupes (carte, code-barres, téléphone)
const LONG_DIGITS = /\d(?:[ \-.]?\d){8,}/g;
// Numéro partiellement masqué par la caisse (« **** **** 1234 », « XXXX1234 ») ou groupe de 4 chiffres ou plus sur une ligne de carte
const CARD_TAIL = /(?:[*xX•#]{2,}[ -]?)+\d{2,6}|\b\d{4,}\b/g;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const PHONE = /(?<!\d)(?:(?:\+|00)33[\s.-]?\(?0?\)?|0)[1-9](?:[\s.-]?\d{2}){4}(?!\d)/g;
const CASHIER = /(caissi[eè]re?|vendeu[sr]e?|h[ôo]tesse|op[ée]rat(?:eur|rice)|servi\s+par|conseill[eè]re?|responsable)(\s*[:.]?\s*)((?:[\p{L}'’-]+\.?)(?:\s+[\p{L}'’-]+\.?)?)/giu;
const TITLE = /\b(M\.|Mme|Mlle|Monsieur|Madame|Mademoiselle)\s+[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)?/gu;
const GREETING = /\b(Bonjour|Bonsoir|Bienvenue|Merci|Bravo|[ÀA] bient[ôo]t)(\s*,?\s+)(?!de\b|d['’]|pour\b|et\b|[àa]\b|votre\b|vos\b|la\b|le\b|les\b)([\p{Lu}][\p{Ll}'’-]{1,})/gu;

export interface MaskedTicket {
  text: string;
  /** Nombre de passages masqués. */
  masked: number;
}

export function maskTicketText(text: string): MaskedTicket {
  let masked = 0;
  const swap = (line: string, re: RegExp, replacement: string | ((...args: string[]) => string)) =>
    line.replace(re, (...args: unknown[]) => {
      masked += 1;
      return typeof replacement === "string" ? replacement : replacement(...(args as string[]));
    });

  const out = text.split(/\r?\n/).map((raw) => {
    let line = raw;
    if (LOYALTY.test(line)) {
      if (PAYMENT.test(line)) {
        line = swap(line, CARD_TAIL, (m) => (/^\d{1,2}$/.test(m) ? m : MASK));
      } else {
        masked += 1;
        return MASK;
      }
    }
    line = swap(line, EMAIL, MASK);
    line = swap(line, PHONE, MASK);
    line = swap(line, LONG_DIGITS, MASK);
    line = swap(line, CASHIER, (_all, label, sep) => `${label}${sep}${MASK}`);
    line = swap(line, TITLE, MASK);
    line = swap(line, GREETING, (_all, word, sep) => `${word}${sep}${MASK}`);
    return line;
  });
  return { text: out.join("\n"), masked };
}
