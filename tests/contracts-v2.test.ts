import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addContract as addCategory, addContractField, addDocumentField, archiveContract, updateDocumentField } from "@/server/admin/contracts";
import { updateSettings } from "@/server/admin/settings";
import type { Ctx, SessionContext } from "@/server/auth/service";
import {
  addContract,
  addDocument,
  bundlePhotos,
  clearContract,
  deleteContract,
  getContracts,
  readDocument,
  removeDocument,
  renameContract,
  saveDetails,
  setChannel,
  unbundlePhotos,
  type ContractView,
} from "@/server/contracts/service";
import { runContractMaintenance } from "@/server/contracts/maintenance";
import { loadDocument, objectStore } from "@/server/contracts/storage";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createGuest, createProfile, messagesTo, sessionFor, testDb } from "./helpers/fixtures";

// Le mode « preview » rend l'interrupteur « Analyse IA » utilisable sans aucun appel au modèle ; il est lu à la première utilisation de la configuration.
process.env.CONTRACT_ANALYSIS_MODE = "preview";

let db: Kysely<DB>;
let adminId: string;
beforeAll(async () => {
  db = testDb();
  adminId = (await createProfile(db, { role: "admin" })).id;
});
afterAll(async () => {
  await db.destroy();
});

const at = (now = new Date()): Ctx => ({ db, now });
const tag = () => Math.random().toString(36).slice(2, 8);

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

const PDF = (pages = 1) => Buffer.from(`%PDF-1.4\n${"1 0 obj << /Type /Page >> endobj\n".repeat(pages)}%%EOF`);
const JPEG = (n = 0) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, n]);

/** Catégorie de test : un champ obligatoire, un facultatif, un détail texte obligatoire et une liste de choix. */
async function category(name = `Catégorie ${tag()}`) {
  const id = await addCategory(at(), adminId, name);
  const required = await addDocumentField(at(), adminId, id, { name: "Conditions particulières", help: "La page des garanties" });
  const optional = await addDocumentField(at(), adminId, id, { name: "Avis d'échéance", required: false });
  await addContractField(at(), adminId, id, { label: "Numéro de police", type: "text", required: true, options: [] });
  return { id, name, required, optional };
}

async function family() {
  const primary = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: "Europe/Paris" }).where("id", "=", primary.accountId!).execute();
  const core = await createGuest(db, primary.accountId!, "Julien", "core");
  const secondary = await createGuest(db, primary.accountId!, "Élodie");
  return { accountId: primary.accountId!, primary, primarySession: await sessionFor(db, primary.id), coreSession: await sessionFor(db, core.id), secondarySession: await sessionFor(db, secondary.id) };
}

async function baseOf(session: SessionContext, categoryId: string): Promise<ContractView> {
  const view = await getContracts(at(), session);
  return view.categories.find((c) => c.id === categoryId)!.contracts.find((c) => c.isBase)!;
}

describe("Mes contrats : base d'office, catégories, accès (US-124, US-32)", () => {
  it("le contrat de base de chaque catégorie proposée est créé d'office et porte le nom de la catégorie ; les invités secondaires n'ont pas accès", async () => {
    const f = await family();
    const c = await category();
    const view = await getContracts(at(), f.primarySession);
    const mine = view.categories.find((x) => x.id === c.id)!;
    expect(mine).toMatchObject({ name: c.name, archived: false, canAdd: true });
    expect(mine.contracts).toHaveLength(1);
    expect(mine.contracts[0]).toMatchObject({ name: c.name, isBase: true, createdBy: null, filled: false, missingRequired: 1 });
    expect(mine.contracts[0].slots.map((s) => [s.name, s.required, s.document])).toEqual([["Conditions particulières", true, null], ["Avis d'échéance", false, null]]);
    // Idempotent, et partagé avec l'invité 1.
    const again = await getContracts(at(), f.coreSession);
    expect(again.categories.find((x) => x.id === c.id)!.contracts).toHaveLength(1);
    expect((await failure(getContracts(at(), f.secondarySession))).status).toBe(403);
    expect(view.limits).toEqual({ maxDocumentMb: 15, maxContracts: 20 });
  });
});

