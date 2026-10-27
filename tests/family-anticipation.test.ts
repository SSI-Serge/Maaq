import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { ageInMonths, answerQuestion, getAnticipation, monthlyBody, periodOf, runAnticipation, selectQuestions, setAnticipationEnabled, setSituationAnswer } from "@/server/assistant/anticipation";
import { applyCatalog, previewCatalog, validateCatalog, type CatalogFileRow } from "@/server/assistant/catalog";
import { getDigest } from "@/server/assistant/digest";
import { addChild, removeMember, updateMember } from "@/server/assistant/family";
import { open } from "@/server/assistant/fields";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { saveSubscription } from "@/server/push/service";
import { createGuest, createProfile, sessionFor, testDb } from "./helpers/fixtures";

process.env.VAPID_PUBLIC_KEY = "BPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTe";
process.env.VAPID_PRIVATE_KEY = "PrivateKeyDeTestPrivateKeyDeTestPrivateKeyDeTe";
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
const send = vi.mocked(webpush.sendNotification);

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  await db.deleteFrom("anticipation_questions").execute();
  await db.deleteFrom("anticipation_catalog_items").execute();
});

const TZ = "Europe/Paris";
// Lundi 2 mars 2054, 10 h à Paris (la base lit l'horloge réelle : tout est daté de 2054).
const at = (iso = "2054-03-02T09:00:00Z"): Ctx => ({ get db() { return db; }, now: new Date(iso) }) as Ctx;

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

async function onDevice(userId: string): Promise<SessionContext> {
  const session = await sessionFor(db, userId);
  await db.insertInto("devices").values({ id: session.device.id, user_id: userId, device_type: "android" }).execute();
  return session;
}

/** Foyer : Sophie (principale), Marc (invité 1), Élodie (invitée secondaire), Léo (né en 06/2046, 7 ans) et Mia (sans naissance). */
async function family() {
  const primary = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Sophie" }).where("id", "=", primary.id).execute();
  await db.updateTable("accounts").set({ family_timezone: TZ }).where("id", "=", primary.accountId!).execute();
  const marc = await createGuest(db, primary.accountId!, "Marc", "core");
  const elodie = await createGuest(db, primary.accountId!, "Élodie");
  const sophie = await onDevice(primary.id);
  const marcSession = await onDevice(marc.id);
  const sub = { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };
  await saveSubscription(at(), sophie, sub);
  const leo = await addChild(at(), sophie, { firstName: "Léo", birth: "2046-06" });
  const mia = await addChild(at(), sophie, { firstName: "Mia" });
  send.mockClear();
  return { accountId: primary.accountId!, sophie, marc: marcSession, elodie: await sessionFor(db, elodie.id), leoId: leo.id, miaId: mia.id, userIds: { sophie: primary.id, marc: marc.id } };
}
type Family = Awaited<ReturnType<typeof family>>;

const base: CatalogFileRow = { medical: "non", par_membre: "non", periode_debut_mois: 4, periode_debut_jour: 1, periode_fin_mois: 5, periode_fin_jour: 31, delai_jours: 21, frequence_annees: 1, actif: "oui" };
const CATALOG: CatalogFileRow[] = [
  { ...base, code: "impots", libelle: "Déclaration de revenus", categorie: "impots" },
  { ...base, code: "controle_technique", libelle: "Contrôle technique de la voiture", situation: "vehicle=oui", periode_debut_mois: 3, periode_fin_mois: 4 },
  {
    ...base, code: "dentaire", libelle: "Suivi dentaire de {membre} cette année", medical: "oui", par_membre: "oui", role: "enfant", age_min_mois: 36, age_max_mois: 215, periode_debut_mois: 1, periode_fin_mois: 12, periode_fin_jour: 31,
    delai_jours: 0, source: "Recommandations de santé publique", date_revue: "2026-10-01", valide_par: "Dr Martin, référent santé",
  },
];

async function load(rows: CatalogFileRow[] = CATALOG) {
  const keys = (await db.selectFrom("family_situation_questions").select("situation_key").execute()).map((r) => r.situation_key);
  const { items, errors } = validateCatalog(rows, keys);
  expect(errors).toEqual([]);
  return applyCatalog(db, items);
}
const questions = (accountId: string) =>
  db.selectFrom("anticipation_questions as q").innerJoin("anticipation_catalog_items as c", "c.id", "q.catalog_item_id").select(["q.id", "c.code", "q.status", "q.member_id", "q.presented_week", "q.label_template"])
    .select(sql<string>`q.period_start::text`.as("start")).select(sql<string>`q.period_end::text`.as("end")).where("q.account_id", "=", accountId).orderBy("c.code").execute();

