import { randomUUID } from "node:crypto";
import { drive } from "@/server/adapters/drive";
import type { AgentBrain, AgentHistoryItem, BrainReply } from "@/server/agents/types";
import { env } from "@/server/env";
import type {
  ActionProposal,
  AgentConfiguration,
  AuthorizationResult,
  GoogleConnector,
  ChatEvent,
  ClassifyDocumentInput,
  DecideActionInput,
  DigitornClient,
  DigitornUserData,
  HostedAgent,
  LogbookItem,
  SubmitRequestInput,
} from "./types";

export interface MockOptions {
  /** Délai avant la réponse de l'agent (traitement asynchrone, CC-10). 0 = immédiat. */
  replyDelayMs?: number;
  /** Délai d'exécution d'une action validée. 0 = immédiat. */
  executionDelayMs?: number;
  now?: () => Date;
  /** Agents exécutés par MAAQ : ils répondent à la place des réponses figées du simulateur. */
  brains?: AgentBrain[];
}

/** Message affiché quand un agent local n'a pas pu répondre. */
export const BRAIN_FAILURE_MESSAGE = "Je n'ai pas réussi à répondre. Réessayez dans un instant.";
/** Nombre de messages récents transmis à un agent local comme contexte. */
const BRAIN_HISTORY = 20;

/** Agents fictifs hébergés par le simulateur. */
export const MOCK_HOSTED_AGENTS: HostedAgent[] = [
  { ref: "admin_classify", name: "Admin_Classify" },
  { ref: "admin_rdv", name: "Admin_RDV" },
  { ref: "admin_lib", name: "Admin_lib" },
  { ref: "admin_impots", name: "Admin_Impots" },
  { ref: "perso_courses", name: "Perso_Courses" },
  { ref: "contrats_challenge", name: "Contrats_Challenge" },
  { ref: "kdo_help", name: "kdo_help" },
];

/** Permissions non accordées lors d'une autorisation partielle. */
const MISSING_PERMISSIONS: Record<GoogleConnector, string[]> = {
  google_drive: ["Créer et déplacer des fichiers dans les dossiers dédiés"],
  google_calendar: ["Consulter et créer des événements dans votre agenda"],
};

const APPOINTMENT_PATTERN = /rendez-vous|\brdv\b|réserv/i;
const EMAIL_PATTERN = /\be-?mail\b|\bmail\b|écri[st]|envoie/i;
/** Mot-clé de démonstration : l'action proposée échouera à l'exécution (US-39 RF9). */
const FAILURE_PATTERN = /[ée]chec/i;
/** Mot-clé de démonstration : l'agent ne répond jamais (attentes de 30 s et de 2 min, US-38 RF9, RF10). */
const SILENCE_PATTERN = /silence/i;

/**
 * Simulateur de Digitorn. Il garde les conversations en mémoire et imite le comportement
 * attendu : réponse différée, proposition d'action à valider pour les rendez-vous et les emails,
 * exécution unique d'une action validée, alimentation du carnet de bord.
 */
export class MockDigitorn implements DigitornClient {
  private readonly conversations = new Map<string, ChatEvent[]>();
  private readonly proposals = new Map<string, { proposal: ActionProposal; userRef: string; agentRef: string; willFail: boolean; execute?: () => Promise<void> }>();
  private readonly requests = new Set<string>();
  private readonly logbook: LogbookItem[] = [];
  private readonly profileInfo = new Map<string, Record<string, string | string[]>>();
  private readonly authorizations = new Map<string, { connector: GoogleConnector; email: string; profileRef: string; result: AuthorizationResult }>();
  private readonly agentConfigurations = new Map<string, AgentConfiguration>();
  readonly revocations: { profileRef: string; connector: GoogleConnector; email: string }[] = [];
  private readonly brains: Map<string, AgentBrain>;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly replyDelayMs: number;
  private readonly executionDelayMs: number;
  private readonly now: () => Date;

