import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addChild } from "@/server/assistant/family";
import { loadHomeworkCatalog } from "@/server/assistant/homework/catalog";
import { getHomeworkSetting, setHomeworkAge, setHomeworkEnabled } from "@/server/assistant/homework/settings";
import { childOptions, prepareWeek } from "@/server/assistant/homework/weeks";
import { createTask, listTasks, mondayAfter, type NewTask, type TaskView } from "@/server/assistant/tasks";
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

const NOW = new Date("2054-11-05T09:00:00Z"); // jeudi
const ctx = (): Ctx => ({ get db() { return db; }, now: NOW }) as Ctx;
const SUNDAY = "2054-11-08";

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

async function family(options: { enabled?: boolean } = {}) {
  const camille = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: "Europe/Paris" }).where("id", "=", camille.accountId!).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const camilleSession = await sessionFor(db, camille.id);
  const julienSession = await sessionFor(db, julien.id);
  const elodieSession = await sessionFor(db, elodie.id);
  const leo = await addChild(ctx(), camilleSession, { firstName: "Léo" });
  if (options.enabled !== false) {
    await setHomeworkEnabled(ctx(), camilleSession, { enabled: true, confirmed: true });
    await setHomeworkAge(ctx(), camilleSession, leo.id, 7);
  }
  const member = (await db.selectFrom("family_members").select("id").where("user_id", "=", camille.id).executeTakeFirstOrThrow()).id;
  return { accountId: camille.accountId!, camilleSession, julienSession, elodieSession, leo: leo.id, member };
}
type Family = Awaited<ReturnType<typeof family>>;

const prepInput = (f: Family, over: Partial<NewTask> = {}): NewTask => ({
  title: "Préparer les devoirs de la semaine", due: SUNDAY, dueTime: "18:00", assigneeId: f.member, repetition: { frequency: "weekly", weekdays: [7], end: { kind: "never" } }, kind: "homework_prep", ...over,
});
const allTasks = async (f: Family, session = f.camilleSession): Promise<TaskView[]> => {
  const l = await listTasks(ctx(), session);
  return [...l.overdue, ...l.today, ...l.upcoming, ...l.later];
};
const prepOf = async (f: Family, session = f.camilleSession) => (await allTasks(f, session)).filter((t) => t.title === "Préparer les devoirs de la semaine");

