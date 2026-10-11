import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DigitornError } from "@/server/adapters/digitorn/errors";
import { LiveDigitorn, digitornAgentId } from "@/server/adapters/digitorn/live";
import { MockDigitorn } from "@/server/adapters/digitorn/mock";
import { fakeProject, startFakeDigitorn, type FakeProject } from "./helpers/fake-digitorn";

/** Client réel de Digitorn : chaque appel est vérifié contre un faux serveur qui reproduit l'API documentée. */

const KEY_LIB = "sk_lib_0123456789";
const KEY_TAX = "sk_tax_0123456789";
const KEY_OLD = "sk_revoquee_0123456789";
const USER = "maaq-3a9d6e2c-1b44-4f0a-8c71-5d2e9b7a0f13";

let projects: Record<string, FakeProject>;
let server: Awaited<ReturnType<typeof startFakeDigitorn>>;
let simulator: MockDigitorn;

/** Agents du catalogue : deux agents de projets différents, un agent sans projet (démonstration). */
const access: Record<string, { apiKey: string; appUrl: string | null }> = {
  "prj_lib:agent_lib": { apiKey: KEY_LIB, appUrl: null },
  "prj_tax:agent_tax": { apiKey: KEY_TAX, appUrl: "https://impots.exemple.fr" },
  "prj_lib:agent_lib_bis": { apiKey: KEY_LIB, appUrl: "https://bcac-qx42y7yq112zy-d600d2.digitorn.app" },
};

function client(options: { timeoutMs?: number; baseUrl?: string } = {}) {
  return new LiveDigitorn({
    baseUrl: options.baseUrl ?? server.baseUrl,
    projectOf: async (agentRef) => access[agentRef] ?? null,
    allProjects: async () => Object.entries(access).map(([agentRef, project]) => ({ agentRef, apiKey: project.apiKey })),
    fallback: simulator,
    timeoutMs: options.timeoutMs,
  });
}

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  projects = {};
  server = await startFakeDigitorn(projects, { pageSize: 2 });
});
afterAll(async () => {
  await server.close();
  vi.restoreAllMocks();
});
beforeEach(() => {
  simulator = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0 });
  server.calls.length = 0;
  for (const key of Object.keys(projects)) delete projects[key];
  projects[KEY_LIB] = fakeProject("prj_lib", [
    { id: "agent_lib", name: "Admin_lib", description: "Prend vos rendez-vous." },
    { id: "agent_lib_bis", name: "Admin_lib_bis" },
    { id: "agent_double_1", name: "Doublon" },
    { id: "agent_double_2", name: "doublon" },
  ]);
  projects[KEY_TAX] = fakeProject("prj_tax", [{ id: "agent_tax", name: "Admin_Impôts" }], { name: "Impôts", mode: "production" });
});

async function failureOf(promise: Promise<unknown>): Promise<DigitornError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DigitornError) return error;
    throw error;
  }
  throw new Error("échec attendu");
}

