import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addChild } from "@/server/assistant/family";
import { open } from "@/server/assistant/fields";
import { loadHomeworkCatalog } from "@/server/assistant/homework/catalog";
import { setHomeworkAge, setHomeworkEnabled } from "@/server/assistant/homework/settings";
import {
  activityOptions, addItem, childOptions, getWeek, listWeeks, moveItem, prepareWeek, removeItem, setItemChecked, shouldOfferHomework, titleMentionsHomework, upcomingMondays, type WeekInput,
} from "@/server/assistant/homework/weeks";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createGuest, createProfile, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(async () => {
  db = testDb();
  await loadHomeworkCatalog(db);
});
afterAll(async () => {
  await db.destroy();
});

const NOW = new Date("2054-11-05T09:00:00Z"); // jeudi ; la semaine du lundi 2054-11-02 est la semaine en cours
const ctx = (): Ctx => ({ get db() { return db; }, now: NOW }) as Ctx;
const WEEK = "2054-11-09"; // lundi suivant

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Foyer : Camille et Julien (parents), Élodie (invitée secondaire), Léo (7 ans pour les devoirs) et Inès (9 ans). L'aide Devoirs est activée. */
async function family(options: { enabled?: boolean } = {}) {
  const camille = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: "Europe/Paris" }).where("id", "=", camille.accountId!).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const camilleSession = await sessionFor(db, camille.id);
  const julienSession = await sessionFor(db, julien.id);
  const elodieSession = await sessionFor(db, elodie.id);
  const leo = await addChild(ctx(), camilleSession, { firstName: "Léo" });
  const ines = await addChild(ctx(), camilleSession, { firstName: "Inès" });
  if (options.enabled !== false) {
    await setHomeworkEnabled(ctx(), camilleSession, { enabled: true, confirmed: true });
    await setHomeworkAge(ctx(), camilleSession, leo.id, 7);
    await setHomeworkAge(ctx(), camilleSession, ines.id, 9);
  }
  return { accountId: camille.accountId!, camilleSession, julienSession, elodieSession, leo: leo.id, ines: ines.id };
}
type Family = Awaited<ReturnType<typeof family>>;

const exercise = (textbook: string, level: string, index: number) =>
  db.selectFrom("homework_exercises").select(["id", "number"]).where("textbook_key", "=", textbook).where("level", "=", level as "ce1").orderBy("number").offset(index).limit(1).executeTakeFirstOrThrow();

/** Valide sur photos les `count` premiers exercices France du niveau (D65 : seules les photos valident). */
async function validateFrance(memberId: string, level: string, count: number) {
  const rows = await db.selectFrom("homework_exercises").select("id").where("textbook_key", "=", "france").where("level", "=", level as "ce1").orderBy("number").limit(count).execute();
  for (const r of rows) await db.insertInto("homework_exercise_validations").values({ member_id: memberId, exercise_id: r.id }).onConflict((oc) => oc.doNothing()).execute();
}

const franceBlock = async (f: Family, memberId: string) => (await childOptions(db, f.accountId, memberId)).blocks.find((b) => b.textbook === "france")!;

async function standardWeek(f: Family): Promise<{ weekId: string; input: WeekInput }> {
  const block = await franceBlock(f, f.leo);
  const input: WeekInput = {
    weekStart: WEEK, workDays: [1, 2, 3],
    children: [{ memberId: f.leo, items: [{ kind: "exercises", textbook: "france", numbers: block.numbers, days: [1] }, { kind: "custom", title: "Lecture 15 min", days: [1, 2] }] }],
  };
  const { weekId } = await prepareWeek(ctx(), f.camilleSession, input);
  return { weekId, input };
}

const tasksOf = (weekId: string) =>
  db.selectFrom("family_tasks").select(["title", "status", "assigned_member_id", "source"]).where("homework_week_id", "=", weekId).orderBy("due_date").execute();

