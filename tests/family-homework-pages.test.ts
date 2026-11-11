import { sql, type Kysely } from "kysely";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExerciseSheet } from "@/components/family/HomeworkPageScreen";
import { addChild, setChildProfile } from "@/server/assistant/family";
import { InvalidPage, readModelPage } from "@/server/assistant/homework/page-format";
import { createExercisePage, deleteExercisePage, getExercisePage, listExercisePages, PAGE_MESSAGES } from "@/server/assistant/homework/pages";
import { eraseHomeworkProgress, purgeExpiredHomework, setHomeworkAge, setHomeworkEnabled } from "@/server/assistant/homework/settings";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { randomUUID } from "node:crypto";
import { addAgent, getAgentSheet, getDashboard, listCatalog, removeAgent } from "@/server/catalog/service";
import { getChat, sendMessage } from "@/server/chat/service";
import { prepareExport, readExport, requestExport } from "@/server/compliance/exports";
import { readZip } from "@/server/compliance/zip";
import { sendAssistantMessage } from "@/server/assistant/service";
import { eraseConversation } from "@/server/courses/chat/erase";
import { listCourseMessages, sendCourseMessage } from "@/server/courses/chat/service";
import { courseHome } from "@/server/courses/home";
import { childOptions, prepareWeek } from "@/server/assistant/homework/weeks";
import { loadHomeworkCatalog } from "@/server/assistant/homework/catalog";
import { createGuest, createProfile, sessionFor, testDb } from "./helpers/fixtures";

/** US-180 : créer des exercices à partir d'une leçon (enfant autonome), fiche réponse réservée aux parents, dossier « Exercices ». */
let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

const NOW = new Date("2054-11-05T09:00:00Z");
const ctx = (now = NOW): Ctx => ({ get db() { return db; }, now }) as Ctx;

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** La page que le modèle rend pour une leçon sur les fractions : 3 exercices, réponses et barème 5 + 7 + 8. */
const lesson = (over: Record<string, unknown> = {}) => ({
  statut: "ok", theme: "Les fractions", mot_cle: "fractions", matiere: "Maths", niveau: "CM1",
  exercices: [
    { titre: "Je reconnais", niveau: "facile", points: 5, consigne: "Coche la bonne réponse.", questions: [
      { forme: "multiple_choice", texte: "Dans 3/4, le nombre 4 s'appelle :", choix: ["le numérateur", "le dénominateur", "le quotient"], reponse: 1 },
      { forme: "true_false", texte: "1/2 se lit un demi.", reponse: true },
    ] },
    { titre: "Je complète", niveau: "moyen", points: 7, consigne: "Complète les égalités.", questions: [
      { forme: "equations_to_complete", texte: "1/2 = ___/4", reponse: ["2"] },
      { forme: "fill_in_blanks", texte: "Le nombre du haut s'appelle le ___ et celui du bas le ___.", reponse: ["numérateur", "dénominateur"] },
      { forme: "matching", gauche: ["un demi", "un tiers"], droite: ["1/3", "1/2"], reponse: [1, 0] },
      { forme: "true_false_correction", texte: "1/4 est plus grand que 3/4.", reponse: false, correction: "1/4 est plus petit que 3/4." },
    ] },
    { titre: "Je réfléchis", niveau: "difficile", points: 8, consigne: "Lis le problème, puis réponds.", enonce: "Léa a 12 billes. Elle donne 1/3 de ses billes à son frère.", questions: [
      { forme: "problem", texte: "Combien de billes donne-t-elle ?", reponse: { calcul: "12 ÷ 3 = 4", resultat: "4 billes" } },
      { forme: "written_answer", texte: "Explique ta réponse.", lignes: 2, reponse: "On partage les 12 billes en 3 parts égales." },
      { forme: "ordering", texte: "Range du plus petit au plus grand.", elements: ["3/4", "1/4", "2/4"], reponse: ["1/4", "2/4", "3/4"] },
    ] },
  ],
  ...over,
});
type Lesson = ReturnType<typeof lesson>;
const withExercise = (index: number, change: Record<string, unknown>): Lesson => {
  const page = lesson();
  page.exercices = page.exercices.map((e, i) => (i === index ? { ...e, ...change } : e)) as Lesson["exercices"];
  return page;
};

