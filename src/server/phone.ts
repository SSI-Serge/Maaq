/**
 * Normalise un numéro de téléphone au format international E.164 attendu par la base
 * (« 06 12 34 56 78 » → « +33612345678 »). Renvoie null si le numéro n'est pas valide.
 */
export function normalizePhone(input: string): string | null {
  const compact = input.replace(/[\s.\-()]/g, "");
  if (/^0[1-9]\d{8}$/.test(compact)) return `+33${compact.slice(1)}`;
  if (/^0033[1-9]\d{8}$/.test(compact)) return `+${compact.slice(2)}`;
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  return null;
}
