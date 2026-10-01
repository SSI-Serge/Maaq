/**
 * Client réseau commun à tous les écrans. Il applique une seule fois les comportements
 * communs des user stories, au lieu de les répéter écran par écran :
 *  - CC-3 : délai maximal de 15 s avant le message « connexion lente » ;
 *  - CC-5 : deux nouvelles tentatives silencieuses (≈ 1 s puis 3 s) pour les lectures ;
 *  - CC-6 : signal « Toujours en cours… » au-delà de 5 s ;
 *  - CC-7 : clé d'idempotence sur les enregistrements, qui seuls peuvent alors être renvoyés.
 */

export const MESSAGES = {
  server: "Le service est momentanément indisponible. Veuillez réessayer dans quelques instants.",
  timeout: "La connexion semble lente. Veuillez réessayer.",
  offline: "Pas de connexion internet — MAAQ nécessite une connexion pour fonctionner",
  slow: "Toujours en cours…",
} as const;

export const TOTAL_TIMEOUT_MS = 15_000;
export const SLOW_AFTER_MS = 5_000;
export const RETRY_DELAYS_MS = [1_000, 3_000] as const;

export type ApiErrorKind = "server" | "timeout" | "offline" | "rejected";

/** Erreur métier renvoyée par le serveur (4xx) : { error: { code, message } }. */
export interface RejectedBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    readonly body?: RejectedBody,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Erreur liée au réseau ou au serveur, pour laquelle « Réessayer » a du sens. */
  get retryable(): boolean {
    return this.kind !== "rejected";
  }
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Clé d'idempotence (CC-7). Obligatoire pour qu'un enregistrement puisse être renvoyé automatiquement. */
  idempotencyKey?: string;
  /** Appelé une fois si l'opération dépasse 5 s (CC-6). */
  onSlow?: () => void;
  signal?: AbortSignal;
  /** Remplaçables dans les tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  isOnline?: () => boolean;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Seul un « false » explicite signifie hors connexion (Node expose un navigator sans onLine).
const defaultIsOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const isOnline = options.isOnline ?? defaultIsOnline;
  const timeoutMs = options.timeoutMs ?? TOTAL_TIMEOUT_MS;

  if (!isOnline()) throw new ApiError("offline", MESSAGES.offline);

  // Seules les lectures, et les écritures protégées contre la double exécution, sont rejouées (CC-5, CC-7).
  const canRetry = method === "GET" || Boolean(options.idempotencyKey);
  const maxAttempts = canRetry ? RETRY_DELAYS_MS.length + 1 : 1;

  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), timeoutMs);
  const slowTimer = options.onSlow ? setTimeout(options.onSlow, SLOW_AFTER_MS) : undefined;
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  try {
    let lastError: ApiError = new ApiError("server", MESSAGES.server);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        if (deadline.signal.aborted) break;
      }
      try {
        const response = await fetchImpl(path, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal,
          credentials: "same-origin",
        });
        if (response.ok) {
          // 204 : null (et non undefined), pour distinguer un succès sans contenu d'un échec.
          return (response.status === 204 ? null : await response.json()) as T;
        }
        if (response.status >= 400 && response.status < 500) {
          const payload = (await response.json().catch(() => null)) as { error?: RejectedBody } | null;
          const body = payload?.error ?? { code: "rejected", message: MESSAGES.server };
          notifySessionChange(body.code);
          throw new ApiError("rejected", body.message, response.status, body);
        }
        lastError = new ApiError("server", MESSAGES.server, response.status);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (options.signal?.aborted) throw error;
        if (deadline.signal.aborted) break;
        if (!isOnline()) throw new ApiError("offline", MESSAGES.offline);
        lastError = new ApiError("server", MESSAGES.server);
      }
    }
    if (deadline.signal.aborted) throw new ApiError("timeout", MESSAGES.timeout);
    throw lastError;
  } finally {
    clearTimeout(deadlineTimer);
    if (slowTimer) clearTimeout(slowTimer);
  }
}

/** Événements écoutés par la garde de session : application verrouillée ou session expirée. */
export const SESSION_EVENTS = { locked: "maaq:locked", signedOut: "maaq:signed-out", accessRemoved: "maaq:access-removed" } as const;

function notifySessionChange(code: string): void {
  if (typeof window === "undefined") return;
  if (code === "locked") window.dispatchEvent(new Event(SESSION_EVENTS.locked));
  if (code === "unauthenticated") window.dispatchEvent(new Event(SESSION_EVENTS.signedOut));
  if (code === "access_removed") window.dispatchEvent(new Event(SESSION_EVENTS.accessRemoved));
}

/** Nouvelle clé d'idempotence, à conserver pendant tous les « Réessayer » d'une même action. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
