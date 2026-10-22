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

/** Agenda (phase 2b) : fenêtre d'examen des événements à venir, en jours. */
export const AGENDA_LOOKAHEAD_DAYS = 14;

/** Confiance minimale de la classification d'un titre d'agenda en besoin de service ; en dessous, rien ne se passe. */
export const AGENDA_MIN_CONFIDENCE = 0.6;

/** Version du texte de consentement à la lecture de l'agenda, distinct de celui des suggestions. */
export const AGENDA_CONSENT_VERSION = "2026-10";

export const AGENDA_CONSENT_TEXT =
  "J'autorise MAAQ à lire les titres et dates de mes événements d'agenda à venir pour repérer un besoin de service (par exemple « coiffeur pour les enfants ») et me demander, dans le tchat de coup_de_main, si je souhaite qu'il cherche quelqu'un. Les titres ne sont ni conservés ni transmis à un fournisseur ou à un annuaire, et je peux retirer cette autorisation à tout moment.";

/** Annuaire externe (phase 2c) : résultats montrés au plus, en complément des vitrines de membres. */
export const MAX_EXTERNAL = 3;

/** Mise en relation (phase 3) : sans réponse du fournisseur après ce délai, elle expire et l'acheteur est prévenu. */
export const INTRODUCTION_EXPIRY_DAYS = 7;