const usage = { inputTokens: 900, outputTokens: 700, cacheRead: 0, cacheWrite: 0 };
function fakeModel(answer: unknown | (() => never)): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  return {
    id: "faux", seen,
    send: async (request): Promise<ModelResponse> => {
      seen.push(structuredClone(request));
      if (typeof answer === "function") (answer as () => never)();
      return { content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }], stopReason: "end_turn", usage, requestId: null };
    },
  };
}

/** Camille et Julien (parents), Élodie (profil de Léo), Noé (invité secondaire ordinaire), Léo (8 ans de devoirs) et Mia (7 ans, sans profil). */
async function family() {
  const camille = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: "Europe/Paris" }).where("id", "=", camille.accountId!).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const noe = await createGuest(db, camille.accountId!, "Noé");
  const camilleSession = await sessionFor(db, camille.id);
  const leo = await addChild(ctx(), camilleSession, { firstName: "Léo" });
  const mia = await addChild(ctx(), camilleSession, { firstName: "Mia" });
  await setHomeworkEnabled(ctx(), camilleSession, { enabled: true, confirmed: true });
  await setHomeworkAge(ctx(), camilleSession, leo.id, 8);
  await setHomeworkAge(ctx(), camilleSession, mia.id, 7);
  await setChildProfile(ctx(), camilleSession, leo.id, elodie.id);
  return {
    accountId: camille.accountId!, camilleSession, julienSession: await sessionFor(db, julien.id), leoSession: await sessionFor(db, elodie.id), noeSession: await sessionFor(db, noe.id),
    users: { camille: camille.id, leo: elodie.id }, leo: leo.id, mia: mia.id,
  };
}
type Family = Awaited<ReturnType<typeof family>>;
const photo = { mediaType: "image/jpeg" as const, data: Buffer.from("fausse photo de la leçon") };
const requests = async (userId: string) => (await db.selectFrom("daily_request_counters").select("request_count").where("user_id", "=", userId).execute()).reduce((sum, r) => sum + r.request_count, 0);
const pagesOf = (f: Family) => db.selectFrom("homework_exercise_pages").select(["id", "member_id", "created_by_user_id", "theme", "exercises", "question_forms"]).where("account_id", "=", f.accountId).execute();

