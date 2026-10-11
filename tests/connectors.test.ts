import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devDigitorn } from "@/server/adapters/digitorn";
import type { Ctx, SessionContext } from "@/server/auth/service";
import {
  addCcAddress,
  authorizeConnection,
  disconnect,
  finalizeConnection,
  getOverview,
  refuseConnection,
  removeCcAddress,
  reportRevokedAuthorization,
  resendMailboxCode,
  saveMailbox,
  verifyMailbox,
  type ConnectorCode,
  type Scope,
} from "@/server/connectors/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createProfile, lastCodeSentTo, messagesTo, minutesLater, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

const at = (now = new Date()): Ctx => ({ db, now });
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

/** Agent de test sur le dashboard des profils indiqués. */
async function agentFor(
  userIds: string[],
  options: { requires?: { connector: ConnectorCode; scope: Scope }[]; cc?: number; name?: string } = {},
) {
  const category = await db.selectFrom("agent_categories").select("id").where("code", "=", "perso").executeTakeFirstOrThrow();
  const name = `${options.name ?? "Agent"}_${tag()}`;
  const agent = await db
    .insertInto("agents")
    .values({
      digitorn_agent_ref: `con-${tag()}${tag()}`,
      name,
      category_id: category.id,
      short_description: "Agent de test",
      full_description: "Agent de test",
      cc_addresses_max_count: options.cc ?? 0,
    })
    .returning(["id", "digitorn_agent_ref"])
    .executeTakeFirstOrThrow();
  for (const r of options.requires ?? []) {
    const type = await db.selectFrom("connector_types").select("id").where("code", "=", r.connector).executeTakeFirstOrThrow();
    await db.insertInto("agent_requirements").values({ agent_id: agent.id, connector_type_id: type.id, owner_scope: r.scope }).execute();
  }
  for (const userId of userIds) await db.insertInto("profile_agents").values({ user_id: userId, agent_id: agent.id }).execute();
  return { id: agent.id, name, ref: agent.digitorn_agent_ref };
}

