import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { LlmClient } from "./types";

/** Le modèle a refusé de répondre (classificateurs de sécurité). */
export class LlmRefusal extends Error {}

/**
 * Client Anthropic. Sans clé explicite, le SDK lit ANTHROPIC_API_KEY, ou le profil créé par
 * `ant auth login`. Le texte des demandes transite donc par les serveurs de MAAQ puis d'Anthropic :
 * acceptable pour la zone de test, à revoir avec le tchat embarqué de Digitorn.
 */
export function anthropicLlm(options: { model: string; apiKey?: string }): LlmClient {
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  // Le texte système ne change pas d'une demande à l'autre : il est mis en cache.
  const system = (text: string) => [{ type: "text" as const, text, cache_control: { type: "ephemeral" as const } }];

  return {
    async complete({ system: systemText, messages, schema }) {
      const response = await client.messages.parse({
        model: options.model,
        // Réponses courtes de tchat : bien en dessous de ce plafond.
        max_tokens: 8000,
        system: system(systemText),
        messages,
        output_config: { format: zodOutputFormat(schema), effort: "low" },
      });
      if (response.stop_reason === "refusal") throw new LlmRefusal(response.stop_details?.explanation ?? "Demande refusée par le modèle");
      if (response.parsed_output === null || response.parsed_output === undefined) throw new Error("Réponse du modèle illisible");
      return response.parsed_output;
    },

    async runTools({ system: systemText, messages, tools, maxIterations = 8 }) {
      const final = await client.beta.messages.toolRunner({
        model: options.model,
        max_tokens: 8000,
        system: system(systemText),
        messages,
        tools,
        max_iterations: maxIterations,
        output_config: { effort: "low" },
      });
      if (final.stop_reason === "refusal") throw new LlmRefusal(final.stop_details?.explanation ?? "Demande refusée par le modèle");
      const text = final.content
        .filter((block): block is Extract<(typeof final.content)[number], { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { text };
    },
  };
}