describe("contrôle de la page par le code (US-180 RT1)", () => {
  it("une page conforme : énoncé et fiche réponse séparés, barème, formes de la liste fermée", () => {
    const page = readModelPage(`Voici la page : ${JSON.stringify(lesson())}`);
    if (page.status !== "ok") throw new Error("page attendue");
    expect(page.content).toMatchObject({ theme: "Les fractions", keyword: "fractions", subject: "Maths", level: "CM1" });
    expect(page.content.exercises.map((e) => [e.level, e.points, e.questions.length])).toEqual([["facile", 5, 2], ["moyen", 7, 4], ["difficile", 8, 3]]);
    expect(page.grading).toEqual([{ level: "facile", points: 5 }, { level: "moyen", points: 7 }, { level: "difficile", points: 8 }]);
    expect(page.forms).toEqual(["multiple_choice", "true_false", "true_false_correction", "equations_to_complete", "fill_in_blanks", "matching", "ordering", "problem", "written_answer"]);
    // L'énoncé ne porte aucune réponse : elles sont toutes dans la fiche.
    expect(JSON.stringify(page.content)).not.toMatch(/"correct"|"value"|"blanks"|"pairs"|"order"|"calculation"|"model"|"correction"|plus petit que/);
    expect(page.answers[0][0]).toEqual({ form: "multiple_choice", correct: 1 });
    expect(page.answers[1][3]).toEqual({ form: "true_false_correction", value: false, correction: "1/4 est plus petit que 3/4." });
    expect(page.answers[2][0]).toEqual({ form: "problem", calculation: "12 ÷ 3 = 4", result: "4 billes" });
  });

  it("leçon illisible ou hors sujet : aucun contenu n'est lu", () => {
    expect(readModelPage('{"statut":"illisible"}')).toEqual({ status: "unreadable" });
    expect(readModelPage('{"statut":"hors_sujet"}')).toEqual({ status: "off_topic" });
  });

  it("une page qui s'écarte est refusée : ordre des niveaux, total de 20, barème croissant, réponse manquante, forme inconnue", () => {
    const refused = (page: unknown) => expect(() => readModelPage(JSON.stringify(page))).toThrow(InvalidPage);
    refused(withExercise(0, { niveau: "moyen" }));
    refused(withExercise(2, { points: 9 })); // total 21
    refused({ ...lesson(), exercices: lesson().exercices.map((e, i) => ({ ...e, points: [8, 7, 5][i] })) }); // total 20, mais décroissant
    refused({ ...lesson(), exercices: lesson().exercices.map((e, i) => ({ ...e, points: [6, 6, 8][i] })) }); // facile = moyen
    refused({ ...lesson(), exercices: lesson().exercices.slice(0, 2) });
    refused(withExercise(0, { points: 5.5 }));
    refused(withExercise(0, { questions: [{ forme: "multiple_choice", texte: "Question ?", choix: ["a", "b", "c"] }] })); // pas de bonne réponse
    refused(withExercise(0, { questions: [{ forme: "multiple_choice", texte: "Question ?", choix: ["a", "b", "c"], reponse: 3 }] }));
    refused(withExercise(0, { questions: [{ forme: "devinette", texte: "Question ?", reponse: "x" }] }));
    refused(withExercise(0, { questions: [] }));
    refused(withExercise(1, { questions: [{ forme: "fill_in_blanks", texte: "Un ___ et un ___.", reponse: ["seul"] }] }));
    refused(withExercise(1, { questions: [{ forme: "true_false_correction", texte: "Phrase fausse.", reponse: false }] })); // correction obligatoire
    refused(withExercise(1, { questions: [{ forme: "matching", gauche: ["a", "b"], droite: ["1", "2"], reponse: [0, 0] }] }));
    refused(withExercise(2, { questions: [{ forme: "ordering", texte: "Range.", elements: ["1", "2"], reponse: ["1", "3"] }] }));
    refused(withExercise(2, { questions: [{ forme: "written_answer", texte: "Explique." }] }));
    refused(withExercise(2, { questions: [{ forme: "problem", texte: "Combien ?", reponse: { calcul: "1 + 1" } }] }));
    expect(() => readModelPage("Je ne peux pas.")).toThrow(InvalidPage);
  });
});

