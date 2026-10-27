import { randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { sealPoint, type PlacePoint } from "@/server/assistant/address";
import { STATUS_CODE, TYPE_CODE, type EventType } from "@/server/assistant/calendar";
import { addChild } from "@/server/assistant/family";
import { seal } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import { FakePlaceProvider, type FoundPlace } from "@/server/assistant/place-provider";
import { blocksOf, placeSearchView, requestPlaceSearch, roundedPoint, runPlaceSearch, runPlaceSearches, selectPlaces } from "@/server/assistant/places";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { saveSubscription } from "@/server/push/service";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

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
const NOW = new Date("2054-11-09T09:00:00Z");
const at = (): Ctx => ({ get db() { return db; }, now: NOW }) as Ctx;
const CHATEAU: PlacePoint = { lat: 47.6162, lon: 1.5173 };
const payloads = () => send.mock.calls.map((c) => JSON.parse(c[1] as string) as { body: string; url: string });

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

async function family() {
  const camille = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: TZ }).where("id", "=", camille.accountId!).execute();
  const session = await sessionFor(db, camille.id);
  await db.insertInto("devices").values({ id: session.device.id, user_id: camille.id, device_type: "android" }).execute();
  await saveSubscription(at(), session, { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
  const leo = await addChild(at(), session, { firstName: "Léo" });
  send.mockClear();
  return { accountId: camille.accountId!, userId: camille.id, session, leo: leo.id };
}
type Family = Awaited<ReturnType<typeof family>>;

async function seed(f: Family, s: { place?: string | null; point?: PlacePoint | null; type?: EventType; start?: string; end?: string } = {}): Promise<string> {
  const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE[s.type ?? "family"]).executeTakeFirstOrThrow();
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal("Visite du château"), starts_at: localToUtc(s.start ?? "2054-11-10T15:00", TZ), ends_at: localToUtc(s.end ?? "2054-11-10T17:00", TZ),
      status: STATUS_CODE.confirmed, location: s.place === null ? null : seal(s.place ?? "Château de Chambord"), location_point: s.point ? sealPoint(s.point) : null, source: "chat_text", whole_family: true,
      requested_by_user_id: f.userId, fingerprint: randomBytes(16), confirmed_at: NOW, confirmed_by_user_id: f.userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

const search = async (f: Family, eventId: string, provider = new FakePlaceProvider(), origin: "button" | "chat" | "suggestion" = "button") => {
  const id = await requestPlaceSearch(at(), f.session, eventId, origin, provider);
  await runPlaceSearch(at(), id, provider);
  return id;
};
const row = (id: string) => db.selectFrom("event_place_searches").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

// ---------------------------------------------------------------------------------------------------------------------------
describe("choix des adresses (US-112 RF5, RF6)", () => {
  const origin: PlacePoint = { lat: 47.0, lon: 1.0 };
  const at100 = (km: number): PlacePoint => ({ lat: origin.lat + km * 0.009, lon: origin.lon });
  const p = (name: string, category: FoundPlace["category"], km: number, open: boolean | null = true): FoundPlace => ({ name, category, type: "Lieu", city: "Tours", point: at100(km), open });

  it("garde les adresses à 15 minutes à pied au plus, ouvertes, les plus proches d'abord : 2 par catégorie", () => {
    const payload = selectPlaces(
      [p("Loin", "parking", 2), p("B", "parking", 0.4), p("A", "parking", 0.1), p("C", "parking", 0.2), p("Fermé", "restaurant", 0.2, false), p("R1", "restaurant", 0.5), p("R2", "restaurant", 0.3), p("R3", "restaurant", 0.6), p("S1", "snack", 0.2, null)],
      origin, 15, "fake",
    );
    expect(payload.parking.map((x) => x.name)).toEqual(["A", "C"]);
    expect(payload.restaurant.map((x) => x.name)).toEqual(["R2", "R1"]);
    expect(payload.snack.map((x) => x.name)).toEqual(["S1"]); // horaires inconnus : gardée
    expect(payload.parking[0].walkMinutes).toBe(2); // 100 m à 5 km/h : 1,2 min → 2
  });

  it("CA 6.2 : une seule adresse « Petite faim » est signalée ; un parking seul est normal (1 ou 2)", () => {
    const blocks = blocksOf(selectPlaces([p("P", "parking", 0.1), p("B", "snack", 0.2), p("R1", "restaurant", 0.1), p("R2", "restaurant", 0.2)], origin, 15, "fake"));
    expect(blocks.find((b) => b.category === "snack")?.note).toBe("Une seule adresse « Petite faim » trouvée près du lieu.");
    expect(blocks.find((b) => b.category === "parking")?.note).toBeNull();
    expect(blocks.find((b) => b.category === "restaurant")?.note).toBeNull();
    expect(blocksOf(selectPlaces([], origin, 15, "fake")).find((b) => b.category === "restaurant")?.note).toBe("Aucune adresse « Grande faim » trouvée près du lieu.");
  });

  it("le lien « Voir les avis » est une simple adresse de recherche (nom et ville) ; aucune note ni coordonnée", () => {
    const [block] = blocksOf(selectPlaces([p("Café du Coin", "parking", 0.1)], origin, 15, "fake"));
    expect(block.items[0].reviewsUrl).toBe("https://www.google.com/maps/search/?api=1&query=Caf%C3%A9%20du%20Coin%20Tours");
    expect(JSON.stringify(block)).not.toContain("lat");
  });

  it("arrondit les coordonnées envoyées au service à environ 100 m", () => {
    expect(roundedPoint({ lat: 47.61622, lon: 1.51739 })).toEqual({ lat: 47.616, lon: 1.517 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("recherche « Sur place » (US-112)", () => {
  it("CA 5.1 : une recherche aboutit avec 2 parkings, 2 « petite faim » et 2 « grande faim » ; le résultat est chiffré et daté", async () => {
    const f = await family();
    const event = await seed(f, { point: CHATEAU });
    const id = await requestPlaceSearch(at(), f.session, event, "button", new FakePlaceProvider());
    expect((await row(id)).status).toBe("queued");
    await runPlaceSearch(at(), id, new FakePlaceProvider());
    const done = await row(id);
    expect(done.status).toBe("done");
    expect(String(done.checked_on)).toContain("2054");
    expect(done.result_payload!.toString("utf8")).not.toContain("Parking");
    const view = (await placeSearchView(at(), f.session, event, new FakePlaceProvider()))!;
    expect(view).toMatchObject({ available: true, searches: 1, max: 3, latest: { status: "done" } });
    const byCategory = Object.fromEntries(view.results!.blocks.map((b) => [b.category, b.items.map((i) => i.name)]));
    expect(byCategory.parking).toEqual(["Parking d'essai des Remparts", "Parking d'essai du Marché"]); // celui de la gare est trop loin
    expect(byCategory.snack).toHaveLength(2);
    expect(byCategory.restaurant).toEqual(["Restaurant d'essai Le Donjon", "Restaurant d'essai Chez Louise"]); // un fermé, un trop loin
    expect(view.results!.blocks.every((b) => b.items.every((i) => i.walkMinutes <= 15))).toBe(true);
  });

  it("RT2 : le service ne reçoit que le lieu, des coordonnées arrondies et l'heure du RDV, jamais un prénom ni un titre", async () => {
    const f = await family();
    const event = await seed(f, { point: { lat: 47.61622, lon: 1.51739 } });
    const fake = new FakePlaceProvider();
    await search(f, event, fake);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ query: "Château de Chambord", near: { lat: 47.616, lon: 1.517 }, at: localToUtc("2054-11-10T15:00", TZ) });
    expect(JSON.stringify(fake.calls[0])).not.toContain("château du Léo");
    expect(JSON.stringify(fake.calls[0])).not.toContain("Visite");
  });

  it("un RDV avec du texte seulement (sans coordonnées) est cherché par son nom ; la distance part du repère du service", async () => {
    const f = await family();
    const event = await seed(f);
    const fake = new FakePlaceProvider();
    await search(f, event, fake);
    expect(fake.calls[0].near).toBeNull();
    expect((await placeSearchView(at(), f.session, event, fake))!.results!.blocks.find((b) => b.category === "parking")!.items).toHaveLength(2);
  });

  it("CA 10.1 : aucune information trouvée, sans résultat gardé mais avec la date de vérification", async () => {
    const f = await family();
    const event = await seed(f);
    const fake = new FakePlaceProvider();
    fake.empty = true;
    const id = await search(f, event, fake);
    expect(await row(id)).toMatchObject({ status: "no_result", result_payload: null });
    const view = (await placeSearchView(at(), f.session, event, fake))!;
    expect(view.latest?.status).toBe("no_result");
    expect(view.results?.blocks).toEqual([]);
  });

  it("CA 11.1 : service muet, la recherche échoue (service_unavailable), ne compte pas dans les 3 par RDV, et « Réessayer » est possible", async () => {
    const f = await family();
    const event = await seed(f);
    const fake = new FakePlaceProvider();
    fake.failing = true;
    const id = await search(f, event, fake);
    expect(await row(id)).toMatchObject({ status: "failed", failure_reason: "service_unavailable" });
    expect((await placeSearchView(at(), f.session, event, fake))).toMatchObject({ searches: 0, latest: { status: "failed", failureReason: "service_unavailable" } });
    fake.failing = false;
    await search(f, event, fake);
    expect((await placeSearchView(at(), f.session, event, fake))).toMatchObject({ searches: 1, latest: { status: "done" } });
  });

  it("CA 9.1 : au plus 3 recherches par RDV, avec le message « Nombre maximal de recherches pour ce RDV atteint (3). »", async () => {
    const f = await family();
    const event = await seed(f);
    for (let i = 0; i < 3; i++) await search(f, event);
    const refusal = await failure(requestPlaceSearch(at(), f.session, event, "button", new FakePlaceProvider()));
    expect(refusal).toMatchObject({ code: "event_limit", message: "Nombre maximal de recherches pour ce RDV atteint (3)." });
    expect((await placeSearchView(at(), f.session, event, new FakePlaceProvider()))).toMatchObject({ searches: 3, max: 3 });
  });

  it("RF9 : le plafond quotidien du profil compte chaque recherche, même en échec", async () => {
    const f = await family();
    await db.updateTable("accounts").set({ daily_request_limit: 2 }).where("id", "=", f.accountId).execute();
    const event = await seed(f);
    const fake = new FakePlaceProvider();
    fake.failing = true;
    await search(f, event, fake);
    await search(f, event, fake);
    expect((await failure(requestPlaceSearch(at(), f.session, event, "button", fake))).code).toBe("daily_limit");
  });

  it("CA 1.3 : jamais pour un RDV médical ; sans lieu, ni pour un RDV terminé ou introuvable", async () => {
    const f = await family();
    const medical = await seed(f, { type: "medical" });
    expect((await failure(requestPlaceSearch(at(), f.session, medical, "button", new FakePlaceProvider()))).code).toBe("medical");
    expect((await placeSearchView(at(), f.session, medical, new FakePlaceProvider()))).toMatchObject({ available: false, unavailable: "medical" });
    const noPlace = await seed(f, { place: null });
    expect((await failure(requestPlaceSearch(at(), f.session, noPlace, "button", new FakePlaceProvider()))).code).toBe("no_location");
    const ended = await seed(f, { start: "2000-01-01T10:00", end: "2000-01-01T11:00" });
    expect((await failure(requestPlaceSearch(at(), f.session, ended, "button", new FakePlaceProvider()))).code).toBe("ended");
    expect((await failure(requestPlaceSearch(at(), f.session, randomUUID(), "button", new FakePlaceProvider()))).code).toBe("not_found");
  });

  it("RF9 : si l'adresse du RDV change, le résultat est effacé (périmé) mais la recherche reste comptée", async () => {
    const f = await family();
    const event = await seed(f);
    const id = await search(f, event);
    await db.updateTable("family_events").set({ location: seal("Autre lieu") }).where("id", "=", event).execute();
    expect(await row(id)).toMatchObject({ status: "obsolete", result_payload: null, checked_on: null });
    const view = (await placeSearchView(at(), f.session, event, new FakePlaceProvider()))!;
    expect(view).toMatchObject({ searches: 1, latest: { status: "obsolete" }, results: null });
  });

  it("service fermé : rien n'est proposé ni accepté", async () => {
    const f = await family();
    const event = await seed(f);
    expect(await placeSearchView(at(), f.session, event, null)).toBeNull();
    expect((await failure(requestPlaceSearch(at(), f.session, event, "button", null))).code).toBe("place_off");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("filet de sécurité et notification (US-112 RF4, RT5)", () => {
  it("le planificateur reprend une recherche restée en attente plus de 30 secondes", async () => {
    const f = await family();
    const event = await seed(f);
    const fake = new FakePlaceProvider();
    const id = await requestPlaceSearch(at(), f.session, event, "chat", fake);
    expect((await runPlaceSearches(at(), fake)).executed).toBeGreaterThanOrEqual(0);
    expect((await row(id)).status).toBe("queued"); // trop récente
    await db.updateTable("event_place_searches").set({ queued_at: new Date(Date.now() - 60_000) }).where("id", "=", id).execute();
    await runPlaceSearches(at(), fake);
    expect((await row(id)).status).toBe("done");
  });

  it("une recherche en cours depuis plus de 120 secondes échoue (timeout), une en attente depuis 15 minutes aussi", async () => {
    const f = await family();
    const event = await seed(f);
    const running = await requestPlaceSearch(at(), f.session, event, "chat", new FakePlaceProvider());
    await db.updateTable("event_place_searches").set({ status: "running", started_at: new Date(Date.now() - 200_000) }).where("id", "=", running).execute();
    const queued = await requestPlaceSearch(at(), f.session, event, "chat", new FakePlaceProvider());
    await db.updateTable("event_place_searches").set({ queued_at: new Date(Date.now() - 20 * 60_000) }).where("id", "=", queued).execute();
    await runPlaceSearches(at(), null);
    expect(await row(running)).toMatchObject({ status: "failed", failure_reason: "timeout" });
    expect(await row(queued)).toMatchObject({ status: "failed", failure_reason: "service_unavailable" });
  });

  it("RF4 : « Où se garer et où manger près de [lieu] : le résultat est prêt. » après une recherche du bouton, une seule fois ; rien après une demande du tchat", async () => {
    const f = await family();
    const event = await seed(f);
    const fake = new FakePlaceProvider();
    await search(f, event, fake, "button");
    const first = await runPlaceSearches(at(), fake);
    expect(first.notified).toBe(1);
    expect(payloads()).toEqual([expect.objectContaining({ body: "Où se garer et où manger près de Château de Chambord : le résultat est prêt.", url: "/assistant/demande" })]);
    expect((await runPlaceSearches(at(), fake)).notified).toBe(0);
    send.mockClear();
    const other = await seed(f);
    await search(f, other, fake, "chat");
    expect((await runPlaceSearches(at(), fake)).notified).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
