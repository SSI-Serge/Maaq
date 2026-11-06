import { has, norm, round2 } from "./text";

/** Une ligne lue sur un ticket de caisse (US-161 RF2), après correction par l'utilisateur (RF4). */
export interface TicketLine {
  product: string;
  ref?: string | null;
  /** Prix total de la ligne. */
  total: number;
  qty?: number | null;
  rayon?: string | null;
}

export interface Ticket {
  store: string;
  /** « AAAA-MM-JJ » ; une date illisible devient la date du jour (RF3). */
  date: string;
  lines: TicketLine[];
}

export interface JournalLine {
  date: string;
  store: string;
  product: string;
  total: number;
}

/** Nom de produit normalisé par l'application (CR-25) : sans accent ni majuscule, espaces simples. */
export function normalizeProductName(name: string): string {
  return norm(name).replace(/\s+/g, " ").trim();
}

/** Prix d'une unité : total de la ligne divisé par la quantité (1 par défaut), arrondi au centime. */
export function unitPrice(line: Pick<TicketLine, "total" | "qty">): number {
  const q = line.qty && line.qty > 0 ? line.qty : 1;
  return round2(line.total / q);
}

/** Même ticket déjà enregistré : même magasin, même date, même total (US-161 RT2). */
export function ticketTotal(ticket: Ticket): number {
  return round2(ticket.lines.reduce((s, l) => s + l.total, 0));
}

export function isDuplicateTicket(ticket: Ticket, known: { store: string; date: string; total: number }[]): boolean {
  const total = ticketTotal(ticket);
  return known.some((t) => norm(t.store) === norm(ticket.store) && t.date === ticket.date && round2(t.total) === total);
}

/** Un produit de la liste à acheter correspond à un produit du ticket : noms identiques ou l'un contenu dans l'autre (courses.py, cmd_ticket). */
export function listItemMatches(listName: string, ticketProduct: string): boolean {
  const nm = norm(listName);
  const tp = norm(ticketProduct);
  return !!nm && (has(nm, tp) || has(tp, nm));
}

export interface TicketOutcome {
  /** Lignes nouvelles à enregistrer au journal des achats. */
  newLines: (TicketLine & { unit: number })[];
  /** Lignes déjà connues (même produit, même total, même date, même magasin) : ignorées. */
  duplicates: number;
  /** Produits de la liste à acheter trouvés sur le ticket : à retirer de la liste. */
  removedFromList: string[];
}

/** Applique un ticket confirmé à l'état du foyer (US-161 RF5) : lignes nouvelles, doublons ignorés, produits de la liste trouvés. */
export function applyTicket(ticket: Ticket, journal: JournalLine[], listNames: string[]): TicketOutcome {
  const seen = new Set(journal.map((j) => `${j.date}|${norm(j.store)}|${norm(j.product)}|${round2(j.total)}`));
  const remaining = [...listNames];
  const out: TicketOutcome = { newLines: [], duplicates: 0, removedFromList: [] };
  for (const line of ticket.lines) {
    const key = `${ticket.date}|${norm(ticket.store)}|${norm(line.product)}|${round2(line.total)}`;
    if (seen.has(key)) {
      out.duplicates += 1;
      continue;
    }
    seen.add(key);
    out.newLines.push({ ...line, unit: unitPrice(line) });
    const idx = remaining.findIndex((n) => listItemMatches(n, line.product));
    if (idx >= 0) out.removedFromList.push(remaining.splice(idx, 1)[0]);
  }
  return out;
}