describe("contrats complémentaires et noms (US-124, US-125, US-133)", () => {
  it("ajout, nom unique sans tenir compte des majuscules, 60 caractères, renommage ; « Ajouté par »", async () => {
    const f = await family();
    const c = await category();
    const added = await addContract(at(), f.coreSession, c.id, "Clio de Julien");
    expect(added).toMatchObject({ name: "Clio de Julien", isBase: false, createdBy: { firstName: "Julien" } });
    expect(await failure(addContract(at(), f.primarySession, c.id, "clio DE julien"))).toMatchObject({ code: "duplicate_name", message: "Un contrat porte déjà ce nom dans cette catégorie." });
    expect((await failure(addContract(at(), f.primarySession, c.id, " "))).code).toBe("invalid_name");
    expect((await failure(addContract(at(), f.primarySession, c.id, "x".repeat(61)))).code).toBe("invalid_name");
    // Le contrat de base se renomme, avec la même règle d'unicité.
    const base = await baseOf(f.primarySession, c.id);
    expect((await renameContract(at(), f.primarySession, base.id, "Auto familiale")).name).toBe("Auto familiale");
    expect((await failure(renameContract(at(), f.primarySession, base.id, "CLIO de julien"))).code).toBe("duplicate_name");
    // Le contrat d'un autre foyer n'existe pas pour celui-ci.
    const other = await family();
    expect((await failure(renameContract(at(), other.primarySession, added.id, "Intrus"))).status).toBe(404);
  });

  it("plafond de contrats par catégorie (réglage de la console) et catégorie archivée", async () => {
    const f = await family();
    const c = await category();
    await updateSettings(at(), adminId, { max_contracts_per_category: "2" });
    try {
      await addContract(at(), f.primarySession, c.id, "Deuxième");
      expect((await failure(addContract(at(), f.primarySession, c.id, "Troisième"))).message).toBe("Nombre maximum de contrats atteint pour cette catégorie.");
      const view = (await getContracts(at(), f.primarySession)).categories.find((x) => x.id === c.id)!;
      expect(view).toMatchObject({ atLimit: true, canAdd: false });
    } finally {
      await updateSettings(at(), adminId, { max_contracts_per_category: "20" });
    }
    await archiveContract(at(), adminId, c.id);
    const archived = (await getContracts(at(), f.primarySession)).categories.find((x) => x.id === c.id)!;
    expect(archived).toMatchObject({ archived: true, canAdd: false });
    expect((await failure(addContract(at(), f.primarySession, c.id, "Après archivage"))).message).toMatch(/n'est plus proposée/);
  });

  it("suppression : le contrat de base ne se supprime pas ; un complémentaire part avec ses données, les consentements actifs sont retirés et la preuve reste", async () => {
    const f = await family();
    const c = await category();
    await updateSettings(at(), adminId, { contract_broker_name: "Courtier Exemple", contract_broker_email: "challenge@courtier.test" });
    try {
      const base = await baseOf(f.primarySession, c.id);
      expect((await failure(deleteContract(at(), f.primarySession, base.id))).code).toBe("base_contract");
      const extra = await addContract(at(), f.primarySession, c.id, "Complémentaire");
      await setChannel(at(), f.primarySession, extra.id, "analysis", { enabled: true, accepted: true });
      await setChannel(at(), f.primarySession, extra.id, "challenge", { enabled: true, accepted: true });
      await addDocument(at(), f.primarySession, extra.id, c.required, [{ name: "conditions.pdf", content: PDF() }]);
      const key = (await db.selectFrom("contract_field_documents").select("storage_key").where("account_contract_id", "=", extra.id).executeTakeFirstOrThrow()).storage_key;
      expect(await deleteContract(at(), f.primarySession, extra.id)).toEqual({ challengeSentRecently: false });
      expect(await db.selectFrom("account_contracts").select("id").where("id", "=", extra.id).execute()).toEqual([]);
      const events = await db.selectFrom("contract_consent_events").select(["channel", "action_type", "trigger_reason"]).where("account_contract_id", "=", extra.id).orderBy("id").execute();
      expect(events.map((e) => `${e.channel}:${e.action_type}:${e.trigger_reason}`)).toEqual([
        "analysis:granted:user_action", "challenge:granted:user_action", "analysis:withdrawn:contract_deleted", "challenge:withdrawn:contract_deleted",
      ]);
      // Le fichier chiffré part à la file de suppression, puis le passage d'entretien l'efface.
      expect((await db.selectFrom("storage_deletion_queue").select("status").where("storage_key", "=", key).executeTakeFirstOrThrow()).status).toBe("pending");
      await runContractMaintenance(at());
      expect((await db.selectFrom("storage_deletion_queue").select("status").where("storage_key", "=", key).executeTakeFirstOrThrow()).status).toBe("done");
      await expect(objectStore().get(key)).rejects.toThrow();
    } finally {
      await updateSettings(at(), adminId, { contract_broker_name: "", contract_broker_email: "" });
    }
  });
});

describe("détails texte d'un contrat (US-33, US-35)", () => {
  it("enregistre, contrôle les champs obligatoires, puis « tout vider » remet le contrat à zéro et désactive les interrupteurs avec leur preuve", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    const field = base.fields[0];
    expect((await failure(saveDetails(at(), f.primarySession, base.id, {}))).code).toBe("invalid_details");
    const saved = await saveDetails(at(), f.coreSession, base.id, { [field.id]: "POL-123" });
    expect(saved).toMatchObject({ filled: true, modified: { byFirstName: "Julien" } });
    expect(saved.fields[0].value).toBe("POL-123");
    await setChannel(at(), f.primarySession, base.id, "analysis", { enabled: true, accepted: true });
    const cleared = await clearContract(at(), f.primarySession, base.id);
    expect(cleared).toMatchObject({ filled: false, modified: null, analysis: { enabled: false } });
    const events = await db.selectFrom("contract_consent_events").select(["channel", "action_type", "trigger_reason"]).where("account_contract_id", "=", base.id).orderBy("id").execute();
    expect(events.map((e) => `${e.channel}:${e.action_type}:${e.trigger_reason}`)).toEqual(["analysis:granted:user_action", "analysis:withdrawn:contract_details_deleted"]);
  });

  it("une catégorie archivée se consulte mais ne se modifie plus", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    await archiveContract(at(), adminId, c.id);
    expect((await failure(saveDetails(at(), f.primarySession, base.id, { [base.fields[0].id]: "x" }))).code).toBe("category_archived");
    expect((await failure(addDocument(at(), f.primarySession, base.id, c.required, [{ name: "a.pdf", content: PDF() }]))).message).toMatch(/archivée/);
  });
});

