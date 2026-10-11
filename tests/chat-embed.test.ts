import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveDigitorn } from "@/server/adapters/digitorn/live";
import { MockDigitorn } from "@/server/adapters/digitorn/mock";
import { projectsFrom } from "@/server/adapters/digitorn/projects";
import { logout } from "@/server/auth/service";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { buildClaims, openEmbeddedChat } from "@/server/chat/embed";
import { decideAction, getChat, reportError, sendMessage } from "@/server/chat/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { ensureDigitornRef } from "@/server/profile/digitorn-ref";
import { encrypt } from "@/server/security/crypto";
import { fakeProject, startFakeDigitorn, type FakeProject } from "./helpers/fake-digitorn";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

/** Tchat embarqué de Digitorn (US-37) : un projet Digitorn par agent, lien de lancement, faits vérifiés, fermeture des accès. */

const KEY = "sk_embed_0123456789";
const PROJECT = "prj_embed";

let db: Kysely<DB>;
let projects: Record<string, FakeProject>;
let server: Awaited<ReturnType<typeof startFakeDigitorn>>;
let simulator: MockDigitorn;
const at = (): Ctx => ({ db, now: new Date() });
const tag = () => Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  db = testDb();
  projects = {};
  server = await startFakeDigitorn(projects);
  // Base partagée entre les fichiers de test : seuls les agents créés ici doivent avoir une clé Digitorn.
  await db.updateTable("agents").set({ digitorn_api_key_encrypted: null }).where("digitorn_api_key_encrypted", "is not", null).execute();
});
afterAll(async () => {
  await db.updateTable("agents").set({ digitorn_api_key_encrypted: null }).where("digitorn_api_key_encrypted", "is not", null).execute();
  await server.close();
  await db.destroy();
});
beforeEach(() => {
  simulator = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0 });
  globalThis.__maaqDigitorn = new LiveDigitorn({ baseUrl: server.baseUrl, ...projectsFrom(() => db), fallback: simulator });
  for (const k of Object.keys(projects)) delete projects[k];
  projects[KEY] = fakeProject(PROJECT, []);
  server.calls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.__maaqDigitorn = undefined;
});

async function rejectionOf(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("refus attendu");
}

/** Agent publié, avec ou sans projet Digitorn, présent sur le dashboard des profils donnés. */
async function agentFor(
  userIds: string[],
  options: { project?: boolean; appUrl?: string; blocked?: string; requiresDrive?: boolean; requiredInfo?: string; cc?: number } = {},
) {
  const category = await db.selectFrom("agent_categories").select("id").where("code", "=", "perso").executeTakeFirstOrThrow();
  const withProject = options.project ?? (options.appUrl === undefined);
  // Un identifiant d'agent par test, déclaré dans le faux projet Digitorn.
  const agentId = `agent_${tag()}${tag()}`;
  if (withProject) projects[KEY].agents.push({ id: agentId, name: `Agent ${agentId}` });
  const agent = await db
    .insertInto("agents")
    .values({
      digitorn_agent_ref: withProject ? `${PROJECT}:${agentId}` : options.appUrl ? `app:${tag()}${tag()}.digitorn.app` : `simule-${tag()}`,
      digitorn_app_url: options.appUrl ?? null,
      digitorn_api_key_encrypted: withProject ? encrypt(KEY, Buffer.from(process.env.ENCRYPTION_KEY!, "base64")) : null,
      name: `Agent_${tag()}`,
      category_id: category.id,
      short_description: "Agent de test",
      full_description: "Agent de test",
      cc_addresses_max_count: options.cc ?? 0,
      ...(options.blocked ? { status: "blocked" as const, maintenance_message: options.blocked, blocked_at: new Date() } : {}),
    })
    .returning(["id", "name", "digitorn_agent_ref"])
    .executeTakeFirstOrThrow();
  if (options.requiresDrive) {
    const type = await db.selectFrom("connector_types").select("id").where("code", "=", "google_drive").executeTakeFirstOrThrow();
    await db.insertInto("agent_requirements").values({ agent_id: agent.id, connector_type_id: type.id, owner_scope: "each_profile" }).execute();
  }
  let fieldId: string | null = null;
  if (options.requiredInfo) {
    const field = await db
      .insertInto("agent_info_fields")
      .values({ agent_id: agent.id, label: options.requiredInfo, data_type: "text", is_required: true, max_items: 1, sort_order: 1 })
      .returning("id")
      .executeTakeFirstOrThrow();
    fieldId = field.id;
  }
  for (const userId of userIds) await db.insertInto("profile_agents").values({ user_id: userId, agent_id: agent.id }).execute();
  return { id: agent.id, name: agent.name, ref: agent.digitorn_agent_ref, agentId, fieldId };
}

