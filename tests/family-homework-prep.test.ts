import { randomBytes, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATUS_CODE, TYPE_CODE } from "@/server/assistant/calendar";
import { listUpcoming } from "@/server/assistant/events";
import { addChild, familyOverview, setChildProfile } from "@/server/assistant/family";
import { seal } from "@/server/assistant/fields";
import { loadHomeworkCatalog } from "@/server/assistant/homework/catalog";
import { getHomeworkSetting, setHomeworkAge, setHomeworkDays, setHomeworkEnabled } from "@/server/assistant/homework/settings";
import { childOptions, getWeek, homeworkToday, listWeeks, prepareWeek, remainingDays, setItemChecked } from "@/server/assistant/homework/weeks";
import { profileMember } from "@/server/assistant/profile-member";
import { sendAssistantMessage } from "@/server/assistant/service";
import { assignTask, createTask, listTasks, setTaskDone, updateTask, type NewTask, type TaskView } from "@/server/assistant/tasks";
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

const NOW = new Date("2054-11-05T09:00:00Z"); // jeudi, un jour de devoirs par défaut
const TODAY = "2054-11-05";
const ctx = (): Ctx => ({ get db() { return db; }, now: NOW }) as Ctx;
const isoDay = (day: string) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Camille et Julien (parents), Élodie et Noé (invités secondaires), Léo (7 ans de devoirs) et Mia (sans âge des devoirs). */
async function family(options: { enabled?: boolean } = {}) {
  const camille = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: "Europe/Paris" }).where("id", "=", camille.accountId!).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const noe = await createGuest(db, camille.accountId!, "Noé");
  const camilleSession = await sessionFor(db, camille.id);
  const leo = await addChild(ctx(), camilleSession, { firstName: "Léo" });
  const mia = await addChild(ctx(), camilleSession, { firstName: "Mia" });
  if (options.enabled !== false) {
    await setHomeworkEnabled(ctx(), camilleSession, { enabled: true, confirmed: true });
    await setHomeworkAge(ctx(), camilleSession, leo.id, 7);
  }
  const memberOf = async (userId: string) => (await db.selectFrom("family_members").select("id").where("user_id", "=", userId).executeTakeFirstOrThrow()).id;
  return {
    accountId: camille.accountId!, camilleSession, julienSession: await sessionFor(db, julien.id), elodieSession: await sessionFor(db, elodie.id), noeSession: await sessionFor(db, noe.id),
    users: { camille: camille.id, julien: julien.id, elodie: elodie.id, noe: noe.id }, leo: leo.id, mia: mia.id, member: await memberOf(camille.id), elodieMember: await memberOf(elodie.id),
  };
}
type Family = Awaited<ReturnType<typeof family>>;

const prepInput = (over: Partial<NewTask> = {}): NewTask => ({ title: "Préparer les devoirs", due: TODAY, dueTime: "17:00", assigneeId: null, repetition: { frequency: "weekly", end: { kind: "never" } }, kind: "homework_prep", ...over });
const allTasks = async (f: Family, session = f.camilleSession, mine = false): Promise<TaskView[]> => {
  const l = await listTasks(ctx(), session, { mine });
  return [...l.overdue, ...l.today, ...l.upcoming, ...l.later];
};
const prepOf = async (f: Family, session = f.camilleSession, mine = false) => (await allTasks(f, session, mine)).filter((t) => t.isHomeworkPrep);

async function seedEvent(f: Family, s: { title: string; members?: string[]; allFamily?: boolean; inDays?: number }): Promise<string> {
  const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE.family).executeTakeFirstOrThrow();
  const start = new Date(NOW.getTime() + (s.inDays ?? 2) * 86_400_000);
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal(s.title), starts_at: start, ends_at: new Date(start.getTime() + 3_600_000), status: STATUS_CODE.confirmed, source: "chat_text", whole_family: s.allFamily ?? false,
      requested_by_user_id: f.users.camille, fingerprint: randomBytes(16), confirmed_at: NOW, confirmed_by_user_id: f.users.camille,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (!s.allFamily) await db.insertInto("family_event_members").values((s.members ?? [f.leo]).map((m) => ({ event_id: row.id, member_id: m, account_id: f.accountId }))).execute();
  return row.id;
}
const upcomingTitles = async (session: Family["camilleSession"]) => (await listUpcoming(ctx(), session, 50)).map((e) => e.title).sort();

