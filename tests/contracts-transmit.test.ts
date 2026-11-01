import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { addContract as addCategory, addContractField, addDocumentField, archiveContract } from "@/server/admin/contracts";
import { updateSettings } from "@/server/admin/settings";
import { messenger } from "@/server/adapters/messaging";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { addContract, addDocument, getContracts, setChannel, type ContractView } from "@/server/contracts/service";
import { planTransmission } from "@/server/contracts/plan";
import { runContractMaintenance } from "@/server/contracts/maintenance";
import { familyReference, relaunchChannel, transmitContract } from "@/server/contracts/transmit";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createGuest, createProfile, messagesTo, sessionFor, testDb } from "./helpers/fixtures";

process.env.CONTRACT_ANALYSIS_MODE = "preview";

let db: Kysely<DB>;
let adminId: string;
const BROKER = `courtier-${Math.random().toString(36).slice(2, 7)}@courtier.test`;
beforeAll(async () => {
  db = testDb();
  adminId = (await createProfile(db, { role: "admin" })).id;
  await updateSettings(at(), adminId, { contract_broker_name: "Courtier Exemple", contract_broker_email: BROKER });
});
afterAll(async () => {
  await updateSettings(at(), adminId, { contract_broker_name: "", contract_broker_email: "" });
  await db.destroy();
});
afterEach(() => vi.restoreAllMocks());

const at = (now = new Date()): Ctx => ({ db, now });
const tag = () => Math.random().toString(36).slice(2, 8);
const PDF = (n = 1) => Buffer.from(`%PDF-1.4\n${"1 0 obj << /Type /Page >> endobj\n".repeat(n)}%%EOF`);
const JPEG = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, n]);

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

async function category() {
  const id = await addCategory(at(), adminId, `Assurance ${tag()}`);
  const required = await addDocumentField(at(), adminId, id, { name: "Conditions particulières" });
  const optional = await addDocumentField(at(), adminId, id, { name: "Avis d'échéance", required: false });
  await addContractField(at(), adminId, id, { label: "Numéro de police", type: "text", required: false, options: [] });
  return { id, required, optional };
}

async function family() {
  const primary = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: "Europe/Paris" }).where("id", "=", primary.accountId!).execute();
  const core = await createGuest(db, primary.accountId!, "Julien", "core");
  return { accountId: primary.accountId!, session: await sessionFor(db, primary.id), coreSession: await sessionFor(db, core.id) };
}

async function baseOf(session: SessionContext, categoryId: string): Promise<ContractView> {
  return (await getContracts(at(), session)).categories.find((c) => c.id === categoryId)!.contracts.find((c) => c.isBase)!;
}

/** Contrat prêt pour le challenge : champ obligatoire déposé, challenge activé. */
async function readyForChallenge() {
  const f = await family();
  const c = await category();
  const base = await baseOf(f.session, c.id);
  await addDocument(at(), f.session, base.id, c.required, [{ name: "conditions.pdf", content: PDF(2) }]);
  await setChannel(at(), f.session, base.id, "challenge", { enabled: true, accepted: true });
  return { f, c, base };
}

describe("plan de transmission (US-129 RF1, RF2, US-130)", () => {
  const slot = (over: Partial<{ required: boolean; status: string; transmittedAt: string | null; expiresAt: string; empty: boolean }> = {}) => ({
    fieldId: "1",
    name: "Conditions",
    required: over.required ?? true,
    document: over.empty ? null : { transmittedAt: over.transmittedAt ?? null, expiresAt: over.expiresAt ?? "2099-01-01T00:00:00Z", masking: { status: over.status ?? "pending" } },
  });
  const context = { analysisOpen: true, challengeAvailable: true, archived: false, now: new Date("2026-11-02T10:00:00Z") };

  it("la ligne dit ce qui partira ; sans interrupteur actif, la consigne d'en activer un ; une proposition d'activer l'autre canal", () => {
    const only = (a: boolean, c: boolean) => planTransmission({ analysis: { enabled: a }, challenge: { enabled: c }, slots: [slot({ status: "verified" })], missingRequired: 0 }, context);
    expect(only(true, true).line).toBe("Pour analyse et challenge");
    expect(only(true, false)).toMatchObject({ line: "Pour analyse", offer: "challenge", ready: true });
    expect(only(false, true)).toMatchObject({ line: "Pour challenge", offer: "analysis", ready: true });
    expect(only(false, false)).toMatchObject({ line: "Activez l'analyse ou le challenge pour transmettre", ready: false, offer: null });
    // Tant que le challenge est bloqué (courtier non désigné), on ne le propose pas (US-130 RF5).
    expect(planTransmission({ analysis: { enabled: true }, challenge: { enabled: false }, slots: [slot({ status: "verified" })], missingRequired: 0 }, { ...context, challengeAvailable: false }).offer).toBeNull();
    // Analyse fermée : seul le challenge compte.
    expect(planTransmission({ analysis: { enabled: true }, challenge: { enabled: true }, slots: [slot()], missingRequired: 0 }, { ...context, analysisOpen: false }).line).toBe("Pour challenge");
  });

  it("l'analyse attend un masquage vérifié ; le challenge n'en dépend pas ; un champ obligatoire vide, un envoi déjà fait ou une catégorie archivée bloquent", () => {
    const c = { analysis: { enabled: true }, challenge: { enabled: true }, slots: [slot({ status: "pending" })], missingRequired: 0 };
    const mixed = planTransmission(c, context);
    expect(mixed).toMatchObject({ forAnalysis: false, forChallenge: true, ready: true });
    expect(mixed.analysisBlockers[0]).toMatch(/masquage/);
    expect(planTransmission({ ...c, challenge: { enabled: false } }, context)).toMatchObject({ ready: false, forAnalysis: false });
    expect(planTransmission({ ...c, slots: [slot({ status: "verified" })] }, context)).toMatchObject({ forAnalysis: true, forChallenge: true, ready: true });
    expect(planTransmission({ ...c, missingRequired: 1 }, context).ready).toBe(false);
    expect(planTransmission({ ...c, slots: [slot({ transmittedAt: "2026-11-02T09:00:00Z", expiresAt: "2026-11-04T09:00:00Z" })] }, context)).toMatchObject({ alreadyTransmitted: true, ready: false });
    expect(planTransmission(c, { ...context, archived: true }).ready).toBe(false);
  });
});

