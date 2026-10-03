import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockDigitorn } from "@/server/adapters/digitorn/mock";
import type { Ctx, SessionContext } from "@/server/auth/service";
import {
  capReachedMessage,
  decideAction,
  getChat,
  HISTORY_DAYS,
  localDay,
  reportError,
  sendMessage,
  type ChatItem,
} from "@/server/chat/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createProfile, messagesTo, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
let mock: MockDigitorn;
let clock = new Date();

beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(() => {
  clock = new Date();
  // Réponses et exécutions immédiates : les tests ne dépendent d'aucun délai.
  mock = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0, now: () => clock });
  globalThis.__maaqDigitorn = mock;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const at = (): Ctx => ({ db, now: clock });
const tag = () => Math.random().toString(36).slice(2, 8);

async function rejectionOf(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("refus attendu");
}

async function agentFor(userIds: string[], options: { blocked?: string; requiresDrive?: "each_profile" | "primary_user"; suggestions?: string[]; cc?: number } = {}) {
  const category = await db.selectFrom("agent_categories").select("id").where("code", "=", "perso").executeTakeFirstOrThrow();
  const agent = await db
    .insertInto("agents")
    .values({
      digitorn_agent_ref: `chat-${tag()}${tag()}`,
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
    await db.insertInto("agent_requirements").values({ agent_id: agent.id, connector_type_id: type.id, owner_scope: options.requiresDrive }).execute();
  }
  for (const [index, content] of (options.suggestions ?? []).entries()) {
    await db.insertInto("agent_sample_prompts").values({ agent_id: agent.id, kind: "first_suggestion", content, sort_order: index + 1 }).execute();
  }
  for (const userId of userIds) await db.insertInto("profile_agents").values({ user_id: userId, agent_id: agent.id }).execute();
  return { id: agent.id, name: agent.name, ref: agent.digitorn_agent_ref };
}

async function household() {
  const primary = await createProfile(db);
  const guest = async (rank: "core" | "secondary") => {
    const row = await db
      .insertInto("users")
      .values({
        account_id: primary.accountId,
        role: "guest",
        guest_rank: rank,
        first_name: rank === "core" ? "Dominique" : "Lou",
        last_name: "Martin",
        email: `${rank}-${tag()}@maaq.test`,
        status: "active",
      })
      .returning(["id", "email"])
      .executeTakeFirstOrThrow();
    return { ...row, session: await sessionFor(db, row.id) };
  };
  return { primary: { ...primary, session: await sessionFor(db, primary.id) }, core: await guest("core"), secondary: await guest("secondary") };
}

const send = (session: SessionContext, agentId: string, text: string, requestId: string = randomUUID()) => sendMessage(at(), session, { agentId, requestId, text });

function actionOf(items: ChatItem[]) {
  const action = items.find((i): i is Extract<ChatItem, { kind: "action" }> => i.kind === "action");
  if (!action) throw new Error("aucune carte d'action");
  return action;
}

describe("US-37 — ouverture du tchat", () => {
  it("RF1 : seul un agent présent sur le dashboard du profil s'ouvre", async () => {
    const { primary, core } = await household();
    const agent = await agentFor([primary.id]);
    expect((await rejectionOf(getChat(at(), core.session, agent.id))).status).toBe(404);
    expect((await getChat(at(), primary.session, agent.id)).agent.name).toBe(agent.name);
  });

  it("l'administrateur n'a pas de tchat", async () => {
    const admin = await createProfile(db, { role: "admin" });
    const agent = await agentFor([]);
    expect((await rejectionOf(getChat(at(), await sessionFor(db, admin.id), agent.id))).status).toBe(403);
  });

  it("RF3, RF5 : une conversation neuve est vide ; l'historique ne contient que les échanges du profil", async () => {
    const { primary, core } = await household();
    const agent = await agentFor([primary.id, core.id]);
    expect((await getChat(at(), primary.session, agent.id)).items).toEqual([]);
    await send(primary.session, agent.id, "Note ceci");
    expect((await getChat(at(), primary.session, agent.id)).items.map((i) => i.kind)).toEqual(["user", "agent"]);
    expect((await getChat(at(), core.session, agent.id)).items).toEqual([]);
  });
});

describe("US-41 — suggestions de première demande", () => {
  it("RF1 : jusqu'à 3 suggestions, dans l'ordre défini par l'administrateur", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { suggestions: ["Un", "Deux", "Trois"] });
    expect((await getChat(at(), primary.session, agent.id)).suggestions).toEqual(["Un", "Deux", "Trois"]);
  });
});

