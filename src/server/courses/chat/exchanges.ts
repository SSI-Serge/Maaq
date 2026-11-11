import { ADJUST_PREFIX } from "../menu-ia/cards";

/**
 * Identifiant de l'échange de chaque message (celui de son premier message) : une demande du profil ouvre un échange, que les messages de l'agent qui suivent complètent ; une carte « ingrédients manquants »
 * (jamais demandée par le profil) et un message de l'agent placé avant toute demande ouvrent chacun le leur.
 */
export function exchangesOf(rows: { id: string; sender: string; text: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const r of rows) {
    if (r.sender !== "agent" || current === null || r.text.startsWith(ADJUST_PREFIX)) current = r.id;
    out.set(r.id, current);
  }
  return out;
}