describe("interrupteurs Analyse IA et Challenge, preuves de consentement (US-127, US-128, CT-4)", () => {
  it("analyse : activée avec le texte accepté, preuve avec la version du texte ; retrait immédiat ; un second appel identique n'ajoute rien", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    expect((await failure(setChannel(at(), f.primarySession, base.id, "analysis", { enabled: true }))).code).toBe("consent_required");
    const on = await setChannel(at(), f.coreSession, base.id, "analysis", { enabled: true, accepted: true });
    expect(on.analysis).toMatchObject({ enabled: true, byFirstName: "Julien" });
    await setChannel(at(), f.coreSession, base.id, "analysis", { enabled: true, accepted: true });
    const off = await setChannel(at(), f.primarySession, base.id, "analysis", { enabled: false });
    expect(off.analysis.enabled).toBe(false);
    const events = await db
      .selectFrom("contract_consent_events as e")
      .innerJoin("legal_document_versions as v", "v.id", "e.legal_version_id")
      .select(["e.channel", "e.action_type", "v.document_type", "v.content"])
      .where("e.account_contract_id", "=", base.id)
      .orderBy("e.id")
      .execute();
    expect(events.map((e) => `${e.channel}:${e.action_type}`)).toEqual(["analysis:granted", "analysis:withdrawn"]);
    expect(events[0].document_type).toBe("contract_analysis_consent");
    expect(events[0].content).toContain("provisoire");
    expect(on.challenge.enabled).toBe(false);
  });

  it("challenge : bloqué tant que le courtier n'est pas désigné ; ensuite le texte cite son nom", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    const closed = await getContracts(at(), f.primarySession);
    expect(closed.challenge).toMatchObject({ available: false, brokerName: null });
    expect((await failure(setChannel(at(), f.primarySession, base.id, "challenge", { enabled: true, accepted: true }))).code).toBe("challenge_unavailable");
    await updateSettings(at(), adminId, { contract_broker_name: "Courtier Exemple", contract_broker_email: "challenge@courtier.test" });
    try {
      const open = await getContracts(at(), f.primarySession);
      expect(open.challenge.available).toBe(true);
      expect(open.challenge.text).toContain("Courtier Exemple");
      expect(open.challenge.text).not.toContain("[nom du partenaire]");
      const on = await setChannel(at(), f.primarySession, base.id, "challenge", { enabled: true, accepted: true });
      expect(on.challenge).toMatchObject({ enabled: true, byFirstName: expect.any(String) });
    } finally {
      await updateSettings(at(), adminId, { contract_broker_name: "", contract_broker_email: "" });
    }
  });
});

