import { randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATUS_CODE, TYPE_CODE } from "@/server/assistant/calendar";
import { seal } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import {
  getLocationConsent, grantLocationConsent, LOCATION_NOTICE, LOCATION_NOTICE_VERSION, readLastPosition, saveLastPosition, withdrawLocationConsent,
} from "@/server/assistant/location-consent";
import type { Ctx, SessionContext } from "@/server/auth/service";
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

// Lundi 2 novembre 2054, 09:00 à Paris (dates décalées de 28 ans : toujours dans le futur de l'horloge de la base).
const NOW = new Date("2054-11-02T08:00:00Z");
const at = (): Ctx => ({ db, now: NOW });
const point = { lat: 47.3941, lon: 0.6848 };

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Un profil avec un vrai appareil en base (le consentement y est rattaché par clé étrangère). */
async function profile(accountId?: string): Promise<{ session: SessionContext; userId: string; accountId: string }> {
  const user = accountId ? await createGuest(db, accountId, "Marc", "core") : await createProfile(db);
  const session = await sessionFor(db, user.id);
  await db.insertInto("devices").values({ id: session.device.id, user_id: user.id, device_type: "android", browser: "Chrome" }).execute();
  return { session, userId: user.id, accountId: user.accountId ?? accountId! };
}

const journal = (deviceId: string) => db.selectFrom("device_location_consent_events").select(["action", "cause", "notice_version", "user_id", "retain_until"]).where("device_id", "=", deviceId).orderBy("id").execute();
const positions = (deviceId: string) => db.selectFrom("device_last_positions").selectAll().where("device_id", "=", deviceId).execute();

describe("consentement à la position (US-107 RF11, RT5)", () => {
  it("CA 11.1 : jamais autorisée au départ ; le texte à montrer avant la demande du téléphone est celui validé par le DPO", async () => {
    const p = await profile();
    const consent = await getLocationConsent(at(), p.session);
    expect(consent.status).toBe("none");
    expect(consent.notice).toMatchObject({ version: LOCATION_NOTICE_VERSION, text: LOCATION_NOTICE });
    expect(consent.notice.text).toBe("MAAQ lit votre position seulement quand l'application est ouverte, pour estimer votre trajet avant un RDV que vous suivez. Votre dernière position est gardée au plus 3 heures.");
  });

  it("l'accord est inscrit au journal (appareil, profil, version du texte, durée de conservation de 5 ans) une seule fois", async () => {
    const p = await profile();
    const granted = await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    expect(granted.status).toBe("active");
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    const rows = await journal(p.session.device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "granted", cause: "user_action", notice_version: LOCATION_NOTICE_VERSION, user_id: p.userId });
    const years = (new Date(rows[0].retain_until).getTime() - Date.now()) / (365.25 * 86_400_000);
    expect(years).toBeGreaterThan(4.9);
    expect(years).toBeLessThan(5.1);
  });

  it("refuse l'accord si le texte a changé depuis l'écran montré", async () => {
    const p = await profile();
    expect((await failure(grantLocationConsent(at(), p.session, "2020-01"))).code).toBe("notice_changed");
    expect((await getLocationConsent(at(), p.session)).status).toBe("none");
  });

  it("le retrait est inscrit au journal, efface la dernière position aussitôt, et l'accord peut être redonné", async () => {
    const p = await profile();
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    await saveLastPosition(at(), p.session, point);
    expect(await positions(p.session.device.id)).toHaveLength(1);
    const withdrawn = await withdrawLocationConsent(at(), p.session);
    expect(withdrawn.status).toBe("withdrawn");
    expect(await positions(p.session.device.id)).toHaveLength(0);
    expect(await readLastPosition(at(), p.session)).toBeNull();
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    expect((await journal(p.session.device.id)).map((r) => r.action)).toEqual(["granted", "withdrawn", "granted"]);
  });

  it("un texte devenu plus ancien que le courant demande un nouvel accord, inscrit au journal", async () => {
    const p = await profile();
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    await db.updateTable("device_location_consents").set({ notice_version: "2020-01" }).where("device_id", "=", p.session.device.id).execute();
    expect((await getLocationConsent(at(), p.session)).status).toBe("outdated");
    expect((await failure(saveLastPosition(at(), p.session, point))).code).toBe("no_location_consent");
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    expect((await getLocationConsent(at(), p.session)).status).toBe("active");
    expect((await journal(p.session.device.id)).at(-1)).toMatchObject({ action: "granted", notice_version: LOCATION_NOTICE_VERSION });
  });

  it("un appareil révoqué perd son consentement (cause « appareil révoqué ») et sa dernière position", async () => {
    const p = await profile();
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    await saveLastPosition(at(), p.session, point);
    await db.updateTable("devices").set({ revoked_at: new Date() }).where("id", "=", p.session.device.id).execute();
    expect(await positions(p.session.device.id)).toHaveLength(0);
    expect((await journal(p.session.device.id)).at(-1)).toMatchObject({ action: "withdrawn", cause: "device_revoked" });
  });

  it("un appareil supprimé laisse la preuve du retrait au journal (sans clé étrangère)", async () => {
    const p = await profile();
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    await db.deleteFrom("devices").where("id", "=", p.session.device.id).execute();
    expect((await journal(p.session.device.id)).map((r) => [r.action, r.cause])).toEqual([["granted", "user_action"], ["withdrawn", "device_deleted"]]);
  });
});