describe("détection d'un devoir (US-119 RF1, RT1)", () => {
  it("repère « devoir » et « devoirs », sans tenir compte des majuscules ni des accents", () => {
    expect(["Devoirs de maths de Léo", "faire le DEVOIR", "Les dévoirs", "devoir"].map(titleMentionsHomework)).toEqual([true, true, true, true]);
    expect(["Dévouement", "Redevoir de l'argent", "Aller au parc"].map(titleMentionsHomework)).toEqual([false, false, false]);
  });

  it("CA 1.1 : la carte est proposée si l'aide est activée et qu'aucune semaine n'est préparée ; CA 1.2 : pas si une semaine l'est déjà", async () => {
    const f = await family();
    expect(await shouldOfferHomework(ctx(), f.camilleSession, { title: "Devoirs de maths de Léo", due: "2054-11-11" })).toBe(true);
    expect(await shouldOfferHomework(ctx(), f.camilleSession, { title: "Acheter du pain", due: "2054-11-11" })).toBe(false);
    await standardWeek(f);
    expect(await shouldOfferHomework(ctx(), f.camilleSession, { title: "Un autre devoir", due: "2054-11-12" })).toBe(false); // même semaine
    expect(await shouldOfferHomework(ctx(), f.camilleSession, { title: "Un autre devoir", due: "2054-11-17" })).toBe(true); // semaine suivante
  });

  it("CA 5.1 (US-118) : aide désactivée, la carte n'apparaît pas", async () => {
    const f = await family();
    await setHomeworkEnabled(ctx(), f.julienSession, { enabled: false });
    expect(await shouldOfferHomework(ctx(), f.camilleSession, { title: "Devoir de maths", due: "2054-11-11" })).toBe(false);
  });

  it("propose les lundis à venir : la semaine en cours puis les suivantes", () => {
    expect(upcomingMondays("2054-11-05", 3)).toEqual(["2054-11-02", "2054-11-09", "2054-11-16"]);
  });
});

describe("options proposées au parent (US-119 RF2, RF7)", () => {
  it("CA 2.2 : des blocs d'exercices du niveau de l'âge des devoirs (7 ans : CE1)", async () => {
    const f = await family();
    const options = await childOptions(db, f.accountId, f.leo);
    expect(options).toMatchObject({ level: "ce1", levelLabel: "CE1", homeworkAge: 7 });
    expect(options.blocks.length).toBe(5); // 25 exercices, blocs de 5
    expect(options.blocks.every((b) => b.textbook === "france" && b.state === "free")).toBe(true);
    const ce1 = (await exercise("france", "ce1", 0)).number;
    expect(options.blocks[0].from).toBe(ce1);
  });

  it("CA 7.1 : moins de la moitié validée, aucun manuel étranger n'est mentionné", async () => {
    const f = await family();
    await validateFrance(f.leo, "ce1", 12); // 12/25 : pas encore la moitié
    const options = await childOptions(db, f.accountId, f.leo);
    expect(options.progress).toMatchObject({ total: 25, validated: 12, foreignUnlocked: false });
    expect(JSON.stringify(options)).not.toMatch(/Singapour|Chine|singapore|china/i);
  });

  it("CA 7.2 : la moitié validée sur photos, un seul manuel étranger est proposé, présenté comme une nouveauté", async () => {
    const f = await family();
    await validateFrance(f.leo, "ce1", 13);
    const options = await childOptions(db, f.accountId, f.leo);
    expect(options.progress.foreignUnlocked).toBe(true);
    const books = [...new Set(options.blocks.map((b) => b.textbook))];
    expect(books).toHaveLength(2);
    expect(books[0]).toBe("france");
    expect(options.blocks.filter((b) => b.novelty).every((b) => b.textbook === books[1])).toBe(true);
  });

  it("une case cochée ne débloque rien : seules les photos valident (D65, CA 6.1)", async () => {
    const f = await family();
    const { weekId } = await standardWeek(f);
    const items = await db.selectFrom("homework_week_items").select("id").where("week_id", "=", weekId).where("exercise_id", "is not", null).execute();
    for (const item of items) await setItemChecked(ctx(), f.camilleSession, String(item.id), true);
    const options = await childOptions(db, f.accountId, f.leo, WEEK);
    expect(options.progress.validated).toBe(0);
    expect(options.blocks[0].counts).toEqual({ validated: 0, done: 5, planned: 5 });
    expect(options.blocks[0].state).toBe("done");
  });

  it("CA 7.3 : une semaine compte au plus deux manuels ; tous les exercices France validés en permettent plusieurs", async () => {
    const f = await family();
    await validateFrance(f.leo, "ce1", 13);
    const options = await childOptions(db, f.accountId, f.leo);
    const foreign = options.blocks.find((b) => b.novelty)!;
    const other = ["singapore", "china"].find((b) => b !== foreign.textbook)!;
    const otherNumber = (await exercise(other, "ce1", 0)).number;
    const base = { weekStart: WEEK, workDays: [1, 2] };
    const two = prepareWeek(ctx(), f.camilleSession, {
      ...base,
      children: [{ memberId: f.leo, items: [{ kind: "exercises", textbook: foreign.textbook, numbers: [foreign.from], days: [1] }, { kind: "exercises", textbook: other, numbers: [otherNumber], days: [2] }] }],
    });
    expect((await failure(two)).code).toBe("book_not_allowed");
    await validateFrance(f.leo, "ce1", 25);
    const all = await childOptions(db, f.accountId, f.leo);
    expect(all.progress.franceDone).toBe(true);
    expect(all.suggestOlderAge).toBe(true);
    expect([...new Set(all.blocks.map((b) => b.textbook))].sort()).toEqual(["china", "france", "singapore"]);
  });

  it("des activités à l'âge des devoirs, à un an près, avec ce qui demande un adulte ; les non faites d'abord", async () => {
    const f = await family();
    const list = await activityOptions(db, f.accountId, f.leo, "nature", 4);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.length).toBeLessThanOrEqual(4);
    const ages = await db.selectFrom("homework_activities").select(["id", "age"]).where("id", "in", list.map((a) => a.activityId)).execute();
    expect(ages.every((a) => Math.abs(a.age - 7) <= 1)).toBe(true);
    expect(new Set(list.map((a) => a.title)).size).toBe(list.length); // une seule ligne par activité
    // Une activité déjà prévue passe après les autres.
    await prepareWeek(ctx(), f.camilleSession, { weekStart: WEEK, workDays: [1], children: [{ memberId: f.leo, items: [{ kind: "activity", activityId: list[0].activityId, days: [1] }] }] });
    const after = await activityOptions(db, f.accountId, f.leo, "nature", 20);
    expect(after.find((a) => a.activityId === list[0].activityId)?.state).toBe("planned");
    expect(after[after.length - 1].state).toBe("planned");
  });

  it("un enfant sans âge des devoirs n'est pas proposé", async () => {
    const f = await family({ enabled: false });
    expect((await failure(childOptions(db, f.accountId, f.leo))).status).toBe(404);
  });
});

