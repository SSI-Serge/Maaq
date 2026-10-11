/**
 * Erreur renvoyée par Digitorn, avec ce que son API indique : code, si l'appel peut être réessayé et dans combien de
 * temps, identifiant de suivi à donner au support. `status` vaut 0 quand Digitorn n'a pas répondu du tout.
 */
export class DigitornError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null = null,
    readonly traceId: string | null = null,
  ) {
    super(message);
    this.name = "DigitornError";
  }
}
