import { randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import webpush from "web-push";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addChild } from "@/server/assistant/family";
import { seal, sealOptional } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import { pendingConfirmations, runReminders } from "@/server/assistant/reminders";
import { logout, type Ctx, type SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { actorOf, revokeDevice } from "@/server/devices/service";
import { Rejection } from "@/server/http";
import { endpointHash, isPushEndpoint, pushStatus, removeSubscription, saveSubscription, sendPush } from "@/server/push/service";
import { createGuest, createProfile, messagesTo, sessionFor, testDb } from "./helpers/fixtures";

// Les clés ne servent à rien ici : l'envoi est simulé. Elles doivent seulement exister pour que les notifications soient « configurées ».
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
const paris = (local: string) => localToUtc(local, TZ);
const ctxAt = (local: string): Ctx => ({ db, now: paris(local) });
const fcm = (id = randomUUID()) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Session d'un profil sur un vrai appareil (les abonnements en dépendent). */
async function onDevice(userId: string): Promise<SessionContext> {
  const session = await sessionFor(db, userId);
  await db.insertInto("devices").values({ id: session.device.id, user_id: userId, device_type: "iphone" }).execute();
  return session;
}

async function family() {
  const camille = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Camille" }).where("id", "=", camille.id).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const camilleSession = await onDevice(camille.id);
  const leo = await addChild(ctxAt("2054-11-02T09:00"), camilleSession, { firstName: "Léo" });
  return { accountId: camille.accountId!, camille, julien, camilleSession, julienSession: await onDevice(julien.id), leoId: leo.id };
}
type Family = Awaited<ReturnType<typeof family>>;

async function seed(f: Family, s: { start: string; status?: "confirmed" | "provisional"; type?: "medical" | "school"; place?: string; title?: string; created?: string }): Promise<string> {
  const created = paris(s.created ?? "2054-10-01T09:00");
  const start = paris(s.start);
  const type = await db.selectFrom("event_types").select("id").where("code", "=", s.type ?? "medical").executeTakeFirstOrThrow();
  const status = s.status ?? "confirmed";
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, title: seal(s.title ?? "RDV médical — Léo"), event_type_id: type.id, starts_at: start, ends_at: new Date(start.getTime() + 3_600_000),
      location: sealOptional(s.place), status, source: "chat_text", requested_by_user_id: f.camille.id, created_at: created, updated_at: created, fingerprint: randomBytes(16),
      ...(status === "confirmed" ? { confirmed_at: created, confirmed_by_user_id: f.camille.id } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.insertInto("family_event_members").values({ event_id: row.id, member_id: f.leoId, account_id: f.accountId }).execute();
  return row.id;
}

const run = (f: Family, local: string) => runReminders(ctxAt(local), { accountId: f.accountId });
const payloadOf = (call: number) => JSON.parse(send.mock.calls[call][1] as string) as { title: string; body: string; url: string; tag: string; badge: number };

describe("adresses des services de notification (SSRF)", () => {
  it("n'accepte que les services connus, en https et sans identifiants", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/QGx", "https://wns2-par02p.notify.windows.com/w/?token=x"]) {
      expect(isPushEndpoint(ok), ok).toBe(true);
    }
    for (const bad of ["http://fcm.googleapis.com/x", "https://example.com/x", "https://fcm.googleapis.com.evil.test/x", "https://evil.test/fcm.googleapis.com", "https://user:pw@fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://localhost/x", "pas une adresse"]) {
      expect(isPushEndpoint(bad), bad).toBe(false);
    }
  });
});