// ---------------------------------------------------------------------------------------------------------------------------
describe("fichier du catalogue : contrôles (US-111 RF3, RF5, RF7)", () => {
  const keys = ["vehicle", "home_owner", "pet", "children_schooled"];
  it("rend les erreurs avec ligne, colonne et message ; rien ne passe tant qu'il y en a (CA 6.1)", () => {
    const { items, errors } = validateCatalog(
      [
        { ...base, code: "ok", libelle: "Une échéance" },
        { ...base, code: "ok", libelle: "Doublon" },
        { ...base, code: "Mauvais Code", libelle: "" },
        { ...base, code: "ages", libelle: "Âges", par_membre: "oui", age_min_mois: 100, age_max_mois: 50 },
        { ...base, code: "medical", libelle: "Dentiste", medical: "oui", par_membre: "oui" },
        { ...base, code: "situation", libelle: "S", situation: "avion=oui" },
        { ...base, code: "mois", libelle: "M", periode_debut_mois: 13, delai_jours: 400, frequence_annees: 11 },
        { ...base, code: "role", libelle: "R", par_membre: "non", role: "enfant" },
      ],
      keys,
    );
    expect(items.map((i) => i.code)).toEqual(["ok"]);
    const at_ = (line: number) => errors.filter((e) => e.line === line).map((e) => e.column);
    expect(at_(2)).toEqual(["code"]);
    expect(at_(3)).toEqual(expect.arrayContaining(["code", "libellé"]));
    expect(errors.find((e) => e.line === 4)).toMatchObject({ column: "âge maximal", message: "doit être supérieur à l'âge minimal." });
    expect(at_(5)).toEqual(expect.arrayContaining(["source", "date de revue", "validé par"]));
    expect(at_(6)).toEqual(["situation"]);
    expect(at_(7)).toEqual(expect.arrayContaining(["début de période (mois)", "délai d'anticipation", "fréquence"]));
    expect(at_(8)).toEqual(["par membre"]);
  });

  it("un libellé de 150 caractères au plus ; un rappel médical reste générique et par membre (D44)", () => {
    const { errors } = validateCatalog(
      [{ ...base, code: "long", libelle: "x".repeat(151) }, { ...base, code: "dernier", libelle: "Dentiste, comme lors du dernier rendez-vous de {membre}", medical: "oui", par_membre: "oui", source: "s", date_revue: "2026-10-01", valide_par: "Dr X" }, { ...base, code: "famille", libelle: "Famille", medical: "oui", source: "s", date_revue: "2026-10-01", valide_par: "Dr X" }],
      keys,
    );
    expect(errors.map((e) => [e.line, e.column])).toEqual([[1, "libellé"], [2, "libellé"], [3, "par membre"]]);
  });

  it("un rappel médical désactivé n'exige pas de revue ; plus de 1 000 lignes est refusé", () => {
    expect(validateCatalog([{ ...base, code: "dentaire", libelle: "Suivi de {membre}", medical: "oui", par_membre: "oui", actif: "non" }], keys).errors).toEqual([]);
    expect(validateCatalog(Array.from({ length: 1001 }, (_v, i) => ({ ...base, code: `c${i}`, libelle: "x" })), keys).errors[0].message).toMatch(/1 000 lignes/);
  });

  it("le fichier d'amorçage du dépôt est valide", () => {
    const rows = JSON.parse(readFileSync("data/catalogue-anticipation.json", "utf8")) as CatalogFileRow[];
    const { items, errors } = validateCatalog(rows, keys);
    expect(errors).toEqual([]);
    expect(items.length).toBe(rows.length);
    expect(items.find((i) => i.isMedical)?.active).toBe(false); // le contenu médical attend la validation du référent santé
  });
});

