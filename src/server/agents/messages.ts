import type { AgentTurnInput, LlmMessage } from "./types";

/** Historique récent puis la demande, précédée de son contexte. Le premier message est toujours celui de la personne. */
export function buildMessages(input: AgentTurnInput, context: string): LlmMessage[] {
  const firstUser = input.history.findIndex((item) => item.role === "user");
  const history = firstUser === -1 ? [] : input.history.slice(firstUser);
  const messages: LlmMessage[] = history.map((item) => ({ role: item.role === "user" ? "user" : "assistant", content: item.text }));
  messages.push({ role: "user", content: `${context}\n\n[Demande]\n${input.text}` });
  return messages;
}
