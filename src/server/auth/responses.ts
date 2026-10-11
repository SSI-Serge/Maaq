import { Rejection } from "@/server/http";
import type { CheckResult } from "./codes";
import { MESSAGES } from "./rules";
import type { SendCodeResult } from "./service";

/** Refus affiché pour un code non accepté (US-8 RF6-RF7, US-51 RF4-RF5, US-66 RF5). */
export function codeRejection(result: Exclude<CheckResult, "ok">): Rejection {
  switch (result) {
    case "incorrect":
      return new Rejection("code_incorrect", MESSAGES.codeIncorrect);
    case "expired":
      return new Rejection("code_expired", MESSAGES.codeExpired);
    case "invalidated":
      return new Rejection("code_invalidated", MESSAGES.codeInvalidated);
    case "missing":
      return new Rejection("code_missing", MESSAGES.codeMissing);
  }
}

/** Refus d'un envoi de code trop rapproché ou trop fréquent (US-8 RF8, US-51 RF6). */
export function sendRejection(result: Exclude<SendCodeResult, { kind: "sent" }>): Rejection {
  switch (result.kind) {
    case "cooldown":
      return new Rejection("code_cooldown", "Patientez avant de demander un nouveau code.", 429, { retryAt: result.retryAt.toISOString() });
    case "rate_limited":
      return new Rejection("code_rate_limited", "Trop de codes demandés. Réessayez dans une heure.", 429, {
        retryAt: result.retryAt.toISOString(),
      });
    case "no_phone":
      return new Rejection("no_phone", "Aucun numéro de téléphone n'est connu pour ce profil.", 422);
    case "unknown":
      return new Rejection("verification_expired", "La vérification a expiré. Reconnectez-vous.", 401);
  }
}

export function lockedRejection(until: Date): Rejection {
  return new Rejection("login_locked", "Trop de tentatives.", 423, { until: until.toISOString() });
}