describe("chargement par code (US-111 RF6 à RF9, D50)", () => {
  it("l'aperçu ne change rien ; le chargement crée, modifie (version +1), désactive et ne supprime jamais", async () => {
    await load();
    const keys = ["vehicle"];
    const changed = validateCatalog([{ ...CATALOG[0], libelle: "Impôts sur le revenu" }, { ...base, code: "nouveau", libelle: "Nouveau" }], keys).items;
    const preview = await previewCatalog(db, changed);
    expect(preview.created).toEqual(["nouveau"]);
    expect(preview.updated).toEqual([{ code: "impots", changes: [{ field: "label", before: "Déclaration de revenus", after: "Impôts sur le revenu" }] }]);
    expect(preview.deactivated.sort()).toEqual(["controle_technique", "dentaire"]);
    expect((await db.selectFrom("anticipation_catalog_items").select("code").execute()).map((r) => r.code).sort()).toEqual(["controle_technique", "dentaire", "impots"]); // rien n'a bougé
    await applyCatalog(db, changed);
    const rows = await db.selectFrom("anticipation_catalog_items").select(["code", "active", "version", "label"]).orderBy("code").execute();
    expect(rows).toEqual([
      { code: "controle_technique", active: false, version: 2, label: "Contrôle technique de la voiture" },
      { code: "dentaire", active: false, version: 2, label: "Suivi dentaire de {membre} cette année" },
      { code: "impots", active: true, version: 2, label: "Impôts sur le revenu" },
      { code: "nouveau", active: true, version: 1, label: "Nouveau" },
    ]);
    // Rechargé à l'identique : rien ne change, pas de nouvelle version.
    const again = await previewCatalog(db, changed);
    expect(again.unchanged.sort()).toEqual(["impots", "nouveau"]);
    expect(again.updated).toEqual([]);
  });

  it("un rappel désactivé retire ses questions sans réponse et garde les réponses données (RF9)", async () => {
    const f = await family();
    await load();
    await setSituationAnswer(at("2054-04-02T09:00:00Z"), f.sophie, "vehicle", true);
    await selectQuestions(at("2054-04-02T09:00:00Z"), f.accountId, TZ);
    const open_ = await questions(f.accountId);
    expect(open_.map((q) => q.code)).toEqual(["controle_technique", "dentaire", "impots"]);
    await answerQuestion(at("2054-04-02T09:00:00Z"), f.sophie, open_.find((q) => q.code === "impots")!.id, { answer: "done_or_planned" });
    await load([{ ...CATALOG[1], actif: "non" }]); // le fichier ne garde que le contrôle technique, désactivé
    const left = await questions(f.accountId);
    expect(left.map((q) => [q.code, q.status])).toEqual([["impots", "settled"]]); // « Oui » conservée, les deux autres retirées
  });

  it("tout ou rien : une ligne refusée par la base annule tout le chargement", async () => {
    await load();
    const bad = validateCatalog([{ ...base, code: "avant", libelle: "Créé avant l'échec" }], []).items;
    // Contourne le contrôle du fichier pour faire échouer la base : médical actif sans revue.
    bad.push({ ...bad[0], code: "rejete", isMedical: true, perMember: true, active: true, sourceReference: null, reviewedAt: null, reviewedBy: null });
    await expect(applyCatalog(db, bad)).rejects.toThrow();
    expect((await db.selectFrom("anticipation_catalog_items").select("code").execute()).map((r) => r.code).sort()).toEqual(["controle_technique", "dentaire", "impots"]);
  });
});

describe("périodes", () => {
  it("une période peut déborder sur l'année suivante ; le 31 se replie sur le dernier jour du mois", () => {
    expect(periodOf({ periodStart: { month: 4, day: 1 }, periodEnd: { month: 5, day: 31 } }, 2054)).toEqual({ start: "2054-04-01", end: "2054-05-31" });
    expect(periodOf({ periodStart: { month: 11, day: 1 }, periodEnd: { month: 2, day: 28 } }, 2054)).toEqual({ start: "2054-11-01", end: "2055-02-28" });
    expect(periodOf({ periodStart: { month: 1, day: 31 }, periodEnd: { month: 2, day: 31 } }, 2055)).toEqual({ start: "2055-01-31", end: "2055-02-28" });
  });
  it("l'âge se compte en mois à partir du mois et de l'année de naissance", () => {
    expect(ageInMonths(2046, 6, "2054-03-02")).toBe(93);
    expect(ageInMonths(2054, 3, "2054-03-02")).toBe(0);
  });
});

