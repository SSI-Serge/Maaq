import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addChild } from "@/server/assistant/family";
import { familyAgentId } from "@/server/assistant/conversation";
import { loadHomeworkCatalog } from "@/server/assistant/homework/catalog";
import { eraseHomeworkProgress, getHomeworkSetting, homeworkEnabled, levelForAge, purgeExpiredHomework, setHomeworkAge, setHomeworkEnabled } from "@/server/assistant/homework/settings";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { getLogbook } from "@/server/logbook/service";
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

const ctx = (): Ctx => ({ get db() { return db; }, now: new Date() }) as Ctx;

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

async function family(options: { children?: boolean } = {}) {
  const camille = await createProfile(db);
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const camilleSession = await sessionFor(db, camille.id);
  const julienSession = await sessionFor(db, julien.id);
  const elodieSession = await sessionFor(db, elodie.id);
  const leo = options.children === false ? null : await addChild(ctx(), camilleSession, { firstName: "Léo" });
  return { accountId: camille.accountId!, camilleSession, julienSession, elodieSession, leoId: leo?.id ?? null };
}

describe("catalogue (US-119 RT4)", () => {
  it("se charge sans doublon, plusieurs fois de suite", async () => {
    const first = await loadHomeworkCatalog(db);
    await loadHomeworkCatalog(db);
    const count = (table: "homework_exercises" | "homework_activities") => db.selectFrom(table).select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
    expect(first.exercises).toBe(375);
    expect((await count("homework_exercises")).n).toBe(375); // 3 manuels × 5 niveaux × 25
    const activities = await db.selectFrom("homework_activities").select(["category", "title"]).execute();
    expect(new Set(activities.map((a) => `${a.category}/${a.title}`)).size).toBe(60); // une ligne par âge, 60 activités
    expect(new Set(activities.map((a) => a.category)).size).toBe(6);
  });

  it("D66 : énoncés, étapes et matériel sont portés par la base, sans donnée personnelle ; la base refuse un contenu vide", async () => {
    const exercises = await db.selectFrom("homework_exercises").select(["statement", "answer"]).execute();
    expect(exercises.every((e) => e.statement && e.statement.length <= 2000 && e.answer)).toBe(true);
    const activities = await db.selectFrom("homework_activities").select(["steps", "materials"]).execute();
    expect(activities.every((a) => a.steps && a.steps.length <= 4000 && a.materials && a.materials.length <= 1000)).toBe(true);
    const personal = /[\w.+-]+@[\w-]+\.\w+|\b0[1-9](?:[ .]?\d{2}){4}\b|https?:\/\/|www\./i;
    expect([...exercises.map((e) => e.statement), ...activities.map((a) => a.steps), ...activities.map((a) => a.materials)].filter((t) => t && personal.test(t))).toEqual([]);
    await expect(db.updateTable("homework_exercises").set({ statement: "   " }).where("textbook_key", "=", "france").where("level", "=", "cp").where("number", "=", 1).execute()).rejects.toThrow();
  });
});