describe("US-38 — envoi d'une demande", () => {
  it("RF4 : Digitorn reçoit le rang, les participants automatiques, les copies et les informations du profil", async () => {
    const { primary, core } = await household();
    const agent = await agentFor([primary.id, core.id], { cc: 3 });
    await db.insertInto("cc_addresses").values({ user_id: primary.id, agent_id: agent.id, email: "voisin@exemple.fr" }).execute();
    await db.insertInto("agent_info_fields").values({ agent_id: agent.id, data_type: "text", label: "Ville", is_required: false, max_items: 1, sort_order: 1 }).execute();
    const field = await db.selectFrom("agent_info_fields").select("id").where("agent_id", "=", agent.id).executeTakeFirstOrThrow();
    const { encrypt } = await import("@/server/security/crypto");
    const { env } = await import("@/server/env");
    await db
      .insertInto("user_agent_info_values")
      .values({ user_id: primary.id, info_field_id: field.id, item_position: 1, value_encrypted: encrypt("Lyon", Buffer.from(env().ENCRYPTION_KEY, "base64")), updated_by_user_id: primary.id })
      .execute();

    const spy = vi.spyOn(mock, "submitRequest");
    await send(primary.session, agent.id, "Prends un rendez-vous chez le dentiste");
    expect(spy).toHaveBeenCalledOnce();
    const sent = spy.mock.calls[0][0];
    expect(sent.agentRef).toBe(agent.ref);
    expect(sent.context).toEqual({ rank: "primary_user", autoParticipants: [core.email], ccAddresses: ["voisin@exemple.fr"], info: { Ville: "Lyon" } });

    await send(core.session, agent.id, "Autre demande");
    expect(spy.mock.calls[1][0].context.rank).toBe("core_guest");
    expect(spy.mock.calls[1][0].context.autoParticipants).toEqual([primary.email]);
  });

  it("RF1 : une demande vide ou de plus de 2000 caractères est refusée", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    expect((await rejectionOf(send(primary.session, agent.id, "   "))).code).toBe("empty_request");
    expect((await rejectionOf(send(primary.session, agent.id, "a".repeat(2001)))).code).toBe("request_too_long");
    await send(primary.session, agent.id, "a".repeat(2000)); // la limite elle-même est acceptée
  });

  it("RT2 : renvoyer la même demande ne l'exécute ni ne la compte deux fois", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    const requestId = randomUUID();
    const first = await send(primary.session, agent.id, "Classe ce document", requestId);
    const second = await send(primary.session, agent.id, "Classe ce document", requestId);
    expect(first.cap.used).toBe(1);
    expect(second.cap.used).toBe(1);
    expect((await getChat(at(), primary.session, agent.id)).items.filter((i) => i.kind === "user")).toHaveLength(1);
  });

  it("une demande refusée par Digitorn n'est pas comptée, et son renvoi repart de zéro", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    vi.spyOn(mock, "submitRequest").mockRejectedValueOnce(new Error("Digitorn injoignable"));
    const requestId = randomUUID();
    await expect(send(primary.session, agent.id, "Classe ce document", requestId)).rejects.toThrow("injoignable");
    expect((await getChat(at(), primary.session, agent.id)).cap.used).toBe(0);
    expect((await send(primary.session, agent.id, "Classe ce document", requestId)).cap.used).toBe(1);
  });

  it("US-42 : un agent bloqué refuse toute demande, mais son historique reste lisible", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    await send(primary.session, agent.id, "Avant le blocage");
    await db.updateTable("agents").set({ status: "blocked", maintenance_message: "Mise à jour en cours", blocked_at: clock }).where("id", "=", agent.id).execute();

    const view = await getChat(at(), primary.session, agent.id);
    expect(view.blocked).toEqual({ message: "Mise à jour en cours" });
    expect(view.items).toHaveLength(2);
    const refused = await rejectionOf(send(primary.session, agent.id, "Pendant le blocage"));
    expect(refused.code).toBe("agent_blocked");
    expect(refused.message).toContain("Mise à jour en cours");

    // Remis en service : la même personne peut de nouveau écrire, sans rechargement manuel.
    await db.updateTable("agents").set({ status: "available", maintenance_message: null, blocked_at: null }).where("id", "=", agent.id).execute();
    expect((await getChat(at(), primary.session, agent.id)).blocked).toBeNull();
    await send(primary.session, agent.id, "Après le blocage");
  });
});

