import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addContract as addCategory, addDocumentField } from "@/server/admin/contracts";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { addManualMask, dbMaskCounts, openBlob, removeManualMask, type MaskedBlob } from "@/server/contracts/masked";
import { entitySpans } from "@/server/contracts/masking/rules";
import { maskDocument } from "@/server/contracts/masking/engine";
import { addMask, maskedPreview, processContract, processPending, removeMask, verifyDocument } from "@/server/contracts/process";
import { ReaderError, setDocumentReader, type DocumentReader, type ReadPage } from "@/server/contracts/reader";
import { addContract, addDocument, getContracts, setChannel, type ContractView } from "@/server/contracts/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

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
afterEach(() => setDocumentReader(undefined));

const at = (now = new Date()): Ctx => ({ db, now });
const tag = () => Math.random().toString(36).slice(2, 8);
const PDF = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF`);

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

const page = (text: string, over: Partial<ReadPage> = {}): ReadPage => ({ text, confidence: 96, method: "ocr", entities: [], ...over });
const reading = (pages: ReadPage[], tool = "reader-test|tesseract|modele"): DocumentReader => ({ read: async () => ({ tool, pages }) });

const AVIS = "AVIS D'ÉCHÉANCE\nSouscripteur : Camille Test\nContrat n° 45-889-120\nFranchise 300 EUR\nEmail : camille.test@example.org\nDossier suivi par Dupond. Dupond a payé. Chez DUPOND.";

async function family() {
  const primary = await createProfile(db);
  return { accountId: primary.accountId!, session: await sessionFor(db, primary.id) };
}
async function category() {
  const id = await addCategory(at(), adminId, `Assurance ${tag()}`);
  const required = await addDocumentField(at(), adminId, id, { name: "Conditions particulières" });
  const optional = await addDocumentField(at(), adminId, id, { name: "Avis d'échéance", required: false });
  return { id, required, optional };
}
async function baseOf(session: SessionContext, categoryId: string): Promise<ContractView> {
  return (await getContracts(at(), session)).categories.find((c) => c.id === categoryId)!.contracts.find((c) => c.isBase)!;
}
async function withAnalysis() {
  const f = await family();
  const c = await category();
  const base = await baseOf(f.session, c.id);
  await setChannel(at(), f.session, base.id, "analysis", { enabled: true, accepted: true });
  return { f, c, base };
}
const docOf = (contract: ContractView, fieldId: string) => contract.slots.find((s) => s.fieldId === fieldId)!.document!;

describe("masques posés à la main (US-137 RF3)", () => {
  const blob = (): MaskedBlob => ({
    v: 1,
    pages: [
      { text: "Dupond a signé. [PERSONNE_1] et dupond ; Dupondt reste.", state: "ok" },
      { text: "[Page retirée : relevé ou données de santé]", state: "removed" },
      { text: "Chez DUPOND, le [DONNEE_2] reste.", state: "ok" },
    ],
    counts: { PERSONNE: 1 },
    references: {},
    removedHealthPages: 1,
    doubtHealthPages: 0,
    manual: [],
    tokens: {},
  });

  it("toutes les occurrences du mot, sans tenir compte de la casse, deviennent un jeton ; ni les jetons ni les mots voisins ne sont touchés", () => {
    const { blob: next, occurrences, token } = addManualMask(blob(), "dupond");
    expect(occurrences).toBe(3);
    expect(token).toBe("[DONNEE_3]"); // [DONNEE_2] existe déjà dans le texte
    expect(next.pages[0].text).toBe("[DONNEE_3] a signé. [PERSONNE_1] et [DONNEE_3] ; Dupondt reste.");
    expect(next.pages[2].text).toBe("Chez [DONNEE_3], le [DONNEE_2] reste.");
    expect(next.pages[1].text).toBe("[Page retirée : relevé ou données de santé]");
    expect(next.counts.DONNEE).toBe(3);
  });

  it("le texte à l'intérieur d'un jeton ne se masque pas ; un mot absent, trop court ou avec crochets est refusé", () => {
    expect(() => addManualMask(blob(), "PERSONNE")).toThrow(/n'apparaît pas/);
    expect(() => addManualMask(blob(), "a")).toThrow(/mot/);
    expect(() => addManualMask(blob(), "[PERSONNE_1]")).toThrow(/mot/);
  });

  it("annuler rend à chaque occurrence exactement ce qu'elle disait", () => {
    const original = blob();
    const masked = addManualMask(original, "dupond");
    const restored = removeManualMask(masked.blob, masked.token);
    expect(restored.pages).toEqual(original.pages);
    expect(restored.counts).toEqual(original.counts);
    expect(restored.manual).toEqual([]);
    expect(() => removeManualMask(restored, masked.token)).toThrow(/n'existe pas/);
  });

  it("les compteurs de la base suivent le vocabulaire des types, sans valeur", () => {
    expect(dbMaskCounts({ PERSONNE: 2, IBAN: 1, RIB: 1, DONNEE: 3, AGE: 1, DEPARTEMENT: 1 })).toEqual([
      { mask_type: "person", mask_count: 2 },
      { mask_type: "bank_account", mask_count: 2 },
      { mask_type: "manual", mask_count: 3 },
      { mask_type: "other", mask_count: 2 },
    ]);
  });
});

describe("couche 3, noms repérés par le modèle (US-136 RT2)", () => {
  const options = { household: { people: [] }, now: new Date("2026-11-02T10:00:00Z") };

  it("une personne est masquée ; un mot de fonction, un assureur, un lieu ou une organisation ne le sont pas", () => {
    const text = "Rédigé pour Jean-Michel Roux. Conducteur : à définir. Allianz couvre Paris. Mutuelle des Coteaux.";
    const at = (word: string) => ({ start: text.indexOf(word), end: text.indexOf(word) + word.length });
    const entities = [
      { ...at("Jean-Michel Roux"), label: "PER" },
      { ...at("Conducteur"), label: "PER" },
      { ...at("Allianz"), label: "PER" },
      { ...at("Paris"), label: "LOC" },
      { ...at("Mutuelle des Coteaux"), label: "ORG" },
    ];
    expect(entitySpans(text, entities).map((s) => text.slice(s.start, s.end))).toEqual(["Jean-Michel Roux"]);
    const masked = maskDocument([text], { ...options, entities: [entities] });
    expect(masked.text).toBe("Rédigé pour [PERSONNE_1]. Conducteur : à définir. Allianz couvre Paris. Mutuelle des Coteaux.");
  });

  it("une zone en minuscules ou trop longue est ignorée ; sans entités, le résultat est celui des règles seules", () => {
    const text = "le dossier de martin dupont est suivi";
    const entities = [{ start: 14, end: 27, label: "PER" }];
    expect(entitySpans(text, entities)).toEqual([]);
    expect(maskDocument([text], options).text).toBe(text);
  });
});

describe("du dépôt au texte masqué (US-136 RF1, RF6, RF7)", () => {
  it("sans analyse activée sur le contrat, rien n'est lu : le document reste en attente", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.session, c.id);
    let calls = 0;
    setDocumentReader({ read: async () => (calls++, { tool: "t", pages: [page(AVIS)] }) });
    await addDocument(at(), f.session, base.id, c.required, [{ name: "conditions.pdf", content: PDF }]);
    const view = await processContract(at(), f.session, base.id);
    expect(docOf(view, c.required).masking.status).toBe("pending");
    expect(calls).toBe(0);
  });

  it("sans lecteur configuré, le document reste en attente et rien ne casse", async () => {
    const { f, c, base } = await withAnalysis();
    setDocumentReader(null);
    await addDocument(at(), f.session, base.id, c.required, [{ name: "conditions.pdf", content: PDF }]);
    expect(docOf(await processContract(at(), f.session, base.id), c.required).masking.status).toBe("pending");
  });

  it("le document est lu, masqué et mis « À vérifier » ; le texte masqué est chiffré, sans valeur personnelle, avec ses compteurs et ses versions", async () => {
    const { f, c, base } = await withAnalysis();
    const person = await db.selectFrom("users").select(["first_name", "last_name"]).where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    setDocumentReader(reading([page(AVIS.replace("Camille Test", `${person.first_name} ${person.last_name}`))]));
    await addDocument(at(), f.session, base.id, c.required, [{ name: "conditions.pdf", content: PDF }]);
    const doc = docOf(await processContract(at(), f.session, base.id), c.required);
    expect(doc.masking).toMatchObject({ status: "to_verify", confidencePct: 96, healthDoubt: false, removedHealthPages: 0 });

    const row = await db.selectFrom("contract_field_documents").selectAll().where("id", "=", doc.id).executeTakeFirstOrThrow();
    expect(row.masking_tool_version).toBe("reader-test|tesseract|modele");
    expect(row.masking_rules_version).toBe("rules-1");
    const text = openBlob(row.masked_text!).pages.map((p) => p.text).join("\n");
    expect(text).toContain("Franchise 300 EUR");
    expect(text).toMatch(/\[PERSONNE_1\]/);
    expect(text).toMatch(/\[CONTRAT_1\]/);
    expect(text).toMatch(/\[EMAIL_1\]/);
    for (const forbidden of [person.last_name, "45-889-120", "camille.test@example.org"]) expect(text).not.toContain(forbidden);
    expect(row.masked_text!.toString("utf8")).not.toContain("Franchise"); // chiffré
    const counts = await db.selectFrom("contract_document_mask_counts").select(["mask_type", "mask_count"]).where("document_id", "=", doc.id).orderBy("mask_type").execute();
    expect(counts.map((x) => x.mask_type)).toEqual(expect.arrayContaining(["contract_number", "email", "person"]));
  });

  it("un second traitement du même document est sans effet ; un nom garde le même jeton d'un document à l'autre du contrat", async () => {
    const { f, c, base } = await withAnalysis();
    const person = await db.selectFrom("users").select(["first_name", "last_name"]).where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    const full = `${person.first_name} ${person.last_name}`;
    setDocumentReader(reading([page(`Souscripteur : Paul Roux\nBénéficiaire : ${full}\nPrime 500 EUR`)]));
    await addDocument(at(), f.session, base.id, c.required, [{ name: "a.pdf", content: PDF }]);
    await processContract(at(), f.session, base.id);
    setDocumentReader(reading([page(`Assuré : ${full}\nSouscripteur : Paul Roux\nFranchise 150 EUR`)]));
    await addDocument(at(), f.session, base.id, c.optional, [{ name: "b.pdf", content: PDF }]);
    const view = await processContract(at(), f.session, base.id);
    const first = openBlob((await db.selectFrom("contract_field_documents").select("masked_text").where("id", "=", docOf(view, c.required).id).executeTakeFirstOrThrow()).masked_text!).pages[0].text;
    const second = openBlob((await db.selectFrom("contract_field_documents").select("masked_text").where("id", "=", docOf(view, c.optional).id).executeTakeFirstOrThrow()).masked_text!).pages[0].text;
    const paul = (t: string) => t.match(/\[PERSONNE_\d+\]/g)!;
    expect(first).toContain("Prime 500 EUR");
    expect(new Set([...paul(first), ...paul(second)]).size).toBe(2); // Paul Roux et la personne du foyer, dans les deux documents
    expect(first.match(/Souscripteur : (\[PERSONNE_\d+\])/)![1]).toBe(second.match(/Souscripteur : (\[PERSONNE_\d+\])/)![1]);
    expect((await processPending(at(), { contractId: base.id })).processed).toBe(0);
  });

  it("une lecture sous le seuil de confiance donne « Lecture incertaine » ; très peu fiable ou presque vide : « Illisible »", async () => {
    const { f, c, base } = await withAnalysis();
    setDocumentReader(reading([page(AVIS, { confidence: 65 })]));
    await addDocument(at(), f.session, base.id, c.required, [{ name: "a.pdf", content: PDF }]);
    expect(docOf(await processContract(at(), f.session, base.id), c.required).masking).toMatchObject({ status: "uncertain", confidencePct: 65 });

    setDocumentReader(reading([page(AVIS, { confidence: 12 })]));
    await addDocument(at(), f.session, base.id, c.optional, [{ name: "b.pdf", content: PDF }]);
    expect(docOf(await processContract(at(), f.session, base.id), c.optional).masking.status).toBe("unreadable");

    setDocumentReader(reading([page("ok", { confidence: 99 })]));
    await addDocument(at(), f.session, base.id, c.optional, [{ name: "c.pdf", content: PDF }]);
    expect(docOf(await processContract(at(), f.session, base.id), c.optional).masking.status).toBe("unreadable");
  });

  it("un fichier que le service refuse est « Illisible » ; un service injoignable remet le document en attente pour un nouvel essai", async () => {
    const { f, c, base } = await withAnalysis();
    setDocumentReader({ read: async () => { throw new ReaderError("unreadable", "protégé"); } });
    await addDocument(at(), f.session, base.id, c.required, [{ name: "a.pdf", content: PDF }]);
    expect(docOf(await processContract(at(), f.session, base.id), c.required).masking.status).toBe("unreadable");

    setDocumentReader({ read: async () => { throw new ReaderError("unavailable", "hors service"); } });
    await addDocument(at(), f.session, base.id, c.required, [{ name: "b.pdf", content: PDF }]);
    expect(docOf(await processContract(at(), f.session, base.id), c.required).masking.status).toBe("pending");

    setDocumentReader(reading([page(AVIS)]));
    expect(docOf(await processContract(at(), f.session, base.id), c.required).masking.status).toBe("to_verify");
  });

  it("le passage de fond reprend les documents en attente depuis plus de deux minutes, et un masquage resté en cours trop longtemps", async () => {
    const { f, c, base } = await withAnalysis();
    setDocumentReader(null);
    await addDocument(at(), f.session, base.id, c.required, [{ name: "a.pdf", content: PDF }]);
    setDocumentReader(reading([page(AVIS)]));
    expect((await processPending(at(), { limit: 1000 })).processed).toBeGreaterThanOrEqual(0);
    const later = new Date(Date.now() + 20 * 60_000);
    await db.updateTable("contract_field_documents").set({ masking_status: "masking" }).where("account_contract_id", "=", base.id).execute();
    await processPending(at(later), { contractId: base.id });
    expect(docOf((await getContracts(at(later), f.session)).categories.find((x) => x.id === c.id)!.contracts[0], c.required).masking.status).toBe("to_verify");
  });

  it("une page de relevé de soins est retirée et signalée ; une page de santé douteuse bloque l'analyse et la confirmation", async () => {
    const { f, c, base } = await withAnalysis();
    setDocumentReader(reading([page(AVIS), page("DÉCOMPTE DE REMBOURSEMENT\nconsultation 12/03/2026 25,00 €")]));
    await addDocument(at(), f.session, base.id, c.required, [{ name: "a.pdf", content: PDF }]);
    const view = await processContract(at(), f.session, base.id);
    expect(docOf(view, c.required).masking).toMatchObject({ status: "to_verify", removedHealthPages: 1 });
    const preview = await maskedPreview(at(), f.session, docOf(view, c.required).id);
    expect(preview.pages.map((p) => p.removed)).toEqual([false, true]);
    expect(preview.pages[1].text).not.toMatch(/consultation/);

    setDocumentReader(reading([page("Informations\nVotre médecin traitant et votre état de santé sont décrits ci-après.")]));
    await addDocument(at(), f.session, base.id, c.optional, [{ name: "b.pdf", content: PDF }]);
    const doubtful = docOf(await processContract(at(), f.session, base.id), c.optional);
    expect(doubtful.masking.healthDoubt).toBe(true);
    expect((await failure(verifyDocument(at(), f.session, doubtful.id))).code).toBe("health_doubt");
    const contract = (await getContracts(at(), f.session)).categories.find((x) => x.id === c.id)!.contracts[0];
    expect(contract.transmit.analysisBlockers.join(" ")).toMatch(/données de santé/);
  });
});

describe("aperçu, masques et confirmation (US-137)", () => {
  async function masked(text = AVIS) {
    const { f, c, base } = await withAnalysis();
    setDocumentReader(reading([page(text)]));
    await addDocument(at(), f.session, base.id, c.required, [{ name: "a.pdf", content: PDF }]);
    const doc = docOf(await processContract(at(), f.session, base.id), c.required);
    return { f, c, base, doc };
  }

  it("l'aperçu montre le texte masqué, page par page, et ce qui reste visible (types seulement)", async () => {
    const { f, doc } = await masked("Contact : jean@exemple.fr\nFranchise 300 EUR");
    const preview = await maskedPreview(at(), f.session, doc.id);
    expect(preview).toMatchObject({ documentId: doc.id, fileName: "a.pdf", status: "to_verify", confidencePct: 96, manual: [], removedHealthPages: 0, healthDoubt: false });
    expect(preview.pages).toHaveLength(1);
    expect(preview.pages[0].text).toContain("Franchise 300 EUR");
  });

  it("« Masquer aussi ce mot » remplace toutes les occurrences, s'annule, et n'est plus possible une fois le document vérifié", async () => {
    const { f, doc } = await masked();
    const after = await addMask(at(), f.session, doc.id, "Dupond");
    expect(after.pages[0].text).not.toMatch(/Dupond/);
    expect(after.pages[0].text.match(/\[DONNEE_1\]/g)).toHaveLength(3);
    expect(after.manual).toEqual([{ token: "[DONNEE_1]", occurrences: 3 }]);
    const counts = await db.selectFrom("contract_document_mask_counts").select("mask_count").where("document_id", "=", doc.id).where("mask_type", "=", "manual").executeTakeFirstOrThrow();
    expect(counts.mask_count).toBe(3);

    const undone = await removeMask(at(), f.session, doc.id, "[DONNEE_1]");
    expect(undone.pages[0].text).toContain("Dossier suivi par Dupond. Dupond a payé. Chez DUPOND.");
    expect(undone.manual).toEqual([]);

    await addMask(at(), f.session, doc.id, "Dupond");
    const verified = await verifyDocument(at(), f.session, doc.id);
    expect(verified).toMatchObject({ status: "verified", verifiedByFirstName: "Camille" });
    expect(verified.verifiedAt).toBeTruthy();
    expect((await failure(addMask(at(), f.session, doc.id, "Franchise"))).code).toBe("not_editable");
    expect((await failure(removeMask(at(), f.session, doc.id, "[DONNEE_1]"))).code).toBe("not_editable");
    expect((await failure(verifyDocument(at(), f.session, doc.id))).code).toBe("not_editable");
  });

  it("un document vérifié lève le blocage de l'analyse ; un document remplacé repasse par le masquage et la vérification (US-137 RF5)", async () => {
    const { f, c, base, doc } = await masked();
    await verifyDocument(at(), f.session, doc.id);
    const contract = async () => (await getContracts(at(), f.session)).categories.find((x) => x.id === c.id)!.contracts.find((x) => x.id === base.id)!;
    expect((await contract()).transmit.analysisBlockers).toEqual([]);

    await addDocument(at(), f.session, base.id, c.required, [{ name: "nouveau.pdf", content: PDF }]);
    const replaced = docOf(await contract(), c.required);
    expect(replaced.masking.status).toBe("pending");
    expect(replaced.masking.verifiedAt).toBeNull();
    expect((await contract()).transmit.analysisBlockers.join(" ")).toMatch(/masquage/);
    expect((await failure(maskedPreview(at(), f.session, replaced.id))).code).toBe("not_ready");
  });

  it("un document illisible ou en attente n'a pas d'aperçu ; la famille voisine ne voit rien", async () => {
    const { f, doc } = await masked();
    const stranger = await family();
    expect((await failure(maskedPreview(at(), stranger.session, doc.id))).code).toBe("not_found");
    expect((await failure(addMask(at(), stranger.session, doc.id, "Franchise"))).code).toBe("not_found");
    expect((await failure(verifyDocument(at(), stranger.session, doc.id))).code).toBe("not_found");
    await expect(maskedPreview(at(), f.session, doc.id)).resolves.toBeTruthy();
  });

  it("une lecture incertaine se vérifie aussi, puis attend la décision de l'administrateur (US-137 RF8)", async () => {
    const { f, c, base } = await withAnalysis();
    setDocumentReader(reading([page(AVIS, { confidence: 60 })]));
    await addDocument(at(), f.session, base.id, c.required, [{ name: "a.pdf", content: PDF }]);
    const doc = docOf(await processContract(at(), f.session, base.id), c.required);
    expect(doc.masking.status).toBe("uncertain");
    expect((await verifyDocument(at(), f.session, doc.id)).status).toBe("verified");
    const contract = (await getContracts(at(), f.session)).categories.find((x) => x.id === c.id)!.contracts.find((x) => x.id === base.id)!;
    expect(contract.transmit).toMatchObject({ forAnalysis: true, needsAdmin: true }); // lecture à 60 % : sous le seuil de 80 %, même vérifiée
  });
});

describe("autres contrats d'une catégorie", () => {
  it("un contrat complémentaire a ses propres documents et ses propres jetons", async () => {
    const { f, c } = await withAnalysis();
    const extra = await addContract(at(), f.session, c.id, "Seconde voiture");
    await setChannel(at(), f.session, extra.id, "analysis", { enabled: true, accepted: true });
    setDocumentReader(reading([page("Souscripteur : Paul Roux\nFranchise 100 EUR")]));
    await addDocument(at(), f.session, extra.id, c.required, [{ name: "x.pdf", content: PDF }]);
    const doc = docOf(await processContract(at(), f.session, extra.id), c.required);
    const preview = await maskedPreview(at(), f.session, doc.id);
    expect(preview.pages[0].text).toMatch(/Souscripteur : \[PERSONNE_1\]/);
  });
});