describe("transmission pour le challenge par email (US-129 RF5, RF6, C-03)", () => {
  it("l'email part vers la boîte du courtier avec les documents d'origine en pièces jointes, la catégorie et un identifiant de famille, sans le nom du contrat ; les documents sont datés et verrouillés", async () => {
    const { f, c, base } = await readyForChallenge();
    const renamed = `Clio de Julien ${tag()}`;
    const named = await addContract(at(), f.coreSession, c.id, renamed);
    await addDocument(at(), f.coreSession, named.id, c.required, [1, 2, 3].map((n) => ({ name: `p${n}.jpg`, content: JPEG(n) })));
    await setChannel(at(), f.coreSession, named.id, "challenge", { enabled: true, accepted: true });
    const before = (await messagesTo(BROKER)).length;

    const done = await transmitContract(at(), f.coreSession, named.id);
    expect(done.transmission).toMatchObject({ forChallenge: true, forAnalysis: false, challengeStatus: "sent", byFirstName: "Julien" });
    expect(Date.parse(done.transmission!.documentsDeletedAt) - Date.parse(done.transmission!.at)).toBe(48 * 3_600_000);
    expect(done.slots[0].document).toMatchObject({ locked: true });
    const mails = (await messagesTo(BROKER)).slice(0, (await messagesTo(BROKER)).length - before);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain(familyReference(f.accountId));
    expect(mails[0].subject).toContain((await db.selectFrom("contract_definitions").select("name").where("id", "=", c.id).executeTakeFirstOrThrow()).name);
    expect(mails[0].text).toContain("Pièces jointes");
    expect(mails[0].text).toMatch(/Conditions particulières-1\.jpg.*Conditions particulières-2\.jpg.*Conditions particulières-3\.jpg/);
    expect(mails[0].text + mails[0].subject).not.toContain(renamed); // jamais le nom du contrat
    expect(mails[0].text).not.toContain("JFIF");
    // Pas de double transmission, ni d'autre dépôt.
    expect((await failure(transmitContract(at(), f.coreSession, named.id))).code).toBe("already_transmitted");
    expect(base.id).not.toBe(named.id);
  });

  it("refus : aucun canal actif, champ obligatoire vide, catégorie archivée", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.session, c.id);
    expect((await failure(transmitContract(at(), f.session, base.id))).code).toBe("missing_required");
    await addDocument(at(), f.session, base.id, c.required, [{ name: "c.pdf", content: PDF() }]);
    expect((await failure(transmitContract(at(), f.session, base.id))).code).toBe("no_channel");
    await setChannel(at(), f.session, base.id, "challenge", { enabled: true, accepted: true });
    await archiveContract(at(), adminId, c.id);
    expect((await failure(transmitContract(at(), f.session, base.id))).message).toMatch(/archivée/);
    // Le contrat d'une autre famille n'existe pas pour celle-ci.
    const other = await family();
    expect((await failure(transmitContract(at(), other.session, base.id))).status).toBe(404);
  });

  it("échec de l'envoi : repris à chaque passage pendant 1 heure, puis « échoué » ; « Renvoyer » repart pour une heure et aboutit sans prolonger les 48 h", async () => {
    const { f, base } = await readyForChallenge();
    vi.spyOn(messenger(), "sendEmail").mockRejectedValue(new Error("boîte injoignable"));
    const sent = await transmitContract(at(), f.session, base.id);
    expect(sent.transmission?.challengeStatus).toBe("sending");
    const transmittedAt = new Date(sent.transmission!.at);

    await runContractMaintenance(at(new Date(transmittedAt.getTime() + 30 * 60_000)));
    expect((await baseOf(f.session, base.categoryId)).transmission?.challengeStatus).toBe("sending");
    await runContractMaintenance(at(new Date(transmittedAt.getTime() + 61 * 60_000)));
    const failed = await baseOf(f.session, base.categoryId);
    expect(failed.transmission?.challengeStatus).toBe("failed");
    expect(failed.reportAt).toBeNull();

    // « Renvoyer » : la boîte répond de nouveau.
    vi.restoreAllMocks();
    const row = await db.selectFrom("contract_transmissions").select(["id", "challenge_attempts"]).where("account_contract_id", "=", base.id).executeTakeFirstOrThrow();
    const again = await relaunchChannel(at(), f.session, base.id, "challenge");
    expect(again.transmission?.challengeStatus).toBe("sent");
    expect((await db.selectFrom("contract_transmissions").select("challenge_attempts").where("id", "=", row.id).executeTakeFirstOrThrow()).challenge_attempts).toBeGreaterThan(row.challenge_attempts);
    // Une relance ne prolonge pas le délai de 48 h.
    expect(again.slots[0].document?.expiresAt).toBe(again.transmission!.documentsDeletedAt);
    // Rien à renvoyer quand l'envoi a abouti.
    expect((await failure(relaunchChannel(at(), f.session, base.id, "challenge"))).message).toMatch(/échoué|renvoie/);
  });
});

