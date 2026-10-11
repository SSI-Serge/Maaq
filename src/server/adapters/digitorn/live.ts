import { randomUUID } from "node:crypto";
import { DigitornError } from "./errors";
import type {
  ActionProposal,
  AgentCard,
  AgentConfiguration,
  AuthorizationResult,
  ChatEvent,
  ClassifyDocumentInput,
  DecideActionInput,
  DigitornClient,
  DigitornUserData,
  GoogleConnector,
  LogbookItem,
  OpenChatInput,
  OpenedChat,
  SubmitRequestInput,
} from "./types";

/**
 * Client de l'API réelle de Digitorn (https://docs.digitorn.ai/docs/api/api-index).
 *
 * Un projet Digitorn par agent : la clé secrète (sk_…) et l'application publiée sont propres à chaque agent. Cette classe
 * n'appelle Digitorn que pour ce que la documentation décrit aujourd'hui (recherche d'agent, lancement du tchat embarqué,
 * fermeture des accès, effacement des conversations, suppression d'un utilisateur). Tout le reste (connecteurs Google,
 * carnet de bord, classement des documents, export, anonymisation) reste confié au simulateur, jusqu'à ce que Digitorn le
 * documente. Un agent sans projet (démonstration) passe entièrement par le simulateur.
 */

/** Clé secrète et domaine personnalisé du projet Digitorn d'un agent. */
export interface ProjectAccess {
  apiKey: string;
  appUrl: string | null;
}

export interface LiveOptions {
  /** Adresse de l'API, par exemple https://api.digitorn.ai/v1 (sans « / » final). */
  baseUrl: string;
  /** Projet d'un agent publié ; null si l'agent n'a pas de projet Digitorn réel. */
  projectOf(agentRef: string): Promise<ProjectAccess | null>;
  /** Tous les agents qui ont un projet, pour ce qui concerne un profil dans chaque projet. */
  allProjects(): Promise<{ agentRef: string; apiKey: string }[]>;
  /** Simulateur pour ce que Digitorn n'a pas encore documenté. */
  fallback: DigitornClient;
  fetch?: typeof fetch;
  /** Délai d'attente d'une réponse (15 secondes : comportement CC-3). */
  timeoutMs?: number;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Profil au nom duquel on agit (en-tête Digitorn-User) : nécessaire pour lire ou effacer ses conversations. */
  user?: string;
  idempotencyKey?: string;
}

/** Part de l'identifiant « <projet>:<agent> » qui désigne l'agent chez Digitorn. */
export function digitornAgentId(ref: string): string {
  const separator = ref.indexOf(":");
  return separator < 0 ? ref : ref.slice(separator + 1);
}

function projectIdOf(ref: string): string | null {
  const separator = ref.indexOf(":");
  return separator < 0 ? null : ref.slice(0, separator);
}

/** Garde-fou : 50 pages de 100 conversations au plus par effacement ; au-delà, MAAQ réessaiera. */
const MAX_ERASE_ROUNDS = 50;

const warned = new Set<string>();

export class LiveDigitorn implements DigitornClient {
  readonly embeddedChat = true;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: LiveOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Simulateur utilisé pour ce que Digitorn n'a pas encore documenté (pages de développement). */
  get simulator(): DigitornClient {
    return this.options.fallback;
  }

  // -------------------------------------------------------------------------
  // Appel HTTP
  // -------------------------------------------------------------------------