describe("sélection des échéances (US-102 RF3, RF2, RF7, RF9)", () => {
  async function setup(extra: CatalogFileRow[] = []) {
    const f = await family();
    await load([...CATALOG, ...extra]);
    return f;
  }

  it("l'échéance du catalogue est posée quand son délai est ouvert, une seule fois (CA 1.1)", async () => {
    const f = await setup();
    await selectQuestions(at("2054-03-02T09:00:00Z"), f.accountId, TZ); // mars : l'impôt s'ouvre le 11 mars, pas encore au 1er
    expect((await questions(f.accountId)).map((q) => q.code)).not.toContain("impots");
    const april = at("2054-04-02T09:00:00Z");
    const first = await selectQuestions(april, f.accountId, TZ);
    expect(first.created).toBeGreaterThan(0);
    const taxes = (await questions(f.accountId)).filter((q) => q.code === "impots");
    expect(taxes).toHaveLength(1);
    expect(taxes[0]).toMatchObject({ start: "2054-04-01", end: "2054-05-31", status: "pending", label_template: "Déclaration de revenus" });
    expect((await selectQuestions(april, f.accountId, TZ)).created).toBe(0); // rejoué : pas de doublon
  });

  it("sans réponse au questionnaire, seules les échéances sans condition de situation (CA 2.2) ; « non » en exclut (CA 2.1)", async () => {
    const f = await setup();
    const april = at("2054-03-30T09:00:00Z");
    await selectQuestions(april, f.accountId, TZ);
    expect((await questions(f.accountId)).map((q) => q.code)).not.toContain("controle_technique");
    await setSituationAnswer(april, f.sophie, "vehicle", false);
    await selectQuestions(april, f.accountId, TZ);
    expect((await questions(f.accountId)).map((q) => q.code)).not.toContain("controle_technique");
    await setSituationAnswer(april, f.sophie, "vehicle", true);
    await selectQuestions(april, f.accountId, TZ);
    expect((await questions(f.accountId)).map((q) => q.code)).toContain("controle_technique");
    expect((await failure(setSituationAnswer(april, f.sophie, "avion", true))).code).toBe("invalid_setting");
    expect((await setSituationAnswer(april, f.sophie, "vehicle", null)).find((s) => s.key === "vehicle")?.answer).toBeNull();
  });

  it("une échéance liée à l'âge exige la naissance : la question de santé est générique (CA 5.1), une carte demande la naissance (CA 7.1)", async () => {
    const f = await setup();
    const now = at("2054-03-02T09:00:00Z");
    const view = await getAnticipation(now, f.sophie);
    const dentist = view.questions.filter((q) => q.medical);
    expect(dentist.map((q) => [q.member?.firstName, q.text])).toEqual([["Léo", "Pensez-vous à : suivi dentaire de Léo cette année ?"]]); // Mia : naissance inconnue
    expect(view.birthCards).toEqual([{ memberId: f.miaId, firstName: "Mia" }]);
    // La question garde le repère, jamais le prénom (RT3).
    expect((await questions(f.accountId)).find((q) => q.member_id === f.leoId)?.label_template).toBe("Suivi dentaire de {membre} cette année");
    // Une fois la naissance de Mia indiquée, sa question est posée et la carte disparaît.
    await updateMember(now, f.sophie, f.miaId, { birth: "2048-02" });
    const after = await getAnticipation(now, f.sophie);
    expect(after.birthCards).toEqual([]);
    expect((await questions(f.accountId)).filter((q) => q.code === "dentaire").map((q) => q.member_id).sort()).toEqual([f.leoId, f.miaId].sort());
  });

  it("une échéance qui revient tous les 2 ans n'est pas reposée l'année suivante (RF1, RF6)", async () => {
    const f = await family();
    await load([{ ...base, code: "bisannuel", libelle: "Tous les deux ans", frequence_annees: 2, periode_debut_mois: 3, periode_fin_mois: 6, delai_jours: 0 }]);
    await selectQuestions(at("2054-03-02T09:00:00Z"), f.accountId, TZ);
    const [q] = await questions(f.accountId);
    await answerQuestion(at(), f.sophie, q.id, { answer: "done_or_planned" });
    await selectQuestions(at("2055-03-02T09:00:00Z"), f.accountId, TZ);
    expect(await questions(f.accountId)).toHaveLength(1); // 2055 : pas encore
    await selectQuestions(at("2056-03-02T09:00:00Z"), f.accountId, TZ);
    expect((await questions(f.accountId)).map((x) => x.start)).toEqual(["2054-03-01", "2056-03-01"]);
  });

  it("désactivé pour la famille, rien n'est posé ni montré (RF9, CA 9.1) ; réactivé, tout revient", async () => {
    const f = await setup();
    await setAnticipationEnabled(at(), f.sophie, false);
    const april = at("2054-04-02T09:00:00Z");
    expect((await selectQuestions(april, f.accountId, TZ)).created).toBe(0);
    expect(await questions(f.accountId)).toEqual([]);
    expect(await getAnticipation(april, f.marc)).toMatchObject({ enabled: false, questions: [], birthCards: [] });
    await setAnticipationEnabled(at(), f.marc, true); // chaque parent le règle pour la famille
    expect((await getAnticipation(april, f.sophie)).questions.length).toBeGreaterThan(0);
  });

  it("au plus 5 questions par semaine, celles sans réponse reviennent la semaine suivante (AT-7)", async () => {
    const f = await family();
    const many = Array.from({ length: 7 }, (_v, i): CatalogFileRow => ({ ...base, code: `q${i}`, libelle: `Échéance ${i}`, periode_debut_mois: 3, periode_fin_mois: 6, delai_jours: 0 }));
    await load(many);
    const week1 = await getAnticipation(at("2054-03-02T09:00:00Z"), f.sophie);
    expect(week1.questions).toHaveLength(5);
    // Deux réponses : la semaine suivante, les 3 restantes plus les 2 jamais présentées.
    for (const q of week1.questions.slice(0, 2)) await answerQuestion(at(), f.sophie, q.id, { answer: "done_or_planned" });
    const week2 = await getAnticipation(at("2054-03-09T09:00:00Z"), f.sophie);
    expect(week2.questions).toHaveLength(5);
    expect(week2.questions.map((q) => q.id)).toEqual(expect.arrayContaining(week1.questions.slice(2).map((q) => q.id)));
  });

  it("le départ d'un membre supprime ses questions (RF7, US-93)", async () => {
    const f = await setup();
    await selectQuestions(at("2054-03-02T09:00:00Z"), f.accountId, TZ);
    expect((await questions(f.accountId)).some((q) => q.member_id === f.leoId)).toBe(true);
    await removeMember(at(), f.sophie, f.leoId);
    expect((await questions(f.accountId)).some((q) => q.member_id === f.leoId)).toBe(false);
  });
});