describe("aide Devoirs du foyer (US-118)", () => {
  it("CA 1.1 : désactivée par défaut ; CA 1.2 : commune au foyer, les deux parents la modifient", async () => {
    const f = await family();
    expect((await getHomeworkSetting(ctx(), f.julienSession)).enabled).toBe(false);
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: true, confirmed: true });
    const seenByJulien = await getHomeworkSetting(ctx(), f.julienSession);
    expect(seenByJulien).toMatchObject({ enabled: true, canEdit: true });
    await setHomeworkEnabled(ctx(), f.julienSession, { enabled: false });
    expect(await homeworkEnabled(ctx(), f.accountId)).toBe(false);
  });

  it("D66 S-21 : l'activation et la désactivation sont inscrites au carnet de bord du foyer ; l'autre parent les voit, l'invité secondaire non", async () => {
    const f = await family();
    const agent = await familyAgentId(db);
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: true, confirmed: true });
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: true, confirmed: true }); // aucun changement : rien de plus
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: false });
    const seen = await getLogbook(ctx(), f.julienSession, agent);
    expect(seen.entries.map((e) => e.summary)).toEqual([expect.stringMatching(/a désactivé l'aide Devoirs$/), expect.stringMatching(/a activé l'aide Devoirs$/)]);
    expect(seen.entries.every((e) => e.type === "action_done")).toBe(true);
    expect((await getLogbook(ctx(), f.elodieSession, agent)).entries).toEqual([]);
  });

  it("l'invité secondaire voit le réglage en lecture seule et ne peut pas le changer (RF1)", async () => {
    const f = await family();
    expect(await getHomeworkSetting(ctx(), f.elodieSession)).toMatchObject({ enabled: false, canEdit: false });
    expect((await failure(setHomeworkEnabled(ctx(), f.elodieSession, { enabled: true, confirmed: true }))).status).toBe(403);
    expect((await failure(setHomeworkAge(ctx(), f.elodieSession, f.leoId!, 8))).status).toBe(403);
  });

  it("CA 2.1 : sans enfant, l'aide ne s'active pas", async () => {
    const f = await family({ children: false });
    expect(await getHomeworkSetting(ctx(), f.camilleSession)).toMatchObject({ hasChildren: false, enabled: false });
    expect((await failure(setHomeworkEnabled(ctx(), f.camilleSession, { enabled: true, confirmed: true }))).code).toBe("no_child");
  });

  it("CA 3.1 : la première activation demande la présentation ; la suivante non", async () => {
    const f = await family();
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).needsIntro).toBe(true);
    expect((await failure(setHomeworkEnabled(ctx(), f.camilleSession, { enabled: true }))).code).toBe("intro_required");
    expect((await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: true, confirmed: true })).needsIntro).toBe(false);
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: false });
    expect((await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: true })).enabled).toBe(true);
  });

  it("CA 4.1 : l'âge des devoirs donne le niveau, sans toucher à la date de naissance ; un enfant sans âge n'a pas de niveau", async () => {
    const f = await family();
    await db.updateTable("family_members").set({ birth_year: 2047, birth_month: 3 }).where("id", "=", f.leoId!).execute();
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).children[0]).toMatchObject({ homeworkAge: null, level: null });
    const done = await setHomeworkAge(ctx(), f.camilleSession, f.leoId!, 8);
    expect(done.children[0]).toMatchObject({ homeworkAge: 8, level: "ce2", levelLabel: "CE2" });
    const member = await db.selectFrom("family_members").select(["birth_year", "birth_month"]).where("id", "=", f.leoId!).executeTakeFirstOrThrow();
    expect(member).toEqual({ birth_year: 2047, birth_month: 3 });
    expect([6, 7, 8, 9, 10, 11, 12].map(levelForAge)).toEqual(["cp", "ce1", "ce2", "cm1", "cm2", "cm2", "cm2"]);
  });

  it("l'âge des devoirs est compris entre 6 et 12 ans, et ne concerne qu'un enfant de la famille", async () => {
    const f = await family();
    const other = await family();
    expect((await failure(setHomeworkAge(ctx(), f.camilleSession, f.leoId!, 5))).code).toBe("invalid_age");
    expect((await failure(setHomeworkAge(ctx(), f.camilleSession, f.leoId!, 13))).code).toBe("invalid_age");
    expect((await failure(setHomeworkAge(ctx(), f.camilleSession, other.leoId!, 8))).status).toBe(404);
  });

  it("RF5, S-12 : « Effacer les progrès » supprime semaines, tâches et validations, et garde l'âge des devoirs", async () => {
    const f = await family();
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: true, confirmed: true });
    await setHomeworkAge(ctx(), f.camilleSession, f.leoId!, 7);
    const exercise = await db.selectFrom("homework_exercises").select("id").where("textbook_key", "=", "france").where("level", "=", "ce1").orderBy("number").limit(1).executeTakeFirstOrThrow();
    await db.insertInto("homework_exercise_validations").values({ member_id: f.leoId!, exercise_id: exercise.id }).execute();
    await db.insertInto("homework_weeks").values({ account_id: f.accountId, week_start: "2054-11-09", work_days: [1, 2] }).execute();
    expect((await eraseHomeworkProgress(ctx(), f.julienSession)).erased).toBe(2);
    expect(await db.selectFrom("homework_exercise_validations").select("member_id").where("member_id", "=", f.leoId!).execute()).toHaveLength(0);
    expect(await db.selectFrom("homework_weeks").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(0);
    expect((await getHomeworkSetting(ctx(), f.camilleSession)).children[0].homeworkAge).toBe(7);
  });

  it("D65 : la purge garde les exercices validés tant que l'aide est active, puis 30 jours après sa désactivation", async () => {
    const f = await family();
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: true, confirmed: true });
    await setHomeworkAge(ctx(), f.camilleSession, f.leoId!, 7);
    const exercise = await db.selectFrom("homework_exercises").select("id").where("textbook_key", "=", "france").where("level", "=", "ce1").orderBy("number").limit(1).executeTakeFirstOrThrow();
    await db.insertInto("homework_exercise_validations").values({ member_id: f.leoId!, exercise_id: exercise.id }).execute();
    const kept = () => db.selectFrom("homework_exercise_validations").select("member_id").where("member_id", "=", f.leoId!).execute();
    await purgeExpiredHomework(ctx());
    expect(await kept()).toHaveLength(1); // aide active
    await setHomeworkEnabled(ctx(), f.camilleSession, { enabled: false });
    await purgeExpiredHomework(ctx());
    expect(await kept()).toHaveLength(1); // délai de grâce
    await db.updateTable("family_settings").set({ homework_help_disabled_at: new Date(Date.now() - 31 * 86_400_000) }).where("account_id", "=", f.accountId).execute();
    await purgeExpiredHomework(ctx());
    expect(await kept()).toHaveLength(0); // plus de 30 jours après la désactivation
  });
});