describe("US-29 — agent à configurer", () => {
  it("l'écran informatif liste ce qui manque ; aucune demande n'est acceptée", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { requiresDrive: "each_profile" });
    const view = await getChat(at(), primary.session, agent.id);
    expect(view.gate?.items).toEqual([{ kind: "connector", label: expect.stringContaining("Drive"), responsible: "profile", reconnect: false }]);
    expect(view.gate?.canFix).toBe(true);
    expect(view.items).toEqual([]);
    expect((await rejectionOf(send(primary.session, agent.id, "Bonjour"))).code).toBe("agent_to_configure");
  });

  it("une autorisation retirée côté Google est signalée « À reconnecter »", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id], { requiresDrive: "each_profile" });
    const type = await db.selectFrom("connector_types").select("id").where("code", "=", "google_drive").executeTakeFirstOrThrow();
    await db.insertInto("agent_connections").values({ user_id: primary.id, agent_id: agent.id, connector_type_id: type.id, connected_email: "camille@exemple.fr", status: "reconnect_required" }).execute();
    const view = await getChat(at(), primary.session, agent.id);
    expect(view.gate?.items[0]).toMatchObject({ kind: "connector", reconnect: true });
  });

  it("un invité devant une configuration réservée à l'utilisateur principal est renvoyé vers lui", async () => {
    const { primary, core } = await household();
    const agent = await agentFor([primary.id, core.id], { requiresDrive: "primary_user" });
    const view = await getChat(at(), core.session, agent.id);
    expect(view.gate?.canFix).toBe(false);
    expect(view.gate?.primaryFirstName).toBe("Camille");
    expect((await getChat(at(), primary.session, agent.id)).gate?.canFix).toBe(true);
  });
});

describe("US-70 — plafond quotidien de demandes", () => {
  async function limitTo(accountId: string | null, limit: number) {
    await db.updateTable("accounts").set({ daily_request_limit: limit }).where("id", "=", accountId!).execute();
  }

  it("RF1, RF2 : au-delà du plafond, la demande est refusée avec le message prévu et n'atteint pas Digitorn", async () => {
    const { primary } = await household();
    await limitTo(primary.accountId, 2);
    const agent = await agentFor([primary.id]);
    await send(primary.session, agent.id, "Une");
    await send(primary.session, agent.id, "Deux");

    const spy = vi.spyOn(mock, "submitRequest");
    const refused = await rejectionOf(send(primary.session, agent.id, "Trois"));
    expect(refused.code).toBe("daily_cap_reached");
    expect(refused.message).toBe(capReachedMessage(2));
    expect(refused.message).toBe("Vous avez atteint le nombre maximum de demandes pour aujourd'hui (2). Vous pourrez de nouveau solliciter les agents demain.");
    expect(spy).not.toHaveBeenCalled();
    expect((await getChat(at(), primary.session, agent.id)).cap).toEqual({ limit: 2, used: 2, remaining: 0 });
  });

  it("RF6 : le renvoi d'une demande déjà comptée passe même quand le plafond est atteint", async () => {
    const { primary } = await household();
    await limitTo(primary.accountId, 1);
    const agent = await agentFor([primary.id]);
    const requestId = randomUUID();
    await send(primary.session, agent.id, "Une", requestId);
    await send(primary.session, agent.id, "Une", requestId); // pas recomptée : accepté
    expect((await rejectionOf(send(primary.session, agent.id, "Deux"))).code).toBe("daily_cap_reached");
  });

  it("RF5 : la journée suit le fuseau de l'appareil, le compteur repart le lendemain", async () => {
    const instant = new Date("2026-10-02T22:30:00Z");
    expect(localDay(instant, "Europe/Paris")).toBe("2026-10-03");
    expect(localDay(instant, "America/New_York")).toBe("2026-10-02");

    const { primary } = await household();
    await limitTo(primary.accountId, 1);
    const agent = await agentFor([primary.id]);
    clock = new Date("2026-10-02T10:00:00Z");
    await send(primary.session, agent.id, "Aujourd'hui");
    expect((await rejectionOf(send(primary.session, agent.id, "Encore"))).code).toBe("daily_cap_reached");
    clock = new Date("2026-10-03T10:00:00Z");
    await send(primary.session, agent.id, "Demain");
  });

  it("RF9 : valider ou refuser une action ne compte pas dans le plafond", async () => {
    const { primary } = await household();
    await limitTo(primary.accountId, 1);
    const agent = await agentFor([primary.id]);
    await send(primary.session, agent.id, "Prends un rendez-vous");
    const action = actionOf((await getChat(at(), primary.session, agent.id)).items);
    await decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "validate" });
    expect((await getChat(at(), primary.session, agent.id)).cap).toEqual({ limit: 1, used: 1, remaining: 0 });
  });
});