async function household() {
  const primary = await createProfile(db);
  const guest = async (rank: "core" | "secondary", firstName: string) => {
    const row = await db
      .insertInto("users")
      .values({ account_id: primary.accountId, role: "guest", guest_rank: rank, first_name: firstName, last_name: "Martin", email: `${rank}-${tag()}@maaq.test`, status: "active" })
      .returning(["id", "email"])
      .executeTakeFirstOrThrow();
    return { ...row, session: await sessionFor(db, row.id) };
  };
  return { primary: { ...primary, session: await sessionFor(db, primary.id) }, core: await guest("core", "Dominique"), secondary: await guest("secondary", "Lou") };
}

describe("l'écran sait si le tchat est embarqué", () => {
  it("un agent avec projet Digitorn est embarqué : pas de fil de messages, pas de blocage par les connecteurs", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { requiresDrive: true });
    const view = await getChat(at(), primary.session, agent.id);
    expect(view).toMatchObject({ embedded: true, gate: null, items: [], blocked: null });
    expect(server.calls).toHaveLength(0); // MAAQ ne relit aucune conversation
  });

  it("un agent sans projet garde le tchat construit par MAAQ, connecteurs requis compris", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { project: false, requiresDrive: true });
    const view = await getChat(at(), primary.session, agent.id);
    expect(view.embedded).toBe(false);
    expect(view.gate?.items.map((i) => i.kind)).toEqual(["connector"]);
  });

  it("avec le simulateur seul, un agent qui a une clé garde le tchat construit par MAAQ", async () => {
    globalThis.__maaqDigitorn = simulator;
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    expect((await getChat(at(), primary.session, agent.id)).embedded).toBe(false);
  });

  it("les informations de profil manquantes bloquent encore, mais pas les connecteurs", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { requiresDrive: true, requiredInfo: "Numéro fiscal" });
    const view = await getChat(at(), primary.session, agent.id);
    expect(view.embedded).toBe(true);
    expect(view.gate?.items.map((i) => `${i.kind}:${i.label}`)).toEqual(["info:Numéro fiscal"]);
  });

  it("un agent bloqué reste signalé, sans ouvrir le cadre", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { blocked: "Maintenance jusqu'à demain" });
    expect((await getChat(at(), primary.session, agent.id)).blocked?.message).toBe("Maintenance jusqu'à demain");
    expect((await rejectionOf(openEmbeddedChat(at(), primary.session, agent.id))).code).toBe("agent_blocked");
    expect(server.calls).toHaveLength(0);
  });

  it("les demandes, décisions et signalements du tchat construit par MAAQ sont refusés pour un agent embarqué", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    expect((await rejectionOf(sendMessage(at(), primary.session, { agentId: agent.id, requestId: randomUUID(), text: "Bonjour" }))).code).toBe("embedded_chat");
    expect((await rejectionOf(decideAction(at(), primary.session, { agentId: agent.id, proposalId: "x", decision: "validate" }))).code).toBe("embedded_chat");
    expect((await rejectionOf(reportError(at(), primary.session, { agentId: agent.id, messageRef: "x", category: "other" }))).code).toBe("embedded_chat");
    expect(server.calls).toHaveLength(0);
  });
});

