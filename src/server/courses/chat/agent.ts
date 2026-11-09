import { readFileSync } from "node:fs";
import path from "node:path";
import type { AssistantModel, ModelMessage, TextBlock, ToolResultBlock, ToolUseBlock } from "@/server/assistant/model";
import { describeError } from "@/server/safe-log";
import { courseInstructions } from "../agent/instructions";
import { env } from "@/server/env";
import { MENU_TOOLS } from "../menu-ia/contract";
import { menuProgress, type MenuProgress } from "../menu-ia/progress";
import { SCREENS } from "./screens";
import { executeCourseTool, type CourseToolContext } from "./tools";

/**
 * Boucle de l'agent « Courses et repas » : MAAQ appelle le modèle, exécute lui-même les outils demandés (liste, achats, budget, liens d'écran) et boucle jusqu'à la réponse
 * finale. Le modèle ne reçoit jamais les allergies, les régimes, une adresse, une photo de ticket ni un prénom (socle de l'agent) : seulement la date, le jour du budget, ce qui
 * manque aux réglages et le droit du profil.
 */

export const FAILURE_REPLY = "Je n'ai pas pu traiter votre demande pour le moment. Vous pouvez réessayer dans un instant.";

/** Menu non composé : deux essais invalides, ou l'IA ne répond pas (CR-44). */
/** Plafond de menus du jour atteint (CR-44) : ce n'est pas une erreur, il n'y a rien à réessayer. */
export const MENU_LIMIT_REPLY = "Vous avez atteint la limite de menus pour aujourd'hui : vous pourrez reprendre demain.";
export const MENU_FAILURE_REPLY = "Je n'ai pas réussi à composer le menu pour le moment. Vous pouvez réessayer.";

const tools = (): unknown[] => JSON.parse(readFileSync(path.join(process.env.COURSES_AGENT_DIR ?? path.join(process.cwd(), "agent-courses"), "outils.json"), "utf8")) as unknown[];

export interface CourseContextFacts {
  now: Date;
  timeZone: string;
  budgetDay: boolean;
  missingSettings: string[];
  access: "couple" | "list";
  /** Menu proposé et pas encore validé (noms des plats seulement) : le modèle le corrige quand l'utilisateur le demande. */
  menuInProgress?: string | null;
  /** Semaine choisie au début de la conversation (CR-54) : « du 9 au 15 nov. » et un menu est-il déjà validé pour elle. */
  week?: { label: string; hasMenu: boolean } | null;
}

/** Les outils de l'agent : ceux du fichier, plus la composition du menu pour les parents quand elle est ouverte (MENU_IA). */
function toolsFor(access: "couple" | "list"): unknown[] {
  return access === "couple" && env().MENU_IA === "live" ? [...tools(), ...MENU_TOOLS] : tools();
}

const MISSING_TEXT: Record<string, string> = { city: "la ville", householdSize: "le nombre de personnes", shoppingDays: "les jours de courses", cuisines: "les cuisines préférées", goals: "les objectifs" };

function describeNow(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short", timeZone }).format(now);
}

export function contextBlock(facts: CourseContextFacts): string {
  return (
    "<contexte>\n" +
    `Date et heure actuelles : ${describeNow(facts.now, facts.timeZone)}\n` +
    `Jour du budget : ${facts.budgetDay ? "oui, c'est aujourd'hui" : "non"}\n` +
    `Réglages du foyer à renseigner : ${facts.missingSettings.length ? facts.missingSettings.map((m) => MISSING_TEXT[m] ?? m).join(", ") : "aucun"}\n` +
    `Droit de la personne qui écrit : ${facts.access === "couple" ? "parent du couple (tout)" : "invité secondaire (liste de courses seulement)"}\n` +
    (facts.week ? `Semaine choisie pour le menu et la liste : ${facts.week.label} (${facts.week.hasMenu ? "un menu est déjà validé pour cette semaine : le remplacer demande la confirmation de la personne" : "pas encore de menu validé"}). MAAQ place le menu composé sur cette semaine.\n` : "") +
    (facts.menuInProgress ? `${facts.menuInProgress}\n` : "") +
    "</contexte>"
  );
}

export interface CourseAgentInput {
  model: AssistantModel;
  tool: CourseToolContext;
  facts: CourseContextFacts;
  text: string;
  /** Échanges récents du même fil (le plus ancien d'abord). */
  history: { role: "user" | "assistant"; text: string }[];
  maxTurns?: number;
  deadlineMs?: number;
  /** Consignes de remplacement du dialogue (US-176, plus tard). */
  dialogue?: string | null;
  /** Menu au fil de l'eau : rappelé chaque fois qu'un plat ou une étape de plus est écrit par le modèle. */
  onProgress?: (progress: MenuProgress) => void;
}

