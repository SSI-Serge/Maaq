import { randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { sealPoint, type PlacePoint } from "@/server/assistant/address";
import { STATUS_CODE, TYPE_CODE, type EventType } from "@/server/assistant/calendar";
import { getEvent } from "@/server/assistant/events";
import { addChild } from "@/server/assistant/family";
import { seal } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import { grantLocationConsent, LOCATION_NOTICE_VERSION, saveLastPosition } from "@/server/assistant/location-consent";
import { durationLabel, firstNoticeAt, refreshTravel, runTravelNotices, setTracking } from "@/server/assistant/travel";
import { FakeTravelProvider, TomTomTravelProvider, TravelServiceError } from "@/server/assistant/travel-provider";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { saveSubscription } from "@/server/push/service";
import { createGuest, createProfile, sessionFor, testDb } from "./helpers/fixtures";

// Le détail d'un RDV propose le suivi du trajet quand le service est ouvert : ici, le faux service.
process.env.TRAVEL_MODE = "fake";
process.env.VAPID_PUBLIC_KEY = "BPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTe";
process.env.VAPID_PRIVATE_KEY = "PrivateKeyDeTestPrivateKeyDeTestPrivateKeyDeTe";
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
const send = vi.mocked(webpush.sendNotification);

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
});

const TZ = "Europe/Paris";
// Paris est à UTC+1 en novembre (heure d'hiver) : 18 h locales = 17:00 UTC.
const at = (iso: string): Ctx => ({ get db() { return db; }, now: new Date(iso) }) as Ctx;
const local = (iso: string) => localToUtc(iso, TZ);
const fcm = () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
const payloads = () => send.mock.calls.map((c) => ({ endpoint: String(c[0].endpoint), ...(JSON.parse(c[1] as string) as { body: string; url: string }) }));
const bodiesFor = (endpoints: Set<string>) => payloads().filter((p) => endpoints.has(p.endpoint)).map((p) => p.body);

const HOME: PlacePoint = { lat: 47.39, lon: 0.69 }; // un point de départ : la dernière position
const STADIUM: PlacePoint = { lat: 47.45, lon: 0.75 }; // le lieu du RDV
const SCHOOL: PlacePoint = { lat: 47.41, lon: 0.7 }; // le lieu d'un RDV précédent

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

async function onDevice(userId: string): Promise<SessionContext> {
  const session = await sessionFor(db, userId);
  await db.insertInto("devices").values({ id: session.device.id, user_id: userId, device_type: "android" }).execute();
  return session;
}

/** Foyer : Camille (principale), Julien (invité 1), Léo. Chacun a un appareil qui reçoit les notifications. */
async function family() {
  const camille = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Camille" }).where("id", "=", camille.id).execute();
  await db.updateTable("accounts").set({ family_timezone: TZ }).where("id", "=", camille.accountId!).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const camilleSession = await onDevice(camille.id);
  const julienSession = await onDevice(julien.id);
  const camilleSub = fcm();
  const julienSub = fcm();
  const earlier = at("2054-11-01T09:00:00Z");
  await saveSubscription(earlier, camilleSession, camilleSub);
  await saveSubscription(earlier, julienSession, julienSub);
  const leo = await addChild(earlier, camilleSession, { firstName: "Léo" });
  const member = async (userId: string) => (await db.selectFrom("family_members").select("id").where("user_id", "=", userId).executeTakeFirstOrThrow()).id;
  send.mockClear();
  return {
    accountId: camille.accountId!, camille, julien, camilleSession, julienSession, leo: leo.id,
    members: { camille: await member(camille.id), julien: await member(julien.id) },
    devices: { camille: new Set([camilleSub.endpoint]), julien: new Set([julienSub.endpoint]) },
  };
}
type Family = Awaited<ReturnType<typeof family>>;

