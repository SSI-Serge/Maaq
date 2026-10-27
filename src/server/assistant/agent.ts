import { describeError } from "@/server/safe-log";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { estimateCostUsd } from "./cost";
import { describeNow } from "./local-time";
import type { AssistantModel, ContentBlock, ModelMessage, TextBlock, ToolResultBlock, ToolUseBlock } from "./model";
import { Pseudonymizer, type PseudoMember } from "./pseudonymize";
import { executeTool, expandEventRefs, type TaskDraft, type ToolContext } from "./tools";

/**
 * Boucle de l'Assistant Famille (agent/INTEGRATION.md § 1 à 3) : MAAQ appelle le modèle, exécute lui-même les outils demandés et boucle
 * jusqu'à la réponse finale. Les instructions et les outils sont lus dans le dossier agent/ : source de vérité, non réécrite ici.
 */

export interface AgentDefinition {
  instructions: string;
  tools: unknown[];
}

const definitions = new Map<string, AgentDefinition>();

export function loadAgentDefinition(dir: string = process.env.ASSISTANT_AGENT_DIR ?? path.join(process.cwd(), "agent")): AgentDefinition {
  let definition = definitions.get(dir);
  if (!definition) {
    definition = {
      instructions: readFileSync(path.join(dir, "instructions.md"), "utf8"),
      tools: JSON.parse(readFileSync(path.join(dir, "outils", "outils.json"), "utf8")) as unknown[],
    };
    definitions.set(dir, definition);
  }
  return definition;
}

export type AgentSource = "typed" | "dictation" | "capture" | "mail";
const SOURCE_LABEL: Record<AgentSource, string> = { typed: "saisie", dictation: "dictee", capture: "capture", mail: "mail" };

export interface AgentLimits {
  /** Tours de la boucle (un tour = un appel du modèle). */
  maxTurns: number;
  /** Durée maximale d'une demande, en millisecondes. */
  deadlineMs: number;
}
const DEFAULT_LIMITS: AgentLimits = { maxTurns: 12, deadlineMs: 60_000 };

export interface AgentRunInput {
  db: Kysely<DB>;
  model: AssistantModel;
  definition: AgentDefinition;
  accountId: string;
  userId: string;
  members: PseudoMember[];
  /** Membre qui écrit (parent), pour « Personne qui écrit ». */
  authorMemberId: string | null;
  timeZone: string;
  now: Date;
  requestId: string;
  /** Message du parent qui déclenche la demande : les rendez-vous créés s'y rattachent. */
  sourceMessageId?: number | null;
  source: AgentSource;
  text: string;
  /** Échanges récents du même fil (le plus ancien d'abord), pour qu'une réponse à une question de l'assistant garde son contexte. */
  history?: { role: "user" | "assistant"; text: string; source?: AgentSource }[];
  limits?: Partial<AgentLimits>;
  /** Droit de voir un rendez-vous cité dans la réponse (D26) ; tout le foyer par défaut. */
  canSee?: (eventId: string) => boolean;
}

export type AgentStatus = "ok" | "error" | "timeout" | "max_turns" | "refused" | "max_tokens";

export interface AgentRunResult {
  /** Réponse prête à l'affichage : alias retraduits, identifiants d'événements remplacés par leur titre. */
  reply: string;
  status: AgentStatus;
  createdEventIds: string[];
  proposalIds: string[];
  /** Tâches seules proposées : cartes du tchat, rien n'est enregistré. */
  taskDrafts: TaskDraft[];
  /** Rendez-vous créés dont le lieu est public (« oui ») ou incertain (« doute ») selon l'agent : suggestion « Sur place » (US-112 RF3). */
  placeHints: [string, "oui" | "doute"][];
  /** Recherches « Sur place » lancées par l'agent, à exécuter après la réponse (US-112 RF2). */
  placeSearchIds: string[];
  toolCalls: { name: string; ms: number; isError: boolean }[];
  /** Appels d'outils détaillés (paramètres retraduits, résultat tel que vu par le modèle) : pour le banc d'essai, jamais journalisés. */
  trace: { name: string; input: unknown; output: string; isError: boolean }[];
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
  turns: number;
  durationMs: number;
  requestIds: string[];
  /** Identifiants qui ont pu partir chez le modèle malgré la pseudonymisation (devrait rester vide). */
  leaks: string[];
  /** Alias inventés par le modèle. */
  unknownAliases: string[];
}

export const FAILURE_REPLY = "Je n'ai pas pu traiter votre demande pour le moment. Vous pouvez réessayer dans un instant.";

function contextMessage(input: AgentRunInput, pseudo: Pseudonymizer): string {
  const author = input.authorMemberId ? pseudo.aliasFor(input.authorMemberId) : "un parent";
  return (
    "<contexte>\n" +
    `Date et heure actuelles : ${describeNow(input.now, input.timeZone)}\n` +
    `Personne qui écrit : ${author}\n` +
    "</contexte>\n" +
    `<message source="${SOURCE_LABEL[input.source]}">\n${pseudo.toModel(input.text)}\n</message>`
  );
}

