import { randomBytes, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATUS_CODE, TYPE_CODE, type EventStatus, type EventType } from "@/server/assistant/calendar";
import { cancelEvent, confirmEvent, getEvent, updateEvent } from "@/server/assistant/events";
import { addEventTask, removeEventTask, updateEventTask } from "@/server/assistant/event-tasks";
import { loadAgentDefinition } from "@/server/assistant/agent";
import { addChild, listFamilyMembers, loadPseudoMembers, removeMember } from "@/server/assistant/family";
import { open, seal } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import { Pseudonymizer } from "@/server/assistant/pseudonymize";
import { createSeries, type SeriesRule } from "@/server/assistant/series";
import { completeTaskSeries, shiftRule, taskRepetitionOf, ruleFromTaskRepetition } from "@/server/assistant/task-series";
import { assignTask, cancelTask, createTask, getTask, listTasks, listTasksBetween, setTaskDone, updateTask, type NewTask } from "@/server/assistant/tasks";
import { executeTool, type ToolContext } from "@/server/assistant/tools";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createGuest, createProfile, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

// Lundi 2 novembre 2054, 09:00 à Paris (dates décalées de 28 ans : mêmes jours de semaine, toujours dans le futur de l'horloge de la base).
const NOW = new Date("2054-11-02T08:00:00Z");
const TZ = "Europe/Paris";
const at = (now = NOW): Ctx => ({ db, now });

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Foyer : Sophie (principale), Marc (invité core), Élodie (invitée secondaire), Léo et Mia (enfants). */
async function family() {
  const primary = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Sophie" }).where("id", "=", primary.id).execute();
  const marc = await createGuest(db, primary.accountId!, "Marc", "core");
  const elodie = await createGuest(db, primary.accountId!, "Élodie");
  const sophieSession = await sessionFor(db, primary.id);
  const leo = await addChild(at(), sophieSession, { firstName: "Léo", birth: "2046-06" });
  const mia = await addChild(at(), sophieSession, { firstName: "Mia", birth: "2049-02" });
  const members = await listFamilyMembers(at(), sophieSession);
  const elodieMember = await db.selectFrom("family_members").select("id").where("user_id", "=", elodie.id).executeTakeFirstOrThrow();
  return {
    accountId: primary.accountId!, sophie: sophieSession, marc: await sessionFor(db, marc.id), elodie: await sessionFor(db, elodie.id),
    ids: { sophie: members.find((m) => m.firstName === "Sophie")!.id, marc: members.find((m) => m.firstName === "Marc")!.id, elodie: elodieMember.id, leo: leo.id, mia: mia.id },
    userIds: { sophie: primary.id, marc: marc.id, elodie: elodie.id },
  };
}
type Family = Awaited<ReturnType<typeof family>>;

async function seed(f: Family, s: { start: string; end?: string; status?: EventStatus; type?: EventType; members?: string[]; by?: string | null }): Promise<string> {
  const status = STATUS_CODE[s.status ?? "provisional"];
  const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE[s.type ?? "family"]).executeTakeFirstOrThrow();
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal("Anniversaire de Mia"), starts_at: localToUtc(s.start, TZ), ends_at: localToUtc(s.end ?? s.start.replace(/T(\d\d):/, (_m, h: string) => `T${String(Number(h) + 2).padStart(2, "0")}:`), TZ),
      status, source: "chat_text", whole_family: false, requested_by_user_id: s.by === undefined ? f.userIds.sophie : s.by, fingerprint: randomBytes(16),
      ...(status === "confirmed" || status === "cancelled" ? { confirmed_at: NOW, confirmed_by_user_id: f.userIds.sophie } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.insertInto("family_event_members").values((s.members ?? [f.ids.mia]).map((m) => ({ event_id: row.id, member_id: m, account_id: f.accountId }))).execute();
  return row.id;
}

const weeklyOn = (...weekdays: number[]): NewTask["repetition"] => ({ frequency: "weekly", weekdays, end: { kind: "never" } });
const dues = async (accountId: string, seriesId?: string) => {
  let q = db.selectFrom("family_tasks").select(["status", "cancel_reason"]).select((eb) => eb.fn<string>("to_char", ["due_date", eb.val("YYYY-MM-DD")]).as("day")).where("account_id", "=", accountId).orderBy("due_date");
  if (seriesId) q = q.where("series_id", "=", seriesId);
  return q.execute();
};

