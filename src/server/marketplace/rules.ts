/**
 * Marketplace silencieux — seuils et constantes de la mise en relation (phase 2). Réunis ici pour qu'un
 * changement de réglage ne touche pas la logique (matching.ts). Plan : docs/specs/MAAQ_Marketplace_Silencieux_Plan.md, section 5.
 */

/** Vitrines éligibles transmises au modèle pour le score de pertinence, au plus. */
export const MAX_CANDIDATES = 10;

/** Suggestions montrées à l'acheteur pour une demande, au plus (section 6, étape 2). */
export const MAX_SHOWN = 3;

/** En dessous de ce score, la vitrine est retenue par l'opérateur mais pas montrée. */
export const SCORE_LOW = 0.4;

/** À partir de ce score, la suggestion est affirmée ; entre SCORE_LOW et ce seuil, elle est posée en question. */
export const SCORE_STRONG = 0.7;

/** Jours pendant lesquels une vitrine écartée (ou une mise en relation refusée / expirée) n'est pas reproposée. */
export const COOLDOWN_DAYS = 90;

/** Version du texte de consentement aux suggestions proactives, enregistrée avec l'accord (marketplace_prefs.consent_version). */
export const CONSENT_VERSION = "2026-10";

/** Texte du consentement, affiché sur Réglages › Suggestions de services et enregistré avec sa version. */
export const CONSENT_TEXT =
  "J'accepte que MAAQ me propose, dans le tchat de coup_de_main, des vitrines de membres qui offrent un service correspondant à un besoin que j'ai exprimé. Rien n'est transmis à un fournisseur sans ma validation explicite, et je peux arrêter ces suggestions à tout moment.";

export function isStrong(score: number): boolean {
  return score >= SCORE_STRONG;
}

export function isWithheld(score: number): boolean {
  return score < SCORE_LOW;
}
