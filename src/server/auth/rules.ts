/** Règles de sécurité du lot « Accès et sécurité », reprises des user stories. */

/** US-3 RF4 : 5 échecs consécutifs bloquent la connexion par mot de passe pendant 15 minutes. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MINUTES = 15;

/** US-6 RF8, US-7 : 3 échecs consécutifs verrouillent le schéma sur l'appareil. */
export const PATTERN_MAX_FAILURES = 3;
/** US-6 RF2 : grille 3 × 3, au moins 4 points reliés. */
export const PATTERN_MIN_POINTS = 4;

/** US-6 RT3 : la session mémorisée dure 3 mois au maximum. */
export const SESSION_MONTHS = 3;

/** US-52 : verrouillage après 5 minutes sans interaction. */
export const IDLE_LOCK_MINUTES = 5;

/** Durée laissée pour terminer une vérification d'appareil ou un parcours de récupération. */
export const PENDING_FLOW_MINUTES = 30;

export type CodePurpose = "device_verification" | "access_recovery" | "password_reset" | "validation_mailbox";

/** Codes à 6 chiffres : durée de validité selon l'usage (US-51 RF2, US-8 RF4, US-66 RF4). */
export const CODE_TTL_MINUTES: Record<CodePurpose, number> = {
  device_verification: 10,
  access_recovery: 30,
  password_reset: 30,
  // La spec ne fixe pas cette durée : même valeur que les codes de récupération.
  validation_mailbox: 30,
};

/** 5 codes incorrects invalident le code (US-8 RF6, US-51 RF4, US-66 RF5). */
export const CODE_MAX_ATTEMPTS = 5;
/** Nouveau code possible 60 s après le précédent, 5 envois par heure au maximum (US-8 RF8). */
export const CODE_RESEND_SECONDS = 60;
export const CODE_MAX_PER_HOUR = 5;

export const MESSAGES = {
  invalidEmail: "Adresse email invalide",
  invalidCredentials: "Email ou mot de passe incorrect",
  neutralCodeSent: "Si un compte existe pour cette adresse, un code vient de vous être envoyé par email.",
  codeIncorrect: "Code incorrect",
  codeExpired: "Ce code a expiré",
  codeInvalidated: "Code incorrect. Ce code n'est plus valable : demandez un nouveau code.",
  codeMissing: "Aucun code valable : demandez un nouveau code.",
  patternTooShort: "Reliez au moins 4 points",
  patternMismatch: "Les deux schémas ne correspondent pas. Recommencez.",
  passwordWeak: "Le mot de passe doit comporter au moins 10 caractères, dont une lettre et un chiffre.",
  passwordMismatch: "Les deux mots de passe ne correspondent pas.",
} as const;

export function patternRemainingMessage(remaining: number): string {
  return `Schéma incorrect. Il vous reste ${remaining} tentative${remaining > 1 ? "s" : ""}.`;
}