describe("documents d'un contrat : dépôt chiffré, formats, photos, verrouillage (US-126, US-134)", () => {
  it("dépose un PDF : chiffré dans le stockage, nom chiffré en base, date de suppression à 30 jours, lecture par le noyau seulement", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    const after = await addDocument(at(), f.coreSession, base.id, c.required, [{ name: "conditions.pdf", content: PDF(3) }]);
    const slot = after.slots[0].document!;
    expect(slot).toMatchObject({ fileName: "conditions.pdf", kind: "pdf", pages: 3, uploadedByFirstName: "Julien", transmittedAt: null, locked: false });
    expect(slot.masking.status).toBe("pending");
    expect(after.missingRequired).toBe(0);
    expect(Date.parse(slot.expiresAt) - Date.parse(slot.uploadedAt)).toBeGreaterThanOrEqual(29.9 * 86_400_000);
    const row = await db.selectFrom("contract_field_documents").select(["storage_key", "file_name"]).where("id", "=", slot.id).executeTakeFirstOrThrow();
    expect(Buffer.from(row.file_name).toString("latin1")).not.toContain("conditions");
    const raw = await objectStore().get(row.storage_key);
    expect(raw.includes(Buffer.from("%PDF-"))).toBe(false); // jamais en clair dans le stockage
    expect((await loadDocument(row.storage_key)).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const read = await readDocument(at(), f.primarySession, slot.id);
    expect(read).toMatchObject({ fileName: "conditions.pdf", mimeType: "application/pdf" });
    const other = await family();
    expect((await failure(readDocument(at(), other.primarySession, slot.id))).status).toBe(404);
    expect((await failure(readDocument(at(), f.secondarySession, slot.id))).status).toBe(403);
  });

  it("jusqu'à 10 photos forment un seul document, lu page par page ; pas de mélange PDF et photos, pas plus de 10 pages", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    const after = await addDocument(at(), f.primarySession, base.id, c.required, [1, 2, 3].map((n) => ({ name: `page${n}.jpg`, content: JPEG(n) })));
    expect(after.slots[0].document).toMatchObject({ kind: "photos", pages: 3, fileName: "3 photos" });
    expect((await readDocument(at(), f.primarySession, after.slots[0].document!.id, 2)).content).toEqual(JPEG(2));
    expect((await readDocument(at(), f.primarySession, after.slots[0].document!.id, 99)).content).toEqual(JPEG(3));
    expect((await failure(addDocument(at(), f.primarySession, base.id, c.optional, [{ name: "a.pdf", content: PDF() }, { name: "b.jpg", content: JPEG() }]))).code).toBe("invalid_format");
    expect((await failure(addDocument(at(), f.primarySession, base.id, c.optional, [{ name: "a.pdf", content: PDF() }, { name: "b.pdf", content: PDF() }]))).code).toBe("invalid_format");
    const eleven = Array.from({ length: 11 }, (_, n) => ({ name: `p${n}.jpg`, content: JPEG(n) }));
    expect((await failure(addDocument(at(), f.primarySession, base.id, c.optional, eleven))).code).toBe("too_many_pages");
    expect(unbundlePhotos(bundlePhotos([{ mime: "image/gif", content: Buffer.from("GIF89a") }]))).toEqual([{ mime: "image/gif", content: Buffer.from("GIF89a") }]);
  });

  it("refuse un format ou un contenu non accepté, et un document trop lourd (réglage de la console)", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    expect(await failure(addDocument(at(), f.primarySession, base.id, c.required, [{ name: "texte.txt", content: Buffer.from("bonjour") }]))).toMatchObject({
      code: "invalid_format",
      message: "Format non accepté. Formats possibles : jpeg, jpg, gif, pdf.",
    });
    expect((await failure(addDocument(at(), f.primarySession, base.id, c.required, [{ name: "faux.pdf", content: Buffer.from("pas un pdf") }]))).code).toBe("invalid_format");
    await updateSettings(at(), adminId, { max_document_size_mb: "1" });
    try {
      const big = Buffer.concat([PDF(), Buffer.alloc(1_100_000)]);
      expect((await failure(addDocument(at(), f.primarySession, base.id, c.required, [{ name: "gros.pdf", content: big }]))).message).toBe("Ce document dépasse 1 Mo.");
    } finally {
      await updateSettings(at(), adminId, { max_document_size_mb: "15" });
    }
  });

  it("remplacer un document repart à zéro et envoie l'ancien fichier à la file de suppression ; « Retirer » le supprime", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    const first = await addDocument(at(), f.primarySession, base.id, c.required, [{ name: "v1.pdf", content: PDF() }]);
    const oldKey = (await db.selectFrom("contract_field_documents").select("storage_key").where("id", "=", first.slots[0].document!.id).executeTakeFirstOrThrow()).storage_key;
    const second = await addDocument(at(), f.primarySession, base.id, c.required, [{ name: "v2.pdf", content: PDF(2) }]);
    expect(second.slots[0].document).toMatchObject({ fileName: "v2.pdf", pages: 2, id: first.slots[0].document!.id });
    expect(await db.selectFrom("storage_deletion_queue").select("id").where("storage_key", "=", oldKey).execute()).toHaveLength(1);
    const removed = await removeDocument(at(), f.primarySession, second.slots[0].document!.id);
    expect(removed.slots[0].document).toBeNull();
    expect(removed.missingRequired).toBe(1);
  });

  it("après la transmission, les documents sont verrouillés 48 h : ni remplacement, ni retrait ; un champ obligatoire ajouté ensuite est exigé", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    const done = await addDocument(at(), f.primarySession, base.id, c.required, [{ name: "conditions.pdf", content: PDF() }]);
    // La transmission elle-même arrive avec l'étape suivante : on date le document comme le ferait la base à l'envoi.
    await db.updateTable("contract_field_documents").set({ transmitted_at: new Date() }).where("id", "=", done.slots[0].document!.id).execute();
    const locked = (await baseOf(f.primarySession, c.id)).slots[0].document!;
    expect(locked.locked).toBe(true);
    expect(Date.parse(locked.expiresAt) - Date.now()).toBeLessThan(48 * 3_600_000 + 5_000);
    expect((await failure(removeDocument(at(), f.primarySession, locked.id))).message).toMatch(/verrouillé/);
    expect((await failure(addDocument(at(), f.primarySession, base.id, c.required, [{ name: "autre.pdf", content: PDF() }]))).message).toMatch(/verrouillé/);
    expect((await failure(addDocument(at(), f.primarySession, base.id, c.optional, [{ name: "annexe.pdf", content: PDF() }]))).message).toMatch(/verrouillés/);
    // Une catégorie dont l'administrateur ajoute un champ obligatoire : le contrat redevient incomplet.
    const extra = await addDocumentField(at(), adminId, c.id, { name: "Attestation" });
    expect((await baseOf(f.primarySession, c.id)).missingRequired).toBe(1);
    await updateDocumentField(at(), adminId, c.id, extra, { required: false });
    expect((await baseOf(f.primarySession, c.id)).missingRequired).toBe(0);
  });
});