export interface CourseAgentResult {
  reply: string;
  status: "ok" | "error" | "timeout" | "max_turns" | "refused" | "max_tokens";
  toolCalls: { name: string; ms: number; isError: boolean }[];
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
  durationMs: number;
}

function buildMessages(input: CourseAgentInput): ModelMessage[] {
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const item of input.history) {
    const text = item.role === "user" ? `<message>\n${item.text}\n</message>` : item.text;
    const last = turns[turns.length - 1];
    if (last && last.role === item.role) last.text += `\n\n${text}`;
    else turns.push({ role: item.role, text });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  const current = `${contextBlock(input.facts)}\n<message>\n${input.text}\n</message>`;
  const last = turns[turns.length - 1];
  if (last && last.role === "user") last.text += `\n\n${current}`;
  else turns.push({ role: "user", text: current });
  return turns.map((t): ModelMessage => (t.role === "user" ? { role: "user", content: t.text } : { role: "assistant", content: [{ type: "text", text: t.text }] }));
}

/** Remplace les marqueurs `[[ecran:nom]]` inconnus ou interdits par le nom de l'écran en clair. */
export function cleanMarkers(reply: string, allowed: Set<string>): string {
  return reply.replace(/\[\[ecran:([a-z_]+)\]\]/g, (all, key: string) => (allowed.has(key) && key in SCREENS ? all : (SCREENS[key as keyof typeof SCREENS]?.label ?? "")));
}

export async function runCourseAgent(input: CourseAgentInput): Promise<CourseAgentResult> {
  const started = Date.now();
  const maxTurns = input.maxTurns ?? 6;
  const deadline = input.deadlineMs ?? 50_000;
  const system = courseInstructions({ replacement: input.dialogue });
  const definition = toolsFor(input.tool.access);
  const messages = buildMessages(input);
  const result: CourseAgentResult = { reply: FAILURE_REPLY, status: "error", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0 };
  try {
    for (let turn = 0; ; turn += 1) {
      if (turn >= maxTurns) {
        result.status = "max_turns";
        break;
      }
      if (Date.now() - started > deadline) {
        result.status = "timeout";
        break;
      }
      let shown = "";
      const response = await input.model.send(
        { system, tools: definition, messages },
        input.onProgress
          ? {
              onDelta: (delta) => {
                if (delta.type !== "tool_input" || delta.name !== "proposer_menu") return;
                const progress = menuProgress(delta.json);
                const key = `${progress.dinners.length}/${progress.express.length}/${progress.steps}`;
                if (key === shown) return;
                shown = key;
                input.onProgress!(progress);
              },
            }
          : undefined,
      );
      result.usage.inputTokens += response.usage.inputTokens;
      result.usage.outputTokens += response.usage.outputTokens;
      result.usage.cacheRead += response.usage.cacheRead;
      result.usage.cacheWrite += response.usage.cacheWrite;
      messages.push({ role: "assistant", content: response.content });
      if (response.stopReason === "tool_use") {
        const results: ToolResultBlock[] = [];
        for (const use of response.content.filter((b): b is ToolUseBlock => b.type === "tool_use")) {
          const t0 = Date.now();
          let outcome: { content: string; isError: boolean };
          try {
            outcome = await executeCourseTool(use.name, use.input, input.tool);
          } catch (error) {
            console.error(`[courses] outil ${use.name} en échec : ${describeError(error)}`);
            outcome = { content: "Erreur : l'outil a rencontré un problème, réessayez ou renvoyez vers l'écran.", isError: true };
          }
          result.toolCalls.push({ name: use.name, ms: Date.now() - t0, isError: outcome.isError });
          results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        if (input.tool.menu.limitReached) {
          result.reply = MENU_LIMIT_REPLY;
          result.status = "ok";
          break;
        }
        if (input.tool.menu.aborted) {
          result.reply = MENU_FAILURE_REPLY;
          result.status = "error";
          break;
        }
        continue;
      }
      if (response.stopReason === "refusal") result.status = "refused";
      else if (response.stopReason === "max_tokens") result.status = "max_tokens";
      else {
        const raw = response.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
        result.reply = cleanMarkers(raw, input.tool.opened);
        result.status = raw ? "ok" : "error";
      }
      break;
    }
  } catch (error) {
    result.status = "error";
    console.error(`[courses] échec de la demande : ${describeError(error)}`);
  }
  result.durationMs = Date.now() - started;
  // Trace d'exploitation : métadonnées seulement, jamais le contenu des messages.
  console.info(JSON.stringify({ event: "courses_turn", status: result.status, durationMs: result.durationMs, tools: result.toolCalls.map((c) => c.name), toolErrors: result.toolCalls.filter((c) => c.isError).length, model: input.model.id ?? null, tokens: result.usage }));
  return result;
}