describe("ouverture du tchat embarqué", () => {
  it("demande un lien de lancement avec le prénom et les faits vérifiés : rang, compte, membres", async () => {
    const { primary, core, secondary } = await household();
    const agent = await agentFor([primary.id, core.id, secondary.id]);
    const chat = await openEmbeddedChat(at(), core.session, agent.id);

    const [call] = server.calls;
    const userRef = await ensureDigitornRef(db, core.id);
    expect(call).toMatchObject({ method: "POST", path: `/v1/users/${userRef}/launch`, headers: { authorization: `Bearer ${KEY}` } });
    const body = call.body as { name: string; claims: { app: string; rank: string; account: string; members: { rank: string; name: string; email: string }[] } };
    expect(body.name).toBe("Dominique");
    expect(body.claims).toMatchObject({ app: "maaq", rank: "core_guest", account: `maaq-acc-${primary.accountId}` });
    expect(body.claims.members.map((m) => `${m.rank}:${m.name}`)).toEqual(["primary_user:Camille", "core_guest:Dominique", "secondary_guest:Lou"]);
    expect(body.claims.members.map((m) => m.email)).toEqual([primary.email, core.email, secondary.email]);
    expect(body.name).not.toContain("@"); // seul le prénom part dans le profil Digitorn
    expect(Object.keys(body).sort()).toEqual(["claims", "name"]);

    expect(chat.url).toBe("https://prj_embed.digitorn.app/#ticket-1");
    expect(chat.origin).toBe("https://prj_embed.digitorn.app");
    expect(chat.context.page.url).toMatch(new RegExp(`/tchat/${agent.id}$`));
    expect(chat.context.data).toMatchObject({ timezone: "Europe/Paris", language: "fr" });
  });

  it("le rang transmis est celui du demandeur", async () => {
    const { primary, secondary } = await household();
    const agent = await agentFor([primary.id, secondary.id]);
    await openEmbeddedChat(at(), primary.session, agent.id);
    await openEmbeddedChat(at(), secondary.session, agent.id);
    expect(server.calls.map((c) => (c.body as { claims: { rank: string } }).claims.rank)).toEqual(["primary_user", "secondary_guest"]);
  });

  it("le contexte de la page reprend les informations du profil et ses adresses en copie", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { requiredInfo: "Téléphone", cc: 5 });
    await db
      .insertInto("user_agent_info_values")
      .values({ user_id: primary.id, info_field_id: agent.fieldId!, item_position: 1, value_encrypted: encrypt("06 12 34 56 78", Buffer.from(process.env.ENCRYPTION_KEY!, "base64")), updated_by_user_id: primary.id })
      .execute();
    await db.insertInto("cc_addresses").values({ user_id: primary.id, agent_id: agent.id, email: "secretariat@exemple.fr" }).execute();

    const chat = await openEmbeddedChat(at(), primary.session, agent.id);
    expect(chat.context.data).toMatchObject({ settings: { Téléphone: "06 12 34 56 78" }, ccAddresses: ["secretariat@exemple.fr"] });
  });

  it("les garde-fous du tchat restent appliqués", async () => {
    const { primary, secondary } = await household();
    const agent = await agentFor([primary.id], { requiredInfo: "Numéro fiscal" });
    expect((await rejectionOf(openEmbeddedChat(at(), primary.session, agent.id))).code).toBe("agent_to_configure");
    expect((await rejectionOf(openEmbeddedChat(at(), secondary.session, agent.id))).code).toBe("not_found"); // pas sur son dashboard
    const legacy = await agentFor([primary.id], { project: false });
    expect((await rejectionOf(openEmbeddedChat(at(), primary.session, legacy.id))).code).toBe("not_embedded");
    expect(server.calls).toHaveLength(0);
  });

  it("les pannes de Digitorn deviennent des messages lisibles", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id]);

    server.failNext({ status: 401, body: { error: { code: "invalid_key", message: "x", retryable: false, trace_id: "tr_k" } } });
    const refused = await rejectionOf(openEmbeddedChat(at(), primary.session, agent.id));
    expect(refused).toMatchObject({ code: "key_refused", status: 422 });
    expect(refused.message).toContain("tr_k");

    server.failNext({ status: 503 });
    expect(await rejectionOf(openEmbeddedChat(at(), primary.session, agent.id))).toMatchObject({ code: "digitorn_unavailable", status: 503 });

    projects[KEY].published = false;
    expect((await rejectionOf(openEmbeddedChat(at(), primary.session, agent.id))).code).toBe("app_not_published");

    projects[KEY].published = true;
    server.failNext({ status: 403, body: { error: { code: "test_mode_limit", message: "x", retryable: false, trace_id: "tr_t" } } });
    expect((await rejectionOf(openEmbeddedChat(at(), primary.session, agent.id))).code).toBe("test_mode_limit");
  });

  it("le lien de lancement n'est jamais écrit dans les journaux", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    const chat = await openEmbeddedChat(at(), primary.session, agent.id);
    for (const spy of [log, warn, error]) expect(JSON.stringify(spy.mock.calls)).not.toContain(chat.url);
  });
});

