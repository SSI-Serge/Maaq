/**
 * Contrat entre MAAQ et Digitorn (plateforme qui exécute les agents IA).
 * L'API réelle n'est pas encore publiée : ce contrat est notre hypothèse, implémentée
 * par un simulateur (mock.ts) en attendant. Les écrans ne dépendent que de ce contrat.
 */

export type RequesterRank = "primary_user" | "core_guest" | "secondary_guest";

/** Contexte transmis avec chaque demande (US-38 RF4). */
export interface RequestContext {
  rank: RequesterRank;
  /** Participants automatiques des rendez-vous, selon la décision D2 (emails de connexion). */
  autoParticipants: string[];
  /** Adresses en copie systématique applicables (US-16, US-17). */
  ccAddresses: string[];
  /** Informations du profil pour cet agent (US-10), déjà déchiffrées. */
  info: Record<string, string | string[]>;
}

export interface SubmitRequestInput {
  /** Identifiant choisi par MAAQ : une même demande renvoyée n'est exécutée qu'une fois (US-38 RT2). */
  requestId: string;
  userRef: string;
  agentRef: string;
  text: string;
  context: RequestContext;
}

export type ActionStatus = "pending" | "executing" | "succeeded" | "failed" | "refused" | "abandoned";

export interface ActionProposal {
  proposalId: string;
  kind: "appointment" | "email";
  summary: string;
  when?: string;
  place?: string;
  participants: string[];
  recipient?: string;
  status: ActionStatus;
}

export type ChatEvent =
  | { type: "user_message"; id: string; requestId: string; text: string; at: string }
  | { type: "agent_message"; id: string; requestId: string; text: string; at: string }
  | { type: "action_proposal"; id: string; requestId: string; proposal: ActionProposal; at: string };

export interface DecideActionInput {
  proposalId: string;
  userRef: string;
  decision: "validate" | "refuse";
}

/** Ligne du carnet de bord telle que renvoyée par Digitorn (synchronisée toutes les X heures, D4). */
export interface LogbookItem {
  externalId: string;
  userRef: string;
  agentRef: string;
  type: "request" | "action_done" | "action_validated" | "action_refused";
  text: string;
  occurredAt: string;
  participants: string[];
}

/** Agent hébergé chez Digitorn, qui peut être publié dans le catalogue MAAQ (US-45 RT2). */
export interface HostedAgent {
  ref: string;
  name: string;
}

export interface DigitornClient {
  listHostedAgents(): Promise<HostedAgent[]>;
  /** Transmet les informations d'un profil pour un agent, dès qu'elles changent (US-12 RF5, D11). */
  updateProfileInfo(userRef: string, agentRef: string, info: Record<string, string | string[]>): Promise<void>;
  submitRequest(input: SubmitRequestInput): Promise<void>;
  getConversation(userRef: string, agentRef: string): Promise<ChatEvent[]>;
  decideAction(input: DecideActionInput): Promise<ActionProposal>;
  fetchLogbook(since: Date): Promise<LogbookItem[]>;
  eraseConversation(userRef: string, agentRef: string): Promise<void>;
  deleteProfile(userRef: string): Promise<void>;
}
