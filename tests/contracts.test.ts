import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockDigitorn } from "@/server/adapters/digitorn/mock";
import { drive } from "@/server/adapters/drive";
import { EICAR_TEST_STRING } from "@/server/adapters/scanner";
import type { Ctx, SessionContext } from "@/server/auth/service";
import {
  addDocument,
  classifyDocument,
  clearContract,
  getContracts,
  readDocument,
  removeDocument,
  retryClassification,
  saveDetails,
  setConsent,
  type ContractView,
} from "@/server/contracts/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { emailFingerprint } from "@/server/security/crypto";
import { createProfile, minutesLater, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
let mock: MockDigitorn;

beforeAll(() => {
  db = testDb();
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

async function rejectionOf(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("refus attendu");
}

const PDF = (extra = "") => Buffer.from(`%PDF-1.4\n${extra}\n%%EOF`);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** Contrat de test avec un champ de chaque type, créé à la fin de la liste. */
async function contract(name = `Contrat ${tag()}`) {
  const last = await db.selectFrom("contract_definitions").select("sort_order").orderBy("sort_order", "desc").limit(1).executeTakeFirst();
  const def = await db.insertInto("contract_definitions").values({ name, sort_order: (last?.sort_order ?? 0) + 1 }).returning("id").executeTakeFirstOrThrow();
  const field = async (label: string, type: "text" | "date" | "amount" | "choice", required: boolean, order: number) =>
    (await db.insertInto("contract_field_definitions").values({ contract_definition_id: def.id, label, field_type: type, is_required: required, sort_order: order }).returning("id").executeTakeFirstOrThrow()).id;
  const insurer = await field("Assureur", "text", true, 1);
  const due = await field("Échéance", "date", false, 2);
  const premium = await field("Cotisation", "amount", false, 3);
  const formula = await field("Formule", "choice", false, 4);
  const options = [];
  for (const [i, label] of ["Basique", "Confort"].entries()) {
    options.push((await db.insertInto("contract_field_options").values({ field_definition_id: formula, label, sort_order: i + 1 }).returning("id").executeTakeFirstOrThrow()).id);
  }
  return { id: def.id, name, insurer, due, premium, formula, options };
}

async function household(options: { driveConnected?: boolean } = {}) {
  const primary = await createProfile(db);
  const guest = async (rank: "core" | "secondary") => {
    const row = await db
      .insertInto("users")
      .values({ account_id: primary.accountId, role: "guest", guest_rank: rank, first_name: rank === "core" ? "Thomas" : "Élodie", last_name: "Martin", email: `${rank}-${tag()}@maaq.test`, status: "active" })
      .returning(["id", "email"])
      .executeTakeFirstOrThrow();
    return { ...row, session: await sessionFor(db, row.id) };
  };
  if (options.driveConnected) {
    const type = await db.selectFrom("connector_types").select("id").where("code", "=", "google_drive").executeTakeFirstOrThrow();
    await db
      .insertInto("account_connections")
      .values({ account_id: primary.accountId!, connector_type_id: type.id, connected_email: "camille@exemple.fr", status: "connected", connected_by_user_id: primary.id })
      .execute();
  }
  return { primary: { ...primary, session: await sessionFor(db, primary.id) }, core: await guest("core"), secondary: await guest("secondary") };
}

async function view(session: SessionContext, id: string): Promise<ContractView> {
  const found = (await getContracts(at(), session)).contracts.find((c) => c.id === id);
  if (!found) throw new Error("contrat introuvable dans la liste");
  return found;
}

describe("US-30, US-32 — accès et liste", () => {
  it("RF3, RT1 : un invité secondaire et l'administrateur n'ont aucun accès aux contrats", async () => {
    const { secondary } = await household();
    expect((await rejectionOf(getContracts(at(), secondary.session))).status).toBe(403);
    const admin = await createProfile(db, { role: "admin" });
    expect((await rejectionOf(getContracts(at(), await sessionFor(db, admin.id)))).status).toBe(403);
  });

  it("RF1, RF6 : la liste suit l'ordre de l'administrateur ; un nouveau contrat arrive « Non renseigné »", async () => {
    const { primary } = await household();
    const first = await contract();
    const second = await contract();
    const ids = (await getContracts(at(), primary.session)).contracts.map((c) => c.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    expect(await view(primary.session, second.id)).toMatchObject({ filled: false, documents: [], modified: null, consent: { active: false } });
  });

  it("RF1 : un contrat retiré de la liste (archivé) n'apparaît plus", async () => {
    const { primary } = await household();
    const gone = await contract();
    await db.updateTable("contract_definitions").set({ archived_at: new Date() }).where("id", "=", gone.id).execute();
    expect((await getContracts(at(), primary.session)).contracts.map((c) => c.id)).not.toContain(gone.id);
  });

  it("RF11 : le bandeau Drive dit qui doit connecter ; seul l'utilisateur principal peut le faire", async () => {
    const { primary, core } = await household();
    const forCore = (await getContracts(at(), core.session)).drive;
    expect(forCore).toMatchObject({ connected: false, primaryFirstName: "Camille", canConnect: false });
    expect((await getContracts(at(), primary.session)).drive.canConnect).toBe(true);

    const connected = await household({ driveConnected: true });
    expect((await getContracts(at(), connected.core.session)).drive.connected).toBe(true);
  });

  it("US-36 RF2 : le texte de consentement publié est fourni à l'écran", async () => {
    const { primary } = await household();
    expect((await getContracts(at(), primary.session)).consentText).toContain("partenaire de MAAQ");
  });
});

describe("US-33 — détails d'un contrat", () => {
  it("RF2 : un champ obligatoire vide est refusé", async () => {
    const { primary } = await household();
    const c = await contract();
    const refused = await rejectionOf(saveDetails(at(), primary.session, c.id, { [c.premium]: "100" }));
    expect(refused.code).toBe("invalid_details");
    expect(refused.details).toEqual({ [c.insurer]: "Ce champ est obligatoire" });
  });

  it("RF3 : montant négatif ou non numérique, date impossible et choix inconnu sont refusés", async () => {
    const { primary } = await household();
    const c = await contract();
    const refused = await rejectionOf(saveDetails(at(), primary.session, c.id, { [c.insurer]: "Axa", [c.premium]: "-50", [c.due]: "2026-02-30", [c.formula]: "999999" }));
    expect(refused.details).toEqual({ [c.premium]: "Montant invalide", [c.due]: "Date invalide", [c.formula]: "Choix invalide" });
    expect((await rejectionOf(saveDetails(at(), primary.session, c.id, { [c.insurer]: "Axa", [c.premium]: "abc" }))).details).toMatchObject({ [c.premium]: "Montant invalide" });
    expect((await view(primary.session, c.id)).filled).toBe(false); // rien n'a été enregistré
  });

  it("RF5, RT1 : l'enregistrement rend le contrat « Renseigné », visible du noyau avec l'auteur et la date", async () => {
    const { primary, core } = await household();
    const c = await contract();
    const when = new Date("2026-10-12T09:00:00Z");
    const saved = await saveDetails(at(when), core.session, c.id, { [c.insurer]: "Maif", [c.due]: "2026-12-31", [c.premium]: "123,5 €", [c.formula]: c.options[1] });
    expect(saved.filled).toBe(true);
    expect(saved.modified).toEqual({ byFirstName: "Thomas", at: when.toISOString() });
    const seen = await view(primary.session, c.id);
    expect(Object.fromEntries(seen.fields.map((f) => [f.label, f.value]))).toEqual({ Assureur: "Maif", Échéance: "2026-12-31", Cotisation: "123.50", Formule: c.options[1] });
  });

  it("RF6 : la dernière modification enregistrée l'emporte", async () => {
    const { primary, core } = await household();
    const c = await contract();
    await saveDetails(at(), primary.session, c.id, { [c.insurer]: "Camille Assur" });
    await saveDetails(at(), core.session, c.id, { [c.insurer]: "Thomas Assur" });
    expect((await view(primary.session, c.id)).fields[0].value).toBe("Thomas Assur");
  });

  it("US-35 RF1 : un champ facultatif vidé est supprimé", async () => {
    const { primary } = await household();
    const c = await contract();
    await saveDetails(at(), primary.session, c.id, { [c.insurer]: "Axa", [c.premium]: "10" });
    await saveDetails(at(), primary.session, c.id, { [c.insurer]: "Axa", [c.premium]: "" });
    expect((await view(primary.session, c.id)).fields.find((f) => f.id === c.premium)?.value).toBeNull();
  });

  it("RF4 : un invité secondaire ne peut rien enregistrer", async () => {
    const { secondary } = await household();
    const c = await contract();
    expect((await rejectionOf(saveDetails(at(), secondary.session, c.id, { [c.insurer]: "Axa" }))).status).toBe(403);
  });

  it("un contrat inconnu ou archivé est introuvable", async () => {
    const { primary } = await household();
    expect((await rejectionOf(saveDetails(at(), primary.session, "999999999", {}))).status).toBe(404);
  });
});

describe("US-34 — documents scannés", () => {
  it("RF2, RF3 : seuls jpeg, jpg, gif et pdf dont le contenu correspond sont acceptés", async () => {
    const { primary } = await household();
    const c = await contract();
    const word = await rejectionOf(addDocument(at(), primary.session, c.id, { fileName: "contrat.docx", content: PDF() }));
    expect(word).toMatchObject({ code: "bad_format", message: "Format non accepté. Formats possibles : jpeg, jpg, gif, pdf." });
    // Une extension .pdf ne suffit pas : le contenu est vérifié côté serveur (RT3).
    expect((await rejectionOf(addDocument(at(), primary.session, c.id, { fileName: "faux.pdf", content: Buffer.from("MZ exécutable") }))).code).toBe("bad_format");
    expect((await rejectionOf(addDocument(at(), primary.session, c.id, { fileName: "vide.pdf", content: Buffer.alloc(0) }))).code).toBe("bad_format");

    await addDocument(at(), primary.session, c.id, { fileName: "scan.pdf", content: PDF() });
    await addDocument(at(), primary.session, c.id, { fileName: "photo.JPG", content: JPEG });
    expect((await view(primary.session, c.id)).documents.map((d) => d.mimeType)).toEqual(["application/pdf", "image/jpeg"]);
  });

  it("RF4, RT3 : la taille maximale vient des réglages de la console", async () => {
    const { primary } = await household();
    const c = await contract();
    const big = PDF("x".repeat(1_100_000)); // un peu plus de 1 Mo
    const before = await db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", "max_document_size_mb").executeTakeFirstOrThrow();
    await db.updateTable("platform_settings").set({ value_text: "1" }).where("setting_key", "=", "max_document_size_mb").execute();
    try {
      const refused = await rejectionOf(addDocument(at(), primary.session, c.id, { fileName: "gros.pdf", content: big }));
      expect(refused).toMatchObject({ code: "too_large", message: "Ce document dépasse 1 Mo." });
    } finally {
      await db.updateTable("platform_settings").set({ value_text: before.value_text }).where("setting_key", "=", "max_document_size_mb").execute();
    }
    await addDocument(at(), primary.session, c.id, { fileName: "gros.pdf", content: big }); // accepté sous la limite de 15 Mo
  });

  it("RF5 : le nombre de documents par contrat est limité par les réglages", async () => {
    const { primary } = await household();
    const c = await contract();
    const before = await db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", "max_documents_per_contract").executeTakeFirstOrThrow();
    await db.updateTable("platform_settings").set({ value_text: "2" }).where("setting_key", "=", "max_documents_per_contract").execute();
    try {
      await addDocument(at(), primary.session, c.id, { fileName: "a.pdf", content: PDF("a") });
      await addDocument(at(), primary.session, c.id, { fileName: "b.pdf", content: PDF("b") });
      const refused = await rejectionOf(addDocument(at(), primary.session, c.id, { fileName: "c.pdf", content: PDF("c") }));
      expect(refused).toMatchObject({ code: "too_many_documents", message: "Ce contrat a atteint le nombre maximum de documents (2)." });
    } finally {
      await db.updateTable("platform_settings").set({ value_text: before.value_text }).where("setting_key", "=", "max_documents_per_contract").execute();
    }
  });

  it("RF6 : chaque document porte son nom, sa date d'ajout et le prénom de l'auteur", async () => {
    const { primary, core } = await household();
    const c = await contract();
    const when = new Date("2026-10-05T08:00:00Z");
    await addDocument(at(when), core.session, c.id, { fileName: "attestation.pdf", content: PDF() });
    const [doc] = (await view(primary.session, c.id)).documents;
    expect(doc).toMatchObject({ fileName: "attestation.pdf", addedAt: when.toISOString(), addedByFirstName: "Thomas", status: "pending" });
  });

  it("RT2 : un document infecté est refusé avant d'être rendu disponible", async () => {
    const { primary } = await household();
    const c = await contract();
    const refused = await rejectionOf(addDocument(at(), primary.session, c.id, { fileName: "virus.pdf", content: PDF(EICAR_TEST_STRING) }));
    expect(refused.code).toBe("document_infected");
    expect((await view(primary.session, c.id)).documents).toEqual([]);
  });

  it("RF6 : l'aperçu est servi depuis le stockage provisoire, puis depuis le Drive une fois classé", async () => {
    const { primary } = await household({ driveConnected: true });
    const c = await contract();
    const { documentId } = await addDocument(at(), primary.session, c.id, { fileName: "scan.pdf", content: PDF("aperçu") });
    expect((await readDocument(at(), primary.session, documentId)).content.toString()).toContain("aperçu");
    expect(await classifyDocument(db, documentId, { delaysMs: [0, 0] })).toBe("classified");
    expect((await readDocument(at(), primary.session, documentId)).content.toString()).toContain("aperçu");
  });

  it("l'aperçu est refusé à un invité secondaire et à un autre compte", async () => {
    const { primary, secondary } = await household();
    const other = await household();
    const c = await contract();
    const { documentId } = await addDocument(at(), primary.session, c.id, { fileName: "scan.pdf", content: PDF() });
    expect((await rejectionOf(readDocument(at(), secondary.session, documentId))).status).toBe(403);
    expect((await rejectionOf(readDocument(at(), other.primary.session, documentId))).status).toBe(404);
  });
});

describe("US-34 — classement dans le Drive par Admin_Classify", () => {
  async function upload(session: SessionContext, id: string, name = "scan.pdf", content = PDF()) {
    return (await addDocument(at(), session, id, { fileName: name, content })).documentId;
  }
  const statusOf = async (session: SessionContext, id: string) => (await view(session, id)).documents.map((d) => d.status);

  it("RF13 : « Classement en cours » puis « Document disponible » ; le fichier provisoire est effacé", async () => {
    const { primary } = await household({ driveConnected: true });
    const c = await contract();
    const id = await upload(primary.session, c.id);
    expect(await statusOf(primary.session, c.id)).toEqual(["pending"]);
    expect(await classifyDocument(db, id, { delaysMs: [0, 0] })).toBe("classified");
    expect(await statusOf(primary.session, c.id)).toEqual(["available"]);
    const row = await db.selectFrom("contract_documents").select(["drive_file_ref", "staging_storage_key"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.drive_file_ref).toBeTruthy();
    expect(row.staging_storage_key).toBeNull();
  });

  it("RT1, CA 12.1 : le classement utilise le Drive de l'utilisateur principal, même pour un document ajouté par l'invité 1", async () => {
    const { primary, core } = await household({ driveConnected: true });
    const c = await contract();
    const id = await upload(core.session, c.id);
    await classifyDocument(db, id, { delaysMs: [0, 0] });
    const ownerRef = (await db.selectFrom("users").select("digitorn_user_ref").where("id", "=", primary.id).executeTakeFirstOrThrow()).digitorn_user_ref;
    expect(mock.classified[0].ownerRef).toBe(ownerRef);
    expect(mock.classified[0].accountId).toBe(primary.accountId);
  });

  it("RF12, CA 12.2 : un document déjà présent dans le Drive n'est pas classé une seconde fois", async () => {
    const { primary } = await household({ driveConnected: true });
    const c = await contract();
    const first = await upload(primary.session, c.id, "attestation.pdf", PDF("identique"));
    const second = await upload(primary.session, c.id, "attestation-bis.pdf", PDF("identique"));
    await classifyDocument(db, first, { delaysMs: [0, 0] });
    await classifyDocument(db, second, { delaysMs: [0, 0] });
    const refs = await db.selectFrom("contract_documents").select("drive_file_ref").where("id", "in", [first, second]).execute();
    expect(new Set(refs.map((r) => r.drive_file_ref)).size).toBe(1);
  });

  it("RF14 : trois essais automatiques ; réussir au troisième ne montre aucune erreur", async () => {
    const { primary } = await household({ driveConnected: true });
    const c = await contract();
    const id = await upload(primary.session, c.id);
    mock.classificationFailures = 2;
    expect(await classifyDocument(db, id, { delaysMs: [0, 0] })).toBe("classified");
    expect(mock.classified).toHaveLength(1);
  });

  it("RF14 : après trois échecs, « Classement impossible » ; « Réessayer » repart de zéro", async () => {
    const { primary } = await household({ driveConnected: true });
    const c = await contract();
    const id = await upload(primary.session, c.id);
    mock.classificationFailures = 3;
    expect(await classifyDocument(db, id, { delaysMs: [0, 0] })).toBe("failed");
    expect(await statusOf(primary.session, c.id)).toEqual(["failed"]);

    const retried = await retryClassification(at(), primary.session, id);
    expect(retried.documents[0].status).toBe("pending");
    await vi.waitFor(async () => expect(await statusOf(primary.session, c.id)).toEqual(["available"]), { timeout: 8000 });
  });

  it("RF14, CA 14.1 : sans Drive connecté, le classement échoue aussitôt", async () => {
    const { primary } = await household();
    const c = await contract();
    const id = await upload(primary.session, c.id);
    expect(await classifyDocument(db, id, { delaysMs: [0, 0] })).toBe("failed");
    expect(mock.classified).toHaveLength(0);
  });

  it("un document retiré pendant le classement n'est pas ressuscité", async () => {
    const { primary } = await household({ driveConnected: true });
    const c = await contract();
    const id = await upload(primary.session, c.id);
    await removeDocument(at(), primary.session, id);
    expect(await classifyDocument(db, id, { delaysMs: [0, 0] })).toBe("gone");
  });
});

describe("US-35 — retrait et suppression", () => {
  it("RF2, RT1, CA 4.1 : retirer un document le retire pour tout le noyau, mais il reste dans le Drive", async () => {
    const { primary, core } = await household({ driveConnected: true });
    const c = await contract();
    const { documentId } = await addDocument(at(), core.session, c.id, { fileName: "habitation.pdf", content: PDF("reste dans le drive") });
    await classifyDocument(db, documentId, { delaysMs: [0, 0] });
    const ref = (await db.selectFrom("contract_documents").select("drive_file_ref").where("id", "=", documentId).executeTakeFirstOrThrow()).drive_file_ref!;

    const after = await removeDocument(at(), primary.session, documentId);
    expect(after.documents).toEqual([]);
    expect((await view(core.session, c.id)).documents).toEqual([]);
    expect((await drive().read(primary.accountId!, ref)).content.toString()).toContain("reste dans le drive");
  });

  it("RF3, RT2 : la suppression complète vide les champs et les documents, le contrat reste « Non renseigné »", async () => {
    const { primary, core } = await household({ driveConnected: true });
    const c = await contract();
    await saveDetails(at(), primary.session, c.id, { [c.insurer]: "Axa" });
    const { documentId } = await addDocument(at(), primary.session, c.id, { fileName: "a.pdf", content: PDF() });
    await classifyDocument(db, documentId, { delaysMs: [0, 0] });

    const cleared = await clearContract(at(), core.session, c.id);
    expect(cleared).toMatchObject({ filled: false, documents: [], modified: null });
    expect(cleared.fields.every((f) => f.value === null)).toBe(true);
    expect((await getContracts(at(), primary.session)).contracts.map((x) => x.id)).toContain(c.id);
  });

  it("RF5 : la suppression complète remet le consentement à « désactivé » et le journalise", async () => {
    const { primary } = await household();
    const c = await contract();
    await setConsent(at(), primary.session, c.id, { active: true, accepted: true });
    const cleared = await clearContract(at(), primary.session, c.id);
    expect(cleared.consent.active).toBe(false);
    const events = await db.selectFrom("contract_consent_events").select(["action_type", "trigger_reason"]).where("account_id", "=", primary.accountId!).where("contract_definition_id", "=", c.id).orderBy("id").execute();
    expect(events).toEqual([
      { action_type: "granted", trigger_reason: "user_action" },
      { action_type: "withdrawn", trigger_reason: "contract_details_deleted" },
    ]);
  });

  it("RF4 : un invité secondaire ne peut ni retirer ni supprimer", async () => {
    const { primary, secondary } = await household();
    const c = await contract();
    const { documentId } = await addDocument(at(), primary.session, c.id, { fileName: "a.pdf", content: PDF() });
    expect((await rejectionOf(removeDocument(at(), secondary.session, documentId))).status).toBe(403);
    expect((await rejectionOf(clearContract(at(), secondary.session, c.id))).status).toBe(403);
  });
});

describe("US-36 — consentement au challenge", () => {
  it("RF1 : désactivé par défaut, même pour un contrat non renseigné (RF6)", async () => {
    const { primary } = await household();
    const c = await contract();
    expect((await view(primary.session, c.id)).consent).toEqual({ active: false, byFirstName: null, at: null });
  });

  it("RF2 : l'activation exige l'acceptation du texte ; la désactivation est immédiate", async () => {
    const { primary } = await household();
    const c = await contract();
    expect((await rejectionOf(setConsent(at(), primary.session, c.id, { active: true }))).code).toBe("consent_required");
    expect((await view(primary.session, c.id)).consent.active).toBe(false);

    expect((await setConsent(at(), primary.session, c.id, { active: true, accepted: true })).consent.active).toBe(true);
    expect((await setConsent(at(), primary.session, c.id, { active: false })).consent.active).toBe(false);
  });

  it("RF3 : l'état est partagé, avec « Activé par [prénom] le [date] »", async () => {
    const { primary, core } = await household();
    const c = await contract();
    const when = new Date("2026-10-10T10:00:00Z");
    await setConsent(at(when), core.session, c.id, { active: true, accepted: true });
    expect((await view(primary.session, c.id)).consent).toEqual({ active: true, byFirstName: "Thomas", at: when.toISOString() });
    await setConsent(at(minutesLater(when, 5)), primary.session, c.id, { active: false });
    expect((await view(core.session, c.id)).consent).toMatchObject({ active: false, byFirstName: "Camille" });
  });

  it("RT1 : chaque changement est journalisé avec la version du texte et une empreinte de l'email", async () => {
    const { primary } = await household();
    const c = await contract();
    await setConsent(at(), primary.session, c.id, { active: true, accepted: true });
    await setConsent(at(), primary.session, c.id, { active: false });
    const events = await db.selectFrom("contract_consent_events").selectAll().where("account_id", "=", primary.accountId!).orderBy("id").execute();
    expect(events.map((e) => e.action_type)).toEqual(["granted", "withdrawn"]);
    expect(events[0].legal_version_id).toBeTruthy();
    expect(events[0].actor_user_id).toBe(primary.id);
    expect(Buffer.from(events[0].actor_email_hash).equals(emailFingerprint(primary.email, Buffer.from(env().HMAC_KEY, "base64")))).toBe(true);
    expect(Buffer.from(events[0].actor_email_hash).toString("utf8")).not.toContain(primary.email);
  });

  it("deux activations simultanées ne journalisent qu'un seul consentement", async () => {
    const { primary, core } = await household();
    const c = await contract();
    await Promise.all([
      setConsent(at(), primary.session, c.id, { active: true, accepted: true }),
      setConsent(at(), core.session, c.id, { active: true, accepted: true }),
    ]);
    const events = await db.selectFrom("contract_consent_events").select("id").where("account_id", "=", primary.accountId!).execute();
    expect(events).toHaveLength(1);
  });

  it("RF10, CA 10.1 : la preuve survit à la suppression du compte, sans email en clair", async () => {
    const { primary } = await household();
    const c = await contract();
    await setConsent(at(), primary.session, c.id, { active: true, accepted: true });
    await db.deleteFrom("accounts").where("id", "=", primary.accountId!).execute();
    const events = await db.selectFrom("contract_consent_events").select("actor_email_hash").where("contract_definition_id", "=", c.id).execute();
    expect(events).toHaveLength(1);
    expect(Buffer.from(events[0].actor_email_hash).equals(emailFingerprint(primary.email, Buffer.from(env().HMAC_KEY, "base64")))).toBe(true);
  });

  it("RF4 : un invité secondaire ne peut pas consentir", async () => {
    const { secondary } = await household();
    const c = await contract();
    expect((await rejectionOf(setConsent(at(), secondary.session, c.id, { active: true, accepted: true }))).status).toBe(403);
  });
});