async function account() {
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

/** Parcours complet côté Google : autorisation, choix de l'utilisateur, retour dans MAAQ. */
async function connectGoogle(
  session: SessionContext,
  agentId: string,
  connector: "google_drive" | "google_calendar",
  email: string,
  outcome: "authorized" | "partial" | "denied" = "authorized",
  chosenAccount?: string,
) {
  const { consentUrl } = await authorizeConnection(at(), session, { agentId, connector, email });
  if (!consentUrl) return null;
  const state = new URL(consentUrl).searchParams.get("etat")!;
  devDigitorn().completeConsent(state, outcome, chosenAccount);
  return finalizeConnection(at(), session, state);
}

async function statusOf(userId: string, agentId: string) {
  const row = await db.selectFrom("v_dashboard_agents").select("display_status").where("user_id", "=", userId).where("agent_id", "=", agentId).executeTakeFirstOrThrow();
  return row.display_status;
}

describe("US-13 — vue d'ensemble des connecteurs", () => {
  it("RF1, RF3 : un onglet par agent concerné ; l'invité ne peut pas modifier la connexion du compte ni celle de l'utilisateur principal", async () => {
    const { primary, core } = await account();
    const needing = await agentFor([primary.id, core.id], {
      requires: [
        { connector: "google_calendar", scope: "each_profile" },
        { connector: "google_drive", scope: "account" },
        { connector: "validation_mailbox", scope: "primary_user" },
      ],
    });
    const plain = await agentFor([primary.id]);

    const mine = await getOverview(at(), primary.session);
    expect(mine.agents.map((a) => a.agentId)).toEqual([needing.id]); // l'agent sans connecteur n'a pas d'onglet
    expect(mine.agents[0].connectors.map((c) => [c.code, c.editable, c.status])).toEqual([
      ["google_drive", true, "none"],
      ["google_calendar", true, "none"],
      ["validation_mailbox", true, "none"],
    ]);
    expect(mine.agents[0].connectors[0].label).toBe("Google Drive du compte");
    expect(mine.agents.map((a) => a.agentId)).not.toContain(plain.id);

    const theirs = await getOverview(at(), core.session);
    expect(theirs.agents[0].connectors.map((c) => [c.code, c.editable, c.ownerFirstName])).toEqual([
      ["google_drive", false, "Camille"],
      ["google_calendar", true, null],
      ["validation_mailbox", false, "Camille"],
    ]);
  });
});

describe("US-13 / US-14 / US-67 — comptes Google", () => {
  it("RF3 : l'autorisation passe en attente, puis connectée au retour de Google ; l'agent devient prêt", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    expect(await statusOf(primary.id, agent.id)).toBe("to_configure");

    const { consentUrl } = await authorizeConnection(at(), primary.session, { agentId: agent.id, connector: "google_calendar", email: "camille@gmail.test" });
    expect(consentUrl).toMatch(/\/dev\/google\?etat=/);
    let tab = (await getOverview(at(), primary.session)).agents[0].connectors[0];
    expect(tab).toMatchObject({ status: "pending", email: "camille@gmail.test" });

    const state = new URL(consentUrl!).searchParams.get("etat")!;
    expect((await finalizeConnection(at(), primary.session, state)).outcome).toBe("pending"); // consentement pas encore donné
    devDigitorn().completeConsent(state, "authorized");
    expect(await finalizeConnection(at(), primary.session, state)).toMatchObject({ outcome: "authorized", email: "camille@gmail.test", emailReplaced: false, agentName: agent.name });
    tab = (await getOverview(at(), primary.session)).agents[0].connectors[0];
    expect(tab.status).toBe("connected");
    expect(await statusOf(primary.id, agent.id)).toBe("ready");
    // Le retour déjà traité peut être rejoué sans effet.
    expect((await finalizeConnection(at(), primary.session, state)).outcome).toBe("authorized");
  });

  it("US-14 RF4-RF6 : refus, autorisation partielle avec permissions manquantes, compte différent du compte saisi", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });

    expect(await connectGoogle(primary.session, agent.id, "google_calendar", "a@gmail.test", "denied")).toMatchObject({ outcome: "denied" });
    expect((await getOverview(at(), primary.session)).agents[0].connectors[0].status).toBe("refused");

    expect(await connectGoogle(primary.session, agent.id, "google_calendar", "a@gmail.test", "partial")).toMatchObject({
      outcome: "partial",
      missing: ["Consulter et créer des événements dans votre agenda"],
    });
    expect((await getOverview(at(), primary.session)).agents[0].connectors[0].status).toBe("partial");
    expect(await statusOf(primary.id, agent.id)).toBe("to_configure");

    const replaced = await connectGoogle(primary.session, agent.id, "google_calendar", "a@gmail.test", "authorized", "autre@gmail.test");
    expect(replaced).toMatchObject({ outcome: "authorized", email: "autre@gmail.test", emailReplaced: true });
    expect((await getOverview(at(), primary.session)).agents[0].connectors[0]).toMatchObject({ status: "connected", email: "autre@gmail.test" });
  });

  it("US-14 RF4 : le refus du panneau enregistre le statut « refusé »", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "google_drive", scope: "each_profile" }] });
    await refuseConnection(at(), primary.session, { agentId: agent.id, connector: "google_drive", email: "a@gmail.test" });
    expect((await getOverview(at(), primary.session)).agents[0].connectors[0]).toMatchObject({ status: "refused", email: "a@gmail.test" });
  });

  it("US-14 RF11 : « Reprendre la connexion » relance le parcours sans ressaisir l'adresse", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    await authorizeConnection(at(), primary.session, { agentId: agent.id, connector: "google_calendar", email: "a@gmail.test" });
    const { consentUrl } = await authorizeConnection(at(), primary.session, { agentId: agent.id, connector: "google_calendar" });
    expect(consentUrl).not.toBeNull();
    const state = new URL(consentUrl!).searchParams.get("etat")!;
    devDigitorn().completeConsent(state, "authorized");
    expect((await finalizeConnection(at(), primary.session, state)).email).toBe("a@gmail.test");
  });

  it("US-13 RF4 : refuse une adresse invalide ; sans adresse enregistrée, rien à reprendre", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    const invalid = await rejectionOf(authorizeConnection(at(), primary.session, { agentId: agent.id, connector: "google_calendar", email: "pas-un-email" }));
    expect(invalid).toMatchObject({ code: "invalid_email", details: { email: "Adresse email invalide" } });
    expect((await rejectionOf(authorizeConnection(at(), primary.session, { agentId: agent.id, connector: "google_calendar" }))).code).toBe("invalid_email");
    expect((await rejectionOf(authorizeConnection(at(), primary.session, { agentId: agent.id, connector: "google_drive", email: "a@gmail.test" }))).code).toBe("not_found");
  });

  it("US-13 RF8 : changer d'adresse retire l'autorisation de l'ancien compte", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    await connectGoogle(primary.session, agent.id, "google_calendar", "ancien@gmail.test");
    const before = devDigitorn().revocations.length;
    await connectGoogle(primary.session, agent.id, "google_calendar", "nouveau@gmail.test");
    expect(devDigitorn().revocations.slice(before)).toMatchObject([{ connector: "google_calendar", email: "ancien@gmail.test" }]);
    // Même compte déjà connecté : pas de nouveau consentement.
    expect(await connectGoogle(primary.session, agent.id, "google_calendar", "nouveau@gmail.test")).toBeNull();
  });

  it("US-13 RF9 : déconnecter retire le connecteur, l'agent redevient « À configurer » ; un double envoi est sans effet", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    await connectGoogle(primary.session, agent.id, "google_calendar", "a@gmail.test");
    expect(await statusOf(primary.id, agent.id)).toBe("ready");

    await disconnect(at(), primary.session, { agentId: agent.id, connector: "google_calendar" });
    await disconnect(at(), primary.session, { agentId: agent.id, connector: "google_calendar" });
    expect((await getOverview(at(), primary.session)).agents[0].connectors[0]).toMatchObject({ status: "none", email: null });
    expect(await statusOf(primary.id, agent.id)).toBe("to_configure");
  });

  it("US-13 RF3, RF10 : chaque profil a ses comptes ; la configuration survit au retrait de l'agent", async () => {
    const { primary, core } = await account();
    const agent = await agentFor([primary.id, core.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    await connectGoogle(primary.session, agent.id, "google_calendar", "camille@gmail.test");
    expect((await getOverview(at(), core.session)).agents[0].connectors[0].status).toBe("none");
    expect(await statusOf(core.id, agent.id)).toBe("to_configure");

    await db.updateTable("profile_agents").set({ removed_at: new Date() }).where("user_id", "=", primary.id).where("agent_id", "=", agent.id).execute();
    await db.updateTable("profile_agents").set({ removed_at: null }).where("user_id", "=", primary.id).where("agent_id", "=", agent.id).execute();
    expect((await getOverview(at(), primary.session)).agents[0].connectors[0]).toMatchObject({ status: "connected", email: "camille@gmail.test" });
  });

  it("US-13 RF7 : propose le compte déjà connecté pour un autre agent", async () => {
    const { primary } = await account();
    const first = await agentFor([primary.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    await agentFor([primary.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    expect((await getOverview(at(), primary.session)).suggestedEmail).toBeNull();
    await connectGoogle(primary.session, first.id, "google_calendar", "camille@gmail.test");
    expect((await getOverview(at(), primary.session)).suggestedEmail).toBe("camille@gmail.test");
  });

  it("US-67 RF1-RF3, RF10 : le Drive du compte est unique, seul l'utilisateur principal le gère, il sert à tous les agents qui l'utilisent", async () => {
    const { primary, core } = await account();
    const drive = { connector: "google_drive" as const, scope: "account" as const };
    const one = await agentFor([primary.id, core.id], { requires: [drive] });
    const two = await agentFor([primary.id, core.id], { requires: [drive] });

    expect((await rejectionOf(authorizeConnection(at(), core.session, { agentId: one.id, connector: "google_drive", email: "x@gmail.test" }))).code).toBe("forbidden");
    expect((await rejectionOf(disconnect(at(), core.session, { agentId: one.id, connector: "google_drive" }))).code).toBe("forbidden");

    await connectGoogle(primary.session, one.id, "google_drive", "famille@gmail.test");
    for (const profile of [primary, core]) {
      expect(await statusOf(profile.id, one.id)).toBe("ready");
      expect(await statusOf(profile.id, two.id)).toBe("ready"); // la même connexion sert l'autre agent
    }
    expect((await getOverview(at(), core.session)).agents[0].connectors[0]).toMatchObject({ status: "connected", email: "famille@gmail.test", editable: false });
    const rows = await db.selectFrom("account_connections").select("id").where("account_id", "=", primary.accountId!).execute();
    expect(rows).toHaveLength(1);

    await disconnect(at(), primary.session, { agentId: two.id, connector: "google_drive" });
    expect(await statusOf(core.id, one.id)).toBe("to_configure");
  });

  it("US-14 RF7, US-67 RT3 : une autorisation retirée côté Google passe la connexion à « À reconnecter »", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    await connectGoogle(primary.session, agent.id, "google_calendar", "camille@gmail.test");
    const { digitorn_user_ref } = await db.selectFrom("users").select("digitorn_user_ref").where("id", "=", primary.id).executeTakeFirstOrThrow();

    expect(await reportRevokedAuthorization(at(), { profileRef: digitorn_user_ref!, connector: "google_calendar", email: "camille@gmail.test" })).toBe(1);
    expect((await getOverview(at(), primary.session)).agents[0].connectors[0].status).toBe("reconnect_required");
    expect(await statusOf(primary.id, agent.id)).toBe("to_configure");
    expect(await reportRevokedAuthorization(at(), { profileRef: "inconnu", connector: "google_calendar", email: "x@y.fr" })).toBe(0);

    // « Reprendre la connexion » : le parcours repart avec l'adresse enregistrée.
    const { consentUrl } = await authorizeConnection(at(), primary.session, { agentId: agent.id, connector: "google_calendar" });
    expect(consentUrl).not.toBeNull();
  });

  it("refuse un retour de connexion qui n'appartient pas au profil connecté", async () => {
    const { primary, core } = await account();
    const agent = await agentFor([primary.id, core.id], { requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    const { consentUrl } = await authorizeConnection(at(), primary.session, { agentId: agent.id, connector: "google_calendar", email: "a@gmail.test" });
    const state = new URL(consentUrl!).searchParams.get("etat")!;
    expect((await rejectionOf(finalizeConnection(at(), core.session, state))).code).toBe("invalid_state");
    expect((await rejectionOf(finalizeConnection(at(), primary.session, "n-importe-quoi-du-tout"))).code).toBe("invalid_state");
  });
});

describe("US-15 — boîte de validation", () => {
  it("RF4 : l'adresse est vérifiée par un code reçu dans cette boîte, puis active ; transmise à Digitorn", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "validation_mailbox", scope: "each_profile" }] });
    const mailbox = `validation-${tag()}@maaq.test`;

    expect((await rejectionOf(saveMailbox(at(), primary.session, { agentId: agent.id, email: "faux" }))).code).toBe("invalid_email");
    expect(await saveMailbox(at(), primary.session, { agentId: agent.id, email: mailbox })).toMatchObject({ status: "pending" });
    expect((await getOverview(at(), primary.session)).agents[0].connectors[0]).toMatchObject({ status: "pending", email: mailbox });
    expect(await statusOf(primary.id, agent.id)).toBe("to_configure");

    const code = (await lastCodeSentTo(mailbox))!;
    expect((await messagesTo(mailbox))[0].subject).toContain(code);
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await rejectionOf(verifyMailbox(at(), primary.session, { agentId: agent.id, code: wrong }))).code).toBe("code_incorrect");
    expect(await verifyMailbox(at(), primary.session, { agentId: agent.id, code })).toMatchObject({ status: "connected" });
    expect(await statusOf(primary.id, agent.id)).toBe("ready");

    const ref = (await db.selectFrom("users").select("digitorn_user_ref").where("id", "=", primary.id).executeTakeFirstOrThrow()).digitorn_user_ref!;
    expect(devDigitorn().agentConfigurationOf(ref, agent.ref)).toMatchObject({ validationMailbox: mailbox });
  });

  it("RF3 : l'adresse peut être la même que l'email de connexion (« distincte » est une précision, pas une obligation)", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "validation_mailbox", scope: "each_profile" }] });
    expect(await saveMailbox(at(), primary.session, { agentId: agent.id, email: primary.email })).toMatchObject({ status: "pending" });
  });

  it("RF7 : modifier l'adresse relance la vérification ; la supprimer déconnecte", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "validation_mailbox", scope: "each_profile" }] });
    const first = `a-${tag()}@maaq.test`;
    await saveMailbox(at(), primary.session, { agentId: agent.id, email: first });
    await verifyMailbox(at(), primary.session, { agentId: agent.id, code: (await lastCodeSentTo(first))! });
    expect(await saveMailbox(at(), primary.session, { agentId: agent.id, email: first })).toMatchObject({ status: "connected" }); // inchangée : rien à refaire

    const second = `b-${tag()}@maaq.test`;
    const later = at(minutesLater(new Date(), 2)); // après le délai de 60 s entre deux codes
    expect(await saveMailbox(later, primary.session, { agentId: agent.id, email: second })).toMatchObject({ status: "pending" });
    expect(await statusOf(primary.id, agent.id)).toBe("to_configure");
    await verifyMailbox(later, primary.session, { agentId: agent.id, code: (await lastCodeSentTo(second))! });
    expect(await statusOf(primary.id, agent.id)).toBe("ready");

    await disconnect(at(), primary.session, { agentId: agent.id, connector: "validation_mailbox" });
    expect((await getOverview(at(), primary.session)).agents[0].connectors[0]).toMatchObject({ status: "none", email: null });
  });

  it("RF4 : un code expiré est refusé ; le renvoi respecte le délai de 60 s", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { requires: [{ connector: "validation_mailbox", scope: "each_profile" }] });
    const mailbox = `exp-${tag()}@maaq.test`;
    const start = new Date();
    await saveMailbox(at(start), primary.session, { agentId: agent.id, email: mailbox });
    const code = (await lastCodeSentTo(mailbox))!;
    expect((await rejectionOf(resendMailboxCode(at(minutesLater(start, 0.2)), primary.session, { agentId: agent.id }))).code).toBe("code_cooldown");
    expect((await rejectionOf(verifyMailbox(at(minutesLater(start, 31)), primary.session, { agentId: agent.id, code }))).code).toBe("code_expired");
    expect(await resendMailboxCode(at(minutesLater(start, 32)), primary.session, { agentId: agent.id })).toMatchObject({ status: "pending" });
  });

  it("US-13 RF3 : la boîte de l'utilisateur principal ne se modifie pas par l'invité", async () => {
    const { primary, core } = await account();
    const agent = await agentFor([primary.id, core.id], { requires: [{ connector: "validation_mailbox", scope: "primary_user" }] });
    expect((await rejectionOf(saveMailbox(at(), core.session, { agentId: agent.id, email: "x@maaq.test" }))).code).toBe("forbidden");
  });
});

