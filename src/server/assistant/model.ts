/**
 * Appel du modèle Claude par l'API Messages (agent/INTEGRATION.md § 3 et 5). Sans dépendance : une requête HTTP.
 * Trois fournisseurs possibles pour le même corps de requête : l'API Anthropic directe (tests), Microsoft Foundry (pilote),
 * Vertex AI en région européenne (après le pilote : seule la création du client changera).
 */

export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
/** Bloc de réflexion et autres : à renvoyer tels quels dans l'historique. */
export interface OtherBlock { type: string; [key: string]: unknown }
export type ContentBlock = TextBlock | ToolUseBlock | OtherBlock;

export interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export type ModelMessage = { role: "user"; content: string | (TextBlock | ToolResultBlock)[] } | { role: "assistant"; content: ContentBlock[] };

export interface ModelRequest {
  system: string;
  tools: unknown[];
  messages: ModelMessage[];
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
  /** Identifiant de requête du fournisseur, à journaliser pour le support. */
  requestId: string | null;
}

export interface AssistantModel {
  send(request: ModelRequest): Promise<ModelResponse>;
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
  provider: "anthropic" | "foundry";
  apiKey: string;
  /** Nom de la ressource Foundry (obligatoire avec le fournisseur foundry). */
  resource?: string;
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
  const url =
    (config.baseUrl ??
      (config.provider === "foundry"
        ? `https://${config.resource ?? ""}.services.ai.azure.com/anthropic`
        : "https://api.anthropic.com")) + "/v1/messages";
  if (config.provider === "foundry" && !config.resource && !config.baseUrl) throw new Error("FOUNDRY_RESOURCE est obligatoire avec le fournisseur foundry");

  return {
    async send(request) {
      const body = {
        model: config.model,
        max_tokens: config.maxTokens ?? 16_000,
        system: request.system,
        tools: request.tools,
        messages: request.messages,
        ...(config.effort ? { output_config: { effort: config.effort } } : {}),
        // Le prompt système et les outils restent identiques d'une requête à l'autre : mis en cache côté API Anthropic.
        ...(config.provider === "anthropic" ? { cache_control: { type: "ephemeral" } } : {}),
      };
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(config.provider === "foundry" ? { "api-key": config.apiKey } : { "x-api-key": config.apiKey }),
      };

      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
        try {
          const res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
          const requestId = res.headers.get("request-id") ?? res.headers.get("apim-request-id");
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
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          };
          return {
            content: json.content,
            stopReason: json.stop_reason,
            usage: {
              inputTokens: json.usage?.input_tokens ?? 0,
              outputTokens: json.usage?.output_tokens ?? 0,
              cacheRead: json.usage?.cache_read_input_tokens ?? 0,
              cacheWrite: json.usage?.cache_creation_input_tokens ?? 0,
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