describe("recherche d'un agent par son nom (US-45)", () => {
  it("trouve l'agent sans tenir compte des majuscules ni des accents, et l'identifie par son projet", async () => {
    const card = await client().lookupAgent({ name: "  admin_lib ", apiKey: KEY_LIB });
    expect(card).toEqual({ ref: "prj_lib:agent_lib", name: "Admin_lib", description: "Prend vos rendez-vous.", kind: "chat", project: { name: "Projet prj_lib", mode: "test" } });
    expect((await client().lookupAgent({ name: "ADMIN_IMPOTS", apiKey: KEY_TAX })).ref).toBe("prj_tax:agent_tax");
    expect((await client().lookupAgent({ name: "admin_impots", apiKey: KEY_TAX })).project?.mode).toBe("production");
  });

  it("envoie la clé secrète en en-tête, jamais dans l'adresse, avec un identifiant de suivi", async () => {
    await client().lookupAgent({ name: "Admin_lib", apiKey: KEY_LIB });
    expect(server.calls.length).toBeGreaterThan(0);
    for (const call of server.calls) {
      expect(call.headers.authorization).toBe(`Bearer ${KEY_LIB}`);
      expect(call.headers["x-trace-id"]).toMatch(/^maaq-[0-9a-f-]{36}$/);
      expect(call.path + call.query.toString()).not.toContain(KEY_LIB);
      expect(call.headers.origin).toBeUndefined();
    }
  });

  it("nom inconnu, nom en double, clé refusée : des erreurs que MAAQ sait expliquer", async () => {
    expect((await failureOf(client().lookupAgent({ name: "Inconnu", apiKey: KEY_LIB }))).code).toBe("agent_not_found");
    expect((await failureOf(client().lookupAgent({ name: "Doublon", apiKey: KEY_LIB }))).code).toBe("agent_ambiguous");
    const refused = await failureOf(client().lookupAgent({ name: "Admin_lib", apiKey: KEY_OLD }));
    expect(refused).toMatchObject({ code: "invalid_key", status: 401, retryable: false, traceId: "tr_fake" });
  });

  it("sans clé : seuls les agents simulés se trouvent, un autre nom réclame la clé du projet", async () => {
    expect((await client().lookupAgent({ name: "Admin_RDV" })).ref).toBe("admin_rdv");
    expect((await failureOf(client().lookupAgent({ name: "Agent-reel" }))).code).toBe("key_required");
    expect(server.calls).toHaveLength(0);
  });

  it("relit un agent par son identifiant : la clé doit être celle du projet de l'agent", async () => {
    expect(await client().getAgent({ ref: "prj_lib:agent_lib", apiKey: KEY_LIB })).toMatchObject({ ref: "prj_lib:agent_lib", name: "Admin_lib" });
    expect(await client().getAgent({ ref: "prj_lib:agent_lib", apiKey: KEY_TAX })).toBeNull(); // clé d'un autre projet
    expect(await client().getAgent({ ref: "prj_lib:inconnu", apiKey: KEY_LIB })).toBeNull();
    expect(await client().getAgent({ ref: "sans-projet", apiKey: KEY_LIB })).toBeNull();
    expect((await client().getAgent({ ref: "admin_rdv" }))?.name).toBe("Admin_RDV"); // simulé
  });

  it("l'identifiant chez Digitorn se déduit de l'identifiant MAAQ", () => {
    expect(digitornAgentId("prj_lib:agent_lib")).toBe("agent_lib");
    expect(digitornAgentId("admin_rdv")).toBe("admin_rdv");
  });
});

describe("tchat embarqué (US-37)", () => {
  it("demande un lien de lancement avec le prénom et les faits vérifiés, sans email", async () => {
    const claims = { app: "maaq", rank: "primary_user", members: [{ rank: "primary_user", name: "Camille" }] };
    const opened = await client().openChat({ userRef: USER, agentRef: "prj_lib:agent_lib", name: "Camille", claims });
    expect(opened).toEqual({ url: "https://prj_lib.digitorn.app/#ticket-1", expiresAt: "2026-10-11T10:02:00Z" });

    const [call] = server.calls;
    expect(call).toMatchObject({ method: "POST", path: `/v1/users/${USER}/launch` });
    expect(call.body).toEqual({ name: "Camille", claims });
    expect(JSON.stringify(call.body)).not.toContain("@");
    expect(call.headers["digitorn-user"]).toBeUndefined();
    expect(projects[KEY_LIB].users.has(USER)).toBe(true);
  });

  it("transmet le domaine personnalisé de l'agent, et lui seul", async () => {
    await client().openChat({ userRef: USER, agentRef: "prj_tax:agent_tax", name: "Camille", claims: {} });
    expect(server.calls[0].headers.authorization).toBe(`Bearer ${KEY_TAX}`);
    expect(server.calls[0].body).toMatchObject({ app_url: "https://impots.exemple.fr" });
    await client().openChat({ userRef: USER, agentRef: "prj_lib:agent_lib", name: "Camille", claims: {} });
    expect(server.calls[1].body).not.toHaveProperty("app_url");
  });

  it("l'adresse publiée par défaut (*.digitorn.app) n'est pas retransmise : Digitorn la déduit du projet", async () => {
    await client().openChat({ userRef: USER, agentRef: "prj_lib:agent_lib_bis", name: "Camille", claims: {} });
    expect(server.calls[0].body).not.toHaveProperty("app_url");
  });

  it("un identifiant de profil est encodé dans l'adresse", async () => {
    await client().openChat({ userRef: "maaq/ ?x", agentRef: "prj_lib:agent_lib", name: "Camille", claims: {} });
    expect(server.calls[0].path).toBe("/v1/users/maaq%2F%20%3Fx/launch");
  });

  it("application non publiée : l'erreur est explicite", async () => {
    projects[KEY_LIB].published = false;
    expect((await failureOf(client().openChat({ userRef: USER, agentRef: "prj_lib:agent_lib", name: "Camille", claims: {} }))).code).toBe("app_not_published");
  });

  it("un agent sans projet n'a pas de tchat embarqué", async () => {
    expect(await client().openChat({ userRef: USER, agentRef: "admin_rdv", name: "Camille", claims: {} })).toBeNull();
    expect(server.calls).toHaveLength(0);
  });

  it("le client annonce le tchat embarqué, le simulateur non", () => {
    expect(client().embeddedChat).toBe(true);
    expect(simulator.embeddedChat).toBe(false);
  });
});