  private async request<T>(apiKey: string, method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const traceId = `maaq-${randomUUID()}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "X-Trace-Id": traceId };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.user) headers["Digitorn-User"] = options.user;
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new DigitornError("unreachable", "Digitorn ne répond pas.", 0, true, null, traceId);
    }
    if (!response.ok) throw await errorOf(response, traceId);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Projets distincts (une clé = un projet), avec l'agent qui sert à les désigner dans les messages d'erreur. */
  private async projects(): Promise<{ agentRef: string; apiKey: string }[]> {
    const seen = new Set<string>();
    return (await this.options.allProjects()).filter((project) => !seen.has(project.apiKey) && seen.add(project.apiKey));
  }

  private async inFallback<T>(operation: string, call: () => Promise<T>): Promise<T> {
    if (!warned.has(operation)) {
      warned.add(operation);
      console.warn(`[digitorn] « ${operation} » n'est pas encore décrit par la documentation de Digitorn : simulé.`);
    }
    return call();
  }

  // -------------------------------------------------------------------------
  // Agents (US-45)
  // -------------------------------------------------------------------------

  private async projectInfo(apiKey: string): Promise<{ id: string; name: string; mode: "test" | "production" }> {
    const me = await this.request<{ kind?: string; project?: { id: string; name: string; mode?: string } }>(apiKey, "GET", "/me");
    if (me.kind !== "project" || !me.project) {
      throw new DigitornError("not_a_project_key", "Cette clé n'est pas la clé secrète d'un projet Digitorn.", 403, false);
    }
    return { id: me.project.id, name: me.project.name, mode: me.project.mode === "test" ? "test" : "production" };
  }

  async lookupAgent(input: { name: string; apiKey?: string }): Promise<AgentCard> {
    if (!input.apiKey) {
      // Sans clé, seuls les agents simulés sont trouvables ; un autre nom demande la clé du projet.
      try {
        return await this.options.fallback.lookupAgent(input);
      } catch (error) {
        if (error instanceof DigitornError && error.code === "agent_not_found") {
          throw new DigitornError("key_required", "La clé secrète du projet Digitorn de cet agent est nécessaire pour le trouver.", 422, false);
        }
        throw error;
      }
    }
    const [found, project] = await Promise.all([
      this.request<{ id: string; name: string; description?: string; kind?: string; agent?: { id: string; name: string; description?: string; kind?: string } }>(
        input.apiKey,
        "GET",
        "/agents/lookup",
        { query: { name: input.name } },
      ),
      this.projectInfo(input.apiKey),
    ]);
    const agent = found.agent ?? found;
    return {
      ref: `${project.id}:${agent.id}`,
      name: agent.name,
      description: agent.description ?? "",
      kind: agent.kind ?? "chat",
      project: { name: project.name, mode: project.mode },
    };
  }

  async getAgent(input: { ref: string; apiKey?: string }): Promise<AgentCard | null> {
    if (!input.apiKey) return this.options.fallback.getAgent(input);
    const projectId = projectIdOf(input.ref);
    if (!projectId) return null;
    const project = await this.projectInfo(input.apiKey);
    if (project.id !== projectId) return null; // la clé n'est pas celle du projet de cet agent
    try {
      const agent = await this.request<{ id: string; name: string; description?: string; kind?: string }>(
        input.apiKey,
        "GET",
        `/agents/${encodeURIComponent(digitornAgentId(input.ref))}`,
      );
      return { ref: input.ref, name: agent.name, description: agent.description ?? "", kind: agent.kind ?? "chat", project: { name: project.name, mode: project.mode } };
    } catch (error) {
      if (error instanceof DigitornError && error.status === 404) return null;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Tchat embarqué
  // -------------------------------------------------------------------------

  async openChat(input: OpenChatInput): Promise<OpenedChat | null> {
    const project = await this.options.projectOf(input.agentRef);
    if (!project) return null;
    const launched = await this.request<{ url?: string; expires_at?: string }>(project.apiKey, "POST", `/users/${encodeURIComponent(input.userRef)}/launch`, {
      body: { name: input.name, claims: input.claims, ...(isCustomDomain(project.appUrl) ? { app_url: project.appUrl } : {}) },
    });
    if (!launched.url) {
      throw new DigitornError("app_not_published", "L'application de cet agent n'est pas encore publiée chez Digitorn.", 409, false);
    }
    return { url: launched.url, expiresAt: launched.expires_at ?? new Date(Date.now() + 120_000).toISOString() };
  }

  async closeAccess(userRef: string, agentRef: string | null): Promise<void> {
    const targets = agentRef === null ? await this.projects() : await this.projectsOf(agentRef);
    if (agentRef !== null && targets.length === 0) return this.options.fallback.closeAccess(userRef, agentRef);
    const failures: string[] = [];
    for (const target of targets) {
      try {
        await this.request(target.apiKey, "POST", `/users/${encodeURIComponent(userRef)}/sign-out`);
      } catch (error) {
        if (!isNotFound(error)) failures.push(`${target.agentRef} : ${describe(error)}`);
      }
    }
    if (agentRef === null) await this.options.fallback.closeAccess(userRef, null);
    if (failures.length) throw new Error(`Fermeture des accès chez Digitorn en échec (${failures.join(" ; ")})`);
  }

  private async projectsOf(agentRef: string): Promise<{ agentRef: string; apiKey: string }[]> {
    const project = await this.options.projectOf(agentRef);
    return project ? [{ agentRef, apiKey: project.apiKey }] : [];
  }

  // -------------------------------------------------------------------------
  // Conversations et profils (US-9, 43, 53, 56, 58)
  // -------------------------------------------------------------------------

  async eraseConversation(userRef: string, agentRef: string): Promise<void> {
    const project = await this.options.projectOf(agentRef);
    if (!project) return this.options.fallback.eraseConversation(userRef, agentRef);
    const agent = digitornAgentId(agentRef);
    // On relit toujours la première page jusqu'à ce qu'elle soit vide : supprimer en parcourant avec un curseur ferait
    // sauter des conversations si Digitorn compte le curseur en position.
    for (let round = 0; round < MAX_ERASE_ROUNDS; round++) {
      let page: { data?: { id: string }[] };
      try {
        page = await this.request(project.apiKey, "GET", "/conversations", { query: { agent, limit: 100 }, user: userRef });
      } catch (error) {
        if (isNotFound(error)) return; // utilisateur inconnu chez Digitorn : rien à effacer
        throw error;
      }
      const conversations = page.data ?? [];
      if (conversations.length === 0) return;
      for (const conversation of conversations) {
        try {
          await this.request(project.apiKey, "DELETE", `/conversations/${encodeURIComponent(conversation.id)}`, { user: userRef });
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    }
    throw new Error(`Effacement des conversations chez Digitorn incomplet (${agentRef}) : il reste des conversations après ${MAX_ERASE_ROUNDS} pages`);
  }

  async deleteProfile(userRef: string): Promise<void> {
    const failures: string[] = [];
    for (const target of await this.projects()) {
      try {
        await this.request(target.apiKey, "DELETE", `/users/${encodeURIComponent(userRef)}`);
      } catch (error) {
        if (!isNotFound(error)) failures.push(`${target.agentRef} : ${describe(error)}`);
      }
    }
    await this.options.fallback.deleteProfile(userRef);
    if (failures.length) throw new Error(`Suppression chez Digitorn en échec (${failures.join(" ; ")})`);
  }

  // -------------------------------------------------------------------------
  // Informations et configuration : elles voyagent avec le lancement du tchat (claims, contexte)
  // -------------------------------------------------------------------------

  async updateProfileInfo(userRef: string, agentRef: string, info: Record<string, string | string[]>): Promise<void> {
    if (await this.options.projectOf(agentRef)) return;
    return this.options.fallback.updateProfileInfo(userRef, agentRef, info);
  }

  async updateAgentConfiguration(profileRef: string, agentRef: string, config: AgentConfiguration): Promise<void> {
    if (await this.options.projectOf(agentRef)) return;
    return this.options.fallback.updateAgentConfiguration(profileRef, agentRef, config);
  }

  // -------------------------------------------------------------------------
  // Pas encore décrit par la documentation de Digitorn : simulé
  // -------------------------------------------------------------------------

  beginAuthorization(input: { state: string; profileRef: string; connector: GoogleConnector; email: string; returnUrl: string }): Promise<{ consentUrl: string }> {
    return this.inFallback("connexion Google", () => this.options.fallback.beginAuthorization(input));
  }
  getAuthorizationResult(state: string): Promise<AuthorizationResult> {
    return this.inFallback("connexion Google", () => this.options.fallback.getAuthorizationResult(state));
  }
  revokeAuthorization(profileRef: string, connector: GoogleConnector, email: string): Promise<void> {
    return this.inFallback("connexion Google", () => this.options.fallback.revokeAuthorization(profileRef, connector, email));
  }
  submitRequest(input: SubmitRequestInput): Promise<void> {
    return this.options.fallback.submitRequest(input);
  }
  getConversation(userRef: string, agentRef: string): Promise<ChatEvent[]> {
    return this.options.fallback.getConversation(userRef, agentRef);
  }
  decideAction(input: DecideActionInput): Promise<ActionProposal> {
    return this.options.fallback.decideAction(input);
  }
  classifyDocument(input: ClassifyDocumentInput): Promise<{ driveFileRef: string; alreadyClassified: boolean }> {
    return this.inFallback("classement des documents", () => this.options.fallback.classifyDocument(input));
  }
  fetchLogbook(since: Date): Promise<LogbookItem[]> {
    return this.inFallback("carnet de bord", () => this.options.fallback.fetchLogbook(since));
  }
  exportUserData(userRef: string): Promise<DigitornUserData> {
    return this.inFallback("export des données", () => this.options.fallback.exportUserData(userRef));
  }
  anonymizeLogbook(userRef: string): Promise<void> {
    return this.inFallback("anonymisation du carnet", () => this.options.fallback.anonymizeLogbook(userRef));
  }
}

/** L'adresse publiée par défaut (*.digitorn.app) se déduit du projet ; seul un domaine personnalisé se transmet au lancement. */
function isCustomDomain(appUrl: string | null): appUrl is string {
  if (!appUrl) return false;
  try {
    return !new URL(appUrl).hostname.endsWith(".digitorn.app");
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof DigitornError && error.status === 404;
}

function describe(error: unknown): string {
  return error instanceof DigitornError ? `${error.code}${error.traceId ? ` (suivi ${error.traceId})` : ""}` : String(error);
}

/** Erreur au format de Digitorn : { error: { code, message, retryable, retry_after_seconds, trace_id } }. */
async function errorOf(response: Response, traceId: string): Promise<DigitornError> {
  let body: { error?: { code?: string; message?: string; retryable?: boolean; retry_after_seconds?: number | null; trace_id?: string } } = {};
  try {
    body = JSON.parse(await response.text());
  } catch {
    // corps absent ou illisible : on s'appuie sur le code HTTP
  }
  const detail = body.error ?? {};
  const retryAfter = detail.retry_after_seconds ?? (Number(response.headers.get("Retry-After")) || null);
  return new DigitornError(
    detail.code ?? `http_${response.status}`,
    detail.message ?? `Digitorn a répondu ${response.status}.`,
    response.status,
    detail.retryable ?? (response.status >= 500 || response.status === 429),
    retryAfter,
    detail.trace_id ?? traceId,
  );
}