describe("tâche du foyer « Préparer les devoirs » (D69, D71)", () => {
  it("création : les jours de devoirs du foyer à l'heure choisie, personne d'assigné, quoi qu'envoie le formulaire ; reconnue par sa source", async () => {
    const f = await family();
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).weeklyTask).toBeNull();
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).days).toEqual([1, 2, 4, 5]);
    // Le formulaire ne décide ni des jours, ni de l'assignation, ni du titre.
    const created = await createTask(ctx(), f.camilleSession, prepInput({ title: "Autre titre", assigneeId: f.member, repetition: { frequency: "weekly", weekdays: [7], end: { kind: "count", count: 2 } } }));
    expect(created).toMatchObject({ title: "Préparer les devoirs", isHomeworkPrep: true, assignee: null, dueTime: "17:00", homeworkPrep: { role: "parent" } });
    const series = await db.selectFrom("family_task_series").select(["source", "weekdays", "assigned_member_id", "repeat_unit", "repeat_interval", "end_kind"]).where("account_id", "=", f.accountId).execute();
    expect(series).toEqual([{ source: "homework_prep", weekdays: [1, 2, 4, 5], assigned_member_id: null, repeat_unit: "week", repeat_interval: 1, end_kind: "never" }]);
    const occurrences = await prepOf(f);
    expect(occurrences.length).toBeGreaterThan(4);
    expect([...new Set(occurrences.map((t) => isoDay(t.due)))].sort()).toEqual([1, 2, 4, 5]);
    expect(occurrences.every((t) => t.assignee === null && t.homeworkPrep?.role === "parent")).toBe(true);
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).weeklyTask).toEqual({ label: "les jours de devoirs à 17 h" });
    // Une tâche ordinaire du même titre n'est pas la tâche des devoirs : elle est reconnue par sa source, pas par son titre.
    const plain = await createTask(ctx(), f.camilleSession, { title: "Préparer les devoirs", due: "2054-11-12", assigneeId: null });
    expect(plain).toMatchObject({ isHomeworkPrep: false, homeworkPrep: null });
  });

  it("le titre est affiché d'après la source (S-44) : une ancienne tâche du dimanche prend le nouveau titre sans être réécrite ; la tâche n'est jamais assignée", async () => {
    const f = await family();
    await createTask(ctx(), f.camilleSession, prepInput({ dueTime: "18:30" }));
    await db.updateTable("family_tasks").set({ title: seal("Préparer les devoirs de la semaine") }).where("account_id", "=", f.accountId).where("source", "=", "homework_prep").execute();
    const first = (await prepOf(f))[0];
    expect(first.title).toBe("Préparer les devoirs");
    const updated = await updateTask(ctx(), f.camilleSession, first.id, { title: "Encore un autre titre", note: null, due: first.due, dueTime: "19:00", assigneeId: f.member }, { expectedVersion: first.version, scope: "all" });
    expect(updated).toMatchObject({ title: "Préparer les devoirs", dueTime: "19:00", assignee: null });
    expect((await failure(assignTask(ctx(), f.camilleSession, updated.id, f.member))).code).toBe("household_task");
  });

  it("une seule série active par foyer ; réservée aux parents et à une famille où l'aide est activée", async () => {
    const f = await family();
    await createTask(ctx(), f.camilleSession, prepInput());
    expect((await failure(createTask(ctx(), f.julienSession, prepInput()))).code).toBe("prep_exists");
    await db.updateTable("family_task_series").set({ ended_at: NOW }).where("account_id", "=", f.accountId).execute();
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).weeklyTask).toBeNull();
    await createTask(ctx(), f.julienSession, prepInput());
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).weeklyTask).not.toBeNull();
    expect((await failure(createTask(ctx(), f.elodieSession, prepInput()))).status).toBe(403);
    const off = await family({ enabled: false });
    expect((await failure(createTask(ctx(), off.camilleSession, prepInput()))).code).toBe("homework_disabled");
  });

  it("aide désactivée : la tâche reste dans la liste des parents, sans lien ; réactivée, le lien revient", async () => {
    const f = await family();
    await createTask(ctx(), f.camilleSession, prepInput());
    await setHomeworkEnabled(ctx(), f.julienSession, { enabled: false });
    const tasks = await prepOf(f);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.homeworkPrep === null)).toBe(true);
    await setHomeworkEnabled(ctx(), f.julienSession, { enabled: true });
    expect((await prepOf(f))[0].homeworkPrep).toEqual({ role: "parent" });
  });
});