/** Un RDV confirmé avec son lieu (coordonnées chiffrées), pour Camille et Julien. */
async function seed(f: Family, s: { title?: string; start: string; end: string; point?: PlacePoint | null; members?: string[]; type?: EventType; seriesId?: string | null; occurrence?: string }): Promise<string> {
  const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE[s.type ?? "family"]).executeTakeFirstOrThrow();
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal(s.title ?? "Foot — Léo"), starts_at: local(s.start), ends_at: local(s.end), status: STATUS_CODE.confirmed,
      location: seal("Stade"), location_point: s.point === null ? null : sealPoint(s.point ?? STADIUM), source: "chat_text", whole_family: false, requested_by_user_id: f.camille.id,
      fingerprint: randomBytes(16), confirmed_at: new Date("2054-11-01T09:00:00Z"), confirmed_by_user_id: f.camille.id, series_id: s.seriesId ?? null, occurrence_date: s.seriesId ? (s.occurrence ?? s.start.slice(0, 10)) : null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const members = s.members ?? [f.members.camille, f.members.julien];
  await db.insertInto("family_event_members").values(members.map((m) => ({ event_id: row.id, member_id: m, account_id: f.accountId }))).execute();
  return row.id;
}

/** Autorise la position et en lit une (le téléphone de Camille est « à la maison »). */
async function positioned(f: Family, session: SessionContext, point: PlacePoint, now: string, eventId?: string) {
  await grantLocationConsent(at(now), session, LOCATION_NOTICE_VERSION);
  await saveLastPosition(at(now), session, point, { eventId });
}

/** Un passage du planificateur, limité au foyer du test (la base de test est partagée par tous les tests). */
const run = (f: Family, iso: string, provider: FakeTravelProvider | null) => runTravelNotices(at(iso), { provider, accountId: f.accountId });

const advice = (eventId: string, userId: string) => db.selectFrom("event_travel_advice").selectAll().where("event_id", "=", eventId).where("user_id", "=", userId).executeTakeFirst();
const track = (f: Family, session: SessionContext, id: string, provider: FakeTravelProvider, over: Partial<Parameters<typeof setTracking>[3]> = {}, now = "2054-11-03T09:00:00Z") =>
  setTracking(at(now), session, id, { enabled: true, scope: "event", ...over }, provider);

// ---------------------------------------------------------------------------------------------------------------------------
describe("textes et horaires", () => {
  it("écrit les durées comme la spécification : « 40 min », « 1 h 20 »", () => {
    expect([durationLabel(40), durationLabel(80), durationLabel(120), durationLabel(65)]).toEqual(["40 min", "1 h 20", "2 h", "1 h 05"]);
  });

  it("premier calcul : durée estimée + 1 h 30 avant le RDV (CA 5.4 : château à 2 h, visite à 15 h → 11 h 30)", () => {
    const { at: when, evening } = firstNoticeAt(local("2054-11-04T15:00"), 120, TZ);
    expect(when.toISOString()).toBe(local("2054-11-04T11:30").toISOString());
    expect(evening).toBe(false);
    expect(firstNoticeAt(local("2054-11-04T18:00"), null, TZ).at.toISOString()).toBe(local("2054-11-04T16:30").toISOString());
  });

  it("un premier calcul avant 8 h part la veille à 21 h (D52)", () => {
    const { at: when, evening } = firstNoticeAt(local("2054-11-04T08:30"), null, TZ);
    expect(evening).toBe(true);
    expect(when.toISOString()).toBe(local("2054-11-03T21:00").toISOString());
  });
});