  constructor(options: MockOptions = {}) {
    this.replyDelayMs = options.replyDelayMs ?? 1500;
    this.executionDelayMs = options.executionDelayMs ?? 1000;
    this.now = options.now ?? (() => new Date());
    this.brains = new Map((options.brains ?? []).map((brain) => [brain.ref, brain]));
  }

  /**
   * Message d'un agent hors de toute demande (rappel d'occasion), visible dans le tchat de l'application.
   * Hypothèse d'API à confirmer avec Digitorn : hors simulateur, ce message devra passer par leur plateforme.
   */
  postAgentMessage(userRef: string, agentRef: string, text: string): void {
    this.push(userRef, agentRef, { type: "agent_message", id: randomUUID(), requestId: "", text, at: this.now().toISOString() });
  }

  /** Attend les réponses d'agents locaux encore en cours (tests). */
  async settle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }

  async listHostedAgents(): Promise<HostedAgent[]> {
    return MOCK_HOSTED_AGENTS.map((agent) => ({ ...agent }));
  }

  async beginAuthorization(input: { state: string; profileRef: string; connector: GoogleConnector; email: string; returnUrl: string }) {
    this.authorizations.set(input.state, { connector: input.connector, email: input.email, profileRef: input.profileRef, result: { status: "pending" } });
    const base = env().APP_URL.replace(/\/$/, "");
    return { consentUrl: `${base}/dev/google?etat=${encodeURIComponent(input.state)}` };
  }

  async getAuthorizationResult(state: string): Promise<AuthorizationResult> {
    return this.authorizations.get(state)?.result ?? { status: "pending" };
  }

  /** Simule le choix de l'utilisateur sur la page de consentement Google. */
  completeConsent(state: string, outcome: "authorized" | "partial" | "denied", accountEmail?: string): boolean {
    const pending = this.authorizations.get(state);
    if (!pending) return false;
    const missing = outcome === "partial" ? MISSING_PERMISSIONS[pending.connector] : [];
    pending.result = { status: outcome, accountEmail: accountEmail ?? pending.email, missing };
    return true;
  }

  /** Autorisation en attente de consentement, pour la page de développement. */
  pendingAuthorization(state: string) {
    const entry = this.authorizations.get(state);
    return entry ? { connector: entry.connector, email: entry.email } : null;
  }

  async revokeAuthorization(profileRef: string, connector: GoogleConnector, email: string): Promise<void> {
    this.revocations.push({ profileRef, connector, email });
  }

  async updateAgentConfiguration(profileRef: string, agentRef: string, config: AgentConfiguration): Promise<void> {
    this.agentConfigurations.set(key(profileRef, agentRef), structuredClone(config));
  }

  /** Configuration reçue pour un profil et un agent (contrôle dans les tests). */
  agentConfigurationOf(profileRef: string, agentRef: string): AgentConfiguration | undefined {
    return this.agentConfigurations.get(key(profileRef, agentRef));
  }

  async updateProfileInfo(userRef: string, agentRef: string, info: Record<string, string | string[]>): Promise<void> {
    this.profileInfo.set(key(userRef, agentRef), { ...info });
  }

  /** Informations reçues pour un profil et un agent (contrôle dans les tests). */
  profileInfoOf(userRef: string, agentRef: string): Record<string, string | string[]> | undefined {
    return this.profileInfo.get(key(userRef, agentRef));
  }

  async submitRequest(input: SubmitRequestInput): Promise<void> {
    if (this.requests.has(input.requestId)) return; // demande renvoyée : jamais exécutée deux fois
    this.requests.add(input.requestId);

    this.push(input.userRef, input.agentRef, {
      type: "user_message",
      id: randomUUID(),
      requestId: input.requestId,
      text: input.text,
      at: this.now().toISOString(),
      channel: input.channel ?? "web",
    });
    this.log(input.userRef, input.agentRef, "request", input.text, input.context.autoParticipants);
    const brain = this.brains.get(input.agentRef);
    if (brain) this.later(this.replyDelayMs, () => this.track(this.replyWithBrain(input, brain)));
    else if (!SILENCE_PATTERN.test(input.text)) this.later(this.replyDelayMs, () => this.reply(input));
  }

  private track(task: Promise<void>): void {
    const tracked: Promise<void> = task.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /** Réponse d'un agent local, avec l'historique récent de la conversation comme contexte. */
  private async replyWithBrain(input: SubmitRequestInput, brain: AgentBrain): Promise<void> {
    const history: AgentHistoryItem[] = (this.conversations.get(key(input.userRef, input.agentRef)) ?? [])
      .filter((event): event is Extract<ChatEvent, { type: "user_message" | "agent_message" }> => event.type !== "action_proposal" && event.requestId !== input.requestId)
      .slice(-BRAIN_HISTORY)
      .map((event) => ({ role: event.type === "user_message" ? "user" : "agent", text: event.text }));
    let reply: BrainReply;
    try {
      reply = await brain.respond({
        userRef: input.userRef,
        text: input.text,
        context: input.context,
        history,
        today: this.now(),
        timezone: input.timezone ?? "Europe/Paris",
        channel: input.channel ?? "web",
      });
    } catch (error) {
      console.error(`[agents] ${brain.ref} n'a pas pu répondre :`, error);
      reply = { text: BRAIN_FAILURE_MESSAGE, proposals: [] };
    }
    const at = this.now().toISOString();
    this.push(input.userRef, input.agentRef, { type: "agent_message", id: randomUUID(), requestId: input.requestId, text: reply.text, at });
    // Actions sensibles de l'agent local : une carte à valider chacune, exécutée seulement après accord (US-39).
    for (const pending of reply.proposals) {
      const proposal: ActionProposal = { proposalId: randomUUID(), kind: "other", summary: pending.summary, participants: [], status: "pending" };
      this.proposals.set(proposal.proposalId, { proposal, userRef: input.userRef, agentRef: input.agentRef, willFail: false, execute: pending.execute });
      this.push(input.userRef, input.agentRef, { type: "action_proposal", id: randomUUID(), requestId: input.requestId, proposal, at });
    }
  }

  /** Exécution d'une action d'agent local validée par la personne. */
  private async runExecution(entry: { proposal: ActionProposal; userRef: string; agentRef: string; execute?: () => Promise<void> }): Promise<void> {
    try {
      await entry.execute?.();
      entry.proposal.status = "succeeded";
      this.log(entry.userRef, entry.agentRef, "action_done", entry.proposal.summary, entry.proposal.participants);
    } catch (error) {
      console.error(`[agents] action « ${entry.proposal.summary} » échouée :`, error);
      entry.proposal.status = "failed";
    }
  }

  async getConversation(userRef: string, agentRef: string): Promise<ChatEvent[]> {
    return [...(this.conversations.get(key(userRef, agentRef)) ?? [])];
  }

  async decideAction(input: DecideActionInput): Promise<ActionProposal> {
    const entry = this.proposals.get(input.proposalId);
    if (!entry) throw new Error("Proposition inconnue");
    if (entry.userRef !== input.userRef) throw new Error("Seul l'auteur de la demande peut décider (US-39 RF5)");

    const { proposal } = entry;
    if (proposal.status !== "pending") return { ...proposal }; // décision déjà prise : sans effet

    if (input.decision === "refuse") {
      proposal.status = "refused";
      this.log(entry.userRef, entry.agentRef, "action_refused", proposal.summary, proposal.participants);
      this.push(entry.userRef, entry.agentRef, {
        type: "agent_message",
        id: randomUUID(),
        requestId: "",
        text: "C'est annulé. Voulez-vous que je modifie la demande ?",
        at: this.now().toISOString(),
      });
      return { ...proposal };
    }

    proposal.status = "executing";
    this.log(entry.userRef, entry.agentRef, "action_validated", proposal.summary, proposal.participants);
    if (entry.execute) {
      this.later(this.executionDelayMs, () => this.track(this.runExecution(entry)));
      return { ...proposal };
    }
    this.later(this.executionDelayMs, () => {
      if (entry.willFail) {
        proposal.status = "failed";
        return;
      }
      proposal.status = "succeeded";
      this.log(entry.userRef, entry.agentRef, "action_done", proposal.summary, proposal.participants);
    });
    return { ...proposal };
  }

  /** Échecs de classement à simuler (tests) ; un nom de fichier contenant « echec-classement » échoue aussi (démonstration). */
  classificationFailures = 0;
  readonly classified: ClassifyDocumentInput[] = [];

  async classifyDocument(input: ClassifyDocumentInput): Promise<{ driveFileRef: string; alreadyClassified: boolean }> {
    if (this.classificationFailures > 0) {
      this.classificationFailures--;
      throw new Error("Classement impossible (Drive injoignable)");
    }
    if (/echec-classement/i.test(input.fileName)) throw new Error("Classement impossible (démonstration)");
    this.classified.push(input);
    const existing = await drive().findByContent(input.accountId, input.content);
    if (existing) return { driveFileRef: existing.fileId, alreadyClassified: true };
    const { fileId } = await drive().upload({ accountId: input.accountId, fileName: input.fileName, mimeType: input.mimeType, content: input.content });
    return { driveFileRef: fileId, alreadyClassified: false };
  }

  async fetchLogbook(since: Date): Promise<LogbookItem[]> {
    return this.logbook.filter((item) => new Date(item.occurredAt) > since).map((item) => ({ ...item }));
  }

  async eraseConversation(userRef: string, agentRef: string): Promise<void> {
    this.brains.get(agentRef)?.forget(userRef);
    const k = key(userRef, agentRef);
    for (const [id, entry] of this.proposals) {
      if (key(entry.userRef, entry.agentRef) !== k) continue;
      if (entry.proposal.status === "pending") entry.proposal.status = "abandoned"; // US-39 RF8
      this.proposals.delete(id);
    }
    this.conversations.delete(k);
  }

  /** Profils entièrement supprimés chez Digitorn, et entrées de carnet anonymisées (contrôle dans les tests). */
  readonly deletedProfiles: string[] = [];
  readonly anonymizedProfiles: string[] = [];

  async exportUserData(userRef: string): Promise<DigitornUserData> {
    const conversations: DigitornUserData["conversations"] = {};
    for (const [k, events] of this.conversations) {
      if (k.startsWith(`${userRef}|`)) conversations[k.slice(userRef.length + 1)] = structuredClone(events);
    }
    const configurations: DigitornUserData["configurations"] = {};
    for (const [k, config] of this.agentConfigurations) {
      if (k.startsWith(`${userRef}|`)) configurations[k.slice(userRef.length + 1)] = structuredClone(config);
    }
    const profileInfo: DigitornUserData["profileInfo"] = {};
    for (const [k, info] of this.profileInfo) {
      if (k.startsWith(`${userRef}|`)) profileInfo[k.slice(userRef.length + 1)] = structuredClone(info);
    }
    return { conversations, configurations, profileInfo };
  }

  async anonymizeLogbook(userRef: string): Promise<void> {
    this.anonymizedProfiles.push(userRef);
    for (const item of this.logbook) {
      if (item.userRef === userRef) item.text = "(données personnelles retirées)";
    }
  }

  async deleteProfile(userRef: string): Promise<void> {
    this.deletedProfiles.push(userRef);
    for (const brain of this.brains.values()) brain.forget(userRef);
    for (const k of [...this.agentConfigurations.keys()]) {
      if (k.startsWith(`${userRef}|`)) this.agentConfigurations.delete(k);
    }
    for (const k of [...this.profileInfo.keys()]) {
      if (k.startsWith(`${userRef}|`)) this.profileInfo.delete(k);
    }
    for (const k of [...this.conversations.keys()]) {
      if (k.startsWith(`${userRef}|`)) this.conversations.delete(k);
    }
    for (let i = this.logbook.length - 1; i >= 0; i--) {
      if (this.logbook[i].userRef === userRef) this.logbook.splice(i, 1);
    }
  }

  private reply(input: SubmitRequestInput): void {
    const at = this.now().toISOString();
    const wantsAppointment = APPOINTMENT_PATTERN.test(input.text);
    const wantsEmail = !wantsAppointment && EMAIL_PATTERN.test(input.text);

    if (!wantsAppointment && !wantsEmail) {
      this.push(input.userRef, input.agentRef, {
        type: "agent_message",
        id: randomUUID(),
        requestId: input.requestId,
        text: `C'est noté. Je m'occupe de : « ${input.text.slice(0, 120)} ».`,
        at,
      });
      return;
    }

    const proposal: ActionProposal = wantsEmail
      ? {
          proposalId: randomUUID(),
          kind: "email",
          summary: "Envoyer l'email rédigé",
          participants: [],
          recipient: "destinataire@exemple.fr",
          subject: "Votre demande",
          draftPreview: `Madame, Monsieur, ${input.text.slice(0, 100)}…`,
          status: "pending",
        }
      : {
          proposalId: randomUUID(),
          kind: "appointment",
          summary: "Créer le rendez-vous",
          when: nextWorkingDayAt10(this.now()).toISOString(),
          place: "À préciser",
          participants: [...input.context.autoParticipants],
          status: "pending",
        };
    this.proposals.set(proposal.proposalId, { proposal, userRef: input.userRef, agentRef: input.agentRef, willFail: FAILURE_PATTERN.test(input.text) });
    this.push(input.userRef, input.agentRef, {
      type: "agent_message",
      id: randomUUID(),
      requestId: input.requestId,
      text: wantsEmail
        ? "J'ai préparé le brouillon et l'ai envoyé dans votre boîte de validation. Validez-vous l'envoi ?"
        : "Voici ce que je propose. Validez-vous ?",
      at,
    });
    this.push(input.userRef, input.agentRef, {
      type: "action_proposal",
      id: randomUUID(),
      requestId: input.requestId,
      proposal,
      at,
    });
  }

  private push(userRef: string, agentRef: string, event: ChatEvent): void {
    const k = key(userRef, agentRef);
    const list = this.conversations.get(k) ?? [];
    list.push(event);
    this.conversations.set(k, list);
  }

  private log(userRef: string, agentRef: string, type: LogbookItem["type"], text: string, participants: string[]): void {
    const results: Partial<Record<LogbookItem["type"], string>> = {
      request: "Transmise à l'agent",
      action_done: "Action exécutée",
      action_validated: "Validée par la personne",
      action_refused: "Aucune action réalisée",
    };
    this.logbook.push({
      result: results[type],
      externalId: randomUUID(),
      userRef,
      agentRef,
      type,
      text,
      occurredAt: this.now().toISOString(),
      participants: [...participants],
    });
  }

  /** Traitement en arrière-plan, comme chez Digitorn ; exécuté tout de suite si le délai vaut 0. */
  private later(delayMs: number, task: () => void): void {
    if (delayMs <= 0) task();
    else setTimeout(task, delayMs);
  }
}

function key(userRef: string, agentRef: string): string {
  return `${userRef}|${agentRef}`;
}

/** Prochain jour ouvré à 10 h, heure de Paris. */
function nextWorkingDayAt10(from: Date): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  const parisHour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)),
    ),
  );
  const offset = parisHour - 12; // +1 en hiver, +2 en été
  d.setUTCHours(10 - offset, 0, 0, 0);
  return d;
}