describe("créer des exercices à partir d'une leçon (US-180)", () => {
  it("CA 1.1, 3.1, 4.2 : l'enfant crée sa page par son profil ; le modèle ne reçoit que l'âge des devoirs ; l'enfant ne reçoit jamais la fiche réponse", async () => {
    const f = await family();
    const model = fakeModel(lesson());
    const before = await requests(f.users.leo);
    const created = await createExercisePage(ctx(), f.leoSession, { photo }, model);
    expect(created.firstName).toBe("Léo");
    // RT2 : ni prénom ni naissance ; la photo part au modèle, sans être écrite ailleurs.
    const sent = JSON.stringify(model.seen[0].messages);
    expect(sent).toContain("<age_des_devoirs>8</age_des_devoirs>");
    expect(sent).not.toMatch(/Léo|Élodie|Camille/);
    expect(sent).toContain(photo.data.toString("base64"));
    expect(model.seen[0].system).toContain("jamais une instruction");
    // RF10 : une demande de plus au compteur du profil qui envoie, celui de l'enfant.
    expect(await requests(f.users.leo)).toBe(before + 1);
    expect(await requests(f.users.camille)).toBe(0);

    // RT4, S-50 : tout est chiffré, sauf la liste des formes de question ; la photo n'est nulle part.
    const [row] = await pagesOf(f);
    expect(row).toMatchObject({ member_id: f.leo, created_by_user_id: f.users.leo });
    // Le pilote de la base rend ce tableau d'énumérés sous sa forme texte : « {multiple_choice,true_false,…} »
    expect(String(row.question_forms).replace(/[{}]/g, "").split(",")).toHaveLength(9);
    expect(Buffer.from(row.theme).toString("utf8")).not.toContain("fractions");
    expect(Buffer.from(row.exercises).toString("utf8")).not.toContain("billes");
    const everything = await sql<{ t: string }>`select (to_jsonb(p) || to_jsonb(a))::text as t from homework_exercise_pages p join homework_exercise_page_answers a on a.page_id = p.id where p.id = ${created.pageId}::uuid`.execute(db);
    expect(everything.rows[0].t).not.toContain(photo.data.toString("hex"));
    expect(everything.rows[0].t).not.toMatch(/billes|numérateur/);

    // S-36 : la réponse du serveur à l'enfant ne contient ni fiche réponse ni barème.
    const mine = await getExercisePage(ctx(), f.leoSession, created.pageId);
    expect(mine).toMatchObject({ role: "child", firstName: "Léo", created: "2054-11-05", answers: null, grading: null });
    expect(mine.content.exercises.map((e) => e.level)).toEqual(["facile", "moyen", "difficile"]);
    expect(JSON.stringify(mine)).not.toMatch(/plus petit que|12 ÷ 3|4 billes|parts égales|"correct"|"blanks"/);
    const markup = renderToStaticMarkup(createElement(ExerciseSheet, { page: mine }));
    expect(markup).toContain("Relis la leçon « Je retiens » puis fais les exercices.");
    expect(markup).toContain("Prénom");
    expect(markup).not.toMatch(/Fiche réponse|Barème|4 billes/);
    expect((await listExercisePages(ctx(), f.leoSession))).toEqual({ role: "child", firstName: "Léo", pages: [{ id: created.pageId, theme: "Les fractions", created: "2054-11-05", createdBy: null }] });
  });

  it("CA 4.1, RF7 : un parent ouvre l'énoncé, la fiche réponse et le barème sur 20 ; le dossier range les pages par enfant", async () => {
    const f = await family();
    const { pageId } = await createExercisePage(ctx(), f.leoSession, { text: "Je retiens : une fraction a un numérateur et un dénominateur." }, fakeModel(lesson()));
    const page = await getExercisePage(ctx(), f.julienSession, pageId);
    expect(page.role).toBe("parent");
    expect(page.grading).toEqual([{ level: "facile", points: 5 }, { level: "moyen", points: 7 }, { level: "difficile", points: 8 }]);
    expect(page.grading!.reduce((sum, g) => sum + g.points, 0)).toBe(20);
    expect(page.answers![2][1]).toEqual({ form: "written_answer", model: "On partage les 12 billes en 3 parts égales." });
    const markup = renderToStaticMarkup(createElement(ExerciseSheet, { page }));
    expect(markup).toContain("Fiche réponse · pour l&#x27;adulte qui corrige");
    expect(markup).toContain("Toute réponse proche est acceptée.");
    expect(markup).toContain("Barème conseillé");
    expect(markup).toContain("20 pts");
    const folder = await listExercisePages(ctx(), f.camilleSession);
    if (folder.role !== "parent") throw new Error("dossier des parents attendu");
    expect(folder.children.map((c) => [c.firstName, c.levelLabel, c.hasProfile, c.pages.map((p) => p.theme)])).toEqual([["Léo", "CE2", true, ["Les fractions"]], ["Mia", "CE1", false, []]]);
  });

  it("CA 1.2, S-43 : un parent crée la page d'un enfant sans profil, ou pour un enfant qui en a un, qui la retrouve dans « Mes exercices » sans corrigé", async () => {
    const f = await family();
    const model = fakeModel(lesson({ theme: "Le passé composé", mot_cle: "passé composé", matiere: "Français" }));
    expect((await failure(createExercisePage(ctx(), f.camilleSession, { photo }, model))).code).toBe("not_found"); // l'enfant est à choisir
    const forMia = await createExercisePage(ctx(), f.camilleSession, { memberId: f.mia, photo }, model);
    expect(forMia.firstName).toBe("Mia");
    expect(JSON.stringify(model.seen[0].messages)).toContain("<age_des_devoirs>7</age_des_devoirs>");
    expect(await requests(f.users.camille)).toBe(1);
    const forLeo = await createExercisePage(ctx(), f.camilleSession, { memberId: f.leo, photo }, model);
    const mine = await listExercisePages(ctx(), f.leoSession);
    if (mine.role !== "child") throw new Error("vue enfant attendue");
    expect(mine.pages).toEqual([{ id: forLeo.pageId, theme: "Le passé composé", created: "2054-11-05", createdBy: expect.any(String) }]);
    expect((await getExercisePage(ctx(), f.leoSession, forLeo.pageId)).answers).toBeNull();
    // L'enfant n'ouvre que ses pages ; un invité secondaire ordinaire n'a rien.
    expect((await failure(getExercisePage(ctx(), f.leoSession, forMia.pageId))).status).toBe(404);
    expect((await failure(listExercisePages(ctx(), f.noeSession))).status).toBe(403);
    expect((await failure(getExercisePage(ctx(), f.noeSession, forLeo.pageId))).status).toBe(403);
    expect((await failure(createExercisePage(ctx(), f.noeSession, { photo }, model))).status).toBe(403);
    // Le profil d'un enfant crée toujours pour lui-même, quoi qu'il envoie.
    await createExercisePage(ctx(), f.leoSession, { memberId: f.mia, photo }, model);
    expect((await pagesOf(f)).filter((p) => p.member_id === f.mia)).toHaveLength(1);
  });

  it("RF5 : « Mes exercices » ne garde que les 30 derniers jours pour l'enfant ; le dossier des parents garde tout", async () => {
    const f = await family();
    const old = await createExercisePage(ctx(new Date("2054-10-01T09:00:00Z")), f.leoSession, { photo }, fakeModel(lesson({ theme: "Les angles droits", mot_cle: "angles" })));
    const recent = await createExercisePage(ctx(), f.leoSession, { photo }, fakeModel(lesson()));
    const mine = await listExercisePages(ctx(), f.leoSession);
    expect(mine.role === "child" && mine.pages.map((p) => p.id)).toEqual([recent.pageId]);
    expect((await failure(getExercisePage(ctx(), f.leoSession, old.pageId))).status).toBe(404);
    const folder = await listExercisePages(ctx(), f.camilleSession);
    expect(folder.role === "parent" && folder.children[0].pages.map((p) => p.theme)).toEqual(["Les fractions", "Les angles droits"]);
  });

  it("RF8, RF10, RF11 : leçon illisible ou hors sujet, page refusée par le contrôle, panne, plafond ; aucune page n'est créée", async () => {
    const f = await family();
    const none = async () => expect(await pagesOf(f)).toEqual([]);
    const unreadable = await failure(createExercisePage(ctx(), f.leoSession, { photo }, fakeModel({ statut: "illisible" })));
    expect([unreadable.code, unreadable.message]).toEqual(["lesson_unreadable", "Je n'arrive pas à lire ta leçon. Reprends la photo bien à plat, avec de la lumière."]);
    const offTopic = await failure(createExercisePage(ctx(), f.camilleSession, { memberId: f.leo, photo }, fakeModel({ statut: "hors_sujet" })));
    expect([offTopic.code, offTopic.message]).toEqual(["lesson_off_topic", PAGE_MESSAGES.parent.off_topic]);
    await none();
    // Une page qui échoue au contrôle n'est pas enregistrée, et la demande est rendue.
    const counted = await requests(f.users.leo);
    const invalid = await failure(createExercisePage(ctx(), f.leoSession, { photo }, fakeModel(withExercise(2, { points: 9 }))));
    expect([invalid.code, invalid.message]).toEqual(["page_failed", "Les exercices n'ont pas pu être créés. Réessaie."]);
    const down = await failure(createExercisePage(ctx(), f.leoSession, { photo }, fakeModel(() => { throw new Error("panne"); })));
    expect(down.code).toBe("page_failed");
    expect(await requests(f.users.leo)).toBe(counted);
    await none();
    // Sans leçon, rien n'est envoyé.
    const quiet = fakeModel(lesson());
    expect((await failure(createExercisePage(ctx(), f.leoSession, { text: "   " }, quiet))).code).toBe("no_lesson");
    expect((await failure(createExercisePage(ctx(), f.leoSession, { text: "x".repeat(6001) }, quiet))).code).toBe("lesson_too_long");
    expect((await failure(createExercisePage(ctx(), f.leoSession, { photo: { mediaType: "image/gif" as never, data: photo.data } }, quiet))).code).toBe("invalid_photo");
    expect(quiet.seen).toHaveLength(0);
    // Plafond du jour atteint : le message de l'enfant, et celui du parent.
    await db.updateTable("accounts").set({ daily_request_limit: 1 }).where("id", "=", f.accountId).execute();
    await db.deleteFrom("daily_request_counters").where("user_id", "in", [f.users.leo, f.users.camille]).execute();
    await createExercisePage(ctx(), f.leoSession, { photo }, fakeModel(lesson()));
    const cap = await failure(createExercisePage(ctx(), f.leoSession, { photo }, quiet));
    expect([cap.code, cap.status, cap.message]).toEqual(["daily_cap_reached", 429, "Tu as déjà créé beaucoup d'exercices aujourd'hui. Réessaie demain."]);
    await createExercisePage(ctx(), f.camilleSession, { memberId: f.mia, photo }, fakeModel(lesson()));
    expect((await failure(createExercisePage(ctx(), f.camilleSession, { memberId: f.mia, photo }, quiet))).message).toBe(PAGE_MESSAGES.parent.cap);
    expect(quiet.seen).toHaveLength(0);
  });

  it("RF7, RT5 : un parent supprime une page ; « Effacer les progrès », le retrait de l'enfant et la purge à 12 mois suppriment les pages et leur fiche réponse", async () => {
    const f = await family();
    const a = await createExercisePage(ctx(), f.leoSession, { photo }, fakeModel(lesson()));
    expect((await failure(deleteExercisePage(ctx(), f.leoSession, a.pageId))).status).toBe(403);
    await deleteExercisePage(ctx(), f.julienSession, a.pageId);
    expect((await failure(getExercisePage(ctx(), f.camilleSession, a.pageId))).status).toBe(404);
    expect((await failure(deleteExercisePage(ctx(), f.julienSession, a.pageId))).status).toBe(404);
    const answers = () => db.selectFrom("homework_exercise_page_answers").select("page_id").where("account_id", "=", f.accountId).execute();
    expect(await answers()).toEqual([]);
    // Effacer les progrès de Devoirs
    await createExercisePage(ctx(), f.leoSession, { photo }, fakeModel(lesson()));
    await createExercisePage(ctx(), f.camilleSession, { memberId: f.mia, photo }, fakeModel(lesson()));
    expect(await answers()).toHaveLength(2);
    await eraseHomeworkProgress(ctx(), f.camilleSession);
    expect(await pagesOf(f)).toEqual([]);
    expect(await answers()).toEqual([]);
    // Retrait de l'enfant
    await createExercisePage(ctx(), f.camilleSession, { memberId: f.mia, photo }, fakeModel(lesson()));
    await db.updateTable("family_members").set({ archived_at: new Date() }).where("id", "=", f.mia).execute();
    expect(await pagesOf(f)).toEqual([]);
    // Purge : 12 mois après la création (la base compte avec sa propre horloge)
    const kept = await createExercisePage(ctx(), f.leoSession, { photo }, fakeModel(lesson()));
    const stale = await createExercisePage(ctx(), f.leoSession, { photo }, fakeModel(lesson()));
    await db.updateTable("homework_exercise_pages").set({ created_at: new Date(Date.now() - 370 * 86_400_000) }).where("id", "=", stale.pageId).execute();
    await db.updateTable("homework_exercise_pages").set({ created_at: new Date(Date.now() - 300 * 86_400_000) }).where("id", "=", kept.pageId).execute();
    await purgeExpiredHomework(ctx());
    expect((await pagesOf(f)).map((p) => p.id)).toEqual([kept.pageId]);
    // Aide désactivée : plus d'accès, pour personne.
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: false });
    expect((await failure(listExercisePages(ctx(), f.leoSession))).code).toBe("homework_disabled");
    expect((await failure(getExercisePage(ctx(), f.camilleSession, kept.pageId))).code).toBe("homework_disabled");
  });
});