describe("jours de devoirs (US-118 RF7, S-30, S-44)", () => {
  it("CA 7.1, CA 7.2 : sept cases, au moins un jour, les deux parents ; un invité secondaire lit sans modifier", async () => {
    const f = await family();
    expect((await getHomeworkSetting(ctx(), f.elodieSession))).toMatchObject({ days: [1, 2, 4, 5], canEdit: false });
    expect((await failure(setHomeworkDays(ctx(), f.camilleSession, []))).code).toBe("no_homework_day");
    expect((await failure(setHomeworkDays(ctx(), f.camilleSession, [0, 8]))).code).toBe("invalid_days");
    expect((await failure(setHomeworkDays(ctx(), f.elodieSession, [3]))).status).toBe(403);
    expect((await setHomeworkDays(ctx(), f.julienSession, [6, 3, 3])).days).toEqual([3, 6]);
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).days).toEqual([3, 6]);
  });

  it("un changement s'applique à la tâche : jours décochés retirés, jours ajoutés créés, heure gardée", async () => {
    const f = await family();
    await createTask(ctx(), f.camilleSession, prepInput({ dueTime: "18:30" }));
    await setHomeworkDays(ctx(), f.camilleSession, [3, 6]);
    const after = (await prepOf(f)).filter((t) => t.due > TODAY);
    expect(after.length).toBeGreaterThanOrEqual(4); // deux jours par semaine sur les 14 jours de « À venir »
    expect([...new Set(after.map((t) => isoDay(t.due)))].sort()).toEqual([3, 6]);
    expect(after.every((t) => t.dueTime === "18:30")).toBe(true);
    expect((await db.selectFrom("family_task_series").select("weekdays").where("account_id", "=", f.accountId).executeTakeFirstOrThrow()).weekdays).toEqual([3, 6]);
    // Sans tâche créée, le réglage s'enregistre seul ; la tâche créée ensuite prend ces jours.
    const g = await family();
    await setHomeworkDays(ctx(), g.camilleSession, [7]);
    await createTask(ctx(), g.camilleSession, prepInput());
    expect([...new Set((await prepOf(g)).map((t) => isoDay(t.due)))]).toEqual([7]);
  });
});