describe("tâche hebdomadaire de préparation des devoirs (D69)", () => {
  it("lundi qui suit l'échéance : un dimanche, le lendemain ; un lundi, le lundi suivant", () => {
    expect([mondayAfter("2054-11-08"), mondayAfter("2054-11-09"), mondayAfter("2054-11-06"), mondayAfter("2054-11-11")]).toEqual(["2054-11-09", "2054-11-16", "2054-11-09", "2054-11-16"]);
  });

  it("création : une série hebdomadaire reconnue par sa source (jamais par son titre), dont les occurrences copient la source", async () => {
    const f = await family();
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).weeklyTask).toBeNull();
    await createTask(ctx(), f.camilleSession, prepInput(f));
    const series = await db.selectFrom("family_task_series").select(["source", "weekdays", "assigned_member_id"]).where("account_id", "=", f.accountId).execute();
    expect(series).toEqual([{ source: "homework_prep", weekdays: [7], assigned_member_id: f.member }]);
    const occurrences = await db.selectFrom("family_tasks").select(["source", "homework_week_id"]).where("account_id", "=", f.accountId).execute();
    expect(occurrences.length).toBeGreaterThan(1);
    expect(occurrences.every((o) => o.source === "homework_prep" && o.homework_week_id === null)).toBe(true);
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).weeklyTask).toEqual({ label: "chaque dimanche à 18 h" });
  });

  it("le jour, l'heure et la personne restent modifiables ; la tâche doit revenir chaque semaine", async () => {
    const f = await family();
    await createTask(ctx(), f.camilleSession, prepInput(f, { due: "2054-11-06", dueTime: "20:30", assigneeId: null, repetition: { frequency: "weekly", weekdays: [6], end: { kind: "never" } } }));
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).weeklyTask).toEqual({ label: "chaque samedi à 20 h30" });
    const g = await family();
    expect((await failure(createTask(ctx(), g.camilleSession, prepInput(g, { repetition: null })))).code).toBe("prep_needs_weekly");
    expect((await failure(createTask(ctx(), g.camilleSession, prepInput(g, { repetition: { frequency: "biweekly", end: { kind: "never" } } })))).code).toBe("prep_needs_weekly");
  });

  it("une seule série active par foyer ; une fois terminée, on peut en recréer une", async () => {
    const f = await family();
    await createTask(ctx(), f.camilleSession, prepInput(f));
    expect((await failure(createTask(ctx(), f.julienSession, prepInput(f, { assigneeId: null })))).code).toBe("prep_exists");
    await db.updateTable("family_task_series").set({ ended_at: NOW }).where("account_id", "=", f.accountId).execute();
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).weeklyTask).toBeNull();
    await createTask(ctx(), f.julienSession, prepInput(f, { assigneeId: null }));
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).weeklyTask).not.toBeNull();
  });

  it("réservée aux parents, et à une famille où l'aide Devoirs est activée", async () => {
    const f = await family();
    expect((await failure(createTask(ctx(), f.elodieSession, prepInput(f, { assigneeId: f.member })))).status).toBe(403);
    const off = await family({ enabled: false });
    expect((await failure(createTask(ctx(), off.camilleSession, prepInput(off)))).code).toBe("homework_disabled");
    expect(await db.selectFrom("family_task_series").select("id").where("account_id", "=", off.accountId).execute()).toEqual([]);
  });

  it("le lien de la tâche : « Préparer » vers la semaine qui suit l'échéance, puis « Voir la semaine » une fois préparée", async () => {
    const f = await family();
    await createTask(ctx(), f.camilleSession, prepInput(f));
    const before = (await prepOf(f))[0];
    expect(before.homeworkPrep).toEqual({ weekStart: "2054-11-09", weekId: null });
    const block = (await childOptions(db, f.accountId, f.leo)).blocks[0];
    const { weekId } = await prepareWeek(ctx(), f.camilleSession, { weekStart: "2054-11-09", workDays: [1, 2], children: [{ memberId: f.leo, items: [{ kind: "exercises", textbook: "france", numbers: block.numbers, days: [1] }] }] });
    const after = await prepOf(f);
    expect(after.find((t) => t.due === SUNDAY)?.homeworkPrep).toEqual({ weekStart: "2054-11-09", weekId });
    // La semaine suivante n'est pas préparée : l'occurrence suivante garde « Préparer ».
    expect(after.find((t) => t.due === "2054-11-15")?.homeworkPrep).toEqual({ weekStart: "2054-11-16", weekId: null });
  });

  it("aide désactivée : la tâche reste, sans lien ; le lien de création n'est plus proposé par le réglage ; réactivée, le lien revient", async () => {
    const f = await family();
    await createTask(ctx(), f.camilleSession, prepInput(f));
    await setHomeworkEnabled(ctx(), f.julienSession, { enabled: false });
    const tasks = await prepOf(f);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.homeworkPrep === null)).toBe(true);
    await setHomeworkEnabled(ctx(), f.julienSession, { enabled: true });
    expect((await prepOf(f))[0].homeworkPrep).not.toBeNull();
  });

  it("le lien n'est donné qu'à un parent ; une tâche ordinaire du même titre n'a jamais de lien (reconnue par la marque, pas par le titre)", async () => {
    const f = await family();
    await createTask(ctx(), f.camilleSession, prepInput(f, { assigneeId: null }));
    await createTask(ctx(), f.camilleSession, { title: "Devoirs de maths", due: SUNDAY, assigneeId: null });
    await createTask(ctx(), f.camilleSession, { title: "Préparer les devoirs de la semaine", due: "2054-11-12", assigneeId: null }); // même titre, sans la marque
    const mine = await allTasks(f);
    expect(mine.filter((t) => t.homeworkPrep).every((t) => t.due.endsWith("08") || t.recurring)).toBe(true);
    expect(mine.find((t) => t.title === "Devoirs de maths")?.homeworkPrep).toBeNull();
    expect(mine.find((t) => t.title === "Préparer les devoirs de la semaine" && t.due === "2054-11-12")?.homeworkPrep).toBeNull();
    // Un invité secondaire qui voit la tâche (non assignée à un enfant) ne reçoit pas le lien.
    const seen = await allTasks(f, f.elodieSession);
    expect(seen.every((t) => t.homeworkPrep === null)).toBe(true);
  });
});
