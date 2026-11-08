/**
 * Appel du modèle Claude par l'API Messages (agent/INTEGRATION.md § 3 et 5). Sans dépendance : une requête HTTP.
 * Fournisseur : l'API Anthropic directe (tests et pilote, décision D54). Claude sur Vertex AI en région européenne pourra suivre si le pilote
 * est concluant : le corps de la requête est le même, seule la création du client changera. Microsoft Foundry est abandonné (pas de Claude en Europe).
 */

export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
/** Bloc de réflexion et autres : à renvoyer tels quels dans l'historique. */
export interface OtherBlock { type: string; [key: string]: unknown }
export type ContentBlock = TextBlock | ToolUseBlock | OtherBlock;

export interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
/** Image envoyée au modèle pour analyse (photos du travail des enfants, US-119) : jamais conservée par MAAQ, supprimée dès la réponse. */
export interface ImageBlock { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp"; data: string } }
export type ModelMessage = { role: "user"; content: string | (TextBlock | ToolResultBlock | ImageBlock)[] } | { role: "assistant"; content: ContentBlock[] };

export interface ModelRequest {
  system: string;
  tools: unknown[];
  messages: ModelMessage[];
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: string;
  /** `webSearches` : recherches web faites par le fournisseur pendant l'appel (facturées en plus des jetons), quand l'outil de recherche est fourni. */
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; webSearches?: number };
  /** Identifiant de requête du fournisseur, à journaliser pour le support. */
  requestId: string | null;
}

/** Ce que le modèle écrit au fil de l'eau (affichage progressif) : du texte, ou les arguments JSON d'un outil en train d'être écrits (cumulés depuis le début). */
export type ModelDelta = { type: "text"; text: string } | { type: "tool_input"; name: string; json: string };

export interface SendOptions {
  /** Demande la réponse en flux et rappelle `onDelta` à chaque morceau ; le résultat final est le même que sans flux. */
  onDelta?: (delta: ModelDelta) => void;
}

