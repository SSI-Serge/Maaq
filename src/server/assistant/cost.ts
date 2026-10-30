/**
 * Coût estimé d'un appel au modèle, pour les journaux d'exploitation (chiffres seulement, jamais de contenu) : de quoi connaître le coût réel d'une demande et d'un foyer pendant le pilote.
 * C'est une estimation : la facture de l'API Anthropic fait foi.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** Recherches web du fournisseur, facturées à part. */
  webSearches?: number;
}

/** Dollars par million de jetons (tarifs publics au 06/10/2026). Un modèle absent de la liste n'a pas de coût estimé (`null`) plutôt qu'un coût faux. */
const RATES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
};

/** Écrire dans le cache (durée de 5 minutes) coûte 1,25 fois le prix d'entrée : règle générale du fournisseur, pas un tarif propre à chaque modèle. */
const CACHE_WRITE_FACTOR = 1.25;

/** Une recherche web du fournisseur coûte 10 dollars les 1 000 recherches, en plus des jetons. */
export const WEB_SEARCH_USD = 0.01;

/** Coût en dollars, arrondi au millionième ; `null` si le modèle n'est pas dans la liste des tarifs. */
export function estimateCostUsd(model: string | undefined, usage: TokenUsage): number | null {
  const rate = model ? RATES[model] : undefined;
  if (!rate) return null;
  const dollars = (usage.inputTokens * rate.input + usage.outputTokens * rate.output + usage.cacheRead * rate.cacheRead + usage.cacheWrite * rate.input * CACHE_WRITE_FACTOR) / 1_000_000 + (usage.webSearches ?? 0) * WEB_SEARCH_USD;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