describe("service de trajet", () => {
  it("le faux service donne une durée d'après la distance, plus longue avec le trafic aux heures de pointe", async () => {
    const fake = new FakeTravelProvider();
    const quiet = await fake.route({ from: HOME, to: STADIUM, departAt: local("2054-11-04T11:00"), traffic: true });
    const rush = await fake.route({ from: HOME, to: STADIUM, departAt: local("2054-11-04T17:30"), traffic: true });
    const free = await fake.route({ from: HOME, to: STADIUM, departAt: local("2054-11-04T17:30"), traffic: false });
    expect(rush).toBeGreaterThan(quiet);
    expect(quiet).toBeGreaterThan(free);
  });

  it("TomTom : interroge la bonne adresse avec les seules coordonnées et l'heure, lit la durée avec ou sans trafic, et signale une panne", async () => {
    const urls: string[] = [];
    const answering = (status: number, body: unknown) => (async (u: string) => { urls.push(u); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
    const summary = { routes: [{ summary: { travelTimeInSeconds: 2410, noTrafficTravelTimeInSeconds: 1800 } }] };
    const tomtom = (status: number, body: unknown) => new TomTomTravelProvider("cle-d-essai", { fetch: answering(status, body) });
    expect(await tomtom(200, summary).route({ from: HOME, to: STADIUM, departAt: local("2054-11-04T17:00"), traffic: true })).toBe(41);
    expect(await tomtom(200, summary).route({ from: HOME, to: STADIUM, departAt: local("2054-11-04T17:00"), traffic: false })).toBe(30);
    const url = new URL(urls[0]);
    expect(url.pathname).toBe("/routing/1/calculateRoute/47.39,0.69:47.45,0.75/json");
    expect(url.searchParams.get("traffic")).toBe("true");
    expect(url.searchParams.get("departAt")).toBe("2054-11-04T16:00:00Z");
    await expect(tomtom(500, {}).route({ from: HOME, to: STADIUM, departAt: new Date(), traffic: true })).rejects.toBeInstanceOf(TravelServiceError);
    await expect(tomtom(200, { routes: [] }).route({ from: HOME, to: STADIUM, departAt: new Date(), traffic: true })).rejects.toBeInstanceOf(TravelServiceError);
  });
});

describe("« Suivre mon trajet » (RF4)", () => {
  it("CA 4.1 : sans adresse choisie, le suivi n'est pas possible ; CA 4.3 : jamais pour un RDV médical", async () => {
    const f = await family();
    const fake = new FakeTravelProvider();
    const noAddress = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00", point: null });
    expect((await failure(track(f, f.camilleSession, noAddress, fake))).code).toBe("no_address");
    // La base interdit déjà des coordonnées de lieu pour un RDV médical ; l'activation est refusée avec le motif « medical », et la vue ne propose rien.
    const medical = await seed(f, { start: "2054-11-04T10:00", end: "2054-11-04T11:00", type: "medical", point: null });
    expect((await getEvent(at("2054-11-03T09:00:00Z"), f.camilleSession, medical)).travel).toMatchObject({ available: false, unavailable: "medical" });
    expect((await failure(track(f, f.camilleSession, medical, fake))).code).toBe("medical");
  });

  it("CA 4.2 : propre à chaque profil ; l'estimation de durée n'est visible que du profil qui suit (D55)", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(30);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-03T08:00:00Z");
    const view = await track(f, f.camilleSession, id, fake, { position: HOME });
    expect(view).toMatchObject({ available: true, tracking: true, estimatedMinutes: 30 });
    const julien = await getEvent(at("2054-11-03T09:00:00Z"), f.julienSession, id);
    expect(julien.travel).toMatchObject({ available: true, tracking: false, estimatedMinutes: null });
    expect(await advice(id, f.julien.id)).toBeUndefined();
  });

  it("l'estimation à l'activation vient de la position du téléphone et n'enregistre que la durée", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(55);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-03T08:00:00Z");
    await track(f, f.camilleSession, id, fake, { position: HOME });
    expect(fake.calls[0]).toMatchObject({ from: HOME, to: STADIUM, traffic: false });
    const row = await advice(id, f.camille.id);
    expect(row?.estimated_duration_minutes).toBe(55);
    expect(JSON.stringify(row)).not.toContain("47.39");
  });

  it("sans position autorisée, l'activation réussit sans estimation", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    const view = await track(f, f.camilleSession, id, new FakeTravelProvider(30), { position: HOME });
    expect(view).toMatchObject({ tracking: true, estimatedMinutes: null });
  });

  it("série : suivre toute la série, écarter une séance, retirer le suivi", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(30);
    const series = (await db
      .insertInto("family_event_series")
      .values({
        account_id: f.accountId, event_type_id: (await db.selectFrom("event_types").select("id").where("code", "=", "family").executeTakeFirstOrThrow()).id, title: seal("Foot"),
        location: seal("Stade"), location_point: sealPoint(STADIUM), start_time: "18:00", duration_minutes: 60, series_timezone: TZ, first_date: "2054-11-04", repeat_unit: "week",
        weekdays: [4], end_kind: "never", status: "confirmed", source: "chat_text", requested_by_user_id: f.camille.id, confirmed_at: new Date(), confirmed_by_user_id: f.camille.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow()).id;
    await db.insertInto("family_event_series_members").values({ series_id: series, member_id: f.members.camille, account_id: f.accountId }).execute();
    const first = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00", seriesId: series, members: [f.members.camille] });
    const second = await seed(f, { start: "2054-11-11T18:00", end: "2054-11-11T19:00", seriesId: series, members: [f.members.camille] });
    expect((await track(f, f.camilleSession, first, fake, { scope: "series" })).viaSeries).toBe(true);
    expect((await getEvent(at("2054-11-03T09:00:00Z"), f.camilleSession, second)).travel).toMatchObject({ tracking: true, viaSeries: true });
    // On écarte la seconde séance seulement.
    await setTracking(at("2054-11-03T09:00:00Z"), f.camilleSession, second, { enabled: false, scope: "event" }, fake);
    expect((await getEvent(at("2054-11-03T09:00:00Z"), f.camilleSession, second)).travel?.tracking).toBe(false);
    expect((await getEvent(at("2054-11-03T09:00:00Z"), f.camilleSession, first)).travel?.tracking).toBe(true);
    await setTracking(at("2054-11-03T09:00:00Z"), f.camilleSession, first, { enabled: false, scope: "series" }, fake);
    expect((await getEvent(at("2054-11-03T09:00:00Z"), f.camilleSession, first)).travel?.tracking).toBe(false);
    expect((await failure(track(f, f.julienSession, first, fake, { scope: "series" }))).code).toBe("not_concerned");
  });

  it("service fermé : aucun suivi proposé", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    expect((await failure(setTracking(at("2054-11-03T09:00:00Z"), f.camilleSession, id, { enabled: true, scope: "event" }, null))).code).toBe("travel_off");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("notifications de trajet (RF5, RF7, RF8, RF10, RF13)", () => {
  it("CA 5.1 : 1 h 30 avant le RDV de 18 h, « Ouvrez MAAQ… départ estimé vers 17h20 » avec la dernière position", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(40);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T14:00:00Z");
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    expect((await run(f, "2054-11-04T15:20:00Z", fake)).first).toBe(0); // 16 h 20 : trop tôt
    const result = await run(f, "2054-11-04T15:30:00Z", fake); // 16 h 30
    expect(result.first).toBe(1);
    expect(bodiesFor(f.devices.camille)).toEqual(["Ouvrez MAAQ pour suivre votre trajet vers Foot — Léo : départ estimé vers 17h20"]);
    expect(bodiesFor(f.devices.julien)).toEqual([]); // CA 4.2 : seul le profil qui suit est prévenu
    expect(payloads()[0].url).toBe(`/calendrier/rdv/${id}/trajet`);
    expect(await advice(id, f.camille.id)).toMatchObject({ status: "first_done", origin_kind: "last_position", first_duration_minutes: 40 });
  });

  it("au plus une fois par profil et par RDV (RT4)", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(40);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T14:00:00Z");
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    await run(f, "2054-11-04T15:30:00Z", fake);
    await run(f, "2054-11-04T15:35:00Z", fake);
    await run(f, "2054-11-04T15:40:00Z", fake);
    expect(bodiesFor(f.devices.camille)).toHaveLength(1);
    const rows = await db.selectFrom("scheduled_notifications").select(["kind", "status"]).where("event_id", "=", id).execute();
    expect(rows).toEqual([{ kind: "travel_first", status: "sent" }]);
  });

  it("CA 5.2 : part du lieu du RDV précédent s'il se termine dans les 30 minutes qui précèdent", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(40);
    await seed(f, { title: "Réunion", start: "2054-11-04T16:15", end: "2054-11-04T17:45", point: SCHOOL });
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T14:00:00Z");
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    await run(f, "2054-11-04T15:30:00Z", fake);
    expect(fake.calls.at(-1)).toMatchObject({ from: SCHOOL, to: STADIUM, traffic: true });
    expect((await advice(id, f.camille.id))?.origin_kind).toBe("previous_event");
  });

  it("CA 5.4 : un long trajet (château à 2 h) déclenche le premier calcul plus tôt", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(120);
    const id = await seed(f, { title: "Visite du château", start: "2054-11-04T15:00", end: "2054-11-04T17:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T08:00:00Z");
    await track(f, f.camilleSession, id, fake, { position: HOME }, "2054-11-04T08:01:00Z");
    expect((await advice(id, f.camille.id))?.estimated_duration_minutes).toBe(120);
    expect((await run(f, "2054-11-04T10:20:00Z", fake)).first).toBe(0); // 11 h 20
    await run(f, "2054-11-04T10:30:00Z", fake); // 11 h 30
    expect(bodiesFor(f.devices.camille)).toEqual(["Ouvrez MAAQ pour suivre votre trajet vers Visite du château : départ estimé vers 13h00"]);
  });

  it("CA 5.3 : si le départ doit avoir lieu dans les 15 minutes, « Partez maintenant pour… »", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(80);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T14:00:00Z");
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    await run(f, "2054-11-04T15:30:00Z", fake); // 16 h 30 ; départ à 16 h 40
    expect(bodiesFor(f.devices.camille)).toEqual(["Partez maintenant pour Foot — Léo : 1 h 20 de trajet"]);
  });

  it("D52 : un premier calcul avant 8 h part la veille à 21 h, avec la mention « la prévision sera affinée »", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(30);
    const id = await seed(f, { title: "Brocante", start: "2054-11-05T09:00", end: "2054-11-05T12:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T19:30:00Z");
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T19:31:00Z");
    expect((await run(f, "2054-11-04T19:55:00Z", fake)).first).toBe(0); // 20 h 55
    await run(f, "2054-11-04T20:05:00Z", fake); // 21 h 05
    expect(bodiesFor(f.devices.camille)).toEqual(["Départ conseillé demain vers 8h30, trafic estimé : la prévision sera affinée."]);
  });

  it("CA 10.1 : sans origine connue, un simple appel à ouvrir MAAQ ; aucun second calcul", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(40);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    await run(f, "2054-11-04T15:30:00Z", fake);
    expect(bodiesFor(f.devices.camille)).toEqual(["Ouvrez MAAQ pour suivre votre trajet vers Foot — Léo"]);
    expect(fake.calls).toHaveLength(0);
    await run(f, "2054-11-04T16:50:00Z", fake);
    expect(bodiesFor(f.devices.camille)).toHaveLength(1);
    expect((await advice(id, f.camille.id))?.status).toBe("skipped");
  });

  it("CA 12.2 : une position de plus de 3 heures n'est plus utilisée", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(40);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T10:00:00Z"); // lue à 11 h ; 16 h 30 : plus de 3 heures
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T10:01:00Z");
    await run(f, "2054-11-04T15:30:00Z", fake);
    expect(bodiesFor(f.devices.camille)).toEqual(["Ouvrez MAAQ pour suivre votre trajet vers Foot — Léo"]);
  });

  it("CA 7.1 : second calcul 15 minutes avant le départ, sans ouverture : « Départ conseillé à 17h20… estimé depuis votre dernière position »", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(40);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T14:00:00Z");
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    await run(f, "2054-11-04T15:30:00Z", fake); // départ estimé 17 h 20
    await positioned(f, f.camilleSession, HOME, "2054-11-04T15:50:00Z"); // la position reste récente
    expect((await run(f, "2054-11-04T15:59:00Z", fake)).second).toBe(0);
    const result = await run(f, "2054-11-04T16:05:00Z", fake); // 17 h 05
    expect(result.second).toBe(1);
    expect(bodiesFor(f.devices.camille).at(-1)).toBe("Départ conseillé à 17h20 pour Foot — Léo : 40 min de trajet, trafic compris, estimé depuis votre dernière position");
    await run(f, "2054-11-04T16:10:00Z", fake);
    expect(bodiesFor(f.devices.camille)).toHaveLength(2);
  });

  it("CA 8.1 : un trajet plus long de plus de 10 minutes que le premier calcul : « Trafic plus dense que prévu : partez dès maintenant »", async () => {
    const f = await family();
    let minutes = 40;
    const fake = new FakeTravelProvider(() => minutes);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T14:00:00Z");
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    await run(f, "2054-11-04T15:30:00Z", fake);
    minutes = 55;
    await positioned(f, f.camilleSession, HOME, "2054-11-04T15:50:00Z");
    await run(f, "2054-11-04T16:05:00Z", fake);
    expect(bodiesFor(f.devices.camille).at(-1)).toBe("Trafic plus dense que prévu : partez dès maintenant pour Foot — Léo (55 min de trajet)");
  });

  it("RF7 : si l'écran de suivi est ouvert (mis à jour il y a moins de 4 minutes), le second calcul n'envoie rien", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(40);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T14:00:00Z");
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    await run(f, "2054-11-04T15:30:00Z", fake);
    await refreshTravel(at("2054-11-04T16:03:00Z"), f.camilleSession, id, { position: HOME }, fake);
    expect((await run(f, "2054-11-04T16:05:00Z", fake)).second).toBe(0);
    expect(bodiesFor(f.devices.camille)).toHaveLength(1);
    expect((await advice(id, f.camille.id))?.status).toBe("second_done");
  });

  it("RF13 : service muet, rien n'est envoyé ni réservé, et le passage suivant réessaie", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(40);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T14:00:00Z");
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    fake.failing = true;
    expect((await run(f, "2054-11-04T15:30:00Z", fake)).failed).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(await db.selectFrom("scheduled_notifications").select("id").where("event_id", "=", id).execute()).toHaveLength(0);
    fake.failing = false;
    expect((await run(f, "2054-11-04T15:35:00Z", fake)).first).toBe(1);
    expect(bodiesFor(f.devices.camille)).toHaveLength(1);
  });

  it("un RDV qui a commencé, un suivi retiré ou une séance écartée n'envoient plus rien", async () => {
    const f = await family();
    const fake = new FakeTravelProvider(40);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await positioned(f, f.camilleSession, HOME, "2054-11-04T14:00:00Z");
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    await setTracking(at("2054-11-04T14:02:00Z"), f.camilleSession, id, { enabled: false, scope: "event" }, fake);
    expect((await run(f, "2054-11-04T15:30:00Z", fake)).first).toBe(0);
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:03:00Z");
    expect((await run(f, "2054-11-04T17:10:00Z", fake)).first).toBe(0); // 18 h 10 : le RDV a commencé
    expect(send).not.toHaveBeenCalled();
  });

  it("sans service de calcul (mode fermé), le planificateur ne fait rien", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await track(f, f.camilleSession, id, new FakeTravelProvider(40), {}, "2054-11-04T14:01:00Z");
    expect(await run(f, "2054-11-04T15:30:00Z", null)).toEqual({ first: 0, second: 0, skipped: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("écran « Suivi du trajet » (RF6, RF9, RF13)", () => {
  async function tracked(minutes = 40) {
    const f = await family();
    const fake = new FakeTravelProvider(minutes);
    const id = await seed(f, { start: "2054-11-04T18:00", end: "2054-11-04T19:00" });
    await track(f, f.camilleSession, id, fake, {}, "2054-11-04T14:01:00Z");
    return { f, fake, id };
  }

  it("CA 6.1 : recalcule depuis la position lue, avec le trafic ; l'heure de départ et le temps restant suivent", async () => {
    const { f, fake, id } = await tracked(40);
    await grantLocationConsent(at("2054-11-04T15:00:00Z"), f.camilleSession, LOCATION_NOTICE_VERSION);
    const view = await refreshTravel(at("2054-11-04T15:40:00Z"), f.camilleSession, id, { position: HOME }, fake); // 16 h 40
    expect(view).toMatchObject({ departure: "2054-11-04T17:20", durationMinutes: 40, minutesBeforeDeparture: 40, arrived: false, origin: "live_screen", stale: false });
    expect(fake.calls.at(-1)).toMatchObject({ from: HOME, traffic: true });
    expect((await advice(id, f.camille.id))?.origin_kind).toBe("live_screen");
  });

  it("CA 9.1 : à moins de 5 minutes du lieu, « Vous êtes arrivé »", async () => {
    const { f, fake, id } = await tracked(3);
    await grantLocationConsent(at("2054-11-04T15:00:00Z"), f.camilleSession, LOCATION_NOTICE_VERSION);
    expect((await refreshTravel(at("2054-11-04T16:50:00Z"), f.camilleSession, id, { position: STADIUM }, fake)).arrived).toBe(true);
  });

  it("CA 11.1 : sans accord de l'appareil, la position n'est pas acceptée", async () => {
    const { f, fake, id } = await tracked(40);
    expect((await failure(refreshTravel(at("2054-11-04T15:40:00Z"), f.camilleSession, id, { position: HOME }, fake))).code).toBe("no_location_consent");
  });

  it("sans position ni RDV précédent : « no_origin »", async () => {
    const { f, fake, id } = await tracked(40);
    expect((await failure(refreshTravel(at("2054-11-04T15:40:00Z"), f.camilleSession, id, {}, fake))).code).toBe("no_origin");
  });

  it("RF13 : le service ne répond pas, la dernière estimation reste affichée, marquée « stale »", async () => {
    const { f, fake, id } = await tracked(40);
    await grantLocationConsent(at("2054-11-04T15:00:00Z"), f.camilleSession, LOCATION_NOTICE_VERSION);
    await refreshTravel(at("2054-11-04T15:40:00Z"), f.camilleSession, id, { position: HOME }, fake);
    fake.failing = true;
    const view = await refreshTravel(at("2054-11-04T15:43:00Z"), f.camilleSession, id, { position: HOME }, fake);
    expect(view).toMatchObject({ stale: true, durationMinutes: 40, departure: "2054-11-04T17:20" });
  });

  it("RF13 : service muet dès le premier calcul : message d'indisponibilité", async () => {
    const { f, fake, id } = await tracked(40);
    await grantLocationConsent(at("2054-11-04T15:00:00Z"), f.camilleSession, LOCATION_NOTICE_VERSION);
    fake.failing = true;
    expect((await failure(refreshTravel(at("2054-11-04T15:40:00Z"), f.camilleSession, id, { position: HOME }, fake))).code).toBe("travel_unavailable");
  });

  it("un autre profil du foyer ne calcule pas ce trajet pour lui : il ne voit que ses propres estimations", async () => {
    const { f, fake, id } = await tracked(40);
    await grantLocationConsent(at("2054-11-04T15:00:00Z"), f.camilleSession, LOCATION_NOTICE_VERSION);
    await refreshTravel(at("2054-11-04T15:40:00Z"), f.camilleSession, id, { position: HOME }, fake);
    expect(await advice(id, f.julien.id)).toBeUndefined();
  });
});
