"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, apiRequest, newIdempotencyKey, type ApiRequestOptions } from "./api";

/** État de la connexion de l'appareil (CC-4). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener("online", notify);
      window.addEventListener("offline", notify);
      return () => {
        window.removeEventListener("online", notify);
        window.removeEventListener("offline", notify);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

export interface QueryState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  slow: boolean;
  reload: () => void;
}

/**
 * Lecture d'une ressource : indicateur de chargement (CC-1), message d'attente longue (CC-6),
 * erreurs (CC-2, CC-3) et rechargement automatique au retour de la connexion (CC-9).
 */
export function useApiQuery<T>(path: string | null): QueryState<T> {
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  // Chaque chargement a sa clé : l'état « en cours » se déduit de l'absence de résultat pour cette clé.
  const requestKey = path === null ? null : `${path}#${version}`;
  const [result, setResult] = useState<{ key: string; data?: T; error?: ApiError }>();
  const [slowKey, setSlowKey] = useState<string | null>(null);

  useEffect(() => {
    if (path === null || requestKey === null) return;
    const controller = new AbortController();
    apiRequest<T>(path, { signal: controller.signal, onSlow: () => setSlowKey(requestKey) })
      .then((data) => setResult({ key: requestKey, data }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const error = err instanceof ApiError ? err : new ApiError("server", String(err));
        // Les données déjà affichées restent visibles sous le message d'erreur.
        setResult((previous) => ({ key: requestKey, data: previous?.data, error }));
      });
    return () => controller.abort();
  }, [path, requestKey]);

  useEffect(() => {
    window.addEventListener("online", reload);
    return () => window.removeEventListener("online", reload);
  }, [reload]);

  const loading = requestKey !== null && result?.key !== requestKey;
  return {
    data: result?.data,
    error: result?.key === requestKey ? result.error : undefined,
    loading,
    slow: loading && slowKey === requestKey,
    reload,
  };
}

export interface ActionState<TInput, TResult> {
  run: (input: TInput) => Promise<TResult | undefined>;
  pending: boolean;
  slow: boolean;
  error: ApiError | undefined;
  reset: () => void;
}

/**
 * Enregistrement (ajout, modification, suppression). Le bouton est désactivé pendant l'envoi (CC-1).
 * La même clé d'idempotence est réutilisée tant que l'action n'a pas réussi : un double toucher
 * ou un « Réessayer » ne l'exécute jamais deux fois (CC-7).
 */
export function useApiAction<TInput, TResult>(
  path: string,
  method: NonNullable<ApiRequestOptions["method"]> = "POST",
): ActionState<TInput, TResult> {
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<ApiError>();
  const keyRef = useRef<string | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (input: TInput) => {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      keyRef.current ??= newIdempotencyKey();
      setPending(true);
      setSlow(false);
      setError(undefined);
      try {
        const result = await apiRequest<TResult>(path, {
          method,
          body: input,
          idempotencyKey: keyRef.current,
          onSlow: () => setSlow(true),
        });
        keyRef.current = null;
        return result;
      } catch (err) {
        const apiError = err instanceof ApiError ? err : new ApiError("server", String(err));
        if (apiError.kind === "rejected") keyRef.current = null; // refus métier : la prochaine tentative est une nouvelle action
        setError(apiError);
        return undefined;
      } finally {
        inFlight.current = false;
        setPending(false);
        setSlow(false);
      }
    },
    [path, method],
  );

  const reset = useCallback(() => {
    keyRef.current = null;
    setError(undefined);
  }, []);

  return { run, pending, slow, error, reset };
}

/** Valeur stabilisée après une pause de saisie (recherche au fil de la frappe). */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export interface MutationState {
  run: <TResult>(path: string, options: { method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }) => Promise<TResult | undefined>;
  pending: boolean;
  slow: boolean;
  error: ApiError | undefined;
  reset: () => void;
}

/**
 * Comme useApiAction, pour des actions dont l'adresse varie (bloquer tel agent, retirer tel contrat).
 * La clé d'idempotence est conservée tant que la même action est retentée (CC-7).
 */
export function useApiMutation(): MutationState {
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<ApiError>();
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async <TResult,>(path: string, options: { method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }) => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    const signature = `${options.method} ${path} ${JSON.stringify(options.body ?? null)}`;
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: newIdempotencyKey() };
    setPending(true);
    setSlow(false);
    setError(undefined);
    try {
      const result = await apiRequest<TResult>(path, {
        method: options.method,
        body: options.body,
        idempotencyKey: attempt.current.key,
        onSlow: () => setSlow(true),
      });
      attempt.current = null;
      return result;
    } catch (err) {
      const apiError = err instanceof ApiError ? err : new ApiError("server", String(err));
      if (apiError.kind === "rejected") attempt.current = null;
      setError(apiError);
      return undefined;
    } finally {
      inFlight.current = false;
      setPending(false);
      setSlow(false);
    }
  }, []);

  const reset = useCallback(() => {
    attempt.current = null;
    setError(undefined);
  }, []);

  return { run, pending, slow, error, reset };
}

const DRAFT_PREFIX = "maaq:draft:";

/**
 * Saisie préservée (CC-8) : le texte non envoyé survit au verrouillage, à une coupure réseau
 * ou à la fermeture de l'application, jusqu'à son envoi (clear) ou la déconnexion (clearAllDrafts).
 */
export function useDraft(key: string): [string, (value: string) => void, () => void] {
  const storageKey = DRAFT_PREFIX + key;
  const value = useSyncExternalStore(
    subscribeDrafts,
    () => draftMemory.get(storageKey) ?? readStorage(storageKey) ?? "",
    () => "",
  );

  const update = useCallback(
    (next: string) => {
      draftMemory.set(storageKey, next);
      writeStorage(storageKey, next || null);
      notifyDrafts();
    },
    [storageKey],
  );
  const clear = useCallback(() => update(""), [update]);
  return [value, update, clear];
}

/** À appeler à la déconnexion (CC-8 : les brouillons sont effacés). */
export function clearAllDrafts(): void {
  draftMemory.clear();
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(DRAFT_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // stockage indisponible (navigation privée) : rien à effacer
  }
  notifyDrafts();
}

// Copie en mémoire : la saisie fonctionne même si le stockage de l'appareil est indisponible.
const draftMemory = new Map<string, string>();
const draftListeners = new Set<() => void>();

function subscribeDrafts(listener: () => void): () => void {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
}

function notifyDrafts(): void {
  for (const listener of draftListeners) listener();
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // stockage indisponible : la saisie reste en mémoire pour cette session
  }
}
