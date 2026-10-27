import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATUS_CODE, TYPE_CODE, type EventStatus, type EventType } from "@/server/assistant/calendar";
import { getEvent } from "@/server/assistant/events";
import { addChild, listFamilyMembers } from "@/server/assistant/family";
import { seal } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

// Lundi 2 novembre 2054, 09:00 à Paris (dates décalées de 28 ans : toujours dans le futur de l'horloge de la base).
const NOW = new Date("2054-11-02T08:00:00Z");
const TZ = "Europe/Paris";
const at = (): Ctx => ({ db, now: NOW });

async function family() {
  const primary = await createProfile(db);
  const sophie = await sessionFor(db, primary.id);
  const leo = await addChild(at(), sophie, { firstName: "Léo", birth: "2046-06" });
  const mia = await addChild(at(), sophie, { firstName: "Mia", birth: "2049-02" });
  void (await listFamilyMembers(at(), sophie));
  return { accountId: primary.accountId!, userId: primary.id, sophie, leo: leo.id, mia: mia.id };
}
type Family = Awaited<ReturnType<typeof family>>;

async function seed(f: Family, s: { start: string; end: string; member?: string; type?: EventType; status?: EventStatus; allDay?: boolean; allFamily?: boolean }): Promise<string> {
  const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE[s.type ?? "personal"]).executeTakeFirstOrThrow();
  const status = STATUS_CODE[s.status ?? "confirmed"];
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal("Rendez-vous"), starts_at: localToUtc(s.start, TZ), ends_at: localToUtc(s.end, TZ), all_day: s.allDay ?? false,
      status, source: "chat_text", whole_family: s.allFamily ?? false, requested_by_user_id: f.userId, fingerprint: randomBytes(16),
      ...(status === "confirmed" || status === "cancelled" ? { confirmed_at: NOW, confirmed_by_user_id: f.userId } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (!s.allFamily) await db.insertInto("family_event_members").values({ event_id: row.id, member_id: s.member ?? f.leo, account_id: f.accountId }).execute();
  return row.id;
}

const nearby = async (f: Family, id: string) => (await getEvent(at(), f.sophie, id)).nearby;

describe("RDV rapproché (US-107 RF1)", () => {
  it("CA 1.1 : un autre RDV du même membre qui se termine 15 minutes avant déclenche l'alerte", async () => {
    const f = await family();
    const other = await seed(f, { start: "2054-11-03T16:30", end: "2054-11-03T17:30" });
    const foot = await seed(f, { start: "2054-11-03T17:45", end: "2054-11-03T18:45", status: "provisional" });
    expect(await nearby(f, foot)).toEqual([{ id: other, side: "before", at: "2054-11-03T17:30", minutes: 15 }]);
  });

  it("CA 1.2 : un écart de 60 minutes ne déclenche rien, pas plus que 30 minutes exactement", async () => {
    const f = await family();
    await seed(f, { start: "2054-11-03T16:00", end: "2054-11-03T17:00" });
    const sixty = await seed(f, { start: "2054-11-03T18:00", end: "2054-11-03T19:00", status: "provisional" });
    expect(await nearby(f, sixty)).toEqual([]);
    const g = await family();
    await seed(g, { start: "2054-11-03T16:00", end: "2054-11-03T17:00" });
    const thirty = await seed(g, { start: "2054-11-03T17:30", end: "2054-11-03T18:00", status: "provisional" });
    expect(await nearby(g, thirty)).toEqual([]);
  });

  it("signale aussi un RDV qui commence peu après la fin de celui-ci", async () => {
    const f = await family();
    const next = await seed(f, { start: "2054-11-03T18:10", end: "2054-11-03T19:00" });
    const foot = await seed(f, { start: "2054-11-03T17:00", end: "2054-11-03T18:00", status: "provisional" });
    expect(await nearby(f, foot)).toEqual([{ id: next, side: "after", at: "2054-11-03T18:10", minutes: 10 }]);
  });

  it("deux RDV qui se touchent (0 minute) sont rapprochés ; deux RDV qui se chevauchent sont un conflit, pas un RDV rapproché", async () => {
    const f = await family();
    const touching = await seed(f, { start: "2054-11-03T16:00", end: "2054-11-03T17:00" });
    const foot = await seed(f, { start: "2054-11-03T17:00", end: "2054-11-03T18:00", status: "provisional" });
    expect(await nearby(f, foot)).toEqual([{ id: touching, side: "before", at: "2054-11-03T17:00", minutes: 0 }]);
    const clash = await seed(f, { start: "2054-11-04T10:00", end: "2054-11-04T11:00" });
    const over = await seed(f, { start: "2054-11-04T10:30", end: "2054-11-04T11:30", status: "provisional" });
    const view = await getEvent(at(), f.sophie, over);
    expect(view.nearby).toEqual([]);
    expect(view.conflicts.map((c) => c.id)).toEqual([clash]);
  });

  it("ne compte que les membres communs, et ignore un RDV sur la journée entière, annulé ou ignoré", async () => {
    const f = await family();
    await seed(f, { start: "2054-11-03T16:30", end: "2054-11-03T17:30", member: f.mia });
    await seed(f, { start: "2054-11-03T00:00", end: "2054-11-04T00:00", allDay: true });
    await seed(f, { start: "2054-11-03T16:30", end: "2054-11-03T17:30", status: "canceled" });
    await seed(f, { start: "2054-11-03T16:30", end: "2054-11-03T17:30", status: "ignored" });
    const foot = await seed(f, { start: "2054-11-03T17:45", end: "2054-11-03T18:45", status: "provisional" });
    expect(await nearby(f, foot)).toEqual([]);
  });

  it("vaut pour toute la famille et pour un rendez-vous médical", async () => {
    const f = await family();
    const trip = await seed(f, { start: "2054-11-03T16:00", end: "2054-11-03T17:30", allFamily: true });
    const dentist = await seed(f, { start: "2054-11-03T17:45", end: "2054-11-03T18:15", type: "medical", member: f.mia, status: "provisional" });
    expect((await nearby(f, dentist)).map((n) => n.id)).toEqual([trip]);
  });

  it("l'écart se règle (travel_gap_alert_minutes)", async () => {
    const f = await family();
    await seed(f, { start: "2054-11-03T16:00", end: "2054-11-03T17:00" });
    const foot = await seed(f, { start: "2054-11-03T17:45", end: "2054-11-03T18:45", status: "provisional" });
    expect(await nearby(f, foot)).toEqual([]);
    await db.updateTable("platform_settings").set({ value_text: "60" }).where("setting_key", "=", "travel_gap_alert_minutes").execute();
    try {
      expect((await nearby(f, foot)).length).toBe(1);
    } finally {
      await db.updateTable("platform_settings").set({ value_text: "30" }).where("setting_key", "=", "travel_gap_alert_minutes").execute();
    }
  });
});