describe("US-16 / US-17 — adresses en copie", () => {
  it("US-16 RF1-RF2 : section prévue par l'administrateur ; l'invité 1 est le participant automatique de l'utilisateur principal", async () => {
    const { primary, core } = await account();
    const withCc = await agentFor([primary.id, core.id], { cc: 3 });
    await agentFor([primary.id], { cc: 0, requires: [{ connector: "google_calendar", scope: "each_profile" }] });

    const tab = (await getOverview(at(), primary.session)).agents.find((a) => a.agentId === withCc.id)!;
    expect(tab.cc).toMatchObject({ max: 3, addresses: [] });
    expect(tab.cc!.autoParticipants).toEqual([{ email: core.email, name: "Dominique Martin" }]);
    const without = (await getOverview(at(), primary.session)).agents.filter((a) => a.cc === null);
    expect(without).toHaveLength(1);
  });

  it("US-16 RF3, RF4 : format, doublon, soi-même, participant automatique, limite", async () => {
    const { primary, core } = await account();
    const agent = await agentFor([primary.id], { cc: 2 });
    const add = (email: string) => addCcAddress(at(), primary.session, { agentId: agent.id, email });

    expect((await rejectionOf(add("pas-un-email"))).code).toBe("invalid_email");
    expect((await rejectionOf(add(primary.email.toUpperCase()))).code).toBe("already_cc");
    expect((await rejectionOf(add(core.email))).message).toBe("Cette personne est déjà en copie");

    expect((await add("Notaire@Cabinet.test")).addresses).toEqual(["Notaire@Cabinet.test"]);
    expect((await rejectionOf(add("notaire@cabinet.test"))).code).toBe("duplicate_cc");
    await add("banque@exemple.test");
    const limit = await rejectionOf(add("troisieme@exemple.test"));
    expect(limit).toMatchObject({ code: "cc_limit", details: { max: 2 } });
  });

  it("US-16 RF8 : retirer une adresse ; la configuration est transmise à Digitorn", async () => {
    const { primary } = await account();
    const agent = await agentFor([primary.id], { cc: 5 });
    await addCcAddress(at(), primary.session, { agentId: agent.id, email: "a@exemple.test" });
    await addCcAddress(at(), primary.session, { agentId: agent.id, email: "b@exemple.test" });
    const ref = (await db.selectFrom("users").select("digitorn_user_ref").where("id", "=", primary.id).executeTakeFirstOrThrow()).digitorn_user_ref!;
    expect(devDigitorn().agentConfigurationOf(ref, agent.ref)?.ccAddresses).toEqual(["a@exemple.test", "b@exemple.test"]);

    expect((await removeCcAddress(at(), primary.session, { agentId: agent.id, email: "a@exemple.test" })).addresses).toEqual(["b@exemple.test"]);
    expect(devDigitorn().agentConfigurationOf(ref, agent.ref)?.ccAddresses).toEqual(["b@exemple.test"]);
  });

  it("US-17 RF2-RF7 : l'invité voit ses participants automatiques selon son rang ; sa liste est séparée de celle de l'utilisateur principal", async () => {
    const { primary, core, secondary } = await account();
    const agent = await agentFor([primary.id, core.id, secondary.id], { cc: 4 });
    const view = async (s: SessionContext) => (await getOverview(at(), s)).agents.find((a) => a.agentId === agent.id)!.cc!;

    expect((await view(core.session)).autoParticipants.map((p) => p.email)).toEqual([primary.email]);
    expect((await view(secondary.session)).autoParticipants.map((p) => p.email)).toEqual([primary.email, core.email]);

    await addCcAddress(at(), primary.session, { agentId: agent.id, email: "commun@exemple.test" });
    // Une adresse de la liste de l'utilisateur principal peut être ajoutée par l'invité (RF4)...
    await addCcAddress(at(), core.session, { agentId: agent.id, email: "commun@exemple.test" });
    // ... mais pas un participant automatique.
    expect((await rejectionOf(addCcAddress(at(), core.session, { agentId: agent.id, email: primary.email }))).message).toBe("Cette personne est déjà en copie");
    expect((await rejectionOf(addCcAddress(at(), secondary.session, { agentId: agent.id, email: core.email }))).code).toBe("already_cc");

    expect((await view(core.session)).addresses).toEqual(["commun@exemple.test"]);
    expect((await view(primary.session)).addresses).toEqual(["commun@exemple.test"]);
    await removeCcAddress(at(), core.session, { agentId: agent.id, email: "commun@exemple.test" });
    expect((await view(primary.session)).addresses).toEqual(["commun@exemple.test"]); // sans effet sur l'utilisateur principal
    expect((await view(core.session)).addresses).toEqual([]);
  });

  it("refuse l'ajout pour un agent sans adresses en copie ou absent du dashboard", async () => {
    const { primary, core } = await account();
    const none = await agentFor([primary.id], { cc: 0 });
    const notMine = await agentFor([primary.id], { cc: 3 });
    expect((await rejectionOf(addCcAddress(at(), primary.session, { agentId: none.id, email: "a@exemple.test" }))).code).toBe("not_found");
    expect((await rejectionOf(addCcAddress(at(), core.session, { agentId: notMine.id, email: "a@exemple.test" }))).code).toBe("not_found");
  });
});