/** Historique pseudonymisé puis message courant. Les rôles alternent toujours, en commençant par l'utilisateur. */
function buildMessages(input: AgentRunInput, pseudo: Pseudonymizer): ModelMessage[] {
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const item of input.history ?? []) {
    const text = item.role === "user" ? `<message source="${SOURCE_LABEL[item.source ?? "typed"]}">
${pseudo.toModel(item.text)}
</message>` : pseudo.toModel(item.text);
    const last = turns[turns.length - 1];
    if (last && last.role === item.role) last.text += `

${text}`;
    else turns.push({ role: item.role, text });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  const current = contextMessage(input, pseudo);
  const last = turns[turns.length - 1];
  if (last && last.role === "user") last.text += `

${current}`;
  else turns.push({ role: "user", text: current });
  return turns.map((t): ModelMessage => (t.role === "user" ? { role: "user", content: t.text } : { role: "assistant", content: [{ type: "text", text: t.text }] }));
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

export async function runAssistant(input: AgentRunInput): Promise<AgentRunResult> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const pseudo = new Pseudonymizer(input.members);
  const started = Date.now();
  const toolContext: ToolContext = {
    db: input.db, accountId: input.accountId, userId: input.userId, authorMemberId: input.authorMemberId, timeZone: input.timeZone, now: input.now, requestId: input.requestId,
    source: input.source, sourceMessageId: input.sourceMessageId, pseudo, created: { ids: [] }, proposals: [], taskDrafts: [],
  };
  const messages: ModelMessage[] = buildMessages(input, pseudo);
  const result: AgentRunResult = {
    reply: FAILURE_REPLY, status: "error", createdEventIds: [], proposalIds: [], taskDrafts: [], placeHints: [], placeSearchIds: [], toolCalls: [], trace: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, turns: 0, durationMs: 0, requestIds: [], leaks: [], unknownAliases: [],
  };

  try {
    for (let turn = 0; ; turn++) {
      if (turn >= limits.maxTurns) {
        result.status = "max_turns";
        break;
      }
      if (Date.now() - started > limits.deadlineMs) {
        result.status = "timeout";
        break;
      }
      result.turns += 1;
      const response = await input.model.send({ system: input.definition.instructions, tools: input.definition.tools, messages });
      result.usage.inputTokens += response.usage.inputTokens;
      result.usage.outputTokens += response.usage.outputTokens;
      result.usage.cacheRead += response.usage.cacheRead;
      result.usage.cacheWrite += response.usage.cacheWrite;
      if (response.requestId) result.requestIds.push(response.requestId);
      // Tout le contenu de la réponse (réflexion comprise) revient tel quel dans l'historique.
      messages.push({ role: "assistant", content: response.content });

      if (response.stopReason === "tool_use") {
        const uses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        const results: ToolResultBlock[] = [];
        for (const use of uses) {
          const t0 = Date.now();
          let outcome: { content: string; isError: boolean };
          try {
            outcome = await executeTool(use.name, use.input, toolContext);
          } catch (error) {
            console.error(`[assistant] outil ${use.name} en échec : ${describeError(error)}`);
            outcome = { content: "Erreur : l'outil a rencontré un problème, réessayez ou posez la question au parent.", isError: true };
          }
          result.toolCalls.push({ name: use.name, ms: Date.now() - t0, isError: outcome.isError });
          result.trace.push({ name: use.name, input: pseudo.fromModelDeep(use.input), output: outcome.content, isError: outcome.isError });
          results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      if (response.stopReason === "refusal") result.status = "refused";
      else if (response.stopReason === "max_tokens") result.status = "max_tokens";
      else {
        const raw = response.content.filter((b: ContentBlock): b is TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
        result.unknownAliases = pseudo.unknownAliases(raw);
        result.reply = await expandEventRefs(input.db, input.accountId, pseudo.fromModel(raw), input.canSee);
        result.status = "ok";
      }
      break;
    }
  } catch (error) {
    result.status = "error";
    console.error(`[assistant] échec de la demande : ${describeError(error)}`);
  }

  result.createdEventIds = toolContext.created.ids;
  result.proposalIds = toolContext.proposals;
  result.taskDrafts = toolContext.taskDrafts ?? [];
  result.placeHints = [...(toolContext.placeHints ?? new Map())];
  result.placeSearchIds = toolContext.placeSearchIds ?? [];
  result.durationMs = Date.now() - started;
  // Contrôle : rien d'identifiant ne doit être parti chez le modèle (instructions et messages ; les octets d'image ne comptent pas).
  result.leaks = pseudo.leaks([input.definition.instructions, ...strings(messages.filter((m) => m.role === "user"))].join("\n"));
  // Trace d'exploitation : métadonnées seulement, jamais le contenu des messages (agent/INTEGRATION.md § 8).
  console.info(
    JSON.stringify({
      event: "assistant_turn", status: result.status, durationMs: result.durationMs, turns: result.turns, tools: result.toolCalls.map((c) => c.name),
      toolErrors: result.toolCalls.filter((c) => c.isError).length, model: input.model.id ?? null, tokens: result.usage, costUsd: estimateCostUsd(input.model.id, result.usage), requestIds: result.requestIds,
      leaks: result.leaks.length, unknownAliases: result.unknownAliases.length,
    }),
  );
  if (result.leaks.length) console.error(`[assistant] identifiants envoyés au modèle malgré la pseudonymisation : ${result.leaks.join(", ")}`);
  return result;
}
