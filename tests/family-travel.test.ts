import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATUS_CODE, TYPE_CODE, type EventStatus, type EventType } from "@/server/assistant/calendar";
import { AddressServiceError, suggestAddresses } from "@/server/assistant/address";
import { getEvent, updateEvent, type EventChanges } from "@/server/assistant/events";
import { addChild, listFamilyMembers } from "@/server/assistant/family";
import { open, seal, sealOptional } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import { completeSeries, createSeries, type SeriesRule } from "@/server/assistant/series";
import { Rejection } from "@/server/http";
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

async function seed(f: Family, s: { start: string; end: string; member?: string; type?: EventType; status?: EventStatus; allDay?: boolean; allFamily?: boolean; place?: string }): Promise<string> {
  const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE[s.type ?? "personal"]).executeTakeFirstOrThrow();
  const status = STATUS_CODE[s.status ?? "confirmed"];
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal("Rendez-vous"), location: sealOptional(s.place), starts_at: localToUtc(s.start, TZ), ends_at: localToUtc(s.end, TZ), all_day: s.allDay ?? false,
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

// ---------------------------------------------------------------------------------------------------------------------------
describe("suggestions d'adresses (US-107 RT2)", () => {
  const feature = (label: string, lon: number, lat: number) => ({ geometry: { coordinates: [lon, lat] }, properties: { label } });
  const answering = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("transforme les propositions du service en adresses avec leurs coordonnées (longitude puis latitude), cinq au plus", async () => {
    const features = Array.from({ length: 7 }, (_, i) => feature(`${i} Rue des Lilas 37100 Tours`, 0.69 + i / 1000, 47.39));
    const found = await suggestAddresses("rue des lilas tours", { fetch: answering({ features }) });
    expect(found).toHaveLength(5);
    expect(found[0]).toEqual({ label: "0 Rue des Lilas 37100 Tours", lat: 47.39, lon: 0.69 });
  });

  it("n'appelle pas le service sous 3 caractères, et n'envoie que le texte tapé", async () => {
    let calls = 0;
    let url = "";
    const spy = (async (input: string) => {
      calls += 1;
      url = input;
      return new Response(JSON.stringify({ features: [] }));
    }) as unknown as typeof fetch;
    expect(await suggestAddresses("ab", { fetch: spy })).toEqual([]);
    expect(calls).toBe(0);
    await suggestAddresses("12 rue des Lilas", { fetch: spy });
    const params = new URL(url).searchParams;
    expect(params.get("q")).toBe("12 rue des Lilas");
    expect([...params.keys()].sort()).toEqual(["autocomplete", "limit", "q"]);
  });

  it("ignore une proposition sans libellé ou aux coordonnées absurdes", async () => {
    const found = await suggestAddresses("tours", { fetch: answering({ features: [feature("", 1, 1), feature("Hors du monde", 500, 47), feature("Tours", 0.69, 47.39), { properties: { label: "Sans point" } }] }) });
    expect(found.map((f) => f.label)).toEqual(["Tours"]);
  });

  it("signale un service qui répond mal ou ne répond pas", async () => {
    await expect(suggestAddresses("tours", { fetch: answering({}, 500) })).rejects.toBeInstanceOf(AddressServiceError);
    await expect(suggestAddresses("tours", { fetch: (async () => { throw new Error("réseau"); }) as unknown as typeof fetch })).rejects.toBeInstanceOf(AddressServiceError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("adresse d'un RDV : coordonnées chiffrées (US-107 RT2, RF3, RF4)", () => {
  const point = { lat: 47.3941, lon: 0.6848 };
  const form = (f: Family, over: Partial<EventChanges> = {}): EventChanges => ({
    title: "Foot", type: "personal", allFamily: false, memberIds: [f.leo], start: "2054-11-04T14:00", end: "2054-11-04T15:00", allDay: false, ...over,
  });
  const rowOf = async (id: string) => db.selectFrom("family_events").select(["location", "location_point", "version"]).where("id", "=", id).executeTakeFirstOrThrow();
  const edit = async (f: Family, id: string, over: Partial<EventChanges>) => updateEvent(at(), f.sophie, id, form(f, over), { expectedVersion: (await rowOf(id)).version });

  it("garde chiffrées les coordonnées de l'adresse choisie ; l'écran sait seulement qu'elles sont connues", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-04T14:00", end: "2054-11-04T15:00", status: "provisional" });
    expect((await getEvent(at(), f.sophie, id)).placeKnown).toBe(false);
    const view = await edit(f, id, { place: "12 Rue des Lilas 37100 Tours", placePoint: point });
    expect(view.placeKnown).toBe(true);
    expect(JSON.stringify(view)).not.toContain("47.39");
    const row = await rowOf(id);
    expect(JSON.parse(open(row.location_point!))).toEqual(point);
    expect(row.location_point!.toString("utf8")).not.toContain("47.39");
  });

  it("« keep » garde les coordonnées quand le texte du lieu n'a pas changé, sans réécrire le lieu (les résultats « Sur place » restent valables)", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-04T14:00", end: "2054-11-04T15:00", status: "provisional" });
    await edit(f, id, { place: "Tours", placePoint: point });
    const before = await rowOf(id);
    const view = await edit(f, id, { title: "Foot du mercredi", place: "Tours", placePoint: "keep" });
    expect(view.placeKnown).toBe(true);
    const after = await rowOf(id);
    expect(after.location!.equals(before.location!)).toBe(true);
    expect(after.location_point!.equals(before.location_point!)).toBe(true);
  });

  it("un texte changé à la main, un lieu vidé ou un RDV devenu médical effacent les coordonnées", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-04T14:00", end: "2054-11-04T15:00", status: "provisional" });
    await edit(f, id, { place: "Tours", placePoint: point });
    expect((await edit(f, id, { place: "Tours centre", placePoint: "keep" })).placeKnown).toBe(false);
    await edit(f, id, { place: "Tours", placePoint: point });
    expect((await edit(f, id, { place: null, placePoint: "keep" })).placeKnown).toBe(false);
    await edit(f, id, { place: "Tours", placePoint: point });
    const medical = await edit(f, id, { type: "medical", title: "", place: "Tours", placePoint: point });
    expect(medical.placeKnown).toBe(false);
    expect((await rowOf(id)).location_point).toBeNull();
  });

  it("refuse des coordonnées absurdes", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-04T14:00", end: "2054-11-04T15:00", status: "provisional" });
    await expect(edit(f, id, { place: "Tours", placePoint: { lat: 200, lon: 0 } })).rejects.toBeInstanceOf(Rejection);
  });

  it("sur une série, l'adresse choisie vaut pour toutes les séances à venir", async () => {
    const f = await family();
    const rule: SeriesRule = { unit: "week", interval: 1, weekdays: [3], end: { kind: "count", count: 4 }, skipSchoolHolidays: false };
    const { seriesId, eventIds } = await createSeries(db, {
      accountId: f.accountId, userId: f.userId, type: "personal", title: "Foot", place: null, notes: null, startTime: "14:00", durationMinutes: 60, allDay: false, allFamily: false,
      memberIds: [f.leo], firstDate: "2054-11-04", rule, timeZone: TZ, source: "typed", now: NOW,
    });
    await completeSeries(db, NOW);
    const first = await getEvent(at(), f.sophie, eventIds[0]);
    expect(first.placeKnown).toBe(false);
    await updateEvent(at(), f.sophie, eventIds[0], form(f, { place: "Stade de Tours", placePoint: point }), { expectedVersion: first.version, scope: "all" });
    const series = await db.selectFrom("family_event_series").select("location_point").where("id", "=", seriesId).executeTakeFirstOrThrow();
    expect(series.location_point).not.toBeNull();
    const sessions = await db.selectFrom("family_events").select("location_point").where("series_id", "=", seriesId).execute();
    expect(sessions.length).toBe(4);
    expect(sessions.every((s) => s.location_point !== null)).toBe(true);
  });
});