export interface AssistantModel {
  /** Identifiant du modèle, pour le coût estimé des journaux (absent d'un faux modèle de test). */
  readonly id?: string;
  send(request: ModelRequest, options?: SendOptions): Promise<ModelResponse>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface ModelConfig {
  provider: "anthropic";
  apiKey: string;
  /** Remplace l'adresse de base (tests). */
  baseUrl?: string;
  model: string;
  effort?: "low" | "medium" | "high";
  timeoutMs?: number;
  maxTokens?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRIES = 2;

export function createModel(config: ModelConfig): AssistantModel {
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${config.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;

  return {
    id: config.model,
    async send(request, options = {}) {
      const streaming = !!options.onDelta;
      const body = {
        model: config.model,
        max_tokens: config.maxTokens ?? 16_000,
        system: request.system,
        tools: request.tools,
        messages: request.messages,
        ...(config.effort ? { output_config: { effort: config.effort } } : {}),
        // Le prompt système et les outils restent identiques d'une requête à l'autre : mis en cache côté API Anthropic.
        cache_control: { type: "ephemeral" },
        ...(streaming ? { stream: true } : {}),
      };
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": config.apiKey,
      };

      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
        try {
          const res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
          const requestId = res.headers.get("request-id") ?? res.headers.get("apim-request-id");
          if (streaming && res.ok && res.body) return await readStream(res.body, options.onDelta!, requestId);
          const raw = await res.text();
          if (res.status === 429 || res.status >= 500) {
            if (attempt < RETRIES) {
              const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * (attempt + 1);
              await sleep(Math.min(wait, 10_000));
              continue;
            }
            throw new ModelError(`le modèle n'a pas répondu (HTTP ${res.status})`, res.status, true, requestId);
          }
          if (!res.ok) throw new ModelError(`requête refusée par le modèle (HTTP ${res.status}) : ${raw.slice(0, 300)}`, res.status, false, requestId);
          const json = JSON.parse(raw) as {
            content: ContentBlock[]; stop_reason: string;
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; server_tool_use?: { web_search_requests?: number } };
          };
          return {
            content: json.content,
            stopReason: json.stop_reason,
            usage: {
              inputTokens: json.usage?.input_tokens ?? 0,
              outputTokens: json.usage?.output_tokens ?? 0,
              cacheRead: json.usage?.cache_read_input_tokens ?? 0,
              cacheWrite: json.usage?.cache_creation_input_tokens ?? 0,
              webSearches: json.usage?.server_tool_use?.web_search_requests ?? 0,
            },
            requestId,
          };
        } catch (error) {
          if (error instanceof ModelError) throw error;
          if ((error as Error).name === "AbortError") throw new ModelError("le modèle a mis trop de temps à répondre", null, true);
          throw new ModelError(`le modèle est injoignable : ${(error as Error).message}`, null, true);
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; server_tool_use?: { web_search_requests?: number } };

/**
 * Lit la réponse en flux de l'API Messages (événements SSE) et rend la même réponse que sans flux : blocs de texte, appels d'outil (arguments JSON complets), raison d'arrêt et jetons.
 * `onDelta` reçoit le texte et les arguments JSON des outils au fur et à mesure.
 */
export async function readStream(body: ReadableStream<Uint8Array>, onDelta: (delta: ModelDelta) => void, requestId: string | null): Promise<ModelResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const blocks: (ContentBlock & { __json?: string })[] = [];
  const usage: Usage = {};
  let stopReason = "end_turn";
  let buffer = "";

  const handle = (event: { type: string; [key: string]: unknown }) => {
    switch (event.type) {
      case "message_start": {
        const u = (event.message as { usage?: Usage } | undefined)?.usage;
        if (u) Object.assign(usage, u);
        break;
      }
      case "content_block_start": {
        const block = { ...(event.content_block as ContentBlock) } as ContentBlock & { __json?: string };
        if (block.type === "tool_use") block.__json = "";
        blocks[event.index as number] = block;
        break;
      }
      case "content_block_delta": {
        const block = blocks[event.index as number];
        const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string };
        if (!block) break;
        if (delta.type === "text_delta" && block.type === "text") {
          (block as TextBlock).text += delta.text ?? "";
          onDelta({ type: "text", text: (block as TextBlock).text });
        } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
          block.__json = (block.__json ?? "") + (delta.partial_json ?? "");
          onDelta({ type: "tool_input", name: String((block as ToolUseBlock).name), json: block.__json });
        } else if (delta.type === "thinking_delta") {
          (block as Record<string, unknown>).thinking = String((block as Record<string, unknown>).thinking ?? "") + (delta.thinking ?? "");
        } else if (delta.type === "signature_delta") {
          (block as Record<string, unknown>).signature = delta.signature ?? "";
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks[event.index as number];
        if (block?.type === "tool_use") {
          try {
            (block as ToolUseBlock).input = block.__json ? JSON.parse(block.__json) : {};
          } catch {
            (block as ToolUseBlock).input = {};
          }
          delete block.__json;
        }
        break;
      }
      case "message_delta": {
        const d = event.delta as { stop_reason?: string } | undefined;
        if (d?.stop_reason) stopReason = d.stop_reason;
        const u = event.usage as Usage | undefined;
        if (u?.output_tokens !== undefined) usage.output_tokens = u.output_tokens;
        break;
      }
      case "error": {
        const e = event.error as { type?: string; message?: string } | undefined;
        throw new ModelError(`le modèle a interrompu sa réponse : ${e?.type ?? "erreur"}`, null, true, requestId);
      }
    }
  };

  const feed = (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!data) continue;
      try {
        handle(JSON.parse(data));
      } catch (error) {
        if (error instanceof ModelError) throw error;
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    feed(decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n"));
  }
  feed(decoder.decode().replace(/\r\n/g, "\n") + "\n\n");
  return {
    content: blocks.filter(Boolean).map(({ __json: _json, ...block }) => block as ContentBlock),
    stopReason,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      webSearches: usage.server_tool_use?.web_search_requests ?? 0,
    },
    requestId,
  };
}
