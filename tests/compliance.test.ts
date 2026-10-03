import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockDigitorn } from "@/server/adapters/digitorn/mock";
import { drive } from "@/server/adapters/drive";
import { createSession, getSession, type Ctx } from "@/server/auth/service";
import { cleanupExports, getExportState, prepareExport, readExport, requestExport } from "@/server/compliance/exports";
import { acceptCurrent, currentDocuments, pendingAcceptance, publishVersion } from "@/server/compliance/legal";
import {
  applyBillingEvent,
  cancelDeletion,
  GRACE_DAYS,
  processErasures,
  purgeAccount,
  purgeGuest,
  redact,
  requestDeletion,
  runLifecycle,
} from "@/server/compliance/lifecycle";
import { createZip, crc32, readZip } from "@/server/compliance/zip";
import { getLogbook } from "@/server/logbook/service";
import { encrypt } from "@/server/security/crypto";
import { hashSecret } from "@/server/security/password";
import { env } from "@/server/env";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createProfile, messagesTo, PASSWORD, sessionFor, testDb } from "./helpers/fixtures";
import { dataDir } from "@/server/data-dir";
import path from "node:path";

let db: Kysely<DB>;
let mock: MockDigitorn;

beforeAll(async () => {
  db = testDb();
  // Textes à accepter ; « doNothing » car plusieurs fichiers de test les préparent en parallèle.
  await db
    .insertInto("legal_document_versions")
    .values([
      { document_type: "privacy_policy", version_label: "test", content: "Politique", published_at: new Date(0) },
      { document_type: "terms_of_use", version_label: "test", content: "Conditions", published_at: new Date(0) },
    ])
    .onConflict((oc) => oc.columns(["document_type", "version_label"]).doNothing())
    .execute();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(() => {
  mock = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0 });
  globalThis.__maaqDigitorn = mock;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const at = (now = new Date()): Ctx => ({ db, now });
const tag = () => Math.random().toString(36).slice(2, 8);
const daysLater = (base: Date, days: number) => new Date(base.getTime() + days * 86_400_000);

async function rejectionOf(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("refus attendu");
}

/** Compte avec son utilisateur principal et deux invités qui peuvent se connecter (mot de passe connu). */
async function household() {
  const primary = await createProfile(db);
  const hash = await hashSecret(PASSWORD);
  const guest = async (rank: "core" | "secondary", firstName: string, phone: string | null = null) => {
    const row = await db
      .insertInto("users")
      .values({
        account_id: primary.accountId,
        role: "guest",
        guest_rank: rank,
        first_name: firstName,
        last_name: "Durand",
        email: `${rank}-${tag()}@maaq.test`,
        phone,
        status: "active",
        password_hash: hash,
        digitorn_user_ref: `maaq-test-${tag()}${tag()}`,
      })
      .returning(["id", "email"])
      .executeTakeFirstOrThrow();
    return { ...row, firstName, session: await sessionFor(db, row.id) };
  };
  await db.updateTable("users").set({ digitorn_user_ref: `maaq-test-${tag()}${tag()}` }).where("id", "=", primary.id).execute();
  return {
    primary: { ...primary, session: await sessionFor(db, primary.id) },
    core: await guest("core", "Thomas", "+33612345670"),
    secondary: await guest("secondary", "Élodie"),
  };
}

async function refOf(userId: string): Promise<string> {
  return (await db.selectFrom("users").select("digitorn_user_ref").where("id", "=", userId).executeTakeFirstOrThrow()).digitorn_user_ref!;
}

async function openSession(userId: string) {
  const id = randomUUID();
  await db.insertInto("devices").values({ id, user_id: userId, device_type: "android", browser: "Chrome" }).execute();
  return (await createSession(db, userId, id, new Date())).token;
}

async function agent() {
  const category = await db.selectFrom("agent_categories").select("id").where("code", "=", "perso").executeTakeFirstOrThrow();
  return db
    .insertInto("agents")
    .values({ digitorn_agent_ref: `comp-${tag()}${tag()}`, name: `Agent_${tag()}`, category_id: category.id, short_description: "Agent", full_description: "Agent", cc_addresses_max_count: 3 })
    .returning(["id", "name", "digitorn_agent_ref"])
    .executeTakeFirstOrThrow();
}

async function setSetting(key: string, value: string | null) {
  const before = await db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", key).executeTakeFirstOrThrow();
  await db.updateTable("platform_settings").set({ value_text: value }).where("setting_key", "=", key).execute();
  return () => db.updateTable("platform_settings").set({ value_text: before.value_text }).where("setting_key", "=", key).execute();
}

// ---------------------------------------------------------------------------

describe("zip de l'export", () => {
  it("l'archive se relit à l'identique, avec des noms accentués", () => {
    const archive = createZip([
      { name: "mes-donnees.json", data: Buffer.from('{"a":1}') },
      { name: "documents/Mutuelle santé/é.pdf", data: Buffer.from("%PDF-1.4 contenu") },
    ]);
    const files = readZip(archive);
    expect(files.map((f) => f.name)).toEqual(["mes-donnees.json", "documents/Mutuelle santé/é.pdf"]);
    expect(files[1].data.toString()).toBe("%PDF-1.4 contenu");
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926); // valeur de référence du CRC-32
  });

  it("une archive altérée est détectée", () => {
    const archive = createZip([{ name: "a.txt", data: Buffer.from("bonjour") }]);
    archive[archive.indexOf(Buffer.from("bonjour"))] = 0x42;
    expect(() => readZip(archive)).toThrow(/contrôle/);
  });
});

describe("US-54 — textes légaux", () => {
  it("RF3, RT1 : un profil doit accepter les deux documents ; l'administrateur n'a rien à accepter", async () => {
    const { primary } = await household();
    expect((await pendingAcceptance(db, primary.id, "primary_user", new Date())).map((d) => d.type).sort()).toEqual(["privacy_policy", "terms_of_use"]);
    await acceptCurrent(at(), primary.session);
    expect(await pendingAcceptance(db, primary.id, "primary_user", new Date())).toEqual([]);
    const rows = await db.selectFrom("legal_acceptances").select("accepted_at").where("user_id", "=", primary.id).execute();
    expect(rows).toHaveLength(2);
    expect(await pendingAcceptance(db, primary.id, "admin", new Date())).toEqual([]);
  });

  it("RF4, RT2 : une nouvelle version est redemandée, l'ancienne est conservée", async () => {
    const { primary } = await household();
    await acceptCurrent(at(), primary.session);
    const label = `v${tag()}`;
    await publishVersion(db, { type: "terms_of_use", label, content: "Nouvelles conditions", publishedAt: new Date(Date.now() - 1000) });
    const pending = await pendingAcceptance(db, primary.id, "primary_user", new Date());
    expect(pending.map((d) => [d.type, d.label])).toEqual([["terms_of_use", label]]);
    expect((await currentDocuments(db, new Date())).find((d) => d.type === "terms_of_use")?.label).toBe(label);
    await acceptCurrent(at(), primary.session);
    expect(await pendingAcceptance(db, primary.id, "primary_user", new Date())).toEqual([]);
    // Les versions précédentes restent en base (preuve).
    expect((await db.selectFrom("legal_document_versions").select("id").where("document_type", "=", "terms_of_use").execute()).length).toBeGreaterThan(1);
  });

  it("une version pas encore en vigueur n'est pas demandée", async () => {
    const { primary } = await household();
    await acceptCurrent(at(), primary.session);
    await publishVersion(db, { type: "privacy_policy", label: `futur-${tag()}`, content: "À venir", publishedAt: daysLater(new Date(), 10) });
    expect(await pendingAcceptance(db, primary.id, "primary_user", new Date())).toEqual([]);
  });
});

describe("US-55 — export des données", () => {
  async function richHousehold() {
    const people = await household();
    const a = await agent();
    const field = await db.insertInto("agent_info_fields").values({ agent_id: a.id, data_type: "text", label: "Ville", is_required: false, max_items: 1, sort_order: 1 }).returning("id").executeTakeFirstOrThrow();
    const encryptValue = (text: string) => encrypt(text, Buffer.from(env().ENCRYPTION_KEY, "base64"));
    await db.insertInto("profile_agents").values([{ user_id: people.primary.id, agent_id: a.id }, { user_id: people.core.id, agent_id: a.id }]).execute();
    // Camille renseigne sa ville, et celle de Thomas ; Thomas renseigne aussi la sienne (Camille ne la voit pas).
    await db.insertInto("user_agent_info_values").values({ user_id: people.primary.id, info_field_id: field.id, item_position: 1, value_encrypted: encryptValue("Lyon"), updated_by_user_id: people.primary.id }).execute();
    await db.insertInto("user_agent_info_values").values({ user_id: people.core.id, info_field_id: field.id, item_position: 1, value_encrypted: encryptValue("Nantes"), updated_by_user_id: people.primary.id }).execute();
    await db.insertInto("cc_addresses").values({ user_id: people.core.id, agent_id: a.id, email: "voisin@exemple.fr" }).execute();
    await db.insertInto("devices").values({ id: randomUUID(), user_id: people.core.id, device_type: "iphone", browser: "Safari" }).execute();
    const ref = await refOf(people.core.id);
    await mock.submitRequest({
      requestId: randomUUID(),
      userRef: ref,
      agentRef: a.digitorn_agent_ref,
      text: "Ma demande de Thomas",
      context: { rank: "core_guest", autoParticipants: [], ccAddresses: [], info: {} },
    });
    await db
      .insertInto("logbook_entries")
      .values({ account_id: people.primary.accountId!, agent_id: a.id, external_ref: `x-${tag()}`, occurred_at: new Date(), requester_user_id: people.core.id, entry_type: "request", summary: "Demande de Thomas" })
      .execute();
    return { ...people, agent: a };
  }

  it("RF2, RF4 : chaque profil exporte ses propres données, en document lisible et en données structurées", async () => {
    const { core, primary } = await richHousehold();
    const { id } = await requestExport(at(), core.session);
    expect(await prepareExport(at(), id)).toBe("ready");

    const files = readZip(await readExport(at(), core.session, id));
    expect(files.map((f) => f.name)).toEqual(expect.arrayContaining(["LISEZ-MOI.txt", "mes-donnees.html", "mes-donnees.json"]));
    const json = JSON.parse(files.find((f) => f.name === "mes-donnees.json")!.data.toString());
    expect(json.profile).toMatchObject({ prenom: "Thomas", email: core.email });
    expect(json.agentInformation).toEqual([expect.objectContaining({ champ: "Ville", valeur: "Nantes" })]);
    expect(json.ccAddresses).toEqual([expect.objectContaining({ adresse: "voisin@exemple.fr" })]);
    expect(json.logbook).toEqual([expect.objectContaining({ resume: "Demande de Thomas" })]);
    expect(json.devices.length).toBeGreaterThanOrEqual(1);
    expect(json.guestsInformation).toEqual([]);
    // Rien de Camille dans l'export de Thomas (CA 2.1).
    const everything = files.map((f) => f.data.toString()).join("\n");
    expect(everything).not.toContain(primary.email);
    expect(everything).not.toContain("Lyon");
    // Le document lisible porte les mêmes données.
    const page = files.find((f) => f.name === "mes-donnees.html")!.data.toString();
    expect(page).toContain("Nantes");
    expect(page).toContain("Thomas");
  });

  it("RF2, RT1 : l'utilisateur principal reçoit les informations de ses invités qu'il a renseignées, et les données de Digitorn", async () => {
    const { primary, core } = await richHousehold();
    const { id } = await requestExport(at(), primary.session);
    await prepareExport(at(), id);
    const json = JSON.parse(readZip(await readExport(at(), primary.session, id)).find((f) => f.name === "mes-donnees.json")!.data.toString());
    expect(json.guestsInformation).toEqual([expect.objectContaining({ invite: "Thomas", champ: "Ville", valeur: "Nantes" })]);
    expect(json.agentInformation).toEqual([expect.objectContaining({ valeur: "Lyon" })]);
    expect(json.digitorn).toMatchObject({ conversations: {}, configurations: {} });

    // Pour Thomas, l'historique détenu par Digitorn est intégré.
    const other = await requestExport(at(), core.session);
    await prepareExport(at(), other.id);
    const digitorn = JSON.parse(readZip(await readExport(at(), core.session, other.id)).find((f) => f.name === "mes-donnees.json")!.data.toString()).digitorn;
    expect(Object.values(digitorn.conversations).flat()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "user_message", text: "Ma demande de Thomas" })]));
  });

  it("RF2 : les consentements et les documents de contrats saisis par le profil figurent dans l'export", async () => {
    const { primary } = await household();
    const def = await db.insertInto("contract_definitions").values({ name: `Contrat ${tag()}`, sort_order: 999 }).returning("id").executeTakeFirstOrThrow();
    const field = await db.insertInto("contract_field_definitions").values({ contract_definition_id: def.id, label: "Assureur", field_type: "text" }).returning("id").executeTakeFirstOrThrow();
    const ac = await db.insertInto("account_contracts").values({ account_id: primary.accountId!, contract_definition_id: def.id }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("contract_field_values").values({ account_contract_id: ac.id, field_definition_id: field.id, value_text: "Maif", updated_by_user_id: primary.id }).execute();
    const stored = await drive().upload({ accountId: primary.accountId!, fileName: "attestation.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4 attestation") });
    await db
      .insertInto("contract_documents")
      .values({ account_contract_id: ac.id, file_name: "attestation.pdf", mime_type: "application/pdf", size_bytes: 20, added_by_user_id: primary.id, classification_status: "classified", drive_file_ref: stored.fileId })
      .execute();
    const version = await db.selectFrom("legal_document_versions").select("id").where("document_type", "=", "contract_challenge_consent").executeTakeFirstOrThrow();
    await db
      .insertInto("contract_consent_events")
      .values({ account_id: primary.accountId!, actor_user_id: primary.id, actor_email_hash: Buffer.from("x"), contract_definition_id: def.id, action_type: "granted", legal_version_id: version.id })
      .execute();

    const { id } = await requestExport(at(), primary.session);
    await prepareExport(at(), id);
    const files = readZip(await readExport(at(), primary.session, id));
    const json = JSON.parse(files.find((f) => f.name === "mes-donnees.json")!.data.toString());
    expect(json.contractDetails).toEqual([expect.objectContaining({ champ: "Assureur", valeur: "Maif" })]);
    expect(json.consents).toEqual([expect.objectContaining({ action: "Consentement donné" })]);
    const document = files.find((f) => f.name.startsWith("documents/"));
    expect(document?.data.toString()).toContain("attestation");
  });

  it("RF3, RT2 : le lien arrive par email, valable 7 jours ; le fichier est chiffré sur disque", async () => {
    const { core } = await richHousehold();
    const { id } = await requestExport(at(), core.session);
    await prepareExport(at(), id);
    const mail = (await messagesTo(core.email)).find((m) => /export/i.test(m.subject ?? ""));
    expect(mail?.text).toContain(`/export?id=${id}`);
    expect(mail?.text).toContain("7 jours");
    const row = await db.selectFrom("data_exports").select(["status", "download_expires_at"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.status).toBe("ready");
    expect(Math.round((new Date(row.download_expires_at!).getTime() - Date.now()) / 86_400_000)).toBe(7);
    const raw = await (await import("node:fs/promises")).readFile(path.join(dataDir(), "exports", `${id}.bin`));
    expect(raw.includes(Buffer.from("PK"))).toBe(false); // pas une archive en clair
    expect(raw.includes(Buffer.from("Nantes"))).toBe(false);
  });

  it("RF5 : une seule demande à la fois", async () => {
    const { core } = await household();
    const first = await requestExport(at(), core.session);
    const second = await requestExport(at(), core.session);
    expect(first.alreadyInProgress).toBe(false);
    expect(second).toEqual({ id: first.id, alreadyInProgress: true });
    expect(await getExportState(at(), core.session)).toMatchObject({ status: "requested", inProgress: true });
    await prepareExport(at(), first.id);
    expect(await getExportState(at(), core.session)).toMatchObject({ status: "ready", inProgress: false });
    expect((await requestExport(at(), core.session)).alreadyInProgress).toBe(false); // une nouvelle demande est possible
  });

  it("RF10 : si la préparation échoue, le profil est prévenu et peut recommencer", async () => {
    const { core } = await household();
    vi.spyOn(mock, "exportUserData").mockRejectedValueOnce(new Error("Digitorn injoignable"));
    const { id } = await requestExport(at(), core.session);
    expect(await prepareExport(at(), id)).toBe("failed");
    expect(await getExportState(at(), core.session)).toMatchObject({ status: "failed", inProgress: false });
    expect((await messagesTo(core.email)).some((m) => /n'a pas pu être préparé/.test(m.subject ?? ""))).toBe(true);
    expect((await requestExport(at(), core.session)).alreadyInProgress).toBe(false);
  });

  it("RF10 : une préparation restée en suspens est conclue en échec", async () => {
    const { core } = await household();
    const { id } = await requestExport(at(), core.session);
    expect((await cleanupExports(at(daysLater(new Date(), 1)))).failed).toBeGreaterThanOrEqual(1);
    expect((await db.selectFrom("data_exports").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status).toBe("failed");
  });

  it("RF6, RT2 : le téléchargement est réservé à son propriétaire, et le fichier disparaît à l'expiration du lien", async () => {
    const { core, secondary } = await household();
    const { id } = await requestExport(at(), core.session);
    await prepareExport(at(), id);
    expect((await rejectionOf(readExport(at(), secondary.session, id))).status).toBe(404);

    const later = at(daysLater(new Date(), 8));
    expect((await rejectionOf(readExport(later, core.session, id))).status).toBe(410);
    expect((await getExportState(later, core.session)).status).toBe("expired");
    await cleanupExports(later);
    expect(existsSync(path.join(dataDir(), "exports", `${id}.bin`))).toBe(false);
  });

  it("un administrateur n'a pas de données à exporter", async () => {
    const admin = await createProfile(db, { role: "admin" });
    expect((await rejectionOf(requestExport(at(), await sessionFor(db, admin.id)))).status).toBe(403);
  });
});

describe("US-56, US-58, US-59 — suppression, délai de grâce, reprise", () => {
  it("RF2, CA 2.1 : un mot de passe erroné ne lance pas la suppression", async () => {
    const { primary } = await household();
    expect((await rejectionOf(requestDeletion(at(), primary.session, "pas-le-bon"))).code).toBe("wrong_password");
    expect((await db.selectFrom("accounts").select("status").where("id", "=", primary.accountId!).executeTakeFirstOrThrow()).status).toBe("active");
  });

  it("RF3, RF6, RF8 : la suppression suspend le compte, ferme toutes les sessions, prévient par email et vaut désabonnement", async () => {
    const { primary, core } = await household();
    const primaryToken = await openSession(primary.id);
    const guestToken = await openSession(core.id);
    const now = new Date();

    const result = await requestDeletion(at(now), primary.session, PASSWORD);
    expect(new Date(result.purgeAt).getTime()).toBe(daysLater(now, GRACE_DAYS).getTime());

    const account = await db.selectFrom("accounts").select(["status", "grace_origin", "purge_scheduled_at", "subscription_ended_at"]).where("id", "=", primary.accountId!).executeTakeFirstOrThrow();
    expect(account).toMatchObject({ status: "grace_period", grace_origin: "in_app_request" });
    expect(account.subscription_ended_at).not.toBeNull();
    // Accès coupé pour tous : le profil se retrouve en délai de grâce, jamais en accès normal.
    expect((await getSession(at(now), primaryToken))).toBeNull();
    expect((await getSession(at(now), guestToken))).toBeNull();
    expect((await messagesTo(primary.email)).some((m) => /suppression.*programmée/i.test(m.subject ?? ""))).toBe(true);
    expect((await messagesTo(core.email)).some((m) => /suspendu/i.test(m.subject ?? ""))).toBe(true);
    expect((await rejectionOf(requestDeletion(at(now), { ...primary.session, user: { ...primary.session.user, inGracePeriod: true } }, PASSWORD))).code).toBe("already_pending");
  });

  it("RF1, RF7 : un invité qui supprime son compte n'affecte ni le compte ni les autres profils", async () => {
    const { primary, core, secondary } = await household();
    const secondaryToken = await openSession(secondary.id);
    const coreToken = await openSession(core.id);
    await requestDeletion(at(), core.session, PASSWORD);

    const row = await db.selectFrom("users").select(["status", "purge_scheduled_at"]).where("id", "=", core.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("grace_period");
    expect(await getSession(at(), coreToken)).toBeNull();
    expect(await getSession(at(), secondaryToken)).not.toBeNull();
    expect((await db.selectFrom("accounts").select("status").where("id", "=", primary.accountId!).executeTakeFirstOrThrow()).status).toBe("active");
  });

  it("RF3 US-59 : après une suppression demandée dans l'application, « Annuler » rétablit le compte et informe les invités", async () => {
    const { primary, core } = await household();
    await requestDeletion(at(), primary.session, PASSWORD);
    const inGrace = { ...primary.session, user: { ...primary.session.user, inGracePeriod: true } };
    expect(await cancelDeletion(at(), inGrace)).toEqual({ resumed: true });
    expect(await db.selectFrom("accounts").select(["status", "purge_scheduled_at", "subscription_ended_at"]).where("id", "=", primary.accountId!).executeTakeFirstOrThrow()).toEqual({ status: "active", purge_scheduled_at: null, subscription_ended_at: null });
    expect((await messagesTo(core.email)).some((m) => /rétabli/i.test(m.subject ?? ""))).toBe(true);
  });

  it("RF9 US-59 : un invité reprend son propre compte, mais jamais celui que l'utilisateur principal a quitté", async () => {
    const { primary, core } = await household();
    await requestDeletion(at(), core.session, PASSWORD);
    expect(await cancelDeletion(at(), { ...core.session, user: { ...core.session.user, inGracePeriod: true } })).toEqual({ resumed: true });
    expect((await db.selectFrom("users").select(["status", "purge_scheduled_at"]).where("id", "=", core.id).executeTakeFirstOrThrow())).toEqual({ status: "active", purge_scheduled_at: null });

    await requestDeletion(at(), primary.session, PASSWORD);
    const refused = await rejectionOf(cancelDeletion(at(), { ...core.session, user: { ...core.session.user, inGracePeriod: true } }));
    expect(refused.code).toBe("only_primary");
  });

  it("RF2 US-59, US-58 RF1 : après un désabonnement par la facturation, la reprise exige un nouvel abonnement", async () => {
    const { primary, core } = await household();
    const coreToken = await openSession(core.id);
    expect(await applyBillingEvent(at(), { event: "unsubscribed", email: primary.email.toUpperCase() })).toEqual({ changed: true });
    expect(await getSession(at(), coreToken)).toBeNull();
    expect(await db.selectFrom("accounts").select(["status", "grace_origin"]).where("id", "=", primary.accountId!).executeTakeFirstOrThrow()).toEqual({ status: "grace_period", grace_origin: "billing_unsubscribe" });
    expect(await applyBillingEvent(at(), { event: "unsubscribed", email: primary.email })).toEqual({ changed: false }); // idempotent

    const refused = await rejectionOf(cancelDeletion(at(), { ...primary.session, user: { ...primary.session.user, inGracePeriod: true } }));
    expect(refused.code).toBe("resubscribe_required");
    expect(refused.message).toContain("nouvel abonnement");

    expect(await applyBillingEvent(at(), { event: "resubscribed", email: primary.email })).toEqual({ changed: true });
    expect((await db.selectFrom("accounts").select("status").where("id", "=", primary.accountId!).executeTakeFirstOrThrow()).status).toBe("active");
  });

  it("un événement de facturation pour un compte inconnu est refusé", async () => {
    expect((await rejectionOf(applyBillingEvent(at(), { event: "unsubscribed", email: `inconnu-${tag()}@maaq.test` }))).status).toBe(404);
  });

  it("US-58 RF3 : un rappel part 7 jours avant la suppression, une seule fois", async () => {
    const { primary } = await household();
    const now = new Date();
    await requestDeletion(at(now), primary.session, PASSWORD);
    const before = (await messagesTo(primary.email)).length;

    await runLifecycle(at(daysLater(now, 10)));
    expect((await messagesTo(primary.email)).length).toBe(before); // trop tôt

    await runLifecycle(at(daysLater(now, 24)));
    await runLifecycle(at(daysLater(now, 25)));
    const reminders = (await messagesTo(primary.email)).filter((m) => /dans 7 jours/.test(m.subject ?? ""));
    expect(reminders).toHaveLength(1);
  });

  it("US-58 RF4, RF7 : à J+30, le compte, ses invités et leurs données disparaissent chez MAAQ et chez Digitorn, avec une trace non nominative", async () => {
    const { primary, core, secondary } = await household();
    const a = await agent();
    await db.insertInto("profile_agents").values({ user_id: primary.id, agent_id: a.id }).execute();
    const def = await db.insertInto("contract_definitions").values({ name: `Contrat ${tag()}`, sort_order: 998 }).returning("id").executeTakeFirstOrThrow();
    const ac = await db.insertInto("account_contracts").values({ account_id: primary.accountId!, contract_definition_id: def.id }).returning("id").executeTakeFirstOrThrow();
    const version = await db.selectFrom("legal_document_versions").select("id").where("document_type", "=", "contract_challenge_consent").executeTakeFirstOrThrow();
    await db
      .insertInto("contract_consent_events")
      .values({ account_id: primary.accountId!, actor_user_id: primary.id, actor_email_hash: Buffer.from("h"), contract_definition_id: def.id, action_type: "granted", legal_version_id: version.id })
      .execute();
    const refs = await Promise.all([primary.id, core.id, secondary.id].map(refOf));
    const now = new Date();
    await requestDeletion(at(now), primary.session, PASSWORD);

    // Pendant le délai, rien n'est supprimé (US-59 RT1).
    await runLifecycle(at(daysLater(now, 29)));
    expect(await db.selectFrom("accounts").select("id").where("id", "=", primary.accountId!).executeTakeFirst()).toBeDefined();
    expect(mock.deletedProfiles).toEqual([]);

    const due = at(daysLater(now, 31));
    const result = await runLifecycle(due);
    expect(result.accountsPurged).toBeGreaterThanOrEqual(1);
    expect(await db.selectFrom("accounts").select("id").where("id", "=", primary.accountId!).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom("users").select("id").where("account_id", "=", primary.accountId!).execute()).toEqual([]);
    expect(await db.selectFrom("account_contracts").select("id").where("id", "=", ac.id).executeTakeFirst()).toBeUndefined();
    expect(mock.deletedProfiles).toEqual(expect.arrayContaining(refs));

    // Trace : identifiants techniques et date, rien de nominatif.
    const traces = await db.selectFrom("erasure_traces").selectAll().where("former_account_id", "=", primary.accountId!).execute();
    expect(traces).toHaveLength(3);
    expect(traces.every((t) => t.digitorn_status === "done" && t.digitorn_user_ref === null)).toBe(true);
    expect(JSON.stringify(traces)).not.toContain(primary.email);
    // La preuve de consentement est gardée 5 ans après la fin de l'abonnement.
    const kept = await db.selectFrom("contract_consent_events").select("retain_until").where("account_id", "=", primary.accountId!).executeTakeFirstOrThrow();
    expect(new Date(kept.retain_until!).getFullYear()).toBe(due.now.getFullYear() + 5);
    // Après le délai, une connexion obtient « Email ou mot de passe incorrect » (US-59 RF5) : le profil n'existe plus.
    expect(await db.selectFrom("users").select("id").where("email", "=", primary.email).executeTakeFirst()).toBeUndefined();
  });

  it("US-58 RF5 : un échec de suppression chez Digitorn alerte l'administrateur et est réessayé le lendemain", async () => {
    const { primary } = await household();
    const ref = await refOf(primary.id);
    const alert = `alerte-${tag()}@maaq.test`;
    const restore = await setSetting("alert_email", alert);
    try {
      vi.spyOn(mock, "deleteProfile").mockRejectedValueOnce(new Error("Digitorn indisponible"));
      const now = new Date();
      await requestDeletion(at(now), primary.session, PASSWORD);
      await runLifecycle(at(daysLater(now, 31)));

      const traces = await db.selectFrom("erasure_traces").select(["digitorn_status", "digitorn_attempts", "last_error", "digitorn_user_ref"]).where("former_account_id", "=", primary.accountId!).execute();
      const failed = traces.filter((t) => t.digitorn_status === "failed");
      expect(failed).toEqual([expect.objectContaining({ digitorn_attempts: 1, last_error: "Digitorn indisponible" })]);
      expect(traces.filter((t) => t.digitorn_status === "done")).toHaveLength(traces.length - 1);
      const failedRef = failed[0].digitorn_user_ref!;
      expect((await messagesTo(alert)).some((m) => m.text.includes("Digitorn indisponible"))).toBe(true);

      // Le jour même, pas de nouvel essai ; le lendemain, oui.
      await processErasures(at(daysLater(now, 31)));
      expect(mock.deletedProfiles).not.toContain(failedRef);
      const next = await processErasures(at(daysLater(now, 32)));
      expect(next.done).toBeGreaterThanOrEqual(1);
      expect(mock.deletedProfiles).toContain(failedRef);
      expect(mock.deletedProfiles).toContain(ref);
      const after = await db.selectFrom("erasure_traces").select("digitorn_status").where("former_account_id", "=", primary.accountId!).execute();
      expect(after.every((t) => t.digitorn_status === "done")).toBe(true);
    } finally {
      await restore();
    }
  });

  it("un compte supprimé libère son email et son fichier d'export", async () => {
    const { primary } = await household();
    const { id } = await requestExport(at(), primary.session);
    await prepareExport(at(), id);
    const file = path.join(dataDir(), "exports", `${id}.bin`);
    expect(existsSync(file)).toBe(true);
    await purgeAccount(at(), primary.accountId!);
    expect(existsSync(file)).toBe(false);
    const again = await createProfile(db);
    await db.updateTable("users").set({ email: primary.email }).where("id", "=", again.id).execute(); // l'email est de nouveau disponible
  });
});

describe("US-57 — anonymisation des demandes d'un invité supprimé", () => {
  it("redact retire nom, email, téléphone et tout numéro ou adresse qui y ressemble", () => {
    const who = { firstName: "Julien", lastName: "Martin", email: "julien@exemple.fr", phone: "+33612345678" };
    const out = redact("Julien Martin a demandé un RDV, joignable au 06 12 34 56 78 ou julien@exemple.fr, aussi au 07.98.76.54.32 (Martin).", who);
    expect(out).not.toMatch(/Julien|Martin|julien@|06 12|07\.98/);
    expect(out).toContain("RDV");
    expect(redact("Rendez-vous à Martinique", who)).toBe("Rendez-vous à Martinique"); // pas de coupe au milieu d'un mot
  });

  async function withEntries() {
    const people = await household();
    const a = await agent();
    const insert = (requester: string | null, summary: string) =>
      db
        .insertInto("logbook_entries")
        .values({ account_id: people.primary.accountId!, agent_id: a.id, external_ref: `e-${tag()}`, occurred_at: new Date(), requester_user_id: requester, entry_type: "request", summary, result: `Fait pour ${people.core.firstName} Durand` })
        .returning(["id", "occurred_at"])
        .executeTakeFirstOrThrow();
    const entry = await insert(people.core.id, `Thomas Durand demande un rendez-vous, mon numéro : 06 12 34 56 78, ${people.core.email}`);
    await db.insertInto("logbook_entry_participants").values({ entry_id: entry.id, entry_occurred_at: entry.occurred_at, user_id: people.secondary.id }).execute();
    const own = await insert(people.primary.id, "Demande de Camille");
    return { ...people, agent: a, entry, own };
  }

  it("RF1, RF2, RF5 : à la suppression définitive, le nom et les données personnelles disparaissent, l'entrée reste visible selon D3", async () => {
    const { primary, core, secondary, agent: a } = await withEntries();
    await db.updateTable("users").set({ status: "grace_period", purge_scheduled_at: new Date(Date.now() - 1000), deletion_requested_at: new Date() }).where("id", "=", core.id).execute();
    await db.insertInto("cc_addresses").values({ user_id: core.id, agent_id: a.id, email: "voisin@exemple.fr" }).onConflict((oc) => oc.doNothing()).execute().catch(() => undefined);
    const ref = await refOf(core.id);

    await purgeGuest(at(), core.id);

    const entries = await db.selectFrom("logbook_entries").select(["summary", "result", "requester_user_id", "anonymization_status"]).where("agent_id", "=", a.id).execute();
    const anonymized = entries.find((e) => e.anonymization_status === "done")!;
    expect(anonymized.requester_user_id).toBeNull();
    expect(`${anonymized.summary} ${anonymized.result}`).not.toMatch(/Thomas|Durand|06 12|@maaq\.test/);
    expect(anonymized.summary).toContain("demande un rendez-vous");
    expect(mock.anonymizedProfiles).toContain(ref);
    expect(mock.deletedProfiles).toContain(ref);
    expect(await db.selectFrom("users").select("id").where("id", "=", core.id).executeTakeFirst()).toBeUndefined();

    // Visible par l'utilisateur principal (« Invité supprimé ») et par l'invité secondaire participant (CA 5.1).
    const seenByPrimary = (await getLogbook(at(), primary.session, a.id)).entries;
    expect(seenByPrimary.map((e) => e.authorFirstName)).toEqual(expect.arrayContaining([null, "Camille"]));
    expect((await getLogbook(at(), secondary.session, a.id)).entries).toHaveLength(1);
  });

  it("RF6, RF7 : si l'anonymisation échoue, les entrées restent masquées et l'invité n'est pas supprimé, jusqu'au succès", async () => {
    const { primary, core, agent: a } = await withEntries();
    await db.updateTable("users").set({ status: "removed", removed_at: new Date(), purge_scheduled_at: new Date(Date.now() - 1000) }).where("id", "=", core.id).execute();
    vi.spyOn(mock, "anonymizeLogbook").mockRejectedValueOnce(new Error("Digitorn indisponible"));

    await expect(purgeGuest(at(), core.id)).rejects.toThrow("indisponible");
    expect(await db.selectFrom("users").select("id").where("id", "=", core.id).executeTakeFirst()).toBeDefined();
    // Jamais affichée avec le nom : masquée pendant le traitement.
    const hidden = (await getLogbook(at(), primary.session, a.id)).entries;
    expect(hidden.map((e) => e.summary)).toEqual(["Demande de Camille"]);

    const result = await runLifecycle(at());
    expect(result.guestsPurged).toBeGreaterThanOrEqual(1);
    expect(await db.selectFrom("users").select("id").where("id", "=", core.id).executeTakeFirst()).toBeUndefined();
    expect((await getLogbook(at(), primary.session, a.id)).entries).toHaveLength(2);
  });

  it("RF7 US-56 : les informations de contrats renseignées par l'invité restent, ses adresses en copie disparaissent", async () => {
    const { primary, core } = await household();
    const a = await agent();
    const def = await db.insertInto("contract_definitions").values({ name: `Contrat ${tag()}`, sort_order: 997 }).returning("id").executeTakeFirstOrThrow();
    const field = await db.insertInto("contract_field_definitions").values({ contract_definition_id: def.id, label: "Assureur", field_type: "text" }).returning("id").executeTakeFirstOrThrow();
    const ac = await db.insertInto("account_contracts").values({ account_id: primary.accountId!, contract_definition_id: def.id }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("contract_field_values").values({ account_contract_id: ac.id, field_definition_id: field.id, value_text: "Maif", updated_by_user_id: core.id }).execute();
    await db.insertInto("profile_agents").values({ user_id: core.id, agent_id: a.id }).execute();
    await db.updateTable("agents").set({ cc_addresses_max_count: 3 }).where("id", "=", a.id).execute();
    await db.insertInto("cc_addresses").values({ user_id: core.id, agent_id: a.id, email: "voisin@exemple.fr" }).execute();

    await requestDeletion(at(), core.session, PASSWORD);
    await runLifecycle(at(daysLater(new Date(), 31)));

    expect(await db.selectFrom("cc_addresses").select("email").where("agent_id", "=", a.id).execute()).toEqual([]);
    const kept = await db.selectFrom("contract_field_values").select(["value_text", "updated_by_user_id"]).where("account_contract_id", "=", ac.id).executeTakeFirstOrThrow();
    expect(kept.value_text).toBe("Maif");
    expect(kept.updated_by_user_id).toBeNull();
  });

  it("US-20 RT2 : un invité retiré par l'utilisateur principal est supprimé après le délai de conservation", async () => {
    const { core } = await household();
    await db.updateTable("users").set({ status: "removed", removed_at: new Date(), purge_scheduled_at: daysLater(new Date(), 30) }).where("id", "=", core.id).execute();
    await runLifecycle(at(daysLater(new Date(), 10)));
    expect(await db.selectFrom("users").select("id").where("id", "=", core.id).executeTakeFirst()).toBeDefined();
    await runLifecycle(at(daysLater(new Date(), 31)));
    expect(await db.selectFrom("users").select("id").where("id", "=", core.id).executeTakeFirst()).toBeUndefined();
  });
});

describe("US-68 — comptes et invités jamais activés", () => {
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

  async function pendingPrimary(createdDaysAgo: number, linkDaysAgo?: number) {
    const profile = await createProfile(db, { status: "pending_activation" });
    await db.updateTable("users").set({ created_at: ago(createdDaysAgo) }).where("id", "=", profile.id).execute();
    if (linkDaysAgo !== undefined) {
      await db
        .insertInto("activation_links")
        .values({ user_id: profile.id, kind: "account_activation", token_hash: Buffer.from(randomUUID()), expires_at: new Date(Date.now() + 86_400_000), created_at: ago(linkDaysAgo) })
        .execute();
    }
    return profile;
  }

  it("CA 1.1, 7.1 : un compte jamais activé, dont le dernier lien a plus de 30 jours, est supprimé sans laisser de donnée nominative", async () => {
    const profile = await pendingPrimary(40, 31);
    await runLifecycle(at());
    expect(await db.selectFrom("accounts").select("id").where("id", "=", profile.accountId!).executeTakeFirst()).toBeUndefined();
    const trace = await db.selectFrom("erasure_traces").selectAll().where("former_user_id", "=", profile.id).executeTakeFirstOrThrow();
    expect(trace).toMatchObject({ former_role: "primary_user", digitorn_status: "done" });
    expect(JSON.stringify(trace)).not.toContain(profile.email);
  });

  it("CA 1.2, 4.1 : un lien renvoyé récemment remet le délai à zéro", async () => {
    const profile = await pendingPrimary(40, 5);
    await runLifecycle(at());
    expect(await db.selectFrom("accounts").select("id").where("id", "=", profile.accountId!).executeTakeFirst()).toBeDefined();
  });

  it("CA 2.1 : un invité jamais activé est supprimé et sa place est libérée dans le quota", async () => {
    const { primary } = await household();
    const guest = await db
      .insertInto("users")
      .values({ account_id: primary.accountId, role: "guest", guest_rank: "secondary", first_name: "Léa", last_name: "Roux", email: `lea-${tag()}@maaq.test`, status: "pending_activation", created_at: ago(40) })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db.insertInto("activation_links").values({ user_id: guest.id, kind: "guest_invitation", token_hash: Buffer.from(randomUUID()), expires_at: ago(1), created_at: ago(31) }).execute();
    const before = await db.selectFrom("v_account_guest_quota").select("guests_used").where("account_id", "=", primary.accountId!).executeTakeFirstOrThrow();

    await runLifecycle(at());
    expect(await db.selectFrom("users").select("id").where("id", "=", guest.id).executeTakeFirst()).toBeUndefined();
    const after = await db.selectFrom("v_account_guest_quota").select("guests_used").where("account_id", "=", primary.accountId!).executeTakeFirstOrThrow();
    expect(Number(after.guests_used)).toBe(Number(before.guests_used) - 1);
  });

  it("CA 3.1 : le délai est un réglage de la console", async () => {
    const profile = await pendingPrimary(20, 16);
    await runLifecycle(at());
    expect(await db.selectFrom("accounts").select("id").where("id", "=", profile.accountId!).executeTakeFirst()).toBeDefined(); // 16 jours < 30
    const restore = await setSetting("unactivated_purge_days", "15");
    try {
      await runLifecycle(at());
    } finally {
      await restore();
    }
    expect(await db.selectFrom("accounts").select("id").where("id", "=", profile.accountId!).executeTakeFirst()).toBeUndefined();
  });

  it("CA 6.1 : l'email d'un compte supprimé est de nouveau disponible", async () => {
    const profile = await pendingPrimary(40, 31);
    await runLifecycle(at());
    const account = await db.insertInto("accounts").values({ status: "activation_pending", guest_quota: 1 }).returning("id").executeTakeFirstOrThrow();
    await db
      .insertInto("users")
      .values({ account_id: account.id, role: "primary_user", first_name: "Camille", last_name: "Bis", email: profile.email, status: "pending_activation", initial_setup_step: "step_1_my_info" })
      .execute();
    expect(await db.selectFrom("users").select("id").where("email", "=", profile.email).execute()).toHaveLength(1);
  });
});