describe("abonnement d'un appareil (US-94)", () => {
  it("inscrit l'appareil, le reconnaît, et le désinscrit (RF4)", async () => {
    const f = await family();
    expect(await pushStatus(ctxAt("2054-11-02T09:00"), f.camilleSession)).toMatchObject({ configured: true, subscribed: false });
    await saveSubscription(ctxAt("2054-11-02T09:00"), f.camilleSession, fcm());
    expect((await pushStatus(ctxAt("2054-11-02T09:00"), f.camilleSession)).subscribed).toBe(true);
    expect((await pushStatus(ctxAt("2054-11-02T09:00"), f.julienSession)).subscribed).toBe(false); // l'autorisation est propre à chaque appareil (RF8)
    await removeSubscription(ctxAt("2054-11-02T09:00"), f.camilleSession);
    expect((await pushStatus(ctxAt("2054-11-02T09:00"), f.camilleSession)).subscribed).toBe(false);
  });

  it("refuse un abonnement invalide ou vers une adresse inconnue", async () => {
    const f = await family();
    const now = ctxAt("2054-11-02T09:00");
    expect((await failure(saveSubscription(now, f.camilleSession, { ...fcm(), endpoint: "https://example.com/x" }))).code).toBe("invalid_subscription");
    expect((await failure(saveSubscription(now, f.camilleSession, { endpoint: fcm().endpoint, keys: { p256dh: "x", auth: "y" } }))).code).toBe("invalid_subscription");
    expect((await pushStatus(now, f.camilleSession)).subscribed).toBe(false);
  });

  it("réenregistre sans doublon, et rattache l'adresse à l'appareil qui l'envoie", async () => {
    const f = await family();
    const now = ctxAt("2054-11-02T09:00");
    const sub = fcm();
    await saveSubscription(now, f.camilleSession, sub);
    await saveSubscription(now, f.camilleSession, sub);
    await saveSubscription(now, f.julienSession, sub); // un téléphone passé d'un profil à l'autre
    const rows = await db.selectFrom("push_subscriptions").select("device_id").where("endpoint_hash", "=", endpointHash(sub.endpoint)).execute();
    expect(rows).toEqual([{ device_id: f.julienSession.device.id }]);
  });

  it("désinscrit l'appareil à la déconnexion et à la révocation (CA 9.1)", async () => {
    const f = await family();
    const now = ctxAt("2054-11-02T09:00");
    await saveSubscription(now, f.julienSession, fcm());
    await logout(now, f.julienSession);
    expect((await pushStatus(now, f.julienSession)).subscribed).toBe(false);

    const second = await onDevice(f.camille.id);
    await saveSubscription(now, f.camilleSession, fcm());
    await saveSubscription(now, second, fcm());
    await revokeDevice(now, actorOf(f.camilleSession), second.device.id);
    expect((await pushStatus(now, second)).subscribed).toBe(false);
    expect((await pushStatus(now, f.camilleSession)).subscribed).toBe(true); // l'autre appareil garde ses notifications
  });
});