describe("préparer la semaine (US-119 RF4)", () => {
  it("CA 4.1 : une semaine, ses éléments, et une tâche « Devoirs — Léo (N éléments) » par jour de travail, assignée à l'enfant", async () => {
    const f = await family();
    const { weekId } = await standardWeek(f);
    const tasks = await tasksOf(weekId);
    expect(tasks.map((t) => open(t.title))).toEqual(["Devoirs — Léo (6 éléments)", "Devoirs — Léo (1 élément)"]);
    expect(tasks.every((t) => t.assigned_member_id === f.leo && t.source === "homework" && t.status === "todo")).toBe(true);
    const week = await getWeek(ctx(), f.julienSession, weekId); // l'autre parent la voit aussi
    expect(week).toMatchObject({ weekStart: WEEK, workDays: [1, 2, 3] });
    expect(week.children[0].items.filter((i) => i.day === 1)).toHaveLength(6);
    const exerciseItem = week.children[0].items.find((i) => i.kind === "exercise")!;
    expect(exerciseItem).toMatchObject({ source: expect.stringContaining("Manuel France CE1 · Ex"), checked: false });
    expect(exerciseItem.answer).toBeTruthy();
    expect(exerciseItem.statement).toBeTruthy(); // l'énoncé vient de la base (D66)
  });

  it("D66 : une activité du catalogue montre ses étapes, son matériel et sa carte, lus dans la base", async () => {
    const f = await family();
    const [first] = await activityOptions(db, f.accountId, f.leo, "nature", 1);
    const { weekId } = await prepareWeek(ctx(), f.camilleSession, { weekStart: WEEK, workDays: [1], children: [{ memberId: f.leo, items: [{ kind: "activity", activityId: first.activityId, days: [1] }] }] });
    const item = (await getWeek(ctx(), f.camilleSession, weekId)).children[0].items[0];
    expect(item).toMatchObject({ kind: "activity", needsAdult: first.needsAdult, card: first.card });
    expect(item.steps.length).toBeGreaterThan(0);
    expect(item.materials).toBeTruthy();
  });

  it("une seule semaine par semaine ; une semaine passée est refusée ; un lundi est exigé", async () => {
    const f = await family();
    const { input } = await standardWeek(f);
    expect((await failure(prepareWeek(ctx(), f.julienSession, input))).code).toBe("week_exists");
    expect((await failure(prepareWeek(ctx(), f.camilleSession, { ...input, weekStart: "2054-10-26" }))).code).toBe("past_week");
    expect((await failure(prepareWeek(ctx(), f.camilleSession, { ...input, weekStart: "2054-11-10" }))).code).toBe("invalid_week");
  });

  it("les éléments se placent sur les jours de travail, au niveau de l'enfant ; une semaine vide est refusée", async () => {
    const f = await family();
    const block = await franceBlock(f, f.leo);
    const base = { weekStart: WEEK, workDays: [1, 2] };
    expect((await failure(prepareWeek(ctx(), f.camilleSession, { ...base, children: [{ memberId: f.leo, items: [{ kind: "custom", title: "Lecture", days: [5] }] }] }))).code).toBe("invalid_day");
    const cm2 = await exercise("france", "cm2", 0);
    expect((await failure(prepareWeek(ctx(), f.camilleSession, { ...base, children: [{ memberId: f.leo, items: [{ kind: "exercises", textbook: "france", numbers: [cm2.number], days: [1] }] }] }))).code).toBe("invalid_exercise");
    expect((await failure(prepareWeek(ctx(), f.camilleSession, { ...base, children: [{ memberId: f.leo, items: [] }] }))).code).toBe("empty_week");
    expect((await failure(prepareWeek(ctx(), f.camilleSession, { ...base, children: [{ memberId: f.leo, items: [{ kind: "exercises", textbook: "singapore", numbers: [block.from], days: [1] }] }] }))).code).toBe("book_not_allowed");
    expect(await db.selectFrom("homework_weeks").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(0); // rien d'enregistré
  });

  it("plusieurs enfants dans la même semaine, chacun à son niveau", async () => {
    const f = await family();
    const leoBlock = await franceBlock(f, f.leo);
    const inesBlock = await franceBlock(f, f.ines);
    const { weekId } = await prepareWeek(ctx(), f.camilleSession, {
      weekStart: WEEK, workDays: [2, 4],
      children: [{ memberId: f.leo, items: [{ kind: "exercises", textbook: "france", numbers: leoBlock.numbers.slice(0, 2), days: [2] }] }, { memberId: f.ines, items: [{ kind: "exercises", textbook: "france", numbers: inesBlock.numbers.slice(0, 3), days: [4] }] }],
    });
    expect((await tasksOf(weekId)).map((t) => open(t.title))).toEqual(["Devoirs — Léo (2 éléments)", "Devoirs — Inès (3 éléments)"]);
    const week = await getWeek(ctx(), f.camilleSession, weekId);
    expect(week.children.map((c) => [c.firstName, c.levelLabel])).toEqual([["Léo", "CE1"], ["Inès", "CM1"]]);
  });

  it("réservé aux parents, et seulement si l'aide est activée", async () => {
    const f = await family();
    const input: WeekInput = { weekStart: WEEK, workDays: [1], children: [{ memberId: f.leo, items: [{ kind: "custom", title: "Lecture", days: [1] }] }] };
    expect((await failure(prepareWeek(ctx(), f.elodieSession, input))).status).toBe(403);
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: false });
    expect((await failure(prepareWeek(ctx(), f.camilleSession, input))).code).toBe("homework_disabled");
  });

  it("la liste des semaines montre les semaines préparées et les lundis à venir", async () => {
    const f = await family();
    await standardWeek(f);
    const list = await listWeeks(ctx(), f.julienSession);
    expect(list.weeks).toMatchObject([{ weekStart: WEEK, weekEnd: "2054-11-15", children: ["Léo"], items: 7 }]);
    expect(list.mondays.find((m) => m.weekStart === WEEK)?.prepared).toBe(true);
    expect(list.mondays.find((m) => m.weekStart === "2054-11-16")?.prepared).toBe(false);
  });
});