describe("tchats des agents fermés au profil d'un enfant (S-47 élargie)", () => {
  it("un refus du serveur pour chaque agent : Assistant Famille, Courses et repas, agents du catalogue ; un autre invité secondaire n'est pas touché par cette règle", async () => {
    const f = await family();
    const agent = "999999999";
    const refused = [
      () => sendAssistantMessage(ctx(), f.leoSession, { requestId: randomUUID(), text: "Ajoute un rendez-vous" }),
      () => sendCourseMessage(ctx(), f.leoSession, { requestId: randomUUID(), text: "Un menu pour la semaine" }),
      () => listCourseMessages(ctx(), f.leoSession),
      () => eraseConversation(ctx(), f.leoSession),
      () => getChat(ctx(), f.leoSession, agent),
      () => sendMessage(ctx(), f.leoSession, { agentId: agent, requestId: randomUUID(), text: "Bonjour" }),
    ];
    for (const attempt of refused) expect((await failure(attempt())).status).toBe(403);
    expect((await failure(listCourseMessages(ctx(), f.leoSession))).code).toBe("child_no_chat");
    expect((await failure(getChat(ctx(), f.leoSession, agent))).code).toBe("child_no_chat");
    // Noé, invité secondaire ordinaire : la règle de l'enfant ne le concerne pas (il garde les règles d'avant).
    expect(await listCourseMessages(ctx(), f.noeSession)).toEqual([]);
    expect((await failure(getChat(ctx(), f.noeSession, agent))).code).toBe("not_found");
    // À l'écran : pas de tchat sur l'accueil de Courses et repas, pas de bouton « Ouvrir le tchat » sur le dashboard.
    expect((await courseHome(ctx(), f.leoSession)).chat).toBe(false);
    expect((await courseHome(ctx(), f.noeSession)).chat).toBe(true);
    const cards = (session: Family["leoSession"]) => getDashboard(ctx(), session).then((d) => [...d.tabs.pro, ...d.tabs.perso, ...d.tabs.contracts]);
    expect((await cards(f.leoSession)).every((a) => a.chatClosed)).toBe(true);
    expect((await cards(f.noeSession)).every((a) => !a.chatClosed)).toBe(true);
    // S-53 : le catalogue des agents est fermé à l'enfant (liste, fiche, ajout), pas à un autre invité secondaire.
    for (const attempt of [() => listCatalog(ctx(), f.leoSession, {}), () => getAgentSheet(ctx(), f.leoSession, agent), () => addAgent(ctx(), f.leoSession, agent), () => removeAgent(ctx(), f.leoSession, agent)]) {
      expect((await failure(attempt())).code).toBe("child_no_catalog");
    }
    expect((await getDashboard(ctx(), f.leoSession)).catalogClosed).toBe(true);
    expect((await getDashboard(ctx(), f.noeSession)).catalogClosed).toBe(false);
    await listCatalog(ctx(), f.noeSession, {});
  });
});