describe("dernière position (US-107 RF11, RF12, CA 12.1, CA 12.2)", () => {
  it("refusée sans accord actif", async () => {
    const p = await profile();
    expect((await failure(saveLastPosition(at(), p.session, point))).code).toBe("no_location_consent");
    expect(await positions(p.session.device.id)).toHaveLength(0);
  });

  it("gardée chiffrée, 3 heures au plus, et remplacée à chaque lecture (une seule ligne)", async () => {
    const p = await profile();
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    await saveLastPosition(at(), p.session, point);
    await saveLastPosition(at(), p.session, { lat: 48.8566, lon: 2.3522 });
    const rows = await positions(p.session.device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].position_encrypted.toString("utf8")).not.toContain("48.85");
    expect(new Date(rows[0].expires_at).getTime() - NOW.getTime()).toBe(3 * 3_600_000);
    expect(await readLastPosition(at(), p.session)).toEqual({ lat: 48.8566, lon: 2.3522 });
  });

  it("jamais au-delà de la fin du RDV suivi ; rien n'est gardé pour un RDV terminé", async () => {
    const p = await profile();
    const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE.personal).executeTakeFirstOrThrow();
    const event = async (start: string, end: string) => {
      const row = await db
        .insertInto("family_events")
        .values({
          account_id: p.accountId, event_type_id: type.id, title: seal("Foot"), starts_at: localToUtc(start, "Europe/Paris"), ends_at: localToUtc(end, "Europe/Paris"), status: STATUS_CODE.confirmed,
          source: "chat_text", whole_family: true, requested_by_user_id: p.userId, fingerprint: randomBytes(16), confirmed_at: NOW, confirmed_by_user_id: p.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    };
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    const soon = await event("2054-11-02T10:00", "2054-11-02T11:00"); // fin à 11 h à Paris = 10 h UTC, dans 2 h
    expect(await saveLastPosition(at(), p.session, point, { eventId: soon })).toBe(true);
    expect(new Date((await positions(p.session.device.id))[0].expires_at).toISOString()).toBe("2054-11-02T10:00:00.000Z");
    const over = await event("2054-11-02T08:00", "2054-11-02T09:00"); // terminé depuis 9 h à Paris (8 h UTC) : rien n'est gardé
    expect(await saveLastPosition(at(), p.session, point, { eventId: over })).toBe(false);
  });

  it("CA 12.1 : jamais lisible par un autre profil ni un autre appareil", async () => {
    const julien = await profile();
    const camille = await profile(julien.accountId);
    await grantLocationConsent(at(), julien.session, LOCATION_NOTICE_VERSION);
    await grantLocationConsent(at(), camille.session, LOCATION_NOTICE_VERSION);
    await saveLastPosition(at(), julien.session, point);
    expect(await readLastPosition(at(), julien.session)).toEqual(point);
    expect(await readLastPosition(at(), camille.session)).toBeNull();
  });

  it("CA 12.2 : une position échue n'est plus utilisée, et la purge l'efface", async () => {
    const p = await profile();
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    const old = new Date("2000-01-01T10:00:00Z");
    await db.insertInto("device_last_positions").values({ device_id: p.session.device.id, position_encrypted: seal("{}"), captured_at: old, expires_at: new Date(old.getTime() + 3_600_000) }).execute();
    expect(await readLastPosition(at(), p.session)).toBeNull();
    const purged = await db.selectNoFrom((eb) => eb.fn<number>("purge_expired_device_positions", []).as("n")).executeTakeFirstOrThrow();
    expect(Number(purged.n)).toBeGreaterThanOrEqual(1);
    expect(await positions(p.session.device.id)).toHaveLength(0);
  });

  it("refuse une position absurde, et un RDV inconnu", async () => {
    const p = await profile();
    await grantLocationConsent(at(), p.session, LOCATION_NOTICE_VERSION);
    expect((await failure(saveLastPosition(at(), p.session, { lat: 300, lon: 0 }))).code).toBe("invalid_position");
    expect((await failure(saveLastPosition(at(), p.session, point, { eventId: randomUUID() }))).code).toBe("not_found");
  });

  it("un administrateur sans foyer n'a ni consentement ni position", async () => {
    const p = await profile();
    const admin = { ...p.session, user: { ...p.session.user, accountId: null, role: "admin" as const } };
    expect((await failure(getLocationConsent(at(), admin))).code).toBe("forbidden");
  });
});
