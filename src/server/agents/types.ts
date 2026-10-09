import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { z } from "zod";
import type { RequestContext } from "@/server/adapters/digitorn/types";

/**
 * Agents exécutés par MAAQ en attendant leur hébergement chez Digitorn. Un « cerveau » reçoit
 * la demande et son contexte, et rend le texte à afficher dans le tchat. Le simulateur Digitorn
 * (mock.ts) l'appelle à la place de ses réponses figées : le reste de l'application ne change pas.
 */

export type ChannelKind = "web" | "whatsapp";

/** Message déjà échangé dans le tchat, transmis à l'agent comme contexte. */
export interface AgentHistoryItem {
  role: "user" | "agent";
  text: string;
}

export interface AgentTurnInput {
  userRef: string;
  text: string;
  /** Contexte envoyé avec chaque demande (rang, adresses, informations du profil pour cet agent). */
  context: RequestContext;
  history: AgentHistoryItem[];
  today: Date;
  /** Fuseau de la personne, pour les dates relatives et le jour civil. */
  timezone: string;
  /** Canal d'où vient la demande ; `web` par défaut. */
  channel: ChannelKind;
}

/** Action sensible proposée par l'agent : exécutée seulement après validation de la personne (US-39). */
export interface BrainProposal {
  summary: string;
  execute: () => Promise<void>;
}

export interface BrainReply {
  text: string;
  proposals: BrainProposal[];
}

export interface AgentBrain {
  /** Identifiant de l'agent, celui de la colonne `digitorn_agent_ref`. */
  readonly ref: string;
  respond(input: AgentTurnInput): Promise<BrainReply>;
  /** Oublie ce que l'agent retient en mémoire d'un profil (effacement du tchat, suppression du compte). */
  forget(userRef: string): void;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

/** Appel d'un modèle de langage. Le fournisseur est interchangeable (Anthropic, faux modèle des tests). */
export interface LlmClient {
  /** Réponse structurée, sans outil. */
  complete<T>(input: { system: string; messages: LlmMessage[]; schema: z.ZodType<T> }): Promise<T>;
  /** Boucle d'outils : le modèle appelle les outils fournis jusqu'à sa réponse finale en texte. */
  runTools(input: { system: string; messages: LlmMessage[]; tools: BetaRunnableTool[]; maxIterations?: number }): Promise<{ text: string }>;
}