describe("réponses à trois choix (US-102 RF6, RF8, CC-7)", () => {
  async function ready() {
    const f = await family();
    await load();
    await setSituationAnswer(at("2054-04-02T09:00:00Z"), f.sophie, "vehicle", true);
    const view = await getAnticipation(at("2054-04-02T09:00:00Z"), f.sophie);
    return { f, view, id: (code: string) => view.questions.find((q) => q.text.toLowerCase().includes(code))!.id };
  }
  const april = () => at("2054-04-02T09:00:00Z");

  it("« Oui » : rien n'est créé, la question est réglée (CA 6.1)", async () => {
    const { f, id } = await ready();
    const out = await answerQuestion(april(), f.sophie, id("déclaration"), { answer: "done_or_planned" });
    expect(out.taskId).toBeNull();
    expect((await questions(f.accountId)).find((q) => q.code === "impots")?.status).toBe("settled");
    expect(await db.selectFrom("family_tasks").select("id").where("account_id", "=", f.accountId).execute()).toEqual([]);
    expect((await getAnticipation(april(), f.sophie)).questions.map((q) => q.text)).not.toContain("Avez-vous prévu : déclaration de revenus ?");
  });

  it("« Non, à faire » crée une tâche seule due à la fin de la période, assignable, une seule fois (CA 6.2, CC-7)", async () => {
    const { f, id } = await ready();
    const target = id("contrôle technique");
    const sophieMember = (await db.selectFrom("family_members").select("id").where("user_id", "=", f.userIds.sophie).executeTakeFirstOrThrow()).id;
    const [a, b] = await Promise.allSettled([answerQuestion(april(), f.marc, target, { answer: "todo", assigneeId: sophieMember }), answerQuestion(april(), f.sophie, target, { answer: "todo" })]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]); // un seul parent l'emporte : la question disparaît pour l'autre (RF8)
    const tasks = await db.selectFrom("family_tasks").select(["title", "status", "source", "origin_question_id"]).select(sql<string>`due_date::text`.as("due")).where("account_id", "=", f.accountId).execute();
    expect(tasks).toHaveLength(1);
    expect(open(tasks[0].title as unknown as Buffer)).toBe("À prévoir : contrôle technique de la voiture");
    expect(tasks[0]).toMatchObject({ status: "todo", source: "anticipation", due: "2054-04-30" });
    expect((await questions(f.accountId)).find((q) => q.code === "controle_technique")?.status).toBe("task_created");
    const late = await failure(answerQuestion(april(), f.sophie, target, { answer: "done_or_planned" }));
    expect(late).toMatchObject({ code: "already_handled", status: 409 });
  });

  it("« Me le rappeler dans… » : 1, 3 ou 6 mois, sans dépasser la fin de la période ; la question est reposée à l'échéance (CA 6.3)", async () => {
    const { f, id } = await ready();
    const target = id("déclaration");
    expect((await failure(answerQuestion(april(), f.sophie, target, { answer: "remind_later", remindMonths: 2 }))).code).toBe("invalid_delay");
    await answerQuestion(april(), f.sophie, target, { answer: "remind_later", remindMonths: 3 });
    const row = await db.selectFrom("anticipation_questions").select(["status", sql<string>`remind_at::text`.as("remind"), sql<string>`period_end::text`.as("end")]).where("id", "=", target).executeTakeFirstOrThrow();
    expect(row.status).toBe("snoozed");
    expect(row.remind <= row.end).toBe(true);
    expect((await getAnticipation(april(), f.sophie)).questions.map((q) => q.id)).not.toContain(target);
    // L'échéance du rappel arrive : la question est de nouveau posée.
    await db.updateTable("anticipation_questions").set({ remind_at: "2020-01-01" as unknown as Date }).where("id", "=", target).execute();
    expect((await getAnticipation(at("2054-04-09T09:00:00Z"), f.sophie)).questions.map((q) => q.id)).toContain(target);
  });

  it("réservé aux parents : un invité secondaire n'a pas la section ni les réponses (RF8, CA 8.2)", async () => {
    const { f, id } = await ready();
    expect((await failure(getAnticipation(april(), f.elodie))).status).toBe(403);
    expect((await failure(answerQuestion(april(), f.elodie, id("déclaration"), { answer: "done_or_planned" }))).status).toBe(403);
    expect((await failure(answerQuestion(april(), f.sophie, randomUUID(), { answer: "done_or_planned" }))).code).toBe("not_found");
    expect((await failure(answerQuestion(april(), f.sophie, id("déclaration"), { answer: "peut-être" as never }))).code).toBe("invalid_answer");
    expect((await failure(answerQuestion(april(), f.sophie, id("contrôle technique"), { answer: "todo", assigneeId: randomUUID() }))).code).toBe("invalid_assignee");
  });

  it("le point de la semaine porte les questions, pour les parents seulement (CA 4.1, US-98 RF3)", async () => {
    const { f, view } = await ready();
    const digest = await getDigest(april(), f.sophie);
    expect(digest.questions.map((q) => q.id).sort()).toEqual(view.questions.map((q) => q.id).sort());
    expect((await getDigest(april(), f.elodie)).questions).toEqual([]);
  });
});

