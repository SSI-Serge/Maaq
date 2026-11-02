import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addContract as addCategory, addDocumentField } from "@/server/admin/contracts";
import { addReviewMask, decideReview, getReview, listReviews, pendingReviewCount } from "@/server/admin/reviews";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { runContractMaintenance } from "@/server/contracts/maintenance";
import { ANALYSIS_TIMEOUT_MS, failStaleAnalyses, notifyAnalysisOutcomes, runAnalyses, runAnalysis } from "@/server/contracts/analyze";
import { demoReport, setAnalysisRunner, type AnalysisRunner } from "@/server/contracts/analysis";
import { openBlob } from "@/server/contracts/masked";
import { planTransmission } from "@/server/contracts/plan";
import { processContract, verifyDocument } from "@/server/contracts/process";
import { setDocumentReader, type ReadPage } from "@/server/contracts/reader";
import { addDocument, getContracts, renameContract, setChannel, type ContractView } from "@/server/contracts/service";
import { relaunchChannel, transmitContract } from "@/server/contracts/transmit";
import { open, seal } from "@/server/assistant/fields";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createProfile, messagesTo, sessionFor, testDb } from "./helpers/fixtures";

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
afterEach(() => {
  setAnalysisRunner(undefined);
  setDocumentReader(undefined);
});