describe("adresse de l'application publiée seule : visiteur anonyme", () => {
  it("l'agent est embarqué, même avec le simulateur et sans aucune clé", async () => {
    globalThis.__maaqDigitorn = simulator;
    const { primary } = await household();
    const agent = await agentFor([primary.id], { appUrl: "https://bcac-qx42y7yq112zy-d600d2.digitorn.app", requiresDrive: true });
    expect(await getChat(at(), primary.session, agent.id)).toMatchObject({ embedded: true, gate: null, items: [] });
  });

  it("le cadre affiche l'adresse publiée, sans appel à Digitorn, et le contexte porte le rang et le foyer", async () => {
    const { primary, core } = await household();
    const agent = await agentFor([primary.id, core.id], { appUrl: "https://bcac-qx42y7yq112zy-d600d2.digitorn.app" });
    const chat = await openEmbeddedChat(at(), core.session, agent.id);

    expect(chat).toMatchObject({ url: "https://bcac-qx42y7yq112zy-d600d2.digitorn.app", origin: "https://bcac-qx42y7yq112zy-d600d2.digitorn.app", expiresAt: null, identified: false });
    expect(server.calls).toHaveLength(0);
    const data = chat.context.data as { rank: string; household: { rank: string; name: string }[] };
    expect(data.rank).toBe("core_guest");
    expect(data.household.map((m) => `${m.rank}:${m.name}`)).toEqual(["primary_user:Camille", "core_guest:Dominique", "secondary_guest:Lou"]);
  });

  it("la base refuse une adresse qui n'est pas en https : elle ne peut jamais être placée dans le cadre", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { appUrl: "https://bcac-qx42y7yq112zy-d600d2.digitorn.app" });
    await expect(db.updateTable("agents").set({ digitorn_app_url: "http://exemple.fr" }).where("id", "=", agent.id).execute()).rejects.toThrow();
  });

  it("avec la clé du projet, l'utilisateur est reconnu : lien de lancement, adresse publiée non transmise", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { project: true, appUrl: "https://bcac-qx42y7yq112zy-d600d2.digitorn.app" });
    const chat = await openEmbeddedChat(at(), primary.session, agent.id);
    expect(chat.identified).toBe(true);
    expect(chat.url).toMatch(/^https:\/\/prj_embed\.digitorn\.app\/#ticket-\d+$/);
    expect(server.calls[0].body).not.toHaveProperty("app_url"); // adresse publiée par défaut : Digitorn la déduit du projet
    expect(chat.context.data).not.toHaveProperty("household"); // rien de déclaré : les faits sont dans les claims
  });

  it("un domaine personnalisé est transmis au lancement", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { project: true, appUrl: "https://agent.exemple.fr" });
    await openEmbeddedChat(at(), primary.session, agent.id);
    expect(server.calls[0].body).toMatchObject({ app_url: "https://agent.exemple.fr" });
  });
});

describe("faits vérifiés (claims) : 1 000 octets au plus", () => {
  const session = { user: { accountId: "a1", role: "primary_user", guestRank: null } } as unknown as SessionContext;
  const members = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ firstName: `Prénom-${i}`, email: `personne-${i}@exemple-long-domaine.fr`, rank: "secondary_guest" as const }));
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

  it("tient tel quel pour un compte ordinaire", () => {
    const claims = buildClaims(session, members(3));
    expect(size(claims)).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(claims)).toContain("personne-0@");
  });

  it("retire d'abord les emails, puis la liste des membres, sans jamais dépasser la limite", () => {
    const withoutEmails = buildClaims(session, members(15));
    expect(size(withoutEmails)).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(withoutEmails)).not.toContain("@");
    expect(JSON.stringify(withoutEmails)).toContain("Prénom-0");

    const onlyRank = buildClaims(session, members(80));
    expect(size(onlyRank)).toBeLessThanOrEqual(1000);
    expect(onlyRank).toEqual({ app: "maaq", rank: "primary_user", account: "maaq-acc-a1" });
  });
});

describe("déconnexion (US-9, US-43)", () => {
  it("efface les conversations puis ferme tous les accès du profil chez Digitorn", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    const userRef = await ensureDigitornRef(db, primary.id);
    projects[KEY].users.add(userRef);
    projects[KEY].conversations = [
      { id: "c1", agent: agent.agentId, user: userRef },
      { id: "c2", agent: agent.agentId, user: userRef },
    ];

    await logout(at(), primary.session);

    const request = await db.selectFrom("chat_erasure_requests").select(["status", "attempts"]).where("user_id", "=", primary.id).executeTakeFirstOrThrow();
    expect(request.status).toBe("done");
    expect(projects[KEY].conversations).toEqual([]);
    expect(server.calls.some((c) => c.method === "POST" && c.path === `/v1/users/${userRef}/sign-out`)).toBe(true);
  });

  it("une panne de Digitorn laisse l'effacement en attente pour un nouvel essai", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    const userRef = await ensureDigitornRef(db, primary.id);
    projects[KEY].users.add(userRef);
    projects[KEY].conversations = [{ id: "c1", agent: agent.agentId, user: userRef }];
    server.failNext({ status: 503 });

    await logout(at(), primary.session);

    expect((await db.selectFrom("chat_erasure_requests").select("status").where("user_id", "=", primary.id).executeTakeFirstOrThrow()).status).toBe("failed");
    expect(projects[KEY].conversations).toHaveLength(1); // rien n'a été effacé : un nouvel essai est prévu
  });
});
