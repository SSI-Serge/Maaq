import { ApiError, MESSAGES, notifySessionChange, type RejectedBody } from "./api";

/**
 * Envoi d'une demande dont la réponse arrive en flux de lignes JSON (menu au fil de l'eau) : des lignes `progress`, puis `done` avec le résultat, ou `error`. Une même demande n'est pas
 * rejouée automatiquement : l'identifiant de demande du serveur évite le double traitement, et « Réessayer » la renvoie à la main.
 */

export interface StreamOptions<P> {
  onProgress?: (progress: P) => void;
  timeoutMs?: number;
  onSlow?: () => void;
  fetchImpl?: typeof fetch;
}

type Line<R, P> = { type: "progress"; progress: P } | { type: "done"; result: R } | { type: "error"; error: RejectedBody & { status?: number } };

/** Sépare un tampon en lignes complètes ; le reste (ligne coupée) est rendu pour le prochain morceau. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((l) => l.trim()).filter(Boolean), rest };
}

export async function postStream<R, P = unknown>(path: string, body: unknown, options: StreamOptions<P> = {}): Promise<R> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new ApiError("offline", MESSAGES.offline);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 110_000);
  const slow = options.onSlow ? setTimeout(options.onSlow, 5_000) : undefined;
  try {
    let response: Response;
    try {
      response = await fetchImpl(path, { method: "POST", headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal, credentials: "same-origin" });
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError("timeout", MESSAGES.timeout);
      throw error instanceof ApiError ? error : new ApiError("server", MESSAGES.server);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: RejectedBody } | null;
      if (response.status >= 400 && response.status < 500) {
        const err = payload?.error ?? { code: "rejected", message: MESSAGES.server };
        notifySessionChange(err.code);
        throw new ApiError("rejected", err.message, response.status, err);
      }
      throw new ApiError("server", MESSAGES.server, response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError("server", MESSAGES.server);
    const decoder = new TextDecoder();
    let buffer = "";
    let result: R | undefined;
    let finished = false;
    const handle = (raw: string) => {
      let line: Line<R, P>;
      try {
        line = JSON.parse(raw) as Line<R, P>;
      } catch {
        return;
      }
      if (line.type === "progress") options.onProgress?.(line.progress);
      else if (line.type === "done") {
        result = line.result;
        finished = true;
      } else if (line.type === "error") {
        const status = line.error.status ?? 500;
        if (status >= 400 && status < 500) throw new ApiError("rejected", line.error.message, status, line.error);
        throw new ApiError("server", MESSAGES.server, status);
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { lines, rest } = splitLines(buffer);
        buffer = rest;
        for (const l of lines) handle(l);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted) throw new ApiError("timeout", MESSAGES.timeout);
      throw new ApiError("server", MESSAGES.server);
    }
    for (const l of splitLines(`${buffer}\n`).lines) handle(l);
    if (!finished) throw new ApiError("server", MESSAGES.server);
    return result as R;
  } finally {
    clearTimeout(timer);
    if (slow) clearTimeout(slow);
  }
}