describe("envoi aux appareils d'un profil (US-81 RF6, RT4)", () => {
  it("joint chaque appareil autorisé, et pas un appareil révoqué (CA 8.1)", async () => {
    const f = await family();
    const now = ctxAt("2054-11-02T09:00");
    const tablet = await onDevice(f.camille.id);
    const old = await onDevice(f.camille.id);
    await saveSubscription(now, f.camilleSession, fcm());
    await saveSubscription(now, tablet, fcm());
    await saveSubscription(now, old, fcm());
    await db.updateTable("devices").set({ revoked_at: now.now }).where("id", "=", old.device.id).execute();
    const payload = { title: "Assistant Famille", body: "Demain 17h00 — RDV médical — Léo", url: "/calendrier/rdv/x", tag: "d1-x", badge: 2 };
    expect(await sendPush(now, f.camille.id, payload)).toEqual({ attempted: 2, delivered: 2 });
    expect(JSON.parse(send.mock.calls[0][1] as string)).toEqual(payload);
    expect(send.mock.calls[0][2]).toMatchObject({ urgency: "high", TTL: expect.any(Number) });
    expect(await sendPush(now, f.julien.id, payload)).toEqual({ attempted: 0, delivered: 0 }); // aucun appareil autorisé
  });

  it("supprime un abonnement qui n'existe plus (404, 410) sans toucher aux autres (RT4)", async () => {
    const f = await family();
    const now = ctxAt("2054-11-02T09:00");
    const dead = fcm();
    const alive = fcm();
    await saveSubscription(now, f.camilleSession, dead);
    await saveSubscription(now, await onDevice(f.camille.id), alive);
    send.mockImplementation(async (sub) => {
      if (sub.endpoint === dead.endpoint) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      return { statusCode: 201, body: "", headers: {} };
    });
    expect(await sendPush(now, f.camille.id, { title: "t", body: "b", url: "/", tag: "x", badge: 0 })).toEqual({ attempted: 2, delivered: 1 });
    expect((await db.selectFrom("push_subscriptions").select("endpoint_hash").where("endpoint_hash", "in", [endpointHash(dead.endpoint), endpointHash(alive.endpoint)]).execute()).map((r) => r.endpoint_hash)).toEqual([endpointHash(alive.endpoint)]);
    expect(send).toHaveBeenCalledTimes(2); // pas de nouvel essai pour un abonnement disparu
  });

  it("retente une fois après une erreur temporaire, sans désinscrire (RT4)", async () => {
    const f = await family();
    const now = ctxAt("2054-11-02T09:00");
    await saveSubscription(now, f.camilleSession, fcm());
    send.mockRejectedValueOnce(Object.assign(new Error("indisponible"), { statusCode: 503 }));
    expect(await sendPush(now, f.camille.id, { title: "t", body: "b", url: "/", tag: "x", badge: 0 })).toEqual({ attempted: 1, delivered: 1 });
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockRejectedValue(Object.assign(new Error("indisponible"), { statusCode: 500 }));
    expect(await sendPush(now, f.camille.id, { title: "t", body: "b", url: "/", tag: "x", badge: 0 })).toEqual({ attempted: 1, delivered: 0 });
    expect(send).toHaveBeenCalledTimes(2); // un seul nouvel essai
    quiet.mockRestore();
    expect((await pushStatus(now, f.camilleSession)).subscribed).toBe(true);
  });

  it("ne retente pas un refus qui tient à notre configuration (403)", async () => {
    const f = await family();
    const now = ctxAt("2054-11-02T09:00");
    await saveSubscription(now, f.camilleSession, fcm());
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockRejectedValue(Object.assign(new Error("VAPID refusé"), { statusCode: 403 }));
    expect(await sendPush(now, f.camille.id, { title: "t", body: "b", url: "/", tag: "x", badge: 0 })).toEqual({ attempted: 1, delivered: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
    expect((await pushStatus(now, f.camilleSession)).subscribed).toBe(true);
  });
});

describe("rappels par notification, avec repli par email (US-81 RF6, RF11, AF-3)", () => {
  it("envoie la notification à la place de l'email, avec le lien du RDV et le badge (CA 4.1, US-84 RT2)", async () => {
    const f = await family();
    await saveSubscription(ctxAt("2054-11-02T09:00"), f.camilleSession, fcm());
    await seed(f, { start: "2054-11-10T14:00", type: "school", place: "École Jules Ferry", title: "Spectacle" });
    await seed(f, { start: "2054-11-12T10:00", status: "provisional", created: "2054-11-09T09:00", title: "En attente" });
    await seed(f, { start: "2054-11-13T10:00", status: "provisional", created: "2054-11-09T09:00", title: "Aussi en attente" });
    await run(f, "2054-11-10T07:30");
    expect(send).toHaveBeenCalledTimes(1);
    const eventId = (await db.selectFrom("family_events").select("id").where("account_id", "=", f.accountId).where("status", "=", "confirmed").executeTakeFirstOrThrow()).id;
    expect(payloadOf(0)).toEqual({ title: "Assistant Famille", body: "Aujourd'hui 14h00 — Spectacle\nÉcole Jules Ferry", url: `/calendrier/rdv/${eventId}`, tag: `d0-${eventId}`, badge: 2 });
    expect(await messagesTo(f.camille.email)).toHaveLength(0); // Camille a un appareil autorisé : pas d'email
    expect(await messagesTo(f.julien.email)).toHaveLength(1); // Julien n'en a pas : email (CA 6.1)
    const rows = await db.selectFrom("scheduled_notifications").select(["recipient_user_id", "push_sent_at", "email_sent_at", "status"]).where("event_id", "=", eventId).execute();
    const via = (id: string) => {
      const r = rows.find((x) => x.recipient_user_id === id)!;
      return { push: r.push_sent_at !== null, email: r.email_sent_at !== null, status: r.status };
    };
    expect(via(f.camille.id)).toEqual({ push: true, email: false, status: "sent" });
    expect(via(f.julien.id)).toEqual({ push: false, email: true, status: "sent" });
    expect(await pendingConfirmations(db, f.accountId, paris("2054-11-10T07:30"))).toBe(2);
  });

  it("n'inclut pas le lieu d'un RDV médical dans la notification (D31)", async () => {
    const f = await family();
    await saveSubscription(ctxAt("2054-11-02T09:00"), f.camilleSession, fcm());
    await seed(f, { start: "2054-11-10T14:00", type: "medical", place: "Cabinet du Dr Martin" });
    await run(f, "2054-11-10T07:30");
    expect(payloadOf(0).body).toBe("Aujourd'hui 14h00 — RDV médical — Léo");
  });

  it("double le rappel J-1 par un email, pas les autres (CA 6.2)", async () => {
    const f = await family();
    await saveSubscription(ctxAt("2054-11-02T09:00"), f.camilleSession, fcm());
    await seed(f, { start: "2054-11-10T17:00" });
    await run(f, "2054-11-09T18:00");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await messagesTo(f.camille.email)).toHaveLength(1);
    const [row] = await db.selectFrom("scheduled_notifications").select(["push_sent_at", "email_sent_at"]).where("recipient_user_id", "=", f.camille.id).execute();
    expect([row.push_sent_at !== null, row.email_sent_at !== null]).toEqual([true, true]); // notification et email
  });

  it("passe par l'email quand la notification n'est pas partie (CA 11.1)", async () => {
    const f = await family();
    await saveSubscription(ctxAt("2054-11-02T09:00"), f.camilleSession, fcm());
    await seed(f, { start: "2054-11-10T14:00" });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockRejectedValue(Object.assign(new Error("Gone"), { statusCode: 410 }));
    await run(f, "2054-11-10T07:30");
    quiet.mockRestore();
    expect(await messagesTo(f.camille.email)).toHaveLength(1);
    expect((await pushStatus(ctxAt("2054-11-10T07:30"), f.camilleSession)).subscribed).toBe(false); // l'appareil injoignable est désinscrit
  });

  it("ne renvoie pas la notification quand seul l'email de J-1 échoue", async () => {
    const f = await family();
    await saveSubscription(ctxAt("2054-11-02T09:00"), f.camilleSession, fcm());
    await seed(f, { start: "2054-11-10T17:00" });
    const { messenger } = await import("@/server/adapters/messaging");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const mail = vi.spyOn(messenger(), "sendEmail").mockRejectedValueOnce(new Error("SMTP indisponible"));
    try {
      await run(f, "2054-11-09T18:00");
    } finally {
      mail.mockRestore();
      quiet.mockRestore();
    }
    expect(send).toHaveBeenCalledTimes(1);
    await run(f, "2054-11-09T18:05");
    expect(send).toHaveBeenCalledTimes(1); // pas de doublon de notification
    const [row] = await db.selectFrom("scheduled_notifications").select(["status", "push_sent_at", "email_sent_at"]).where("recipient_user_id", "=", f.camille.id).execute();
    expect([row.status, row.push_sent_at !== null, row.email_sent_at !== null]).toEqual(["sent", true, false]);
  });

  it("relance aussi par notification, et ouvre l'écran de confirmation (US-83 RF7, CA 3.1)", async () => {
    const f = await family();
    await saveSubscription(ctxAt("2054-11-02T09:00"), f.camilleSession, fcm());
    const id = await seed(f, { start: "2054-11-06T17:00", status: "provisional", created: "2054-11-02T10:00" });
    await run(f, "2054-11-03T10:00");
    expect(payloadOf(0)).toMatchObject({ body: "À confirmer : RDV médical — Léo, vendredi 17h00", url: `/calendrier/rdv/${id}`, tag: `nudge24-${id}`, badge: 1 });
    expect(await messagesTo(f.camille.email)).toHaveLength(0);
    expect(await messagesTo(f.julien.email)).toHaveLength(1);
  });
});
