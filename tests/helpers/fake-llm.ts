import type { LlmClient, LlmMessage } from "@/server/agents/types";

export interface ScriptStep {
  calls?: { tool: string; input: unknown }[];
  text: string | ((results: string[]) => string);
}

/** Faux modèle : joue les appels d'outils prévus (validés par leur schéma) puis rend le texte prévu. */
export function fakeLlm(steps: ScriptStep[]) {
  const runs: { system: string; messages: LlmMessage[]; results: string[] }[] = [];
  const llm: LlmClient = {
    async complete() {
      throw new Error("non utilisé");
    },
    async runTools({ system, messages, tools }) {
      const step = steps.shift();
      if (!step) throw new Error("modèle indisponible");
      const results: string[] = [];
      for (const call of step.calls ?? []) {
        const tool = tools.find((t) => t.name === call.tool);
        if (!tool) throw new Error(`outil inconnu : ${call.tool}`);
        const out = await tool.run(tool.parse(call.input));
        results.push(typeof out === "string" ? out : JSON.stringify(out));
      }
      runs.push({ system, messages, results });
      return { text: typeof step.text === "function" ? step.text(results) : step.text };
    },
  };
  return { llm, runs, steps, lastPrompt: () => runs.at(-1)!.messages.at(-1)!.content };
}