describe("US-39 — validation des actions", () => {
  async function withAppointment(text = "Prends un rendez-vous chez le dentiste") {
    const people = await household();
    const agent = await agentFor([people.primary.id, people.core.id]);
    await send(people.primary.session, agent.id, text);
    const action = actionOf((await getChat(at(), people.primary.session, agent.id)).items);
    return { ...people, agent, action };
  }

  it("RF2 : valider déclenche l'exécution, la décision est tracée avec son auteur", async () => {
    const { primary, agent, action } = await withAppointment();
    expect(action.proposal.status).toBe("pending");
    const result = await decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "validate" });
    expect(result.alreadyDecided).toBe(false);
    expect(result.proposal.status).toBe("succeeded");

    const row = await db.selectFrom("action_decisions").selectAll().where("external_action_ref", "=", action.proposal.proposalId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ decision: "validated", requester_user_id: primary.id, decided_by_user_id: primary.id, execution_status: "running" });

    // La carte suit l'exécution : l'état de la décision est mis à jour à la lecture suivante.
    const view = await getChat(at(), primary.session, agent.id);
    expect(actionOf(view.items).decidedAt).not.toBeNull();
    const synced = await db.selectFrom("action_decisions").select("execution_status").where("external_action_ref", "=", action.proposal.proposalId).executeTakeFirstOrThrow();
    expect(synced.execution_status).toBe("succeeded");
  });

  it("RF1, RT1 : une seule décision par carte ; un second envoi ne refait rien", async () => {
    const { primary, agent, action } = await withAppointment();
    const spy = vi.spyOn(mock, "decideAction");
    await decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "validate" });
    const again = await decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "refuse" });
    expect(again.alreadyDecided).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    const row = await db.selectFrom("action_decisions").select("decision").where("external_action_ref", "=", action.proposal.proposalId).executeTakeFirstOrThrow();
    expect(row.decision).toBe("validated");
  });

  it("deux décisions simultanées : la première l'emporte, Digitorn n'est appelé qu'une fois", async () => {
    const { primary, agent, action } = await withAppointment();
    const spy = vi.spyOn(mock, "decideAction");
    const results = await Promise.all([
      decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "validate" }),
      decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "refuse" }),
    ]);
    expect(spy).toHaveBeenCalledOnce();
    expect(results.filter((r) => !r.alreadyDecided)).toHaveLength(1);
  });

  it("RF3 : refuser annule l'action et l'agent le confirme", async () => {
    const { primary, agent, action } = await withAppointment();
    const result = await decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "refuse" });
    expect(result.proposal.status).toBe("refused");
    const row = await db.selectFrom("action_decisions").select(["decision", "execution_status"]).where("external_action_ref", "=", action.proposal.proposalId).executeTakeFirstOrThrow();
    expect(row).toEqual({ decision: "refused", execution_status: "not_started" });
  });

  it("RF5 : seul l'auteur de la demande peut décider", async () => {
    const { core, agent, action } = await withAppointment();
    const refused = await rejectionOf(decideAction(at(), core.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "validate" }));
    expect(refused.code).toBe("action_unavailable");
    expect(await db.selectFrom("action_decisions").select("id").where("external_action_ref", "=", action.proposal.proposalId).execute()).toHaveLength(0);
  });

  it("US-42 RF3 : on ne décide rien tant que l'agent est bloqué", async () => {
    const { primary, agent, action } = await withAppointment();
    await db.updateTable("agents").set({ status: "blocked", maintenance_message: "Maintenance", blocked_at: clock }).where("id", "=", agent.id).execute();
    expect((await rejectionOf(decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "validate" }))).code).toBe("agent_blocked");
    expect(actionOf((await getChat(at(), primary.session, agent.id)).items).proposal.status).toBe("pending");
  });

  it("RF9 : une exécution en échec est signalée", async () => {
    const { primary, agent, action } = await withAppointment("Prends un rendez-vous, simule un échec");
    await decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "validate" });
    const view = await getChat(at(), primary.session, agent.id);
    expect(actionOf(view.items).proposal.status).toBe("failed");
    const row = await db.selectFrom("action_decisions").select("execution_status").where("external_action_ref", "=", action.proposal.proposalId).executeTakeFirstOrThrow();
    expect(row.execution_status).toBe("failed");
  });

  it("une décision que Digitorn n'a pas reçue laisse la carte à décider", async () => {
    const { primary, agent, action } = await withAppointment();
    vi.spyOn(mock, "decideAction").mockRejectedValueOnce(new Error("Digitorn injoignable"));
    await expect(decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "validate" })).rejects.toThrow();
    const row = await db.selectFrom("action_decisions").select(["decision", "decided_at"]).where("external_action_ref", "=", action.proposal.proposalId).executeTakeFirstOrThrow();
    expect(row).toEqual({ decision: "pending", decided_at: null });
    expect((await decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "validate" })).proposal.status).toBe("succeeded");
  });

  it("l'email à valider se présente avec son destinataire", async () => {
    const people = await household();
    const agent = await agentFor([people.primary.id]);
    await send(people.primary.session, agent.id, "Écris un mail au syndic");
    const action = actionOf((await getChat(at(), people.primary.session, agent.id)).items);
    expect(action.proposal).toMatchObject({ kind: "email", recipient: expect.any(String) });
  });
});

