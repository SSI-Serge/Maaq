import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Faux serveur Digitorn qui reproduit les appels décrits par https://docs.digitorn.ai/docs/api/api-index :
 * un projet par clé secrète, des agents, des utilisateurs, des conversations. Il garde la trace des appels reçus.
 */

export interface FakeAgent {
  id: string;
  name: string;
  description?: string;
  kind?: string;
}

export interface FakeProject {
  id: string;
  name: string;
  mode?: "test" | "production";
  /** Sans application publiée, le lien de lancement n'a pas d'adresse. */
  published?: boolean;
  agents: FakeAgent[];
  users: Set<string>;
  conversations: { id: string; agent: string; user: string }[];
}

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

const plain = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

export function fakeProject(id: string, agents: FakeAgent[], options: Partial<FakeProject> = {}): FakeProject {
  return { id, name: `Projet ${id}`, mode: "test", published: true, agents, users: new Set(), conversations: [], ...options };
}

export async function startFakeDigitorn(projects: Record<string, FakeProject>, options: { pageSize?: number; delayMs?: number } = {}) {
  const calls: RecordedCall[] = [];
  /** Réponse imposée à la prochaine requête (panne simulée). */
  let failNext: { status: number; body?: unknown; headers?: Record<string, string>; path?: string } | null = null;
  let tickets = 0;

  const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const error = (res: http.ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    send(res, status, { error: { code, message, retryable: status >= 500 || status === 429, trace_id: "tr_fake", ...extra } });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const call: RecordedCall = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    calls.push(call);

    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (failNext && (!failNext.path || failNext.path === url.pathname.slice("/v1".length))) {
      const failure = failNext;
      failNext = null;
      return send(res, failure.status, failure.body ?? { error: { code: "boom", message: "Panne simulée", retryable: failure.status >= 500, trace_id: "tr_fake" } }, failure.headers);
    }

    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const project = projects[key];
    if (!project) return error(res, 401, "invalid_key", "Clé inconnue ou révoquée.");
    if (req.headers.origin) return error(res, 403, "server_only", "Clé secrète refusée depuis un navigateur.");

    const path = url.pathname.replace(/^\/v1/, "");
    const method = call.method;

    if (method === "GET" && path === "/me") return send(res, 200, { kind: "project", project: { id: project.id, name: project.name, mode: project.mode } });

    if (method === "GET" && path === "/agents/lookup") {
      const wanted = plain(url.searchParams.get("name") ?? "");
      const found = project.agents.filter((a) => plain(a.name) === wanted);
      if (found.length === 0) return error(res, 404, "agent_not_found", "Aucun agent ne porte ce nom.");
      if (found.length > 1) return error(res, 409, "agent_ambiguous", "Plusieurs agents portent ce nom.", { ids: found.map((a) => a.id) });
      return send(res, 200, { kind: "chat", description: "", ...found[0] });
    }
    const agentMatch = path.match(/^\/agents\/([^/]+)$/);
    if (method === "GET" && agentMatch) {
      const agent = project.agents.find((a) => a.id === decodeURIComponent(agentMatch[1]));
      return agent ? send(res, 200, { kind: "chat", description: "", ...agent }) : error(res, 404, "agent_not_found", "Agent inconnu.");
    }

    const userMatch = path.match(/^\/users\/([^/]+)(\/launch|\/sign-out)?$/);
    if (userMatch) {
      const userId = decodeURIComponent(userMatch[1]);
      if (method === "POST" && userMatch[2] === "/launch") {
        const created = !project.users.has(userId);
        project.users.add(userId);
        const body = call.body as { name?: string } | undefined;
        const ticket = `ticket-${++tickets}`;
        return send(res, 200, {
          ...(project.published === false ? {} : { url: `https://${project.id}.digitorn.app/#${ticket}` }),
          fragment: ticket,
          expires_at: "2026-10-11T10:02:00Z",
          user: { id: userId, name: body?.name ?? null, created },
        });
      }
      if (method === "POST" && userMatch[2] === "/sign-out") {
        return project.users.has(userId) ? send(res, 200, {}) : error(res, 404, "user_not_found", "Utilisateur inconnu.");
      }
      if (method === "DELETE" && !userMatch[2]) {
        if (!project.users.delete(userId)) return error(res, 404, "user_not_found", "Utilisateur inconnu.");
        project.conversations = project.conversations.filter((c) => c.user !== userId);
        return send(res, 200, {});
      }
    }

    if (method === "GET" && path === "/conversations") {
      const user = String(req.headers["digitorn-user"] ?? "");
      if (!project.users.has(user)) return error(res, 404, "user_not_found", "Utilisateur inconnu.");
      const agent = url.searchParams.get("agent");
      const all = project.conversations.filter((c) => c.user === user && (!agent || c.agent === agent));
      const size = Math.min(Number(url.searchParams.get("limit") ?? 20), options.pageSize ?? 20);
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const page = all.slice(from, from + size);
      return send(res, 200, { data: page.map((c) => ({ id: c.id, agent: c.agent })), next_cursor: from + size < all.length ? String(from + size) : null });
    }
    const conversationMatch = path.match(/^\/conversations\/([^/]+)$/);
    if (method === "DELETE" && conversationMatch) {
      const id = decodeURIComponent(conversationMatch[1]);
      const index = project.conversations.findIndex((c) => c.id === id && c.user === String(req.headers["digitorn-user"] ?? ""));
      if (index < 0) return error(res, 404, "conversation_not_found", "Conversation inconnue.");
      project.conversations.splice(index, 1);
      return send(res, 200, {});
    }

    return error(res, 404, "not_found", `Appel non prévu : ${method} ${path}`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    /** Panne imposée à la prochaine requête, ou à la prochaine requête vers ce chemin (sans « /v1 »). */
    failNext(failure: { status: number; body?: unknown; headers?: Record<string, string>; path?: string }) {
      failNext = failure;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
