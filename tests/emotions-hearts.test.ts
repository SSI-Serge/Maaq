import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEvent } from "@/server/assistant/events";
import { createTask, getTask, listTasks, setTaskDone } from "@/server/assistant/tasks";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { setHeart } from "@/server/emotions/hearts";
import { Rejection } from "@/server/http";
import { coupleFamily, seedEvent, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});
const at = (): Ctx => ({ db, now: new Date() });
const today = () => new Date().toISOString().slice(0, 10);

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Une tâche cochée par `by`. */
async function doneTask(f: CoupleFamily, by: "sophie" | "marc" | "elodie", title = "Sac de piscine de Mia") {
  const task = await createTask(at(), f.sophie, { title, due: today() });
  await setTaskDone(at(), f[by], task.id, true);
  return task.id;
}

describe("cœur sur une tâche (US-141)", () => {
  it("l'autre parent peut remercier une tâche cochée par son partenaire, et le partenaire le voit (CA 1.1, RF3)", async () => {
    const f = await coupleFamily(db);
    const id = await doneTask(f, "marc");
    expect((await getTask(at(), f.sophie, id)).heart).toEqual({ canGive: true, given: false, thanksFrom: null });
    expect(await setHeart(at(), f.sophie, { kind: "task", id }, true)).toEqual({ canGive: true, given: true, thanksFrom: null });
    // Marc, qui a fait la tâche, voit « Sophie vous remercie » et ne peut pas poser son propre cœur
    expect((await getTask(at(), f.marc, id)).heart).toEqual({ canGive: false, given: false, thanksFrom: "Sophie" });
    const lists = await listTasks(at(), f.sophie);
    expect(lists.done.find((t) => t.id === id)?.heart?.given).toBe(true);
  });

  it("jamais sur sa propre action (CA 1.2) ni sur une tâche non faite", async () => {
    const f = await coupleFamily(db);
    const own = await doneTask(f, "sophie", "Inscription cantine");
    expect((await getTask(at(), f.sophie, own)).heart).toBeNull();
    expect((await failure(setHeart(at(), f.sophie, { kind: "task", id: own }, true))).code).toBe("heart_not_allowed");
    const open = await createTask(at(), f.sophie, { title: "À faire", due: today() });
    expect((await failure(setHeart(at(), f.sophie, { kind: "task", id: open.id }, true))).code).toBe("heart_not_allowed");
  });

  it("un second appui retire le cœur (CA 2.1), et c'est sans effet de le retirer deux fois", async () => {
    const f = await coupleFamily(db);
    const id = await doneTask(f, "marc");
    await setHeart(at(), f.sophie, { kind: "task", id }, true);
    await setHeart(at(), f.sophie, { kind: "task", id }, true);
    expect(await db.selectFrom("appreciation_hearts").select("id").where("task_id", "=", id).execute()).toHaveLength(1);
    expect((await setHeart(at(), f.sophie, { kind: "task", id }, false)).given).toBe(false);
    await setHeart(at(), f.sophie, { kind: "task", id }, false);
    expect(await db.selectFrom("appreciation_hearts").select("id").where("task_id", "=", id).execute()).toHaveLength(0);
  });

  it("l'invité secondaire ne voit pas le cœur et ne peut pas en poser (CA 3.1)", async () => {
    const f = await coupleFamily(db);
    const id = await doneTask(f, "marc");
    await setHeart(at(), f.sophie, { kind: "task", id }, true);
    expect((await getTask(at(), f.elodie, id).catch(() => null))?.heart ?? null).toBeNull();
    expect((await failure(setHeart(at(), f.elodie, { kind: "task", id }, true))).code).toBe("forbidden");
  });

  it("aucune notification n'est réservée (CA 4.1)", async () => {
    const f = await coupleFamily(db);
    const id = await doneTask(f, "marc");
    const before = await db.selectFrom("scheduled_notifications").select("id").where("recipient_user_id", "=", f.userIds.marc).execute();
    await setHeart(at(), f.sophie, { kind: "task", id }, true);
    const after = await db.selectFrom("scheduled_notifications").select("id").where("recipient_user_id", "=", f.userIds.marc).execute();
    expect(after.length).toBe(before.length);
  });

  it("le cœur part quand la tâche est décochée (RF6)", async () => {
    const f = await coupleFamily(db);
    const id = await doneTask(f, "marc");
    await setHeart(at(), f.sophie, { kind: "task", id }, true);
    await setTaskDone(at(), f.marc, id, false);
    expect(await db.selectFrom("appreciation_hearts").select("id").where("task_id", "=", id).execute()).toHaveLength(0);
  });

  it("sans invité 1 actif, il n'y a pas de couple : aucun cœur", async () => {
    const f = await coupleFamily(db);
    const id = await doneTask(f, "marc");
    await db.updateTable("users").set({ status: "removed", removed_at: new Date(), purge_scheduled_at: new Date(Date.now() + 30 * 86_400_000) }).where("id", "=", f.userIds.marc).execute();
    expect((await failure(setHeart(at(), f.sophie, { kind: "task", id }, true))).code).toBe("forbidden");
    expect((await getTask(at(), f.sophie, id)).heart).toBeNull();
  });
});

describe("cœur sur un RDV (US-141, E-04, E-25)", () => {
  it("sur un RDV confirmé, terminé et créé par l'autre parent (CA 1.3)", async () => {
    const f = await coupleFamily(db);
    const id = await seedEvent(db, f, { by: f.userIds.marc });
    expect((await getEvent(at(), f.sophie, id)).heart).toEqual({ canGive: true, given: false, thanksFrom: null });
    await setHeart(at(), f.sophie, { kind: "event", id }, true);
    expect((await getEvent(at(), f.sophie, id)).heart?.given).toBe(true);
    expect((await getEvent(at(), f.marc, id)).heart).toEqual({ canGive: false, given: false, thanksFrom: "Sophie" });
  });

  it("pas sur son propre RDV, ni avant la fin du RDV, ni sur un RDV provisoire", async () => {
    const f = await coupleFamily(db);
    const own = await seedEvent(db, f, { by: f.userIds.sophie });
    const future = await seedEvent(db, f, { by: f.userIds.marc, startsInHours: 24, endsInHours: 25 });
    const provisional = await seedEvent(db, f, { by: f.userIds.marc, status: "provisional" });
    for (const id of [own, future, provisional]) {
      expect((await getEvent(at(), f.sophie, id)).heart).toBeNull();
      expect((await failure(setHeart(at(), f.sophie, { kind: "event", id }, true))).code).toBe("heart_not_allowed");
    }
  });

  it("un RDV annulé perd son cœur (E-25)", async () => {
    const f = await coupleFamily(db);
    const id = await seedEvent(db, f, { by: f.userIds.marc });
    await setHeart(at(), f.sophie, { kind: "event", id }, true);
    await db.updateTable("family_events").set({ status: "cancelled" as never }).where("id", "=", id).execute();
    expect(await db.selectFrom("appreciation_hearts").select("id").where("event_id", "=", id).execute()).toHaveLength(0);
  });

  it("le cœur est supprimé avec l'élément", async () => {
    const f = await coupleFamily(db);
    const id = await seedEvent(db, f, { by: f.userIds.marc });
    await setHeart(at(), f.sophie, { kind: "event", id }, true);
    await db.deleteFrom("family_events").where("id", "=", id).execute();
    expect(await db.selectFrom("appreciation_hearts").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(0);
  });
});