describe("modifier la semaine (US-119 RF4, RF6)", () => {
  it("cocher compte comme fait ; décocher le retire ; rien n'est validé", async () => {
    const f = await family();
    const { weekId } = await standardWeek(f);
    const item = (await getWeek(ctx(), f.camilleSession, weekId)).children[0].items[0];
    await setItemChecked(ctx(), f.julienSession, item.id, true);
    expect((await getWeek(ctx(), f.camilleSession, weekId)).children[0].items[0].checked).toBe(true);
    await setItemChecked(ctx(), f.julienSession, item.id, false);
    expect((await getWeek(ctx(), f.camilleSession, weekId)).children[0].items[0].checked).toBe(false);
    expect(await db.selectFrom("homework_exercise_validations").select("member_id").where("member_id", "=", f.leo).execute()).toHaveLength(0);
  });

  it("déplacer un élément d'un jour à l'autre met à jour les tâches ; retirer le dernier élément d'un jour retire la tâche", async () => {
    const f = await family();
    const { weekId } = await standardWeek(f);
    const day2 = (await getWeek(ctx(), f.camilleSession, weekId)).children[0].items.find((i) => i.day === 2)!;
    await moveItem(ctx(), f.camilleSession, day2.id, 3);
    expect((await tasksOf(weekId)).map((t) => open(t.title))).toEqual(["Devoirs — Léo (6 éléments)", "Devoirs — Léo (1 élément)"]);
    const due = await db.selectFrom("family_tasks").select(({ fn }) => fn.min("due_date").as("first")).where("homework_week_id", "=", weekId).executeTakeFirstOrThrow();
    expect(due.first).toBeTruthy();
    await removeItem(ctx(), f.camilleSession, day2.id);
    expect(await tasksOf(weekId)).toHaveLength(1);
    expect((await failure(moveItem(ctx(), f.camilleSession, day2.id, 1))).status).toBe(404);
  });

  it("déplacer sur un jour où le même exercice est déjà prévu : refus clair ; hors jours de travail : refus", async () => {
    const f = await family();
    const { weekId } = await standardWeek(f);
    const first = (await getWeek(ctx(), f.camilleSession, weekId)).children[0].items.find((i) => i.kind === "exercise")!;
    const number = (await franceBlock(f, f.leo)).numbers[0];
    await addItem(ctx(), f.camilleSession, weekId, f.leo, { kind: "exercises", textbook: "france", numbers: [number], days: [2] }); // le même exercice, le mardi
    expect((await failure(moveItem(ctx(), f.camilleSession, first.id, 2))).code).toBe("duplicate_item");
    expect((await failure(moveItem(ctx(), f.camilleSession, first.id, 6))).code).toBe("invalid_day");
  });

  it("ajouter une activité du parent ou un exercice du niveau à une semaine déjà préparée", async () => {
    const f = await family();
    const { weekId } = await standardWeek(f);
    await addItem(ctx(), f.camilleSession, weekId, f.leo, { kind: "custom", title: "Dessin libre", days: [3] });
    const block = (await franceBlock(f, f.leo)).numbers;
    await addItem(ctx(), f.camilleSession, weekId, f.leo, { kind: "exercises", textbook: "france", numbers: [block[0]], days: [3] });
    expect((await tasksOf(weekId)).map((t) => open(t.title))).toEqual(["Devoirs — Léo (6 éléments)", "Devoirs — Léo (1 élément)", "Devoirs — Léo (2 éléments)"]);
    expect((await failure(addItem(ctx(), f.camilleSession, weekId, f.leo, { kind: "custom", title: "x", days: [7] }))).code).toBe("invalid_day");
  });

  it("les titres d'activités du parent sont chiffrés en base", async () => {
    const f = await family();
    await standardWeek(f);
    const row = await db.selectFrom("homework_week_items").select("custom_title").where("account_id", "=", f.accountId).where("custom_title", "is not", null).executeTakeFirstOrThrow();
    expect(row.custom_title!.toString("utf8")).not.toContain("Lecture");
  });

  it("l'autre foyer ne voit ni ne modifie rien", async () => {
    const f = await family();
    const other = await family();
    const { weekId } = await standardWeek(f);
    const item = (await getWeek(ctx(), f.camilleSession, weekId)).children[0].items[0];
    expect((await failure(getWeek(ctx(), other.camilleSession, weekId))).status).toBe(404);
    expect((await failure(setItemChecked(ctx(), other.camilleSession, item.id, true))).status).toBe(404);
    expect((await failure(removeItem(ctx(), other.camilleSession, item.id))).status).toBe(404);
  });

  it("D65 : effacer l'enfant (retrait du membre) supprime ses éléments et ses tâches", async () => {
    const f = await family();
    const { weekId } = await standardWeek(f);
    await db.updateTable("family_members").set({ archived_at: new Date() }).where("id", "=", f.leo).execute();
    expect(await tasksOf(weekId)).toHaveLength(0);
    expect(await db.selectFrom("homework_week_items").select("id").where("member_id", "=", f.leo).execute()).toHaveLength(0);
    expect(await db.selectFrom("homework_children").select("member_id").where("member_id", "=", f.leo).execute()).toHaveLength(0);
  });
});