describe("profil de l'enfant (D73 S-38 à S-49)", () => {
  it("le lien : un invité secondaire du foyer, sur une fiche enfant, par un parent ; un profil pour un seul enfant ; le retrait du lien", async () => {
    const f = await family();
    expect((await familyOverview(ctx(), f.camilleSession)).profiles.map((p) => [p.firstName, p.memberId])).toEqual([["Élodie", null], ["Noé", null]]);
    expect((await failure(setChildProfile(ctx(), f.elodieSession, f.leo, f.users.elodie))).status).toBe(403);
    expect((await failure(setChildProfile(ctx(), f.camilleSession, f.leo, f.users.julien))).code).toBe("invalid_profile");
    expect((await failure(setChildProfile(ctx(), f.camilleSession, f.member, f.users.elodie))).code).toBe("not_a_child");
    expect((await setChildProfile(ctx(), f.camilleSession, f.leo, f.users.elodie)).profile).toEqual({ userId: f.users.elodie, firstName: "Élodie" });
    expect((await failure(setChildProfile(ctx(), f.julienSession, f.mia, f.users.elodie))).code).toBe("profile_taken");
    expect(await profileMember(db, f.accountId, f.users.elodie)).toEqual({ memberId: f.leo, child: true });
    expect(await profileMember(db, f.accountId, f.users.noe)).toMatchObject({ child: false });
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).children.map((c) => [c.firstName, c.hasProfile])).toEqual([["Léo", true], ["Mia", false]]);
    expect((await setChildProfile(ctx(), f.julienSession, f.leo, null)).profile).toBeNull();
    expect(await profileMember(db, f.accountId, f.users.elodie)).toEqual({ memberId: f.elodieMember, child: false });
  });

  it("CA 1.2, S-31, S-40, S-41 : l'enfant voit la tâche des devoirs sans qu'elle lui soit assignée, ne la coche pas, et la garde dans « Mes tâches »", async () => {
    const f = await family();
    await createTask(ctx(), f.camilleSession, prepInput());
    expect(await prepOf(f, f.elodieSession)).toEqual([]);
    await setChildProfile(ctx(), f.camilleSession, f.leo, f.users.elodie);
    const seen = await prepOf(f, f.elodieSession);
    expect(seen.length).toBeGreaterThan(4);
    expect(seen.every((t) => t.homeworkPrep?.role === "child" && !t.can.check && !t.can.manage)).toBe(true);
    expect((await prepOf(f, f.elodieSession, true)).length).toBe(seen.length);
    expect((await listTasks(ctx(), f.elodieSession)).viewer).toMatchObject({ parent: false, child: true, memberId: f.leo });
    expect((await failure(setTaskDone(ctx(), f.elodieSession, seen[0].id, true))).status).toBe(403);
    // Un parent la coche : elle reste lisible par l'enfant, cochée.
    const done = await setTaskDone(ctx(), f.camilleSession, seen[0].id, true);
    expect(done.status).toBe("done");
    expect((await listTasks(ctx(), f.elodieSession)).done.map((t) => t.id)).toContain(seen[0].id);
    // Un autre invité secondaire ne la voit pas ; un enfant sans âge des devoirs non plus.
    expect(await prepOf(f, f.noeSession)).toEqual([]);
    await setChildProfile(ctx(), f.camilleSession, f.mia, f.users.noe);
    expect(await prepOf(f, f.noeSession)).toEqual([]);
    // Aide désactivée : les enfants ne la voient plus (RF1).
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: false });
    expect(await prepOf(f, f.elodieSession)).toEqual([]);
  });

  it("S-45 : l'enfant relié ne voit que les RDV où il est nommé, jamais ceux de toute la famille ; un autre invité secondaire garde la règle d'avant", async () => {
    const f = await family();
    await seedEvent(f, { title: "Repas de famille", allFamily: true });
    await seedEvent(f, { title: "Judo de Léo", members: [f.leo] });
    await seedEvent(f, { title: "Danse de Mia", members: [f.mia] });
    expect(await upcomingTitles(f.elodieSession)).toEqual(["Repas de famille"]);
    await setChildProfile(ctx(), f.camilleSession, f.leo, f.users.elodie);
    expect(await upcomingTitles(f.elodieSession)).toEqual(["Judo de Léo"]);
    expect(await upcomingTitles(f.noeSession)).toEqual(["Repas de famille"]);
    expect(await upcomingTitles(f.camilleSession)).toEqual(["Danse de Mia", "Judo de Léo", "Repas de famille"]);
    // La base applique la même règle (fonction de visibilité).
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from family_events_visible_to(${f.users.elodie}::uuid)`.execute(db);
    expect(rows[0].n).toBe(1);
  });

  it("S-39, S-46, S-49 : la fiche « autre » est masquée, ses RDV et ses tâches passent sur la fiche enfant sans doublon, et l'enfant garde ses tâches à lui", async () => {
    const f = await family();
    // Avant le lien : une tâche assignée à la fiche « autre » d'Élodie, et deux RDV où elle figure (dont un où Léo figure déjà).
    const own = await createTask(ctx(), f.elodieSession, { title: "Ranger ma chambre", due: "2054-11-07", assigneeId: f.elodieMember });
    const past = await createTask(ctx(), f.elodieSession, { title: "Arroser les plantes", due: "2054-11-06", assigneeId: f.elodieMember });
    await setTaskDone(ctx(), f.elodieSession, past.id, true);
    const judo = await seedEvent(f, { title: "Judo", members: [f.leo, f.elodieMember] });
    const piscine = await seedEvent(f, { title: "Piscine", members: [f.elodieMember] });
    expect((await listTasks(ctx(), f.camilleSession)).assignable.map((m) => m.firstName)).toContain("Élodie");
    await setChildProfile(ctx(), f.camilleSession, f.leo, f.users.elodie);
    const participants = async (id: string) => (await db.selectFrom("family_event_members").select("member_id").where("event_id", "=", id).execute()).map((r) => r.member_id);
    expect(await participants(judo)).toEqual([f.leo]);
    expect(await participants(piscine)).toEqual([f.leo]);
    expect((await allTasks(f, f.camilleSession)).find((t) => t.id === own.id)?.assignee).toMatchObject({ id: f.leo, firstName: "Léo" });
    // Les tâches déjà faites suivent : « Faite par Léo », assignée à sa fiche.
    expect(await db.selectFrom("family_tasks").select(["assigned_member_id", "done_by_member_id"]).where("id", "=", past.id).executeTakeFirstOrThrow()).toEqual({ assigned_member_id: f.leo, done_by_member_id: f.leo });
    expect(await db.selectFrom("family_tasks").select("id").where("account_id", "=", f.accountId).where((eb) => eb.or([eb("assigned_member_id", "=", f.elodieMember), eb("done_by_member_id", "=", f.elodieMember)])).execute()).toEqual([]);
    // La fiche masquée n'est plus proposée ; la base refuse qu'on la vise.
    expect((await listTasks(ctx(), f.camilleSession)).assignable.map((m) => m.id)).not.toContain(f.elodieMember);
    expect((await failure(createTask(ctx(), f.camilleSession, { title: "Tâche", due: "2054-11-07", assigneeId: f.elodieMember }))).code).toBe("invalid_assignee");
    await expect(db.insertInto("family_event_members").values({ event_id: judo, member_id: f.elodieMember, account_id: f.accountId }).execute()).rejects.toThrow(/masquée/);
    // L'enfant crée une tâche pour lui-même : elle est posée sur sa fiche enfant, et il la coche (S-46).
    expect((await listTasks(ctx(), f.elodieSession)).assignable.map((m) => m.id)).toEqual([f.leo]);
    const mine = await createTask(ctx(), f.elodieSession, { title: "Préparer mon cartable", due: "2054-11-06", assigneeId: f.leo });
    expect(mine.assignee?.id).toBe(f.leo);
    expect((await failure(createTask(ctx(), f.elodieSession, { title: "Pour Mia", due: "2054-11-06", assigneeId: f.mia }))).status).toBe(403);
    expect((await setTaskDone(ctx(), f.elodieSession, mine.id, true)).doneBy).toBe("Léo");
    // Une tâche qu'un parent assigne à Léo est une tâche de l'enfant.
    const fromParent = await createTask(ctx(), f.camilleSession, { title: "Mettre la table", due: "2054-11-06", assigneeId: f.leo });
    expect((await allTasks(f, f.elodieSession, true)).map((t) => t.id)).toContain(fromParent.id);
  });

  it("S-47 : le tchat de l'Assistant Famille est refusé au profil d'un enfant, côté serveur", async () => {
    const f = await family();
    await setChildProfile(ctx(), f.camilleSession, f.leo, f.users.elodie);
    expect((await failure(sendAssistantMessage(ctx(), f.elodieSession, { requestId: randomUUID(), text: "Ajoute un rendez-vous" }))).status).toBe(403);
  });
});

describe("planning du jour et préparation à tout moment (US-119 RF1, RF11)", () => {
  async function weekOfToday(f: Family) {
    const block = (await childOptions(db, f.accountId, f.leo)).blocks[0];
    // Jeudi 05/11 : seuls jeudi et vendredi restent, les jours passés ne sont pas touchés.
    return prepareWeek(ctx(), f.camilleSession, {
      weekStart: "2054-11-02", workDays: [1, 2, 4, 5],
      children: [{ memberId: f.leo, items: [{ kind: "exercises", textbook: "france", numbers: block.numbers.slice(0, 3), days: [4] }, { kind: "custom", title: "Lecture 15 min", days: [4, 5] }] }],
    });
  }

  it("préparer la semaine en cours ne touche pas aux jours déjà passés ; une semaine déjà préparée est signalée avec son identifiant (CA 1.3, CA 1.4)", async () => {
    const f = await family();
    expect(remainingDays("2054-11-02", [1, 2, 4, 5], TODAY)).toEqual([4, 5]);
    expect(remainingDays("2054-11-09", [1, 2, 4, 5], TODAY)).toEqual([1, 2, 4, 5]);
    const block = (await childOptions(db, f.accountId, f.leo)).blocks[0];
    const item = (days: number[]) => ({ weekStart: "2054-11-02", workDays: [1, 2, 4, 5], children: [{ memberId: f.leo, items: [{ kind: "exercises" as const, textbook: "france", numbers: block.numbers, days }] }] });
    expect((await failure(prepareWeek(ctx(), f.camilleSession, item([1])))).code).toBe("invalid_day");
    expect((await failure(prepareWeek(ctx(), f.camilleSession, { ...item([1]), workDays: [1, 2] }))).code).toBe("no_day_left");
    const { weekId } = await weekOfToday(f);
    expect((await getWeek(ctx(), f.camilleSession, weekId)).workDays).toEqual([4, 5]);
    const mondays = (await listWeeks(ctx(), f.julienSession)).mondays;
    expect(mondays.map((m) => m.weekStart)).toEqual(["2054-11-02", "2054-11-09", "2054-11-16", "2054-11-23", "2054-11-30"]);
    expect(mondays[0]).toEqual({ weekStart: "2054-11-02", prepared: true, weekId });
    expect(mondays[1]).toEqual({ weekStart: "2054-11-09", prepared: false, weekId: null });
    // Aucune tâche « Devoirs — Léo » : le planning s'ouvre depuis la tâche du foyer (CA 4.1).
    expect(await db.selectFrom("family_tasks").select("id").where("account_id", "=", f.accountId).where("source", "=", "homework").execute()).toEqual([]);
  });

  it("le parent voit le planning du jour de chaque enfant ; l'enfant, le sien seul, en lecture seule ; les autres profils sont refusés", async () => {
    const f = await family();
    const { weekId } = await weekOfToday(f);
    const parent = await homeworkToday(ctx(), f.julienSession);
    if (parent.role !== "parent") throw new Error("vue parent attendue");
    expect(parent).toMatchObject({ today: TODAY, days: [1, 2, 4, 5] });
    expect(parent.children.map((c) => [c.firstName, c.homeworkAge, c.levelLabel, c.hasProfile, c.weekId])).toEqual([["Léo", 7, "CE1", false, weekId]]);
    expect(parent.children[0].items.map((i) => [i.title.split(" · ")[0], i.domain])).toEqual([[expect.stringMatching(/^Ex \d+ à \d+$/), "maths"], ["Lecture 15 min", "perso"]]);
    expect(parent.children[0].items[0].sub).toMatch(/^Maths · /);
    // Sans profil relié, un invité secondaire est refusé.
    expect((await failure(homeworkToday(ctx(), f.elodieSession))).status).toBe(403);
    await setChildProfile(ctx(), f.camilleSession, f.leo, f.users.elodie);
    const child = await homeworkToday(ctx(), f.elodieSession);
    if (child.role !== "child") throw new Error("vue enfant attendue");
    expect(child).toMatchObject({ role: "child", firstName: "Léo", today: TODAY });
    expect(child.items.map((i) => i.childTitle)).toEqual([expect.stringMatching(/^Exercices \d+ à \d+$/), "Lecture 15 min"]);
    expect(JSON.stringify(child)).not.toMatch(/corrig|answer/i);
    // Lecture seule : ni la semaine des parents, ni le cochage de ses éléments (S-40).
    expect((await failure(getWeek(ctx(), f.elodieSession, weekId))).status).toBe(403);
    const first = (await getWeek(ctx(), f.camilleSession, weekId)).children[0].items[0];
    expect((await failure(setItemChecked(ctx(), f.elodieSession, first.id, true))).status).toBe(403);
    expect((await homeworkToday(ctx(), f.camilleSession)).role).toBe("parent");
    expect((await failure(homeworkToday(ctx(), f.noeSession))).status).toBe(403);
    // Aide désactivée : plus de planning, pour personne.
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: false });
    expect((await failure(homeworkToday(ctx(), f.elodieSession))).code).toBe("homework_disabled");
  });
});