describe("US-44 — durée de l'historique", () => {
  it(`RF1 : au-delà de ${HISTORY_DAYS} jours, messages et cartes non traitées disparaissent`, async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    await send(primary.session, agent.id, "Prends un rendez-vous");
    const action = actionOf((await getChat(at(), primary.session, agent.id)).items);

    clock = new Date(clock.getTime() + (HISTORY_DAYS - 1) * 86_400_000);
    expect((await getChat(at(), primary.session, agent.id)).items.length).toBeGreaterThan(0);

    clock = new Date(clock.getTime() + 2 * 86_400_000);
    expect((await getChat(at(), primary.session, agent.id)).items).toEqual([]);
    expect((await rejectionOf(decideAction(at(), primary.session, { agentId: agent.id, proposalId: action.proposal.proposalId, decision: "validate" }))).code).toBe("action_unavailable");
  });
});

describe("US-61 — signalement d'une erreur", () => {
  async function withReply() {
    const people = await household();
    const agent = await agentFor([people.primary.id]);
    await send(people.primary.session, agent.id, "Classe la facture d'eau");
    const items = (await getChat(at(), people.primary.session, agent.id)).items;
    const reply = items.find((i) => i.kind === "agent")!;
    return { ...people, agent, reply, items };
  }

  it("RF3, RF5 : le signalement conserve la demande et la réponse, et la réponse est marquée « Signalée »", async () => {
    const { primary, agent, reply } = await withReply();
    const result = await reportError(at(), primary.session, { agentId: agent.id, messageRef: reply.id, category: "incorrect_response", comment: "  Mauvais dossier  " });
    expect(result.alreadyReported).toBe(false);

    const row = await db.selectFrom("error_reports").selectAll().where("message_ref", "=", reply.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      reporter_user_id: primary.id,
      reporter_role: "primary_user",
      category: "incorrect_response",
      user_comment: "Mauvais dossier",
      request_text: "Classe la facture d'eau",
    });
    expect(row.response_text).toContain("Classe la facture d'eau");

    const flagged = (await getChat(at(), primary.session, agent.id)).items.find((i) => i.kind === "agent")!;
    expect(flagged.kind === "agent" && flagged.reported).toBe(true);
  });

  it("RF4 : une réponse ne se signale qu'une fois par personne", async () => {
    const { primary, agent, reply } = await withReply();
    await reportError(at(), primary.session, { agentId: agent.id, messageRef: reply.id, category: "other" });
    const again = await reportError(at(), primary.session, { agentId: agent.id, messageRef: reply.id, category: "wrong_action" });
    expect(again.alreadyReported).toBe(true);
    expect(await db.selectFrom("error_reports").select("id").where("message_ref", "=", reply.id).execute()).toHaveLength(1);
  });

  it("RF6 : le support reçoit le signalement par email quand son adresse est renseignée", async () => {
    const { primary, agent, reply } = await withReply();
    const support = `support-${tag()}@maaq.test`;
    await db.updateTable("platform_settings").set({ value_text: support }).where("setting_key", "=", "support_email").execute();
    try {
      await reportError(at(), primary.session, { agentId: agent.id, messageRef: reply.id, category: "wrong_action", comment: "Pas ce que j'ai demandé" });
      const [mail] = await messagesTo(support);
      expect(mail.subject).toContain(agent.name);
      expect(mail.text).toContain("Action erronée");
      expect(mail.text).toContain("Pas ce que j'ai demandé");
      expect(mail.text).toContain(primary.email);
    } finally {
      await db.updateTable("platform_settings").set({ value_text: null }).where("setting_key", "=", "support_email").execute();
    }
  });

  it("sans adresse de support, le signalement est quand même enregistré", async () => {
    const { primary, agent, reply } = await withReply();
    expect((await reportError(at(), primary.session, { agentId: agent.id, messageRef: reply.id, category: "other" })).alreadyReported).toBe(false);
  });

  it("une action proposée se signale aussi ; un message de l'utilisateur ne se signale pas", async () => {
    const people = await household();
    const agent = await agentFor([people.primary.id]);
    await send(people.primary.session, agent.id, "Prends un rendez-vous");
    const items = (await getChat(at(), people.primary.session, agent.id)).items;
    const action = actionOf(items);
    await reportError(at(), people.primary.session, { agentId: agent.id, messageRef: action.id, category: "wrong_action" });
    const row = await db.selectFrom("error_reports").select("response_text").where("message_ref", "=", action.id).executeTakeFirstOrThrow();
    expect(row.response_text).toContain("Créer le rendez-vous");

    const mine = items.find((i) => i.kind === "user")!;
    expect((await rejectionOf(reportError(at(), people.primary.session, { agentId: agent.id, messageRef: mine.id, category: "other" }))).code).toBe("message_unavailable");
  });

  it("RF2 : le commentaire est limité à 1000 caractères", async () => {
    const { primary, agent, reply } = await withReply();
    expect((await rejectionOf(reportError(at(), primary.session, { agentId: agent.id, messageRef: reply.id, category: "other", comment: "a".repeat(1001) }))).code).toBe("comment_too_long");
  });
});

describe("US-43 — effacement de l'historique", () => {
  it("retirer l'agent efface la conversation et abandonne ses actions en attente", async () => {
    const { primary } = await household();
    const agent = await agentFor([primary.id]);
    await send(primary.session, agent.id, "Prends un rendez-vous");
    const action = actionOf((await getChat(at(), primary.session, agent.id)).items);

    const { removeAgent } = await import("@/server/catalog/service");
    await removeAgent(at(), primary.session, agent.id);
    expect((await rejectionOf(getChat(at(), primary.session, agent.id))).status).toBe(404);
    expect((await mock.getConversation((await db.selectFrom("users").select("digitorn_user_ref").where("id", "=", primary.id).executeTakeFirstOrThrow()).digitorn_user_ref!, agent.ref))).toEqual([]);
    expect(action.proposal.status).toBe("abandoned");
  });
});