describe("fermeture des accès (US-9, US-53)", () => {
  beforeEach(() => {
    projects[KEY_LIB].users.add(USER);
    projects[KEY_TAX].users.add(USER);
  });

  it("pour un agent : seul son projet est concerné", async () => {
    await client().closeAccess(USER, "prj_tax:agent_tax");
    expect(server.calls.map((c) => `${c.method} ${c.path}|${c.headers.authorization}`)).toEqual([`POST /v1/users/${USER}/sign-out|Bearer ${KEY_TAX}`]);
  });

  it("sans agent : tous les projets, une seule fois chacun, même si deux agents partagent un projet", async () => {
    await client().closeAccess(USER, null);
    expect(server.calls.map((c) => c.headers.authorization).sort()).toEqual([`Bearer ${KEY_LIB}`, `Bearer ${KEY_TAX}`]);
    expect(simulator.closedAccess).toEqual([{ userRef: USER, agentRef: null }]);
  });

  it("un profil inconnu d'un projet n'est pas une erreur", async () => {
    projects[KEY_TAX].users.clear();
    await expect(client().closeAccess(USER, null)).resolves.toBeUndefined();
  });

  it("une panne dans un projet n'empêche pas de fermer les autres, puis remonte pour un nouvel essai", async () => {
    server.failNext({ status: 503 });
    const failure = client().closeAccess(USER, null);
    await expect(failure).rejects.toThrow(/Fermeture des accès chez Digitorn en échec/);
    expect(server.calls).toHaveLength(2); // le second projet a bien été traité
  });

  it("un agent sans projet passe par le simulateur", async () => {
    await client().closeAccess(USER, "admin_rdv");
    expect(server.calls).toHaveLength(0);
    expect(simulator.closedAccess).toEqual([{ userRef: USER, agentRef: "admin_rdv" }]);
  });
});

describe("effacement des conversations (US-43)", () => {
  beforeEach(() => {
    projects[KEY_LIB].users.add(USER);
    projects[KEY_LIB].conversations = [
      ...["c1", "c2", "c3", "c4", "c5"].map((id) => ({ id, agent: "agent_lib", user: USER })),
      { id: "autre-agent", agent: "agent_lib_bis", user: USER },
      { id: "autre-profil", agent: "agent_lib", user: "maaq-quelqu-un-d-autre" },
    ];
  });

  it("supprime toutes les conversations du profil avec cet agent, page après page", async () => {
    await client().eraseConversation(USER, "prj_lib:agent_lib");
    expect(projects[KEY_LIB].conversations.map((c) => c.id).sort()).toEqual(["autre-agent", "autre-profil"]);

    const reads = server.calls.filter((c) => c.method === "GET");
    expect(reads.length).toBeGreaterThan(1); // plusieurs pages
    for (const call of server.calls) expect(call.headers["digitorn-user"]).toBe(USER);
    expect(reads[0].query.get("agent")).toBe("agent_lib"); // l'identifiant chez Digitorn, sans le préfixe du projet
  });

  it("un profil inconnu chez Digitorn n'a rien à effacer", async () => {
    projects[KEY_LIB].users.clear();
    await expect(client().eraseConversation(USER, "prj_lib:agent_lib")).resolves.toBeUndefined();
  });

  it("une panne remonte pour que MAAQ réessaie", async () => {
    server.failNext({ status: 503 });
    expect((await failureOf(client().eraseConversation(USER, "prj_lib:agent_lib"))).retryable).toBe(true);
  });
});