describe("export de la famille (US-55, US-119 RT5, US-180 RT5)", () => {
  it("l'export d'un parent contient l'âge des devoirs, les semaines, les exercices validés et les pages d'exercices avec leur fiche réponse ; celui de l'enfant, rien de tout cela", async () => {
    await loadHomeworkCatalog(db);
    const f = await family();
    const block = (await childOptions(db, f.accountId, f.leo)).blocks[0];
    await prepareWeek(ctx(), f.camilleSession, { weekStart: "2054-11-09", workDays: [1, 2], children: [{ memberId: f.leo, items: [{ kind: "exercises", textbook: "france", numbers: block.numbers.slice(0, 2), days: [1] }, { kind: "custom", title: "Lecture 15 min", days: [2] }] }] });
    const exercise = await db.selectFrom("homework_week_items").select("exercise_id").where("member_id", "=", f.leo).where("exercise_id", "is not", null).executeTakeFirstOrThrow();
    await db.insertInto("homework_exercise_validations").values({ member_id: f.leo, exercise_id: exercise.exercise_id! }).execute();
    await createExercisePage(ctx(), f.leoSession, { photo }, fakeModel(lesson()));
    const exported = async (session: Family["camilleSession"]) => {
      const now: Ctx = { db, now: new Date() } as Ctx;
      const { id } = await requestExport(now, session);
      expect(await prepareExport(now, id)).toBe("ready");
      const files = readZip(await readExport(now, session, id));
      return { json: JSON.parse(files.find((x) => x.name === "mes-donnees.json")!.data.toString()), html: files.find((x) => x.name === "mes-donnees.html")!.data.toString() };
    };
    const parent = await exported(f.julienSession);
    expect(parent.json.homeworkChildren).toEqual([expect.objectContaining({ enfant: "Léo", ageDesDevoirs: 8 }), expect.objectContaining({ enfant: "Mia", ageDesDevoirs: 7 })]);
    expect(parent.json.homeworkWeeks).toHaveLength(3);
    expect(parent.json.homeworkWeeks[2]).toMatchObject({ semaineDu: "2054-11-09", jour: "2054-11-10", enfant: "Léo", element: "Activité du parent : Lecture 15 min", fait: false });
    expect(parent.json.homeworkValidations).toEqual([expect.objectContaining({ enfant: "Léo", exercice: expect.stringMatching(/^Exercice \d+ \(france, /) })]);
    expect(parent.json.homeworkPages).toEqual([expect.objectContaining({ enfant: "Léo", theme: "Les fractions", matiere: "Maths", niveau: "CM1" })]);
    expect(parent.json.homeworkPages[0].enonce).toContain("Exercice 1 (Facile, 5 points) : Je reconnais.");
    expect(parent.json.homeworkPages[0].enonce).not.toContain("4 billes");
    expect(parent.json.homeworkPages[0].ficheReponse).toContain("12 ÷ 3 = 4 ; 4 billes");
    expect(parent.json.homeworkPages[0].ficheReponse).toContain("total 20 points");
    expect(parent.html).toContain("Aide Devoirs : pages d&#39;exercices, avec leur fiche réponse");
    // Le profil de l'enfant, invité secondaire, n'exporte ni les plannings ni la fiche réponse.
    const child = await exported(f.leoSession);
    expect([child.json.homeworkChildren, child.json.homeworkWeeks, child.json.homeworkValidations, child.json.homeworkPages]).toEqual([[], [], [], []]);
    expect(JSON.stringify(child.json)).not.toContain("4 billes");
  });
});