describe("notification mensuelle et planificateur (US-102 RF3, CA 3.1)", () => {
  it("« 3 échéances à anticiper ce mois-ci » une fois, aux parents qui ont un appareil", async () => {
    const f = await family();
    await load();
    await setSituationAnswer(at("2054-04-02T09:00:00Z"), f.sophie, "vehicle", true);
    send.mockClear();
    const first = await runAnticipation(at("2054-04-02T05:00:00Z"), { accountId: f.accountId });
    expect(first.created).toBe(3); // impôts, contrôle technique, suivi dentaire de Léo
    expect(first.notified).toBe(1); // Sophie a un appareil, Marc aucun
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][1] as string).body).toBe("3 échéances à anticiper ce mois-ci");
    await runAnticipation(at("2054-04-02T06:00:00Z"), { accountId: f.accountId });
    expect(send).toHaveBeenCalledTimes(1); // rejoué : rien de nouveau, rien de renvoyé
    expect(monthlyBody(1)).toBe("1 échéance à anticiper ce mois-ci");
  });

  it("purge les questions 24 mois après leur période", async () => {
    const f = await family();
    await load();
    await selectQuestions(at("2054-04-02T09:00:00Z"), f.accountId, TZ);
    await sql`select purge_expired_anticipation()`.execute(db);
    expect((await questions(f.accountId)).length).toBeGreaterThan(0); // 2054 : bien dans le futur de l'horloge de la base
    await db.updateTable("anticipation_questions").set({ period_start: "2020-01-01" as unknown as Date, period_end: "2020-02-01" as unknown as Date }).where("account_id", "=", f.accountId).execute();
    await sql`select purge_expired_anticipation()`.execute(db);
    expect(await questions(f.accountId)).toEqual([]);
  });
});