describe("entretien horaire : purge, fichiers, avertissement J-3 (C-01, US-126 RF7)", () => {
  async function deposited(daysAgo: number, session?: SessionContext) {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    await addDocument(at(), session ?? f.primarySession, base.id, c.required, [{ name: "conditions.pdf", content: PDF() }]);
    const doc = await db.selectFrom("contract_field_documents").select(["id", "storage_key"]).where("account_contract_id", "=", base.id).executeTakeFirstOrThrow();
    const uploaded = new Date(Date.now() - daysAgo * 86_400_000);
    await db.updateTable("contract_field_documents").set({ uploaded_at: uploaded, expires_at: new Date(uploaded.getTime() + 30 * 86_400_000) }).where("id", "=", doc.id).execute();
    return { f, base, doc };
  }

  it("un document déposé depuis plus de 30 jours est supprimé avec son fichier", async () => {
    const { doc } = await deposited(31);
    const result = await runContractMaintenance(at());
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(await db.selectFrom("contract_field_documents").select("id").where("id", "=", doc.id).execute()).toEqual([]);
    await expect(objectStore().get(doc.storage_key)).rejects.toThrow();
  });

  it("un document transmis est supprimé 48 h après la transmission, pas avant", async () => {
    const { doc } = await deposited(1);
    await db.updateTable("contract_field_documents").set({ transmitted_at: new Date(Date.now() - 47 * 3_600_000) }).where("id", "=", doc.id).execute();
    await runContractMaintenance(at());
    expect(await db.selectFrom("contract_field_documents").select("id").where("id", "=", doc.id).execute()).toHaveLength(1);
    // La base compte avec sa propre horloge : on avance l'échéance (une transmission ne se redate pas, le document est verrouillé).
    await db.updateTable("contract_field_documents").set({ expires_at: new Date(Date.now() - 60_000) }).where("id", "=", doc.id).execute();
    await runContractMaintenance(at());
    expect(await db.selectFrom("contract_field_documents").select("id").where("id", "=", doc.id).execute()).toEqual([]);
  });

  it("avertissement unique « supprimés dans 3 jours » au déposant : pas la nuit, reporté à 8 h, jamais deux fois ; email à défaut d'appareil", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.primarySession, c.id);
    await updateContractName(base.id, "Clio");
    await addDocument(at(), f.coreSession, base.id, c.required, [{ name: "conditions.pdf", content: PDF() }]);
    const doc = await db.selectFrom("contract_field_documents").select(["id", "uploaded_by_user_id"]).where("account_contract_id", "=", base.id).executeTakeFirstOrThrow();
    // Suppression le 2 décembre à 3 h 30 à Paris (2 h 30 UTC) : l'avertissement tomberait le 29 novembre à 3 h 30 → reporté à 8 h.
    const expires = new Date("2026-12-02T02:30:00Z");
    await db.updateTable("contract_field_documents").set({ uploaded_at: new Date("2026-11-02T02:30:00Z"), expires_at: expires }).where("id", "=", doc.id).execute();
    const email = (await db.selectFrom("users").select("email").where("id", "=", doc.uploaded_by_user_id!).executeTakeFirstOrThrow()).email;
    const before = (await messagesTo(email)).length;

    // Le passage d'entretien est global : on juge sur les messages reçus par ce déposant.
    await runContractMaintenance(at(new Date("2026-11-29T02:35:00Z"))); // 3 h 35 à Paris : la nuit
    expect((await messagesTo(email)).length).toBe(before);
    await runContractMaintenance(at(new Date("2026-11-29T07:05:00Z"))); // 8 h 05 à Paris
    // La boîte de test liste le plus récent d'abord.
    const sent = (await messagesTo(email)).slice(0, (await messagesTo(email)).length - before);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Les documents de Clio seront supprimés dans 3 jours s'ils ne sont pas transmis.");
    await runContractMaintenance(at(new Date("2026-11-29T09:00:00Z")));
    expect((await messagesTo(email)).length).toBe(before + 1); // un seul avertissement
    // Catégorie archivée : le texte ne parle plus de transmission.
    await db.updateTable("contract_field_documents").set({ expiry_warned_at: null }).where("id", "=", doc.id).execute();
    await archiveContract(at(), adminId, c.id);
    await runContractMaintenance(at(new Date("2026-11-30T09:00:00Z")));
    const last = (await messagesTo(email))[0];
    expect(last.text).toContain("Les documents de Clio seront supprimés dans 3 jours.");
    expect(last.text).not.toContain("transmis");
  });

  async function updateContractName(id: string, name: string) {
    await db.updateTable("account_contracts").set({ name }).where("id", "=", id).execute();
  }
});

// Garde-fou : le journal de consentement conserve la preuve sans clé étrangère vers le contrat (CT-4).
describe("preuves de consentement après suppression (CT-4)", () => {
  it("les événements du journal n'ont pas de clé étrangère vers le contrat supprimé", async () => {
    const rows = await sql<{ n: number }>`select count(*)::int as n from pg_constraint where conrelid = 'contract_consent_events'::regclass and contype = 'f' and confrelid = 'account_contracts'::regclass`.execute(db);
    expect(rows.rows[0].n).toBe(0);
  });
});