describe("suppression d'un profil (US-56, US-58, US-68)", () => {
  beforeEach(() => {
    projects[KEY_LIB].users.add(USER);
    projects[KEY_TAX].users.add(USER);
  });

  it("supprime le profil dans chaque projet, une fois par projet", async () => {
    await client().deleteProfile(USER);
    expect(projects[KEY_LIB].users.has(USER)).toBe(false);
    expect(projects[KEY_TAX].users.has(USER)).toBe(false);
    expect(server.calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
    expect(simulator.deletedProfiles).toEqual([USER]);
  });

  it("un profil absent d'un projet n'est pas une erreur (jamais activé chez cet agent)", async () => {
    projects[KEY_TAX].users.clear();
    await expect(client().deleteProfile(USER)).resolves.toBeUndefined();
    expect(projects[KEY_LIB].users.has(USER)).toBe(false);
  });

  it("un échec dans un projet n'arrête pas les autres, puis remonte : MAAQ réessaiera demain", async () => {
    server.failNext({ status: 503 });
    await expect(client().deleteProfile(USER)).rejects.toThrow(/Suppression chez Digitorn en échec/);
    // Le premier projet a échoué, le second a été supprimé.
    expect([projects[KEY_LIB].users.has(USER), projects[KEY_TAX].users.has(USER)].filter(Boolean)).toHaveLength(1);
    await expect(client().deleteProfile(USER)).resolves.toBeUndefined();
    expect(projects[KEY_LIB].users.has(USER) || projects[KEY_TAX].users.has(USER)).toBe(false);
  });
});

describe("erreurs de l'API", () => {
  it("reprend le format d'erreur de Digitorn : code, réessai possible, délai, suivi", async () => {
    server.failNext({
      path: "/agents/lookup",
      status: 429,
      body: { error: { code: "quota_reached", message: "Limite atteinte", retryable: true, retry_after_seconds: 50361, trace_id: "tr_d14536" } },
    });
    expect(await failureOf(client().lookupAgent({ name: "Admin_lib", apiKey: KEY_LIB }))).toMatchObject({
      code: "quota_reached",
      status: 429,
      retryable: true,
      retryAfterSeconds: 50361,
      traceId: "tr_d14536",
    });
  });

  it("une réponse sans corps JSON reste une erreur exploitable, réessayable si c'est une panne du serveur", async () => {
    server.failNext({ path: "/agents/lookup", status: 502, body: undefined });
    const failure = await failureOf(client().lookupAgent({ name: "Admin_lib", apiKey: KEY_LIB }));
    expect(failure.status).toBe(502);
    expect(failure.retryable).toBe(true);
  });

  it("une clé secrète utilisée depuis un navigateur est refusée par Digitorn : MAAQ ne l'envoie jamais avec une origine", async () => {
    await client().lookupAgent({ name: "Admin_lib", apiKey: KEY_LIB });
    expect(server.calls.every((c) => c.headers.origin === undefined)).toBe(true);
  });

  it("Digitorn injoignable : erreur réessayable, sans réponse", async () => {
    const failure = await failureOf(client({ baseUrl: "http://127.0.0.1:1/v1" }).lookupAgent({ name: "Admin_lib", apiKey: KEY_LIB }));
    expect(failure).toMatchObject({ code: "unreachable", status: 0, retryable: true });
  });

  it("un serveur trop lent est abandonné au bout du délai", async () => {
    const slow = await startFakeDigitorn(projects, { delayMs: 300 });
    try {
      const failure = await failureOf(
        new LiveDigitorn({ baseUrl: slow.baseUrl, projectOf: async () => null, allProjects: async () => [], fallback: simulator, timeoutMs: 50 }).lookupAgent({ name: "Admin_lib", apiKey: KEY_LIB }),
      );
      expect(failure).toMatchObject({ code: "unreachable", retryable: true });
    } finally {
      await slow.close();
    }
  });
});

describe("ce que Digitorn n'a pas encore documenté reste simulé", () => {
  it("les informations d'un agent avec projet voyagent au lancement du tchat : rien n'est envoyé à part", async () => {
    await client().updateProfileInfo(USER, "prj_lib:agent_lib", { Téléphone: "0612345678" });
    await client().updateAgentConfiguration(USER, "prj_lib:agent_lib", { validationMailbox: null, googleAccounts: {}, ccAddresses: [] });
    expect(server.calls).toHaveLength(0);
    expect(simulator.profileInfoOf(USER, "prj_lib:agent_lib")).toBeUndefined();
  });

  it("un agent sans projet garde le comportement du simulateur", async () => {
    await client().updateProfileInfo(USER, "admin_rdv", { Téléphone: "0612345678" });
    expect(simulator.profileInfoOf(USER, "admin_rdv")).toEqual({ Téléphone: "0612345678" });
  });

  it("carnet de bord, classement, export, anonymisation et connexions Google passent par le simulateur", async () => {
    const live = client();
    expect(await live.fetchLogbook(new Date(0))).toEqual([]);
    expect(await live.exportUserData(USER)).toEqual({ conversations: {}, configurations: {}, profileInfo: {} });
    await live.anonymizeLogbook(USER);
    expect(simulator.anonymizedProfiles).toEqual([USER]);
    expect((await live.beginAuthorization({ state: "e1", profileRef: USER, connector: "google_calendar", email: "a@exemple.fr", returnUrl: "https://x" })).consentUrl).toContain("/dev/google");
    expect(server.calls).toHaveLength(0);
  });
});
