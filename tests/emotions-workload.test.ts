import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTask } from "@/server/assistant/tasks";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { computeWorkload, levelOf, loadThresholds } from "@/server/emotions/workload";
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
const TZ = "Europe/Paris";

/** Lundi de la semaine prochaine, et le jour demandé de cette semaine (0 = lundi). */
function nextWeek(): { monday: string; day: (i: number) => string } {
  const d = new Date();
  const toMonday = ((8 - d.getUTCDay()) % 7) || 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + toMonday)).toISOString().slice(0, 10);
  return { monday, day: (i) => new Date(Date.parse(`${monday}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10) };
}
const noon = (day: string) => new Date(`${day}T10:00:00Z`);

async function load(f: CoupleFamily, monday: string) {
  const loads = await computeWorkload(db, f.accountId, monday, TZ);
  const of = (day: string, userId: string) => loads.get(day)!.find((l) => l.userId === userId)!.level;
  return { loads, of };
}

describe("seuils de l'indicateur de charge (US-145 RT1, E-16)", () => {
  it("0 à 1 : calme ; 2 à 3 : chargé ; 4 et plus : très chargé", () => {
    const t = { busy: 2, veryBusy: 4 };
    expect([0, 1, 2, 3, 4, 9].map((n) => levelOf(n, t))).toEqual(["calm", "calm", "busy", "busy", "very_busy", "very_busy"]);
  });

  it("les seuils se règlent dans la console ; des valeurs incohérentes reviennent aux valeurs par défaut", async () => {
    expect(await loadThresholds(db)).toEqual({ busy: 2, veryBusy: 4 });
    await db.updateTable("platform_settings").set({ value_text: "3" }).where("setting_key", "=", "workload_busy_min").execute();
    await db.updateTable("platform_settings").set({ value_text: "6" }).where("setting_key", "=", "workload_very_busy_min").execute();
    try {
      expect(await loadThresholds(db)).toEqual({ busy: 3, veryBusy: 6 });
      await db.updateTable("platform_settings").set({ value_text: "2" }).where("setting_key", "=", "workload_very_busy_min").execute();
      expect(await loadThresholds(db)).toEqual({ busy: 2, veryBusy: 4 });
    } finally {
      await db.updateTable("platform_settings").set({ value_text: "2" }).where("setting_key", "=", "workload_busy_min").execute();
      await db.updateTable("platform_settings").set({ value_text: "4" }).where("setting_key", "=", "workload_very_busy_min").execute();
    }
  });
});

describe("charge d'un parent, jour par jour (E-16)", () => {
  it("compte les tâches à faire assignées au parent et dues ce jour-là (CA 2.1)", async () => {
    const f = await coupleFamily(db);
    const w = nextWeek();
    for (let i = 0; i < 4; i++) await createTask(at(), f.sophie, { title: `Tâche ${i}`, due: w.day(3), assigneeId: f.ids.sophie });
    await createTask(at(), f.sophie, { title: "Une seule pour Marc", due: w.day(3), assigneeId: f.ids.marc });
    const { of } = await load(f, w.monday);
    expect(of(w.day(3), f.userIds.sophie)).toBe("very_busy");
    expect(of(w.day(3), f.userIds.marc)).toBe("calm");
    expect(of(w.day(2), f.userIds.sophie)).toBe("calm");
  });

  it("ne compte ni les tâches sans assigné ou d'un enfant, ni les tâches déjà faites, ni celles des devoirs", async () => {
    const f = await coupleFamily(db);
    const w = nextWeek();
    await createTask(at(), f.sophie, { title: "Sans personne", due: w.day(1) });
    await createTask(at(), f.sophie, { title: "Pour Mia", due: w.day(1), assigneeId: f.ids.mia });
    await createTask(at(), f.sophie, { title: "À Sophie", due: w.day(1), assigneeId: f.ids.sophie });
    const homework = await createTask(at(), f.sophie, { title: "Devoirs — Mia", due: w.day(1), assigneeId: f.ids.sophie });
    const week = await db.insertInto("homework_weeks").values({ account_id: f.accountId, week_start: w.monday, work_days: [1, 2, 3, 4] }).returning("id").executeTakeFirstOrThrow();
    await db.updateTable("family_tasks").set({ source: "homework", homework_week_id: week.id }).where("id", "=", homework.id).execute();
    const { of } = await load(f, w.monday);
    // Une seule tâche compte (« À Sophie ») : calme.
    expect(of(w.day(1), f.userIds.sophie)).toBe("calm");
    await createTask(at(), f.sophie, { title: "Une deuxième", due: w.day(1), assigneeId: f.ids.sophie });
    expect((await load(f, w.monday)).of(w.day(1), f.userIds.sophie)).toBe("busy");
  });

  it("compte les RDV du jour dont le parent est participant, pas les RDV de toute la famille", async () => {
    const f = await coupleFamily(db);
    const w = nextWeek();
    const day = w.day(4);
    await seedEvent(db, f, { by: f.userIds.sophie, members: [f.ids.sophie, f.ids.leo], status: "confirmed", start: noon(day), end: new Date(noon(day).getTime() + 3_600_000), title: "Réunion" });
    await seedEvent(db, f, { by: f.userIds.sophie, members: [f.ids.sophie], status: "provisional", start: new Date(noon(day).getTime() + 7_200_000), end: new Date(noon(day).getTime() + 10_800_000), title: "Coiffeur" });
    await seedEvent(db, f, { by: f.userIds.sophie, allFamily: true, status: "confirmed", start: new Date(noon(day).getTime() + 14_400_000), end: new Date(noon(day).getTime() + 18_000_000), title: "Fête" });
    const { of } = await load(f, w.monday);
    expect(of(day, f.userIds.sophie)).toBe("busy"); // deux RDV, la fête de famille ne compte pour personne
    expect(of(day, f.userIds.marc)).toBe("calm");
  });

  it("un RDV d'enfant seul compte pour le parent qui l'a créé ; un RDV annulé ne compte pas", async () => {
    const f = await coupleFamily(db);
    const w = nextWeek();
    const day = w.day(2);
    await seedEvent(db, f, { by: f.userIds.marc, members: [f.ids.leo], start: noon(day), end: new Date(noon(day).getTime() + 3_600_000), title: "Dentiste" });
    await seedEvent(db, f, { by: f.userIds.marc, members: [f.ids.mia], start: new Date(noon(day).getTime() + 7_200_000), end: new Date(noon(day).getTime() + 10_800_000), title: "Orthophoniste" });
    await seedEvent(db, f, { by: f.userIds.marc, members: [f.ids.mia], status: "canceled", start: new Date(noon(day).getTime() + 14_400_000), end: new Date(noon(day).getTime() + 18_000_000), title: "Annulé" });
    const { of } = await load(f, w.monday);
    expect(of(day, f.userIds.marc)).toBe("busy");
    expect(of(day, f.userIds.sophie)).toBe("calm");
  });

  it("donne une ligne par jour pour chacun des deux parents, jamais un nombre", async () => {
    const f = await coupleFamily(db);
    const w = nextWeek();
    const { loads } = await load(f, w.monday);
    expect([...loads.keys()]).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => w.day(i)));
    for (const day of loads.values()) {
      expect(day).toHaveLength(2);
      for (const l of day) expect(Object.keys(l).sort()).toEqual(["firstName", "level", "userId"]);
    }
  });
});