describe("transmission pour analyse : masquage vérifié, plafond quotidien (US-129, US-131 RT4, C-11)", () => {
  async function verified(f: Awaited<ReturnType<typeof family>>, categoryId: string, fieldId: string) {
    const base = await baseOf(f.session, categoryId);
    await addDocument(at(), f.session, base.id, fieldId, [{ name: "c.pdf", content: PDF() }]);
    const doc = await db.selectFrom("contract_field_documents").select("id").where("account_contract_id", "=", base.id).executeTakeFirstOrThrow();
    // Le masquage arrive avec l'étape suivante : on suit le chemin d'états que la base autorise.
    await db.updateTable("contract_field_documents").set({ masking_status: "masking" }).where("id", "=", doc.id).execute();
    await db.updateTable("contract_field_documents").set({ masking_status: "to_verify", masked_text: Buffer.from("texte masqué"), confidence_pct: 95 }).where("id", "=", doc.id).execute();
    await db.updateTable("contract_field_documents").set({ masking_status: "verified", verified_by_user_id: (await db.selectFrom("users").select("id").where("account_id", "=", f.accountId).where("role", "=", "primary_user").executeTakeFirstOrThrow()).id }).where("id", "=", doc.id).execute();
    await setChannel(at(), f.session, base.id, "analysis", { enabled: true, accepted: true });
    return base;
  }

  it("l'analyse attend un document vérifié ; ensuite elle part, l'état devient « en cours » et elle compte au plafond du profil qui transmet", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.session, c.id);
    await addDocument(at(), f.session, base.id, c.required, [{ name: "c.pdf", content: PDF() }]);
    await setChannel(at(), f.session, base.id, "analysis", { enabled: true, accepted: true });
    const waiting = await baseOf(f.session, c.id);
    expect(waiting.transmit).toMatchObject({ forAnalysis: false, ready: false });
    expect((await failure(transmitContract(at(), f.session, base.id))).code).toBe("analysis_blocked");

    const f2 = await family();
    const c2 = await category();
    const ready = await verified(f2, c2.id, c2.required);
    expect((await baseOf(f2.session, c2.id)).transmit).toMatchObject({ forAnalysis: true, ready: true, line: "Pour analyse" });
    const user = (await db.selectFrom("users").select("id").where("account_id", "=", f2.accountId).where("role", "=", "primary_user").executeTakeFirstOrThrow()).id;
    const day = (await sql<{ d: string }>`select (now() at time zone 'Europe/Paris')::date::text as d`.execute(db)).rows[0].d;
    const done = await transmitContract(at(), f2.session, ready.id);
    expect(done.transmission).toMatchObject({ forAnalysis: true, analysisStatus: "running" });
    const counter = await db.selectFrom("daily_request_counters").select("request_count").where("user_id", "=", user).where("request_date", "=", sql<Date>`${day}::date`).executeTakeFirstOrThrow();
    expect(counter.request_count).toBe(1);
  });

  it("au-delà du plafond quotidien, l'analyse est refusée avec le message du plafond et rien n'est transmis ; le challenge seul reste possible", async () => {
    const f = await family();
    await db.updateTable("accounts").set({ daily_request_limit: 1 }).where("id", "=", f.accountId).execute();
    const c = await category();
    const first = await verified(f, c.id, c.required);
    const c2 = await category();
    const second = await verified(f, c2.id, c2.required);
    await transmitContract(at(), f.session, first.id);
    const refused = await failure(transmitContract(at(), f.session, second.id));
    expect(refused).toMatchObject({ code: "daily_cap_reached", status: 429 });
    expect(refused.message).toContain("limite de 1 demandes");
    expect((await baseOf(f.session, c2.id)).transmission).toBeNull();
    // Challenge seul : permis.
    await setChannel(at(), f.session, second.id, "analysis", { enabled: false });
    await setChannel(at(), f.session, second.id, "challenge", { enabled: true, accepted: true });
    expect((await transmitContract(at(), f.session, second.id)).transmission).toMatchObject({ forChallenge: true, forAnalysis: false });
  });
});