// ---------------------------------------------------------------------------------------------------------------------------
describe("tâche seule (US-110)", () => {
  it("classe les tâches en retard, du jour et à venir sur 14 jours (CA 6.1)", async () => {
    const f = await family();
    await createTask(at(), f.sophie, { title: "Payer la cantine", due: "2054-11-05" });
    await createTask(at(), f.sophie, { title: "Rappeler l'école", due: "2054-11-02", dueTime: "08:15" }); // 8 h 15 : déjà passée à 9 h
    await createTask(at(), f.sophie, { title: "Acheter du pain", due: "2054-11-02", dueTime: "18:00" });
    await createTask(at(), f.sophie, { title: "Renvoyer le dossier", due: "2054-10-30" });
    await createTask(at(), f.sophie, { title: "Réserver les vacances", due: "2054-12-30" });
    const lists = await listTasks(at(), f.sophie);
    expect(lists.overdue.map((t) => t.title)).toEqual(["Renvoyer le dossier", "Rappeler l'école"]);
    expect(lists.today.map((t) => t.title)).toEqual(["Acheter du pain"]);
    expect(lists.upcoming.map((t) => t.title)).toEqual(["Payer la cantine"]);
    expect(lists.overdue.every((t) => t.overdue && t.status === "todo")).toBe(true);
    expect(lists.today[0].dueTime).toBe("18:00");
    expect(lists.todayDate).toBe("2054-11-02");
  });

  it("exige un titre de 100 caractères au plus, une note de 500, une échéance et une heure valides (CA 2.1)", async () => {
    const f = await family();
    expect((await failure(createTask(at(), f.sophie, { title: "  ", due: "2054-11-05" }))).code).toBe("invalid_title");
    expect((await failure(createTask(at(), f.sophie, { title: "x".repeat(101), due: "2054-11-05" }))).code).toBe("invalid_title");
    expect((await failure(createTask(at(), f.sophie, { title: "Ok", note: "x".repeat(501), due: "2054-11-05" }))).code).toBe("invalid_notes");
    expect((await failure(createTask(at(), f.sophie, { title: "Ok", due: "2054-02-30" }))).code).toBe("invalid_date");
    expect((await failure(createTask(at(), f.sophie, { title: "Ok", due: "2054-11-05", dueTime: "25:00" }))).code).toBe("invalid_time");
    const ok = await createTask(at(), f.sophie, { title: "x".repeat(100), note: "y".repeat(500), due: "2054-11-05" });
    expect(ok.note).toHaveLength(500);
  });

  it("garde titre et note chiffrés en base", async () => {
    const f = await family();
    const task = await createTask(at(), f.sophie, { title: "Payer la cantine de Léo", note: "Chèque", due: "2054-11-05" });
    const row = await db.selectFrom("family_tasks").select(["title", "note"]).where("id", "=", task.id).executeTakeFirstOrThrow();
    expect(row.title.toString("utf8")).not.toContain("cantine");
    expect(row.note!.toString("utf8")).not.toContain("Chèque");
  });

  it("se coche avec « Faite par », se décoche, et reste consultable 30 jours dans « Faites » (CA 7.1, 7.2, 8.1)", async () => {
    const f = await family();
    const task = await createTask(at(), f.sophie, { title: "Acheter du pain", due: "2054-11-02", assigneeId: f.ids.marc });
    const done = await setTaskDone(at(), f.marc, task.id, true);
    expect(done.status).toBe("done");
    expect(done.doneBy).toBe("Marc");
    const lists = await listTasks(at(), f.sophie);
    expect(lists.today).toHaveLength(0);
    expect(lists.done.map((t) => t.title)).toEqual(["Acheter du pain"]);
    const back = await setTaskDone(at(), f.marc, task.id, false);
    expect(back.status).toBe("todo");
    expect(back.doneBy).toBeNull();
    expect((await listTasks(at(), f.sophie)).today).toHaveLength(1);
    // Une tâche faite il y a plus de 30 jours n'est plus dans la liste.
    await setTaskDone(at(), f.marc, task.id, true);
    await db.updateTable("family_tasks").set({ done_at: new Date(Date.now() - 31 * 86_400_000) }).where("id", "=", task.id).execute();
    expect((await listTasks(at(), f.sophie)).done).toHaveLength(0);
  });

  it("refuse un cochage fondé sur une version périmée, et une tâche déjà annulée", async () => {
    const f = await family();
    const task = await createTask(at(), f.sophie, { title: "Acheter du pain", due: "2054-11-02" });
    await setTaskDone(at(), f.sophie, task.id, true);
    expect((await failure(setTaskDone(at(), f.marc, task.id, false, { expectedVersion: task.version }))).code).toBe("stale_version");
    await setTaskDone(at(), f.sophie, task.id, false);
    await cancelTask(at(), f.sophie, task.id);
    expect((await failure(setTaskDone(at(), f.sophie, task.id, true))).code).toBe("not_found"); // une tâche annulée ne s'affiche plus
  });

  it("se modifie et s'annule (« Annuler la tâche »)", async () => {
    const f = await family();
    const task = await createTask(at(), f.sophie, { title: "Payer la cantine", due: "2054-11-05" });
    const edited = await updateTask(at(), f.sophie, task.id, { title: "Payer la cantine de novembre", due: "2054-11-06", dueTime: "08:15", note: "Chèque" }, { expectedVersion: task.version });
    expect(edited).toMatchObject({ title: "Payer la cantine de novembre", due: "2054-11-06", dueTime: "08:15", note: "Chèque" });
    expect((await failure(updateTask(at(), f.sophie, task.id, { title: "Autre", due: "2054-11-06" }, { expectedVersion: task.version }))).code).toBe("stale_version");
    const cancelled = await cancelTask(at(), f.sophie, task.id, { expectedVersion: edited.version });
    expect(cancelled).toMatchObject({ status: "cancelled", cancelled: 1 });
    expect((await listTasks(at(), f.sophie)).upcoming).toHaveLength(0);
    expect((await failure(cancelTask(at(), f.sophie, task.id))).code).toBe("not_found");
  });

  it("ne montre une tâche non assignée à personne en retard qu'en gris : l'affichage « En retard » n'est pas un statut (AT-1, AT-9)", async () => {
    const f = await family();
    const task = await createTask(at(), f.sophie, { title: "Renvoyer le dossier", due: "2054-10-30" });
    expect(task.status).toBe("todo");
    expect(task.overdue).toBe(true);
    const row = await db.selectFrom("family_tasks").select("status").where("id", "=", task.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("todo"); // jamais stocké comme statut
  });

  it("les tâches à faire de la vue Jour et des vues Semaine et Mois tiennent compte de la période (CA 9.1)", async () => {
    const f = await family();
    await createTask(at(), f.sophie, { title: "Mercredi", due: "2054-11-04" });
    await createTask(at(), f.sophie, { title: "Jeudi", due: "2054-11-05" });
    const done = await createTask(at(), f.sophie, { title: "Faite mercredi", due: "2054-11-04" });
    await setTaskDone(at(), f.sophie, done.id, true);
    const day = await listTasksBetween(at(), f.sophie, { from: "2054-11-04", to: "2054-11-04" });
    expect(day.map((t) => t.title).sort()).toEqual(["Faite mercredi", "Mercredi"]);
    expect((await failure(listTasksBetween(at(), f.sophie, { from: "2054-11-04", to: "2054-11-03" }))).code).toBe("invalid_range");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("tâche récurrente (US-110 RF3 à RF5, RF11, RT2)", () => {
  it("crée les occurrences des 8 prochaines semaines, chacune cochée séparément (CA 3.1, 4.1)", async () => {
    const f = await family();
    const first = await createTask(at(), f.sophie, { title: "Sortir les poubelles", due: "2054-11-03", dueTime: "20:00", repetition: weeklyOn(2) });
    expect(first).toMatchObject({ due: "2054-11-03", recurring: true, rule: "Chaque mardi", dueTime: "20:00" });
    const series = (await db.selectFrom("family_tasks").select("series_id").where("id", "=", first.id).executeTakeFirstOrThrow()).series_id!;
    expect((await dues(f.accountId, series)).map((t) => t.day)).toEqual(["2054-11-03", "2054-11-10", "2054-11-17", "2054-11-24", "2054-12-01", "2054-12-08", "2054-12-15", "2054-12-22"]);
    await setTaskDone(at(), f.sophie, first.id, true);
    const later = new Date("2054-11-09T08:00:00Z");
    const lists = await listTasks(at(later), f.sophie);
    expect(lists.today.map((t) => t.due)).toEqual([]); // mardi 10 : l'occurrence est à 20 h, pas encore en retard
    expect(lists.upcoming.map((t) => t.due)).toEqual(["2054-11-10", "2054-11-17"]);
    expect(lists.done).toHaveLength(1);
  });

  it("une règle qui commence avant aujourd'hui démarre à sa prochaine date, jamais dans le passé", async () => {
    const f = await family();
    const first = await createTask(at(), f.sophie, { title: "Poubelles", due: "2054-10-20", repetition: weeklyOn(2) });
    expect(first.due).toBe("2054-11-03");
  });

  it("chaque jour, toutes les deux semaines, chaque mois, avec une fin à une date ou après N fois", async () => {
    const f = await family();
    const daily = await createTask(at(), f.sophie, { title: "Vitamines", due: "2054-11-02", repetition: { frequency: "daily", end: { kind: "date", date: "2054-11-06" } } });
    expect(daily.rule).toBe("Chaque jour jusqu'au 06/11/2054");
    expect(daily.repetition?.frequency).toBe("daily");
    const series = (await db.selectFrom("family_tasks").select("series_id").where("id", "=", daily.id).executeTakeFirstOrThrow()).series_id!;
    expect(await dues(f.accountId, series)).toHaveLength(5);
    const biweekly = await createTask(at(), f.sophie, { title: "Draps", due: "2054-11-04", repetition: { frequency: "biweekly", end: { kind: "count", count: 3 } } });
    const s2 = (await db.selectFrom("family_tasks").select("series_id").where("id", "=", biweekly.id).executeTakeFirstOrThrow()).series_id!;
    expect((await dues(f.accountId, s2)).map((t) => t.day)).toEqual(["2054-11-04", "2054-11-18", "2054-12-02"]);
    const monthly = await createTask(at(), f.sophie, { title: "Loyer", due: "2054-11-05", repetition: { frequency: "monthly_day", end: { kind: "never" } } });
    expect(monthly.rule).toBe("Chaque mois le 5");
    expect((await failure(createTask(at(), f.sophie, { title: "X", due: "2054-11-05", repetition: { frequency: "weekly", end: { kind: "date", date: "2054-11-01" } } }))).code).toBe("invalid_repetition");
  });

  it("« Cette fois » ne change qu'une occurrence ; « cette fois et les suivantes » décale la règle, les passées restent (CA 5.1)", async () => {
    const f = await family();
    const first = await createTask(at(), f.sophie, { title: "Sortir les poubelles", due: "2054-11-03", repetition: weeklyOn(2) });
    const series = (await db.selectFrom("family_tasks").select("series_id").where("id", "=", first.id).executeTakeFirstOrThrow()).series_id!;
    const third = await db.selectFrom("family_tasks").select(["id", "version"]).where("series_id", "=", series).where("due_date", "=", "2054-11-17" as unknown as Date).executeTakeFirstOrThrow();

    // Cette fois : la troisième occurrence passe au 18, les autres ne bougent pas.
    const once = await updateTask(at(), f.sophie, third.id, { title: "Sortir les poubelles", due: "2054-11-18" }, { expectedVersion: third.version, scope: "this" });
    expect(once.due).toBe("2054-11-18");
    expect((await dues(f.accountId, series)).slice(0, 4).map((t) => t.day)).toEqual(["2054-11-03", "2054-11-10", "2054-11-18", "2054-11-24"]);

    // Cette fois et les suivantes, depuis la quatrième : mercredi.
    const fourth = await db.selectFrom("family_tasks").select(["id", "version"]).where("series_id", "=", series).where("due_date", "=", "2054-11-24" as unknown as Date).executeTakeFirstOrThrow();
    const moved = await updateTask(at(), f.sophie, fourth.id, { title: "Sortir les poubelles", due: "2054-11-25" }, { expectedVersion: fourth.version, scope: "following" });
    expect(moved.due).toBe("2054-11-25");
    expect(moved.rule).toBe("Chaque mercredi");
    const all = await dues(f.accountId);
    expect(all.slice(0, 4).map((t) => t.day)).toEqual(["2054-11-03", "2054-11-10", "2054-11-18", "2054-11-25"]);
    expect(all.slice(3).every((t) => new Date(`${t.day}T00:00:00Z`).getUTCDay() === 3)).toBe(true);
    // L'ancienne règle s'arrête la veille de l'occurrence déplacée.
    const old = await sql<{ until: string }>`select until_date::text as until from family_task_series where id = ${series}::uuid`.execute(db);
    expect(old.rows[0].until).toBe("2054-11-23");
  });

  it("« Toutes » remplace le modèle des occurrences à venir et laisse les passées (RF5)", async () => {
    const f = await family();
    const first = await createTask(at(), f.sophie, { title: "Sortir les poubelles", due: "2054-11-03", repetition: weeklyOn(2) });
    const series = (await db.selectFrom("family_tasks").select("series_id").where("id", "=", first.id).executeTakeFirstOrThrow()).series_id!;
    const later = new Date("2054-11-12T08:00:00Z"); // vendredi 12 : l'occurrence du 10 est en retard, celles à partir du 17 sont à venir
    const next = await db.selectFrom("family_tasks").select(["id", "version"]).where("series_id", "=", series).where("due_date", "=", "2054-11-17" as unknown as Date).executeTakeFirstOrThrow();
    // La séance du 1er décembre a déjà été modifiée seule : « Toutes » n'y touche pas (D47, D61). Celle du 8 est déplacée au 9.
    const special = await db.selectFrom("family_tasks").select(["id", "version"]).where("series_id", "=", series).where("due_date", "=", "2054-12-01" as unknown as Date).executeTakeFirstOrThrow();
    await updateTask(at(later), f.sophie, special.id, { title: "Bac spécial", due: "2054-12-01" }, { expectedVersion: special.version, scope: "this" });
    const moved = await db.selectFrom("family_tasks").select(["id", "version"]).where("series_id", "=", series).where("due_date", "=", "2054-12-08" as unknown as Date).executeTakeFirstOrThrow();
    await updateTask(at(later), f.sophie, moved.id, { title: "Sortir les poubelles", due: "2054-12-09" }, { expectedVersion: moved.version, scope: "this" });
    const changed = await updateTask(at(later), f.sophie, next.id, { title: "Sortir les bacs", due: "2054-11-17", dueTime: "19:00", assigneeId: f.ids.marc }, { expectedVersion: next.version, scope: "all" });
    expect(changed).toMatchObject({ title: "Sortir les bacs", dueTime: "19:00", rule: "Chaque mardi" });
    const titles = await db.selectFrom("family_tasks").select(["title", "assigned_member_id"]).select((eb) => eb.fn<string>("to_char", ["due_date", eb.val("YYYY-MM-DD")]).as("day")).where("series_id", "=", series).orderBy("due_date").execute();
    expect(titles[0].assigned_member_id).toBeNull(); // 3/11 : passée, intacte
    const kept = titles.filter((t) => t.day === "2054-12-01" || t.day === "2054-12-09");
    expect(kept).toHaveLength(2); // les deux occurrences déjà modifiées seules sont intactes
    expect(open(kept[0].title)).toBe("Bac spécial");
    expect(kept.every((t) => t.assigned_member_id === null)).toBe(true);
    const followed = titles.filter((t) => t.day >= "2054-11-17" && !kept.includes(t));
    expect(followed.length).toBeGreaterThan(3);
    expect(followed.every((t) => t.assigned_member_id === f.ids.marc && open(t.title) === "Sortir les bacs")).toBe(true);
    // Rien n'est dupliqué : une occurrence déplacée ne redonne pas une occurrence à sa date d'origine.
    expect(titles.filter((t) => t.day === "2054-12-08")).toHaveLength(0);
  });

  it("annule une occurrence, les suivantes ou toute la tâche (RF5)", async () => {
    const f = await family();
    const first = await createTask(at(), f.sophie, { title: "Poubelles", due: "2054-11-03", repetition: weeklyOn(2) });
    const series = (await db.selectFrom("family_tasks").select("series_id").where("id", "=", first.id).executeTakeFirstOrThrow()).series_id!;
    const at3 = await db.selectFrom("family_tasks").select("id").where("series_id", "=", series).where("due_date", "=", "2054-11-17" as unknown as Date).executeTakeFirstOrThrow();
    const only = await cancelTask(at(), f.sophie, at3.id, { scope: "this" });
    expect(only.cancelled).toBe(1);
    const following = await db.selectFrom("family_tasks").select("id").where("series_id", "=", series).where("due_date", "=", "2054-12-01" as unknown as Date).executeTakeFirstOrThrow();
    const rest = await cancelTask(at(), f.sophie, following.id, { scope: "following" });
    expect(rest.cancelled).toBe(4); // 1/12, 8/12, 15/12, 22/12
    const left = (await dues(f.accountId, series)).filter((t) => t.status === "todo").map((t) => t.day);
    expect(left).toEqual(["2054-11-03", "2054-11-10", "2054-11-24"]);
    const all = await cancelTask(at(), f.sophie, (await db.selectFrom("family_tasks").select("id").where("series_id", "=", series).where("status", "=", "todo").orderBy("due_date").executeTakeFirstOrThrow()).id, { scope: "all" });
    expect(all.cancelled).toBe(3);
    expect((await listTasks(at(), f.sophie)).upcoming).toHaveLength(0);
    const ended = await db.selectFrom("family_task_series").select("ended_at").where("id", "=", series).executeTakeFirstOrThrow();
    expect(ended.ended_at).not.toBeNull();
  });

  it("au plus 50 tâches récurrentes actives, les terminées ne comptent pas (CA 11.1)", async () => {
    const f = await family();
    for (let i = 0; i < 50; i++) {
      await db.insertInto("family_task_series").values({ account_id: f.accountId, title: seal(`Tâche ${i}`), first_date: "2054-11-03", repeat_unit: "week", weekdays: [2], created_by_user_id: f.userIds.sophie }).execute();
    }
    const refused = await failure(createTask(at(), f.sophie, { title: "De trop", due: "2054-11-03", repetition: weeklyOn(2) }));
    expect(refused.message).toBe("Nombre maximal de tâches récurrentes atteint (50).");
    await db.updateTable("family_task_series").set({ ended_at: NOW }).where("id", "=", (await db.selectFrom("family_task_series").select("id").where("account_id", "=", f.accountId).limit(1).executeTakeFirstOrThrow()).id).execute();
    await createTask(at(), f.sophie, { title: "Cette fois", due: "2054-11-03", repetition: weeklyOn(2) });
  });

  it("le planificateur complète vers l'avant sans doublon et termine une règle arrivée à sa fin (RT2)", async () => {
    const f = await family();
    const first = await createTask(at(), f.sophie, { title: "Poubelles", due: "2054-11-03", repetition: weeklyOn(2) });
    const series = (await db.selectFrom("family_tasks").select("series_id").where("id", "=", first.id).executeTakeFirstOrThrow()).series_id!;
    const in4Weeks = new Date("2054-11-30T08:00:00Z");
    const done = await completeTaskSeries(db, in4Weeks, { accountId: f.accountId });
    expect(done.created).toBe(4); // 29/12, 5/1, 12/1, 19/1
    expect((await completeTaskSeries(db, in4Weeks, { accountId: f.accountId })).created).toBe(0);
    expect(await dues(f.accountId, series)).toHaveLength(12);
    // Règle finie : une tâche en 3 fois est terminée quand sa dernière occurrence est passée.
    const short = await createTask(at(), f.sophie, { title: "Trois fois", due: "2054-11-03", repetition: { frequency: "weekly", end: { kind: "count", count: 3 } } });
    const s2 = (await db.selectFrom("family_tasks").select("series_id").where("id", "=", short.id).executeTakeFirstOrThrow()).series_id!;
    await completeTaskSeries(db, new Date("2054-11-20T08:00:00Z"), { accountId: f.accountId });
    expect((await db.selectFrom("family_task_series").select("ended_at").where("id", "=", s2).executeTakeFirstOrThrow()).ended_at).not.toBeNull();
  });

  it("les règles se décalent avec la date déplacée", () => {
    const rule = ruleFromTaskRepetition({ frequency: "weekly", weekdays: [2, 5], end: { kind: "never" } }, "2054-11-03");
    expect(shiftRule(rule, "2054-11-03", "2054-11-04").weekdays).toEqual([3, 6]);
    expect(shiftRule(rule, "2054-11-06", "2054-11-02").weekdays).toEqual([1, 5]); // vendredi → lundi : quatre jours en arrière, par-dessus le début de semaine
    expect(taskRepetitionOf(rule).frequency).toBe("weekly");
    const monthly = ruleFromTaskRepetition({ frequency: "monthly_day", end: { kind: "never" } }, "2054-11-05");
    expect(shiftRule(monthly, "2054-11-05", "2054-11-08").monthDay).toBe(8);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("droits et assignation (AT-2, AT-3, US-96)", () => {
  it("un invité secondaire ne voit que ses tâches, celles qui lui sont assignées et celles des RDV qu'il voit (AT-2)", async () => {
    const f = await family();
    const parentsTask = await createTask(at(), f.sophie, { title: "Des parents", due: "2054-11-03" });
    await createTask(at(), f.sophie, { title: "Pour Élodie", due: "2054-11-03", assigneeId: f.ids.elodie });
    await createTask(at(), f.elodie, { title: "À moi", due: "2054-11-04" });
    const mine = await listTasks(at(), f.elodie);
    expect(mine.upcoming.map((t) => t.title).sort()).toEqual(["Pour Élodie", "À moi"]);
    const parents = await listTasks(at(), f.sophie);
    expect(parents.upcoming).toHaveLength(3);
    expect((await listTasks(at(), f.marc)).upcoming).toHaveLength(3);
    expect((await failure(getTask(at(), f.elodie, parentsTask.id))).code).toBe("not_found");
  });

  it("« Mes tâches » ne garde que les tâches assignées au membre du profil (CA 6.2)", async () => {
    const f = await family();
    await createTask(at(), f.sophie, { title: "Pour Sophie", due: "2054-11-03", assigneeId: f.ids.sophie });
    await createTask(at(), f.sophie, { title: "Pour Marc", due: "2054-11-03", assigneeId: f.ids.marc });
    await createTask(at(), f.sophie, { title: "Pour personne", due: "2054-11-03" });
    expect((await listTasks(at(), f.sophie, { mine: true })).upcoming.map((t) => t.title)).toEqual(["Pour Sophie"]);
    expect((await listTasks(at(), f.marc, { mine: true })).upcoming.map((t) => t.title)).toEqual(["Pour Marc"]);
    expect((await listTasks(at(), f.marc)).upcoming).toHaveLength(3);
  });

  it("un invité secondaire coche ses tâches, ne modifie que les siennes et n'assigne qu'à lui-même (RF3)", async () => {
    const f = await family();
    const given = await createTask(at(), f.sophie, { title: "Pour Élodie", due: "2054-11-03", assigneeId: f.ids.elodie });
    expect((await setTaskDone(at(), f.elodie, given.id, true)).doneBy).toBe("Élodie");
    expect((await failure(updateTask(at(), f.elodie, given.id, { title: "Autre", due: "2054-11-03" }, { expectedVersion: given.version }))).code).toBe("forbidden"); // assignée mais pas créée par elle
    const own = await createTask(at(), f.elodie, { title: "À moi", due: "2054-11-04" });
    expect((await failure(createTask(at(), f.elodie, { title: "Pour Léo", due: "2054-11-04", assigneeId: f.ids.leo }))).code).toBe("forbidden");
    expect((await assignTask(at(), f.elodie, own.id, f.ids.elodie)).assignee?.firstName).toBe("Élodie");
    expect((await failure(assignTask(at(), f.elodie, own.id, f.ids.marc))).code).toBe("forbidden");
    expect((await assignTask(at(), f.elodie, own.id, null)).assignee).toBeNull();
    const parentTask = await createTask(at(), f.sophie, { title: "Des parents", due: "2054-11-03", assigneeId: f.ids.elodie });
    expect((await failure(assignTask(at(), f.elodie, parentTask.id, null))).code).toBe("forbidden");
  });

  it("les parents assignent et réassignent toute tâche ; un enfant sans compte a ses tâches suivies par les deux parents (AT-3, CA 3.1, 5.1)", async () => {
    const f = await family();
    const task = await createTask(at(), f.sophie, { title: "Préparer son sac", due: "2054-11-03", assigneeId: f.ids.mia });
    expect(task.assignee).toMatchObject({ firstName: "Mia", role: "child" });
    expect((await listTasks(at(), f.sophie)).upcoming).toHaveLength(1);
    expect((await listTasks(at(), f.marc)).upcoming).toHaveLength(1);
    const moved = await assignTask(at(), f.marc, task.id, f.ids.marc, { expectedVersion: task.version });
    expect(moved.assignee?.firstName).toBe("Marc");
    expect(moved.assignee?.color).toMatch(/^#/);
    expect((await failure(assignTask(at(), f.marc, task.id, f.ids.sophie, { expectedVersion: task.version }))).code).toBe("stale_version");
    expect((await assignTask(at(), f.marc, task.id, null)).assignee).toBeNull();
  });

  it("n'assigne qu'à un membre actif de la même famille (RT2)", async () => {
    const f = await family();
    const other = await family();
    const task = await createTask(at(), f.sophie, { title: "Pain", due: "2054-11-03" });
    expect((await failure(assignTask(at(), f.sophie, task.id, other.ids.leo))).code).toBe("invalid_assignee");
    await removeMember(at(), f.sophie, f.ids.leo);
    expect((await failure(assignTask(at(), f.sophie, task.id, f.ids.leo))).code).toBe("invalid_assignee");
  });

  it("un membre retiré laisse ses tâches à faire « non assignées » (RF8, CA 8.1)", async () => {
    const f = await family();
    await createTask(at(), f.sophie, { title: "Un", due: "2054-11-03", assigneeId: f.ids.leo });
    const faite = await createTask(at(), f.sophie, { title: "Deux", due: "2054-11-03", assigneeId: f.ids.leo });
    await createTask(at(), f.sophie, { title: "Trois", due: "2054-11-03", assigneeId: f.ids.mia });
    await setTaskDone(at(), f.sophie, faite.id, true);
    await removeMember(at(), f.sophie, f.ids.leo);
    const lists = await listTasks(at(), f.sophie);
    expect(lists.upcoming.map((t) => [t.title, t.assignee?.firstName ?? null]).sort()).toEqual([["Trois", "Mia"], ["Un", null]]);
    expect(lists.done[0].assignee?.firstName).toBe("Léo"); // une tâche faite garde son assigné
  });

});

// ---------------------------------------------------------------------------------------------------------------------------
describe("tâches préparatoires d'un RDV (US-95)", () => {
  it("sont proposées avec le RDV provisoire, retenues à sa confirmation (CA 4.1, RF4, RT2)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-07T15:00" });
    await addEventTask(at(), f.sophie, event, { title: "Envoyer les invitations", daysBefore: 3, assigneeId: f.ids.sophie });
    await addEventTask(at(), f.sophie, event, { title: "Acheter un cadeau", daysBefore: 1 });
    const detail = await getEvent(at(), f.sophie, event);
    expect(detail.tasks?.items.map((t) => [t.title, t.status, t.due, t.relative])).toEqual([["Envoyer les invitations", "proposed", "2054-11-04", "3 jours avant"], ["Acheter un cadeau", "proposed", "2054-11-06", "La veille"]]);
    // Les tâches proposées ne figurent pas dans l'écran « Tâches » tant que le RDV n'est pas confirmé.
    expect((await listTasks(at(), f.sophie)).upcoming).toHaveLength(0);
    await confirmEvent(at(), f.sophie, event, { expectedVersion: detail.version });
    const lists = await listTasks(at(), f.sophie);
    expect(lists.upcoming.map((t) => [t.title, t.status, t.event?.id === event])).toEqual([["Envoyer les invitations", "todo", true], ["Acheter un cadeau", "todo", true]]);
    expect(lists.upcoming[0].assignee?.firstName).toBe("Sophie");
  });

  it("la liste proposée fait monter la version du RDV : une carte périmée est refusée (CA 5.2, RF5, D51)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-07T15:00" });
    await addEventTask(at(), f.sophie, event, { title: "Cadeau", daysBefore: 2 });
    await addEventTask(at(), f.sophie, event, { title: "Gâteau", daysBefore: 1 });
    await addEventTask(at(), f.sophie, event, { title: "Salle", daysBefore: 3 });
    const shown = await getEvent(at(), f.marc, event);
    expect(shown.tasks?.items).toHaveLength(3);
    const removed = shown.tasks!.items.find((t) => t.title === "Gâteau")!;
    await removeEventTask(at(), f.sophie, event, removed.id);
    const refused = await failure(confirmEvent(at(), f.marc, event, { expectedVersion: shown.version }));
    expect(refused.code).toBe("stale_version");
    const fresh = await getEvent(at(), f.marc, event);
    expect(fresh.tasks?.items).toHaveLength(2);
    await confirmEvent(at(), f.marc, event, { expectedVersion: fresh.version });
    expect((await listTasks(at(), f.sophie)).upcoming.map((t) => t.title).sort()).toEqual(["Cadeau", "Salle"]);
  });

  it("« Confirmer sans les tâches » enregistre le RDV seul (CA 4.2)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-07T15:00" });
    await addEventTask(at(), f.sophie, event, { title: "Cadeau", daysBefore: 2 });
    const shown = await getEvent(at(), f.sophie, event);
    const confirmed = await confirmEvent(at(), f.sophie, event, { expectedVersion: shown.version, withoutTasks: true });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.tasks?.items).toEqual([]);
    expect((await dues(f.accountId))).toHaveLength(0);
  });

  it("une tâche se modifie : titre, échéance relative et personne (CA 3.3)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-07T15:00" });
    await addEventTask(at(), f.sophie, event, { title: "Acheter un cadeau", daysBefore: 3, assigneeId: f.ids.marc });
    const item = (await getEvent(at(), f.sophie, event)).tasks!.items[0];
    await updateEventTask(at(), f.sophie, event, item.id, { title: "Acheter un cadeau", daysBefore: 1, assigneeId: f.ids.sophie });
    const after = (await getEvent(at(), f.sophie, event)).tasks!.items[0];
    expect(after).toMatchObject({ relative: "La veille", due: "2054-11-06" });
    expect(after.assignee?.firstName).toBe("Sophie");
    // Une date choisie à la main ne suit pas le RDV.
    await updateEventTask(at(), f.sophie, event, item.id, { title: "Acheter un cadeau", due: "2054-11-05" });
    expect((await getEvent(at(), f.sophie, event)).tasks!.items[0]).toMatchObject({ due: "2054-11-05", relative: null, daysBefore: null });
  });

  it("refuse une échéance passée ou après le RDV (CA 3.4, RF3 bis)", async () => {
    const f = await family();
    const soon = await seed(f, { start: "2054-11-05T15:00" }); // dans 3 jours
    expect((await failure(addEventTask(at(), f.sophie, soon, { title: "Invitations", daysBefore: 7 }))).code).toBe("due_past");
    expect((await failure(addEventTask(at(), f.sophie, soon, { title: "Invitations", due: "2054-11-01" }))).code).toBe("due_past");
    expect((await failure(addEventTask(at(), f.sophie, soon, { title: "Invitations", due: "2054-11-06" }))).code).toBe("due_after_event");
    expect((await failure(addEventTask(at(), f.sophie, soon, { title: "Invitations" }))).code).toBe("invalid_date");
    await addEventTask(at(), f.sophie, soon, { title: "Invitations", daysBefore: 3 }); // aujourd'hui : permis
    await addEventTask(at(), f.sophie, soon, { title: "Gâteau", due: "2054-11-05" });
    expect((await getEvent(at(), f.sophie, soon)).tasks?.items.map((t) => t.due)).toEqual(["2054-11-02", "2054-11-05"]);
  });

  it("une échéance devenue passée avant la confirmation est ramenée au jour de la confirmation (RF3 bis)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-07T15:00" });
    await addEventTask(at(), f.sophie, event, { title: "Invitations", daysBefore: 3 }); // 4/11
    const shown = await getEvent(at(), f.sophie, event);
    // Entre la proposition et la confirmation, l'échéance est devenue passée pour l'horloge de la base (déclencheurs contournés pour simuler le temps).
    await db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await trx.updateTable("family_tasks").set({ due_date: "2020-01-01" as unknown as Date }).where("event_id", "=", event).execute();
    });
    await confirmEvent(at(), f.sophie, event, { expectedVersion: shown.version });
    const row = await db.selectFrom("family_tasks").select(["status"]).select((eb) => eb.fn<string>("to_char", ["due_date", eb.val("YYYY-MM-DD")]).as("day")).where("event_id", "=", event).executeTakeFirstOrThrow();
    expect(row.status).toBe("todo");
    expect(row.day >= new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)).toBe(true); // ramenée au jour de la confirmation, jamais en retard
  });

  it("au plus 10 tâches par RDV (CA 11.1, RF11)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-12T15:00" });
    for (let i = 1; i <= 10; i++) await addEventTask(at(), f.sophie, event, { title: `Tâche ${i}`, daysBefore: 1 });
    const detail = await getEvent(at(), f.sophie, event);
    expect(detail.tasks).toMatchObject({ limit: 10, reached: true });
    const refused = await failure(addEventTask(at(), f.sophie, event, { title: "De trop", daysBefore: 1 }));
    expect(refused.message).toBe("Nombre maximal de tâches pour ce RDV atteint (10).");
    // Retirer une tâche libère une place.
    await removeEventTask(at(), f.sophie, event, detail.tasks!.items[0].id);
    await addEventTask(at(), f.sophie, event, { title: "Onzième", daysBefore: 1 });
  });

  it("après la confirmation, « + Tâche » ajoute une tâche à faire liée au RDV (CA 8.1, RF8)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-07T15:00", status: "confirmed" });
    await addEventTask(at(), f.sophie, event, { title: "Réserver la salle", daysBefore: 2 });
    const lists = await listTasks(at(), f.sophie);
    expect(lists.upcoming).toHaveLength(1);
    expect(lists.upcoming[0]).toMatchObject({ title: "Réserver la salle", status: "todo", daysBefore: 2, due: "2054-11-05" });
    // Retirer une tâche à faire l'annule.
    const item = (await getEvent(at(), f.sophie, event)).tasks!.items[0];
    await removeEventTask(at(), f.sophie, event, item.id);
    expect((await listTasks(at(), f.sophie)).upcoming).toHaveLength(0);
  });

  it("suivent le RDV déplacé en gardant l'écart (CA 9.1, RF9)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-07T15:00", end: "2054-11-07T17:00", status: "confirmed" });
    await addEventTask(at(), f.sophie, event, { title: "Acheter un cadeau", daysBefore: 3 });
    const detail = await getEvent(at(), f.sophie, event);
    await updateEvent(at(), f.sophie, event, { title: "Anniversaire de Mia", type: "family", allFamily: false, memberIds: [f.ids.mia], start: "2054-11-08T15:00", end: "2054-11-08T17:00", allDay: false }, { expectedVersion: detail.version });
    expect((await listTasks(at(), f.sophie)).upcoming[0].due).toBe("2054-11-05");
  });

  it("sont annulées avec le RDV, et le nombre de tâches retirées est rendu (CA 10.1, RF10)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-07T15:00", status: "confirmed" });
    await addEventTask(at(), f.sophie, event, { title: "Cadeau", daysBefore: 2 });
    await addEventTask(at(), f.sophie, event, { title: "Gâteau", daysBefore: 1 });
    const result = await cancelEvent(at(), f.sophie, event);
    expect(result.retiredTasks).toBe(2);
    const rows = await db.selectFrom("family_tasks").select(["status", "cancel_reason"]).where("event_id", "=", event).execute();
    expect(rows).toEqual([{ status: "cancelled", cancel_reason: "event_cancelled" }, { status: "cancelled", cancel_reason: "event_cancelled" }]);
    expect((await listTasks(at(), f.sophie)).upcoming).toHaveLength(0);
  });

  it("un RDV écarté garde ses tâches proposées ; ignoré, il les abandonne (RF6, CA 6.1, 6.2)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-07T15:00", status: "set_aside" });
    await addEventTask(at(), f.sophie, event, { title: "Cadeau", daysBefore: 2 });
    expect((await getEvent(at(), f.sophie, event)).tasks?.items).toHaveLength(1);
    await sql`select change_family_event_status(${event}::uuid, 'dismissed'::event_status, ${f.userIds.sophie}::uuid)`.execute(db);
    const rows = await db.selectFrom("family_tasks").select(["status", "cancel_reason"]).where("event_id", "=", event).execute();
    expect(rows).toEqual([{ status: "cancelled", cancel_reason: "event_cancelled" }]);
    expect((await listTasks(at(), f.sophie)).upcoming).toHaveLength(0);
  });

  it("l'enregistrement sans réponse promeut les tâches proposées avec le RDV (CA 16.1, D49)", async () => {
    const f = await family();
    const event = await seed(f, { start: "2054-11-07T15:00" });
    await addEventTask(at(), f.sophie, event, { title: "Cadeau", daysBefore: 2 });
    await sql`select change_family_event_status(${event}::uuid, 'confirmed'::event_status, null, null, 'no_response'::event_change_reason)`.execute(db);
    expect((await listTasks(at(), f.sophie)).upcoming.map((t) => t.status)).toEqual(["todo"]);
  });

  it("un invité secondaire ajuste les tâches de ses propres demandes seulement (RF15, CA 15.1)", async () => {
    const f = await family();
    const own = await seed(f, { start: "2054-11-07T15:00", members: [f.ids.elodie], by: f.userIds.elodie });
    await addEventTask(at(), f.elodie, own, { title: "Sac", daysBefore: 1, assigneeId: f.ids.elodie });
    const parents = await seed(f, { start: "2054-11-08T15:00", members: [f.ids.elodie] });
    expect((await failure(addEventTask(at(), f.elodie, parents, { title: "Sac", daysBefore: 1 }))).code).toBe("forbidden");
    const hidden = await seed(f, { start: "2054-11-09T15:00", members: [f.ids.leo] });
    expect((await failure(addEventTask(at(), f.elodie, hidden, { title: "Sac", daysBefore: 1 }))).code).toBe("not_found");
  });

  it("refuse une tâche sur un RDV passé ou annulé", async () => {
    const f = await family();
    const past = await seed(f, { start: "2054-11-01T15:00", status: "confirmed" });
    expect((await failure(addEventTask(at(), f.sophie, past, { title: "Trop tard", daysBefore: 0 }))).code).toBe("event_past");
    const gone = await seed(f, { start: "2054-11-07T15:00", status: "canceled" });
    expect((await failure(addEventTask(at(), f.sophie, gone, { title: "Annulé", daysBefore: 1 }))).code).toBe("event_closed");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("tâches d'une série de RDV (US-95 RF12, D48)", () => {
  const thursday: SeriesRule = { unit: "week", interval: 1, weekdays: [4], end: { kind: "count", count: 4 }, skipSchoolHolidays: false };
  const base = (f: Family) => ({ accountId: f.accountId, userId: f.userIds.sophie, type: "personal" as const, title: "Piscine", place: null, notes: null, startTime: "17:30", durationMinutes: 60, allDay: false, allFamily: false, memberIds: [f.ids.mia], firstDate: "2054-11-05", rule: thursday, timeZone: TZ, source: "typed" as const, now: NOW });

  it("le modèle est proposé une fois avec la série, puis une occurrence par séance à la confirmation (CA 12.1)", async () => {
    const f = await family();
    const { seriesId, eventIds } = await createSeries(db, base(f));
    await addEventTask(at(), f.sophie, eventIds[0], { title: "Préparer le sac de piscine", daysBefore: 1 });
    const detail = await getEvent(at(), f.sophie, eventIds[0]);
    expect(detail.tasks).toMatchObject({ perSession: true });
    expect(detail.tasks?.items).toEqual([expect.objectContaining({ kind: "template", status: "proposed", relative: "La veille", due: null })]);
    // Aucune occurrence tant que la série n'est pas confirmée.
    expect(await dues(f.accountId)).toHaveLength(0);
    await confirmEvent(at(), f.sophie, eventIds[0], { expectedVersion: detail.version });
    const lists = await listTasks(at(), f.sophie);
    expect(lists.upcoming.map((t) => t.due)).toEqual(["2054-11-04", "2054-11-11"]);
    expect((await dues(f.accountId)).map((t) => t.day)).toEqual(["2054-11-04", "2054-11-11", "2054-11-18", "2054-11-25"]);
    expect(lists.upcoming[0]).toMatchObject({ title: "Préparer le sac de piscine", followsEventSeries: true, recurring: true, rule: null });
    // Une occurrence se coche seule.
    await setTaskDone(at(), f.sophie, lists.upcoming[0].id, true);
    expect((await dues(f.accountId)).filter((t) => t.status === "done")).toHaveLength(1);
    // Le modèle compte dans les 10 tâches de la série, pas dans les 50 tâches récurrentes.
    expect((await failure(updateTask(at(), f.sophie, lists.upcoming[1].id, { title: "x", due: "2054-11-12" }, { expectedVersion: lists.upcoming[1].version, scope: "all" }))).code).toBe("scope_not_allowed");
    const planner = await completeTaskSeries(db, NOW, { accountId: f.accountId });
    expect(planner.created).toBe(0);
    expect(seriesId).toBeTruthy();
  });

  it("« Confirmer sans les tâches » abandonne les modèles proposés ; un RDV devenu série garde ses tâches proposées", async () => {
    const f = await family();
    const { eventIds } = await createSeries(db, base(f));
    await addEventTask(at(), f.sophie, eventIds[0], { title: "Sac", daysBefore: 1 });
    const detail = await getEvent(at(), f.sophie, eventIds[0]);
    await confirmEvent(at(), f.sophie, eventIds[0], { expectedVersion: detail.version, withoutTasks: true });
    expect(await dues(f.accountId)).toHaveLength(0);
    // Un RDV provisoire qui devient une série emporte ses tâches proposées comme modèles.
    const single = await seed(f, { start: "2054-11-13T10:00", members: [f.ids.mia] });
    await addEventTask(at(), f.sophie, single, { title: "Gourde", daysBefore: 1 });
    const shown = await getEvent(at(), f.sophie, single);
    const turned = await updateEvent(at(), f.sophie, single, { title: "Natation", type: "personal", allFamily: false, memberIds: [f.ids.mia], start: "2054-11-13T10:00", end: "2054-11-13T11:00", allDay: false, repetition: { frequency: "weekly", end: { kind: "count", count: 3 } } }, { expectedVersion: shown.version });
    expect(turned.tasks?.items).toEqual([expect.objectContaining({ kind: "template", title: "Gourde", relative: "La veille" })]);
  });

  it("retirer un modèle de série confirmée annule ses occurrences à venir", async () => {
    const f = await family();
    const { eventIds } = await createSeries(db, base(f));
    await addEventTask(at(), f.sophie, eventIds[0], { title: "Sac", daysBefore: 1 });
    const detail = await getEvent(at(), f.sophie, eventIds[0]);
    await confirmEvent(at(), f.sophie, eventIds[0], { expectedVersion: detail.version });
    const template = (await getEvent(at(), f.sophie, eventIds[0])).tasks!.items[0];
    await updateEventTask(at(), f.sophie, eventIds[0], template.id, { title: "Sac de piscine", daysBefore: 2 });
    expect((await dues(f.accountId)).map((t) => t.day)).toEqual(["2054-11-03", "2054-11-10", "2054-11-17", "2054-11-24"]);
    await removeEventTask(at(), f.sophie, eventIds[0], template.id);
    expect((await dues(f.accountId)).every((t) => t.status === "cancelled")).toBe(true);
    expect((await getEvent(at(), f.sophie, eventIds[0])).tasks?.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("l'agent et les tâches (US-95 RF1, RT1, RT5 ; US-110 RF1)", () => {
  async function tools(f: Family): Promise<ToolContext> {
    const pseudo = new Pseudonymizer(await loadPseudoMembers(db, f.accountId));
    return { db, accountId: f.accountId, userId: f.userIds.sophie, authorMemberId: f.ids.sophie, timeZone: TZ, now: NOW, requestId: randomUUID(), source: "typed", pseudo, created: { ids: [] }, proposals: [] };
  }
  const birthday = { titre: "Anniversaire de Mia", type: "familial", debut: "2054-11-07T15:00", fin: "2054-11-07T17:00", journee_entiere: false, membres: ["Enfant 2"], source: "saisie" };

  it("propose les tâches avec le RDV, au statut « proposée » ; une échéance déjà passée est ignorée et signalée (CA 1.1, CA 3.4)", async () => {
    const f = await family();
    const ctxTools = await tools(f);
    const result = await executeTool("creer_evenement_provisoire", { ...birthday, taches: [
      { titre: "Envoyer les invitations", echeance: "3_jours_avant", membre: "Parent 1" },
      { titre: "Acheter un cadeau", echeance: "la_veille" },
      { titre: "Commander le gâteau", echeance: "1_semaine_avant" },
    ] }, ctxTools);
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.content);
    expect(body).toMatchObject({ statut: "provisoire", taches: 2 });
    expect(body.taches_ignorees).toEqual([{ echeance_jours_avant: 7, raison: "Cette échéance est déjà passée." }]);
    const detail = await getEvent(at(), f.sophie, ctxTools.created.ids[0]);
    expect(detail.tasks?.items.map((t) => [t.title, t.status, t.due, t.assignee?.firstName ?? null])).toEqual([["Envoyer les invitations", "proposed", "2054-11-04", "Sophie"], ["Acheter un cadeau", "proposed", "2054-11-06", null]]);
    // La même demande rejouée ne double pas la liste.
    const again = await executeTool("creer_evenement_provisoire", { ...birthday, taches: [{ titre: "Acheter un cadeau", echeance: "la_veille" }] }, ctxTools);
    expect(JSON.parse(again.content).taches).toBe(0);
    expect((await getEvent(at(), f.sophie, ctxTools.created.ids[0])).tasks?.items).toHaveLength(2);
  });

  it("un RDV médical n'accepte que trois titres génériques, composés avec le prénom (CA 2.1, AT-4)", async () => {
    const f = await family();
    const ctxTools = await tools(f);
    const medical = { titre: "x", type: "medical", debut: "2054-11-09T10:00", fin: "2054-11-09T11:00", journee_entiere: false, membres: ["Enfant 1"], source: "saisie" };
    const refused = await executeTool("creer_evenement_provisoire", { ...medical, taches: [{ titre: "Apporter les radios du genou", echeance: "la_veille" }] }, ctxTools);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("Préparer la carte Vitale");
    const ok = await executeTool("creer_evenement_provisoire", { ...medical, taches: [{ titre: "préparer la carte vitale", echeance: "la_veille" }] }, ctxTools);
    expect(JSON.parse(ok.content).taches).toBe(1);
    const row = (await getEvent(at(), f.sophie, ctxTools.created.ids[0])).tasks!.items[0];
    expect(row.title).toBe("Préparer la carte Vitale — RDV médical de Léo");
  });

  it("une série reçoit un modèle de tâche proposé une seule fois (CA 12.1, RF12)", async () => {
    const f = await family();
    const ctxTools = await tools(f);
    const result = await executeTool("creer_evenement_provisoire", {
      titre: "Piscine", type: "perso", debut: "2054-11-05T17:30", fin: "2054-11-05T18:30", journee_entiere: false, membres: ["Enfant 2"], source: "saisie",
      repetition: { frequence: "hebdomadaire", jours: ["jeudi"], fin: { type: "seances", nombre: 3 } }, taches: [{ titre: "Préparer le sac de piscine", echeance: "la_veille" }],
    }, ctxTools);
    expect(JSON.parse(result.content)).toMatchObject({ seances: 3, taches: 1 });
    const detail = await getEvent(at(), f.sophie, ctxTools.created.ids[0]);
    expect(detail.tasks?.items).toEqual([expect.objectContaining({ kind: "template", status: "proposed", title: "Préparer le sac de piscine" })]);
  });

  it("ajoute une tâche à un RDV existant (CA 3.2), limite à 5 tâches par appel, refuse une échéance inconnue", async () => {
    const f = await family();
    const ctxTools = await tools(f);
    await executeTool("creer_evenement_provisoire", birthday, ctxTools);
    const id = `evt-${ctxTools.created.ids[0].slice(0, 8)}`;
    const added = await executeTool("ajouter_tache_rdv", { id, titre: "Réserver la salle", echeance: "2_jours_avant" }, ctxTools);
    expect(added.isError).toBe(false);
    expect((await getEvent(at(), f.sophie, ctxTools.created.ids[0])).tasks?.items.map((t) => t.title)).toEqual(["Réserver la salle"]);
    expect((await executeTool("ajouter_tache_rdv", { id, titre: "Trop tôt", echeance: "1_semaine_avant" }, ctxTools)).content).toContain("déjà passée");
    expect((await executeTool("ajouter_tache_rdv", { id, titre: "X", echeance: "dans_un_mois" }, ctxTools)).content).toContain("échéance inconnue");
    expect((await executeTool("creer_evenement_provisoire", { ...birthday, debut: "2054-11-08T15:00", fin: "2054-11-08T16:00", taches: Array.from({ length: 6 }, (_v, i) => ({ titre: `T${i}`, echeance: "la_veille" })) }, ctxTools)).content).toContain("au plus 5");
  });

  it("propose une tâche seule sans rien enregistrer : une carte à ajouter (CA 1.1 de la US-110)", async () => {
    const f = await family();
    const ctxTools = await tools(f);
    const result = await executeTool("proposer_tache", { titre: "Payer la cantine", echeance: "2054-11-05", heure: "08:15", membre: "Enfant 1" }, ctxTools);
    expect(result.isError).toBe(false);
    expect(ctxTools.taskDrafts).toEqual([{ title: "Payer la cantine", due: "2054-11-05", dueTime: "08:15", assigneeId: f.ids.leo, repetition: null }]);
    expect(await dues(f.accountId)).toHaveLength(0);
    const daily = await executeTool("proposer_tache", { titre: "Sortir les poubelles", echeance: "2054-11-03", repetition: { frequence: "quotidienne", fin: { type: "jamais" } } }, ctxTools);
    expect(daily.isError).toBe(false);
    expect(ctxTools.taskDrafts?.[1].repetition).toEqual({ frequency: "daily", end: { kind: "never" } });
    expect((await executeTool("proposer_tache", { titre: "Passé", echeance: "2054-10-01" }, ctxTools)).content).toContain("déjà passée");
    expect((await executeTool("proposer_tache", { titre: "Mal écrit", echeance: "5 novembre" }, ctxTools)).content).toContain("illisible");
    expect((await executeTool("proposer_tache", { titre: "Fin avant", echeance: "2054-11-05", repetition: { frequence: "hebdomadaire", fin: { type: "date", date: "2054-11-01" } } }, ctxTools)).content).toContain("fin");
    // La carte, une fois « Ajouter » touché, passe par la création ordinaire.
    const draft = ctxTools.taskDrafts![0];
    const created = await createTask(at(), f.sophie, { title: draft.title, due: draft.due, dueTime: draft.dueTime, assigneeId: draft.assigneeId });
    expect(created).toMatchObject({ title: "Payer la cantine", dueTime: "08:15" });
  });

  it("ajuste ou retire une tâche encore proposée, désignée par son titre ; refuse une tâche enregistrée (D61)", async () => {
    const f = await family();
    const c = await tools(f);
    await executeTool("creer_evenement_provisoire", { ...birthday, taches: [{ titre: "Commander le gâteau", echeance: "2_jours_avant" }, { titre: "Acheter un cadeau", echeance: "3_jours_avant" }] }, c);
    const eventId = c.created.ids[0];
    const id = `evt-${eventId.slice(0, 8)}`;
    const ok = await executeTool("modifier_tache_proposee", { id, titre: "gâteau", echeance: "la_veille", membre: "Parent 1" }, c);
    expect(ok.isError).toBe(false);
    let items = (await getEvent(at(), f.sophie, eventId)).tasks!.items;
    expect(items.find((t) => t.title === "Commander le gâteau")).toMatchObject({ relative: "La veille", due: "2054-11-06", status: "proposed", assignee: expect.objectContaining({ firstName: "Sophie" }) });
    expect((await executeTool("modifier_tache_proposee", { id, titre: "cadeau", nouveau_titre: "Acheter un jeu de société" }, c)).isError).toBe(false);
    expect((await executeTool("modifier_tache_proposee", { id, titre: "cadeau" }, c)).content).toContain("aucune tâche proposée"); // le titre a changé
    expect((await executeTool("modifier_tache_proposee", { id, titre: "jeu" }, c)).content).toContain("rien à changer");
    expect((await executeTool("modifier_tache_proposee", { id, titre: "jeu", echeance: "1_semaine_avant" }, c)).content).toContain("déjà passée");
    expect((await executeTool("retirer_tache_proposee", { id, titre: "jeu de société" }, c)).isError).toBe(false);
    items = (await getEvent(at(), f.sophie, eventId)).tasks!.items;
    expect(items.map((t) => t.title)).toEqual(["Commander le gâteau"]);
    expect((await executeTool("retirer_tache_proposee", { id, titre: "salle" }, c)).content).toContain("aucune tâche proposée");
    // Une fois le RDV confirmé, la tâche est enregistrée : l'agent ne la modifie pas et renvoie vers l'écran Tâches.
    const shown = await getEvent(at(), f.sophie, eventId);
    await confirmEvent(at(), f.sophie, eventId, { expectedVersion: shown.version });
    const refused = await executeTool("modifier_tache_proposee", { id, titre: "gâteau", echeance: "le_jour_meme" }, c);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("ouvrez-la dans Tâches");
    expect((await executeTool("retirer_tache_proposee", { id, titre: "gâteau" }, c)).content).toContain("ouvrez-la dans Tâches");
    expect((await getEvent(at(), f.sophie, eventId)).tasks!.items).toHaveLength(1);
  });

  it("l'agent connaît les outils de tâches et leurs règles", () => {
    const definition = loadAgentDefinition();
    const names = (definition.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ajouter_tache_rdv", "proposer_tache", "modifier_tache_proposee", "retirer_tache_proposee"]));
    const create = (definition.tools as { name: string; input_schema: { properties: Record<string, unknown> } }[]).find((t) => t.name === "creer_evenement_provisoire")!;
    expect(Object.keys(create.input_schema.properties)).toContain("taches");
    expect(definition.instructions).toContain("Tâches préparatoires");
    expect(definition.instructions).toContain("proposer_tache");
  });
});