const at = (now = new Date()): Ctx => ({ db, now });
const tag = () => Math.random().toString(36).slice(2, 8);
const PDF = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF`);
const TEXT = "AVIS D'ÉCHÉANCE\nSouscripteur : Paul Roux\nContrat n° 45-889-120\nFranchise 300 EUR\nBonus-malus 0,76\nPrime annuelle 612,40 EUR";

const page = (text: string, over: Partial<ReadPage> = {}): ReadPage => ({ text, confidence: 96, method: "ocr", entities: [], ...over });
const reading = (pages: ReadPage[]) => ({ read: async () => ({ tool: "reader-test", pages }) });
const runner = (html: string | (() => Promise<string>)): AnalysisRunner => ({ run: async () => (typeof html === "string" ? html : html()) });
const GOOD = "<h2>En résumé</h2><p>Ce contrat couvre la voiture avec une franchise de 300 EUR. Il est valable un an et se renouvelle à l'échéance.</p><h2>Points d'attention</h2><ul><li>Vérifier les exclusions.</li></ul>";

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

async function family() {
  const primary = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: "Europe/Paris" }).where("id", "=", primary.accountId!).execute();
  return { accountId: primary.accountId!, email: primary.email, session: await sessionFor(db, primary.id) };
}
async function category() {
  const id = await addCategory(at(), adminId, `Assurance ${tag()}`);
  const required = await addDocumentField(at(), adminId, id, { name: "Conditions particulières" });
  const optional = await addDocumentField(at(), adminId, id, { name: "Avis d'échéance", required: false });
  return { id, required, optional };
}
const baseOf = async (session: SessionContext, categoryId: string): Promise<ContractView> => (await getContracts(at(), session)).categories.find((c) => c.id === categoryId)!.contracts.find((c) => c.isBase)!;
const reload = async (session: SessionContext, categoryId: string, contractId: string) => (await getContracts(at(), session)).categories.find((c) => c.id === categoryId)!.contracts.find((c) => c.id === contractId)!;
const docOf = (contract: ContractView, fieldId: string) => contract.slots.find((s) => s.fieldId === fieldId)!.document!;

/** Contrat dont le document requis est lu, masqué et vérifié, analyse activée : prêt à transmettre pour analyse. */
async function ready(options: { confidence?: number; weak?: string[]; text?: string } = {}) {
  const f = await family();
  const c = await category();
  const base = await baseOf(f.session, c.id);
  await setChannel(at(), f.session, base.id, "analysis", { enabled: true, accepted: true });
  setDocumentReader(reading([page(options.text ?? TEXT, { confidence: options.confidence ?? 96, weak: options.weak })]));
  await addDocument(at(), f.session, base.id, c.required, [{ name: "conditions.pdf", content: PDF }]);
  const doc = docOf(await processContract(at(), f.session, base.id), c.required);
  await verifyDocument(at(), f.session, doc.id);
  return { f, c, base, doc };
}
const transmissionOf = (contractId: string) => db.selectFrom("contract_transmissions").selectAll().where("account_contract_id", "=", contractId).orderBy("id", "desc").executeTakeFirstOrThrow();

describe("rapport de démonstration du mode d'essai", () => {
  it("ne contient que les noms des champs et des compteurs, jamais le texte des documents", () => {
    const html = demoReport({ category: "Assurance auto", documents: [{ fieldName: "Conditions particulières", text: "Souscripteur : [PERSONNE_1] franchise 300 EUR" }] });
    expect(html).toContain("Contenu de démonstration");
    expect(html).toContain("Conditions particulières");
    expect(html).not.toContain("franchise 300");
    expect(html).not.toContain("PERSONNE");
  });
});

describe("analyse d'un contrat (US-131, US-132)", () => {
  it("lecture sûre : la transmission lance l'analyse ; le rapport est stocké chiffré, affiché sous « Analyse — nom — date » et se termine par la mention obligatoire", async () => {
    const { f, c, base } = await ready();
    setAnalysisRunner(runner(GOOD));
    const sent = await transmitContract(at(), f.session, base.id);
    expect(sent.transmission).toMatchObject({ forAnalysis: true, analysisStatus: "running" });
    expect(sent.report).toBeNull();

    const done = await processContract(at(), f.session, base.id);
    expect(done.transmission?.analysisStatus).toBe("completed");
    expect(done.reportAt).toBeTruthy();
    expect(done.report?.html).toContain("franchise de 300 EUR");
    expect(done.report?.html).toContain("Analyse automatique à partir de vos documents : vérifiez les informations importantes auprès de votre assureur.");
    expect(await db.selectFrom("contract_reports").select("html").where("account_contract_id", "=", base.id).execute().then((rows) => rows[0].html.toString("utf8"))).not.toContain("franchise");
    expect((await reload(f.session, c.id, base.id)).report?.generatedAt).toBe(done.report?.generatedAt);
  });

  it("l'agent ne reçoit que la catégorie et le texte masqué : jamais le nom du contrat, ni le texte d'origine", async () => {
    const { f, c, base } = await ready();
    const name = `Clio-${tag()}`;
    await renameContract(at(), f.session, base.id, name);
    let received = "";
    setAnalysisRunner({ run: async (input) => ((received = JSON.stringify(input)), GOOD) });
    await transmitContract(at(), f.session, base.id);
    await processContract(at(), f.session, base.id);
    expect(received).toContain("Conditions particulières");
    expect(received).toContain("Franchise 300 EUR");
    for (const forbidden of [name, "Paul Roux", "45-889-120"]) expect(received).not.toContain(forbidden);
    expect(received).toMatch(/\[PERSONNE_1\]/);
    expect(c.id).toBeTruthy();
  });

  it("un nouveau rapport remplace l'ancien : un seul par contrat, ses références avec lui", async () => {
    const { f, base } = await ready();
    const account = f.accountId;
    await db.insertInto("contract_reports").values({ account_contract_id: base.id, account_id: account, html: seal("ancien"), generated_at: new Date("2026-10-01T10:00:00Z") }).execute();
    setAnalysisRunner(runner(GOOD));
    await transmitContract(at(), f.session, base.id);
    await processContract(at(), f.session, base.id);
    const rows = await db.selectFrom("contract_reports").select(["account_contract_id", "generated_at"]).where("account_contract_id", "=", base.id).execute();
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].generated_at).getTime()).toBeGreaterThan(new Date("2026-10-02T00:00:00Z").getTime());
  });

  it("un jeton qui désigne un membre du foyer est enregistré comme référence et résolu à l'affichage ; les autres prennent une forme neutre", async () => {
    const f = await family();
    const c = await category();
    const base = await baseOf(f.session, c.id);
    await setChannel(at(), f.session, base.id, "analysis", { enabled: true, accepted: true });
    const me = await db.selectFrom("users").select(["first_name", "last_name"]).where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    setDocumentReader(reading([page(`Souscripteur : ${me.first_name} ${me.last_name}\nConducteur désigné : Paul Roux\nContrat n° 45-889-120\nFranchise 300 EUR`)]));
    await addDocument(at(), f.session, base.id, c.required, [{ name: "a.pdf", content: PDF }]);
    const doc = docOf(await processContract(at(), f.session, base.id), c.required);
    await verifyDocument(at(), f.session, doc.id);
    const blob = openBlob((await db.selectFrom("contract_field_documents").select("masked_text").where("id", "=", doc.id).executeTakeFirstOrThrow()).masked_text!);
    const memberToken = Object.keys(blob.references)[0];
    expect(memberToken).toMatch(/^\[PERSONNE_\d+\]$/);
    setAnalysisRunner(runner(`<h2>En résumé</h2><p>${memberToken} est le souscripteur, le contrat [CONTRAT_1] est garanti, et [PERSONNE_2] conduit aussi. Franchise de 300 EUR.</p>`));
    await transmitContract(at(), f.session, base.id);
    const done = await processContract(at(), f.session, base.id);
    expect(done.report?.html).toContain(me.first_name);
    expect(done.report?.html).toContain("le contrat est garanti");
    expect(done.report?.html).toMatch(/le souscripteur conduit aussi/);
    expect(done.report?.html).not.toMatch(/\[[A-Z]+_\d+\]/);
    const refs = await db.selectFrom("contract_report_refs").select(["token", "member_id"]).where("account_contract_id", "=", base.id).execute();
    expect(refs).toHaveLength(1);
    expect(refs[0].token).toBe(memberToken);
  });

  it("un rapport qui contient un motif personnel est refusé : l'analyse échoue et l'ancien rapport reste", async () => {
    const { f, base } = await ready();
    await db.insertInto("contract_reports").values({ account_contract_id: base.id, account_id: f.accountId, html: seal("ancien"), generated_at: new Date("2026-10-01T10:00:00Z") }).execute();
    setAnalysisRunner(runner(`${GOOD}<p>Écrire à paul.roux@exemple.fr pour toute question.</p>`));
    await transmitContract(at(), f.session, base.id);
    const view = await processContract(at(), f.session, base.id);
    expect(view.transmission?.analysisStatus).toBe("failed");
    expect((await transmissionOf(base.id)).analysis_last_error).toMatch(/Rapport refusé : email/);
    expect(await db.selectFrom("contract_reports").select("html").where("account_contract_id", "=", base.id).executeTakeFirstOrThrow().then((r) => open(r.html))).toBe("ancien");
  });

  it("deux appels simultanés ne font l'analyse qu'une fois", async () => {
    const { f, base } = await ready();
    let calls = 0;
    setAnalysisRunner(runner(async () => (calls++, await new Promise((r) => setTimeout(r, 150)), GOOD)));
    await transmitContract(at(), f.session, base.id);
    const id = (await transmissionOf(base.id)).id;
    const outcomes = await Promise.all([runAnalysis(at(), id), runAnalysis(at(), id)]);
    expect(outcomes.sort()).toEqual(["completed", "skipped"]);
    expect(calls).toBe(1);
  });

  it("une analyse qui dépasse 10 minutes est en échec", async () => {
    const { f, base } = await ready();
    await transmitContract(at(), f.session, base.id);
    expect(await failStaleAnalyses(at(new Date(Date.now() + ANALYSIS_TIMEOUT_MS - 60_000)))).toBe(0);
    expect(await failStaleAnalyses(at(new Date(Date.now() + ANALYSIS_TIMEOUT_MS + 60_000)))).toBeGreaterThanOrEqual(1);
    expect((await transmissionOf(base.id)).analysis_status).toBe("failed");
  });

  it("le passage de fond lance les analyses en cours", async () => {
    const { f, base } = await ready();
    setAnalysisRunner(runner(GOOD));
    await transmitContract(at(), f.session, base.id);
    const result = await runAnalyses(at());
    expect(result.completed).toBeGreaterThanOrEqual(1);
    expect((await transmissionOf(base.id)).analysis_status).toBe("completed");
  });
});

describe("échec de l'analyse, notification et relance (US-135)", () => {
  it("l'échec est annoncé une seule fois à la personne qui a transmis, puis la relance repart et peut réussir", async () => {
    const { f, c, base } = await ready();
    setAnalysisRunner({ run: async () => Promise.reject(new Error("le modèle n'a pas répondu")) });
    await transmitContract(at(), f.session, base.id);
    const failed = await processContract(at(), f.session, base.id);
    expect(failed.transmission?.analysisStatus).toBe("failed");

    const notified = await notifyAnalysisOutcomes(at());
    expect(notified.notified).toBeGreaterThanOrEqual(1);
    const mails = (await messagesTo(f.email)).filter((m) => /n'a pas abouti/.test(m.text));
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toMatch(/Vous pouvez la relancer jusqu'au \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}\./);
    await notifyAnalysisOutcomes(at());
    expect((await messagesTo(f.email)).filter((m) => /n'a pas abouti/.test(m.text))).toHaveLength(1);

    setAnalysisRunner(runner(GOOD));
    const relaunched = await relaunchChannel(at(), f.session, base.id, "analysis");
    expect(relaunched.transmission?.analysisStatus).toBe("running");
    const done = await processContract(at(), f.session, base.id);
    expect(done.transmission?.analysisStatus).toBe("completed");
    expect((await reload(f.session, c.id, base.id)).report).not.toBeNull();
  });

  it("rien n'est annoncé une fois les documents supprimés (il n'y a plus rien à relancer)", async () => {
    const { f, base } = await ready();
    setAnalysisRunner({ run: async () => Promise.reject(new Error("panne")) });
    await transmitContract(at(), f.session, base.id);
    await processContract(at(), f.session, base.id);
    const before = (await messagesTo(f.email)).length;
    await notifyAnalysisOutcomes(at(new Date(Date.now() + 50 * 3_600_000)));
    expect((await messagesTo(f.email)).length).toBe(before);
  });
});

describe("lecture incertaine : analyses à valider (US-138)", () => {
  it("le plan attend un administrateur quand la lecture est sous le seuil, même après vérification de l'utilisateur", () => {
    const contract = { analysis: { enabled: true }, challenge: { enabled: false }, missingRequired: 0, slots: [{ fieldId: "1", name: "Conditions", required: true, document: { transmittedAt: null, expiresAt: "2099-01-01T00:00:00Z", masking: { status: "verified", confidencePct: 70 } } }] };
    const context = { analysisOpen: true, challengeAvailable: false, archived: false, now: new Date("2026-11-02T10:00:00Z"), confidenceThresholdPct: 80 };
    expect(planTransmission(contract, context)).toMatchObject({ forAnalysis: true, needsAdmin: true, ready: true });
    expect(planTransmission({ ...contract, slots: [{ ...contract.slots[0], document: { ...contract.slots[0].document, masking: { status: "verified", confidencePct: 92 } } }] }, context).needsAdmin).toBe(false);
  });

  async function awaiting() {
    const r = await ready({ confidence: 66, weak: ["roux", "clio"] });
    const name = `Scénic-${tag()}`;
    await renameContract(at(), r.f.session, r.base.id, name);
    setAnalysisRunner(runner(GOOD));
    const sent = await transmitContract(at(), r.f.session, r.base.id);
    expect(sent.transmission?.analysisStatus).toBe("awaiting_admin");
    const review = await db.selectFrom("contract_analysis_reviews").selectAll().where("transmission_id", "=", (await transmissionOf(r.base.id)).id).executeTakeFirstOrThrow();
    return { ...r, name, reviewId: review.id };
  }

  it("la transmission crée une demande ; la famille voit « en cours de vérification » ; l'analyse ne part pas", async () => {
    const { f, c, base, name, reviewId } = await awaiting();
    expect((await processContract(at(), f.session, base.id)).transmission?.analysisStatus).toBe("awaiting_admin");
    expect((await reload(f.session, c.id, base.id)).report).toBeNull();
    const list = await listReviews(at());
    expect(list.map((r) => r.id)).toContain(reviewId);
    expect(await pendingReviewCount(at())).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(list)).not.toContain(name);
  });

  it("l'administrateur ne voit que la catégorie et le texte masqué (jamais le nom du contrat, ni la famille, ni les mots masqués) ; chaque consultation est journalisée", async () => {
    const { f, c, name, reviewId } = await awaiting();
    const detail = await getReview(at(), adminId, reviewId);
    const everything = JSON.stringify(detail);
    expect(detail.category).toMatch(/^Assurance /);
    expect(detail.documentsDetail).toHaveLength(1);
    expect(detail.documentsDetail[0]).toMatchObject({ field: "Conditions particulières", confidencePct: 66 });
    expect(detail.documentsDetail[0].texts[0].text).toContain("Franchise 300 EUR");
    expect(detail.documentsDetail[0].weak).toEqual(["roux", "clio"]);
    const me = await db.selectFrom("users").select(["first_name", "email"]).where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    for (const forbidden of [name, "Paul Roux", "45-889-120", me.email, f.accountId, c.id === "" ? "-" : "conditions.pdf"]) expect(everything).not.toContain(forbidden);
    const viewed = await db.selectFrom("admin_audit_log").select(["action_type", "admin_user_id"]).where("entity_type", "=", "contract_analysis_review").where("entity_id", "=", reviewId).execute();
    expect(viewed.filter((v) => v.action_type === "contract_review_viewed")).toHaveLength(1);
    await getReview(at(), adminId, reviewId);
    expect((await db.selectFrom("admin_audit_log").select("id").where("entity_id", "=", reviewId).where("action_type", "=", "contract_review_viewed").execute()).length).toBe(2);
  });

  it("l'administrateur peut masquer un mot de plus ; seul le nombre est gardé", async () => {
    const { reviewId, base } = await awaiting();
    const after = await addReviewMask(at(), adminId, reviewId, "Conditions particulières", "Bonus-malus");
    expect(after.masksAdded).toBe(1);
    expect(after.documentsDetail[0].texts[0].text).not.toContain("Bonus-malus");
    expect(after.documentsDetail[0].texts[0].text).toMatch(/\[DONNEE_1\]/);
    const row = await db.selectFrom("contract_analysis_reviews").select("masks_added_count").where("id", "=", reviewId).executeTakeFirstOrThrow();
    expect(row.masks_added_count).toBe(1);
    expect((await failure(addReviewMask(at(), adminId, reviewId, "Champ inconnu", "Franchise"))).code).toBe("not_found");
    expect(base.id).toBeTruthy();
  });

  it("« Poursuivre » : la décision est journalisée, l'analyse part, la demande quitte la liste, le rapport arrive", async () => {
    const { f, c, base, reviewId } = await awaiting();
    await addReviewMask(at(), adminId, reviewId, "Conditions particulières", "Franchise");
    expect(await decideReview(at(), adminId, reviewId, "continue")).toEqual({ decision: "continue" });
    expect((await listReviews(at())).map((r) => r.id)).not.toContain(reviewId);
    const view = await reload(f.session, c.id, base.id);
    expect(view.transmission?.analysisStatus).toBe("completed");
    expect(view.report).not.toBeNull();
    const entry = await db.selectFrom("admin_audit_log").select(["admin_user_id", "details"]).where("entity_id", "=", reviewId).where("action_type", "=", "contract_analysis_decided").executeTakeFirstOrThrow();
    expect(entry.admin_user_id).toBe(adminId);
    expect(entry.details).toMatchObject({ decision: "continue", masksAdded: 1 });
    expect((await failure(decideReview(at(), adminId, reviewId, "stop"))).code).toMatch(/already_decided|not_found/);
  });

  it("« Ne pas poursuivre » : l'analyse est annulée, la famille voit le message et la personne qui a transmis est prévenue une seule fois", async () => {
    const { f, c, base, name, reviewId } = await awaiting();
    await decideReview(at(), adminId, reviewId, "stop");
    const view = await reload(f.session, c.id, base.id);
    expect(view.transmission?.analysisStatus).toBe("cancelled");
    expect(view.report).toBeNull();
    await notifyAnalysisOutcomes(at());
    await notifyAnalysisOutcomes(at());
    const mails = (await messagesTo(f.email)).filter((m) => m.text.includes("n'était pas assez fiable"));
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain(name);
    expect(mails[0].text).toContain("Déposez une photo plus nette pour relancer.");
  });

  it("sans décision, la demande disparaît avec les documents ; l'analyse est annulée sans notification d'échec", async () => {
    const { f, c, base, reviewId } = await awaiting();
    await db.updateTable("contract_analysis_reviews").set({ expires_at: sql`now() - interval '1 hour'` }).where("id", "=", reviewId).execute();
    expect((await listReviews(at())).map((r) => r.id)).not.toContain(reviewId);
    expect((await failure(getReview(at(), adminId, reviewId))).code).toBe("not_found");
    await runContractMaintenance(at());
    const view = await reload(f.session, c.id, base.id);
    expect(view.transmission?.analysisStatus).toBe("cancelled");
    const before = (await messagesTo(f.email)).length;
    await notifyAnalysisOutcomes(at());
    expect((await messagesTo(f.email)).length).toBe(before);
  });

  it("une décision n'est possible que pour un administrateur (garde de la base)", async () => {
    const { f, reviewId } = await awaiting();
    const me = await db.selectFrom("users").select("id").where("account_id", "=", f.accountId).where("role", "=", "primary_user").executeTakeFirstOrThrow();
    await expect(decideReview(at(), me.id, reviewId, "continue")).rejects.toThrow(/administrateur/);
  });
});

describe("masquage des textes lus par le rapport", () => {
  it("le texte du rapport de démonstration ne passe jamais pour une donnée personnelle", async () => {
    const { f, c, base } = await ready();
    await transmitContract(at(), f.session, base.id); // moteur d'essai : rapport de démonstration
    const done = await processContract(at(), f.session, base.id);
    expect(done.transmission?.analysisStatus).toBe("completed");
    expect(done.report?.html).toContain("Contenu de démonstration");
    expect(open((await db.selectFrom("contract_reports").select("html").where("account_contract_id", "=", base.id).executeTakeFirstOrThrow()).html)).toContain("Documents pris en compte");
    expect(c.id).toBeTruthy();
  });
});
