import { randomBytes, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { STATUS_CODE, TYPE_CODE, type EventStatus, type EventType } from "@/server/assistant/calendar";
import { currentDigestWeek, digestBody, digestSlot, getDigest, mondayAfter, prepareDigest, runDigests } from "@/server/assistant/digest";
import { addChild } from "@/server/assistant/family";
import { seal } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import type { AssistantModel } from "@/server/assistant/model";
import { getPersonalSettings, setPersonalSettings } from "@/server/assistant/notices";
import { runTaskNotices, taskDailyBody, taskSoonBody } from "@/server/assistant/task-notices";
import { assignTask, createTask, setTaskDone, updateTask } from "@/server/assistant/tasks";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { saveSubscription } from "@/server/push/service";
import { createGuest, createProfile, messagesTo, sessionFor, testDb } from "./helpers/fixtures";

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
// Mercredi 4 novembre 2054. Paris est à UTC+1 (heure d'hiver) : 8 h 05 locales = 07:05 UTC.
const at = (iso: string): Ctx => ({ get db() { return db; }, now: new Date(iso) }) as Ctx;
const NOON = at("2054-11-04T07:05:00Z");
const payloads = () => send.mock.calls.map((c) => ({ endpoint: String(c[0].endpoint), ...(JSON.parse(c[1] as string) as { body: string; tag: string; url: string }) }));
const fcm = () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
/** Notifications reçues par un profil : l'appareil porte son adresse, retrouvée par l'abonnement. */
const bodiesFor = (endpoints: Set<string>) => payloads().filter((p) => endpoints.has(p.endpoint)).map((p) => p.body);

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

/** Foyer : Camille (principale), Julien (invité 1), Élodie (invitée secondaire, sans appareil), Léo et Mia. */
async function family() {
  const camille = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Camille" }).where("id", "=", camille.id).execute();
  await db.updateTable("accounts").set({ family_timezone: TZ }).where("id", "=", camille.accountId!).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const camilleSession = await onDevice(camille.id);
  const julienSession = await onDevice(julien.id);
  const elodieSession = await sessionFor(db, elodie.id);
  const camilleSub = fcm();
  const julienSub = fcm();
  await saveSubscription(NOON, camilleSession, camilleSub);
  await saveSubscription(NOON, julienSession, julienSub);
  const leo = await addChild(NOON, camilleSession, { firstName: "Léo" });
  const mia = await addChild(NOON, camilleSession, { firstName: "Mia" });
  const member = async (userId: string) => (await db.selectFrom("family_members").select("id").where("user_id", "=", userId).executeTakeFirstOrThrow()).id;
  const f = {
    accountId: camille.accountId!, camille, julien, elodie, camilleSession, julienSession, elodieSession, leoId: leo.id, miaId: mia.id,
    memberIds: { camille: await member(camille.id), julien: await member(julien.id), elodie: await member(elodie.id) },
    devices: { camille: new Set([camilleSub.endpoint]), julien: new Set([julienSub.endpoint]) },
  };
  send.mockClear();
  return f;
}
type Family = Awaited<ReturnType<typeof family>>;

const task = (f: Family, session: SessionContext, input: Parameters<typeof createTask>[2]) => createTask(at("2054-11-03T09:00:00Z"), session, input);

// ---------------------------------------------------------------------------------------------------------------------------
describe("rappel quotidien des tâches (US-97)", () => {
  it("un seul rappel regroupé à 8 h, sans le mot « retard », avec ce qui concerne le profil (CA 1.1, 2.1, 2.2)", async () => {
    const f = await family();
    await task(f, f.camilleSession, { title: "Sortir les poubelles", due: "2054-11-04", assigneeId: f.memberIds.camille });
    await task(f, f.camilleSession, { title: "Payer la cantine", due: "2054-11-02", assigneeId: f.memberIds.camille });
    await task(f, f.camilleSession, { title: "Acheter le cadeau", due: "2054-11-04", assigneeId: f.memberIds.julien });
    await task(f, f.camilleSession, { title: "Préparer son sac", due: "2054-11-04", assigneeId: f.miaId });
    send.mockClear();
    expect(await runTaskNotices(at("2054-11-04T06:55:00Z"), { accountId: f.accountId })).toMatchObject({ daily: 0 }); // 7 h 55 : trop tôt
    const done = await runTaskNotices(NOON, { accountId: f.accountId });
    expect(done.daily).toBe(2);
    const camille = bodiesFor(f.devices.camille);
    expect(camille).toHaveLength(1);
    expect(camille[0]).toContain("Sortir les poubelles");
    expect(camille[0]).toContain("Payer la cantine (prévue le 02/11)");
    expect(camille[0]).toContain("Préparer son sac — Mia"); // un enfant sans compte : suivi par les deux parents
    expect(camille[0]).not.toContain("Acheter le cadeau"); // la tâche de l'autre parent
    expect(camille[0]).not.toMatch(/retard/i);
    const julien = bodiesFor(f.devices.julien);
    expect(julien).toHaveLength(1);
    expect(julien[0]).toContain("Acheter le cadeau");
    expect(julien[0]).toContain("Préparer son sac — Mia");
    expect(julien[0]).not.toContain("Sortir les poubelles");
    expect(payloads()[0].url).toBe("/assistant/taches#aujourdhui");
    // Le planificateur s'exécute deux fois de suite : pas de doublon (CA 9.1).
    await runTaskNotices(NOON, { accountId: f.accountId });
    await runTaskNotices(at("2054-11-04T07:50:00Z"), { accountId: f.accountId });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rien quand il n'y a rien à rappeler, et un email quotidien sans appareil autorisé (CA 3.1, 7.1)", async () => {
    const f = await family();
    await task(f, f.camilleSession, { title: "Un", due: "2054-11-04", assigneeId: f.memberIds.camille });
    await task(f, f.camilleSession, { title: "Pour Élodie", due: "2054-11-04", assigneeId: f.memberIds.elodie });
    send.mockClear();
    await runTaskNotices(NOON, { accountId: f.accountId });
    expect(bodiesFor(f.devices.julien)).toEqual([]); // Julien : rien d'assigné à lui, aucune tâche sans assigné → rien (CA 3.1)
    const mails = await messagesTo(f.elodie.email);
    expect(mails.filter((m) => m.subject?.startsWith("Aujourd'hui"))).toHaveLength(1);
    expect(await messagesTo(f.camille.email).then((m) => m.filter((x) => x.subject?.includes("Aujourd")))).toHaveLength(0); // jamais doublé par email pour qui a un appareil
  });

  it("une tâche en retard figure 7 jours au plus (CA 6.1)", async () => {
    const f = await family();
    await task(f, f.camilleSession, { title: "Il y a sept jours", due: "2054-10-28", assigneeId: f.memberIds.camille });
    await task(f, f.camilleSession, { title: "Il y a huit jours", due: "2054-10-27", assigneeId: f.memberIds.camille });
    send.mockClear();
    await runTaskNotices(NOON, { accountId: f.accountId });
    const [body] = bodiesFor(f.devices.camille);
    expect(body).toContain("Il y a sept jours");
    expect(body).not.toContain("Il y a huit jours");
    expect(body).toMatch(/^Quand vous avez un moment/); // rien d'échu aujourd'hui : aucun mot de reproche
  });

  it("se désactive pour soi seul (CA 8.1)", async () => {
    const f = await family();
    await task(f, f.camilleSession, { title: "Un", due: "2054-11-04", assigneeId: f.memberIds.camille });
    await task(f, f.camilleSession, { title: "Deux", due: "2054-11-04", assigneeId: f.memberIds.julien });
    await setPersonalSettings(NOON, f.camilleSession, { taskDaily: false });
    send.mockClear();
    await runTaskNotices(NOON, { accountId: f.accountId });
    expect(bodiesFor(f.devices.camille)).toEqual([]);
    expect(bodiesFor(f.devices.julien)).toHaveLength(1);
  });

  it("un rappel qui n'a pas pu partir avant midi est abandonné, sans être retenté (RF9, CA 9.2)", async () => {
    const f = await family();
    await task(f, f.camilleSession, { title: "Un", due: "2054-11-04", assigneeId: f.memberIds.camille });
    send.mockClear();
    await runTaskNotices(at("2054-11-04T12:30:00Z"), { accountId: f.accountId }); // 13 h 30 à Paris : incident de 8 h à 13 h
    expect(send).not.toHaveBeenCalled();
    await runTaskNotices(at("2054-11-04T12:40:00Z"), { accountId: f.accountId });
    expect(send).not.toHaveBeenCalled();
    const row = await db.selectFrom("scheduled_notifications").select("status").where("kind", "=", "task_daily").where("recipient_user_id", "=", f.camille.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("abandoned");
    // Avant midi, un rappel en retard part dès que possible (RF9).
    await task(f, f.julienSession, { title: "Pour Julien", due: "2054-11-04", assigneeId: f.memberIds.julien });
    send.mockClear();
    await runTaskNotices(at("2054-11-04T10:30:00Z"), { accountId: f.accountId }); // 11 h 30
    expect(bodiesFor(f.devices.julien)).toHaveLength(1);
    expect(bodiesFor(f.devices.camille)).toHaveLength(0); // le rappel de Camille est abandonné pour la journée
  });

  it("une heure avant l'heure d'échéance, si la tâche n'est pas faite (RF4, CA 4.1)", async () => {
    const f = await family();
    const sac = await task(f, f.camilleSession, { title: "Préparer le sac de piscine", due: "2054-11-04", dueTime: "18:00", assigneeId: f.miaId });
    const own = await task(f, f.camilleSession, { title: "Appeler le dentiste", due: "2054-11-04", dueTime: "18:00", assigneeId: f.memberIds.julien });
    send.mockClear();
    expect((await runTaskNotices(at("2054-11-04T15:55:00Z"), { accountId: f.accountId })).dueSoon).toBe(0); // 16 h 55 : trop tôt
    const done = await runTaskNotices(at("2054-11-04T16:05:00Z"), { accountId: f.accountId }); // 17 h 05
    expect(done.dueSoon).toBe(3); // le sac de Mia chez les deux parents, l'appel de Julien chez Julien
    expect(bodiesFor(f.devices.camille).filter((b) => b.startsWith("Dans"))).toEqual(["Dans 1 h : Préparer le sac de piscine — Mia"]);
    expect(bodiesFor(f.devices.julien).filter((b) => b.startsWith("Dans")).sort()).toEqual(["Dans 1 h : Appeler le dentiste", "Dans 1 h : Préparer le sac de piscine — Mia"]);
    // Une tâche déjà faite n'est pas rappelée.
    await setTaskDone(at("2054-11-04T16:10:00Z"), f.camilleSession, sac.id, true);
    send.mockClear();
    await runTaskNotices(at("2054-11-04T16:20:00Z"), { accountId: f.accountId });
    expect(send).not.toHaveBeenCalled();
    expect(own.id).toBeTruthy();
  });

  it("textes : « Dans 1 h », au plus trois titres, « si vous avez un moment » seulement avec du passé", () => {
    expect(taskSoonBody("Préparer le sac", "Mia", 60)).toBe("Dans 1 h : Préparer le sac — Mia");
    expect(taskSoonBody("Appel", null, 20)).toBe("Dans 20 min : Appel");
    const four = ["A", "B", "C", "D"].map((title) => ({ title, due: "2054-11-04", other: null }));
    expect(taskDailyBody(four, "2054-11-04")).toBe("Aujourd'hui : 4 tâches — A, B, C et 1 autre.");
    expect(taskDailyBody([{ title: "A", due: "2054-11-04", other: null }, { title: "B", due: "2054-10-23", other: null }], "2054-11-04")).toBe("Aujourd'hui : 2 tâches — A et B (prévue le 23/10), si vous avez un moment.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("« [Prénom] vous a confié… » (US-96 RF4, RF6)", () => {
  it("prévient le nouveau membre assigné, jamais l'ancien ni soi-même ni un enfant (CA 4.1, 6.1)", async () => {
    const f = await family();
    const now = at("2054-11-04T09:00:00Z");
    const t = await createTask(now, f.camilleSession, { title: "Acheter un cadeau", due: "2054-11-05", assigneeId: f.memberIds.julien });
    expect(bodiesFor(f.devices.julien)).toEqual(["Camille vous a confié : Acheter un cadeau, avant demain"]);
    send.mockClear();
    // Julien se la réassigne à Camille : Camille est prévenue, Julien non.
    await assignTask(now, f.julienSession, t.id, f.memberIds.camille);
    expect(bodiesFor(f.devices.camille)).toEqual(["Julien vous a confié : Acheter un cadeau, avant demain"]);
    expect(bodiesFor(f.devices.julien)).toEqual([]);
    send.mockClear();
    await assignTask(now, f.camilleSession, t.id, f.memberIds.camille); // à soi-même : rien
    await assignTask(now, f.camilleSession, t.id, f.miaId); // un enfant sans compte : rien
    await assignTask(now, f.camilleSession, t.id, null);
    expect(send).not.toHaveBeenCalled();
    // Modifier la personne par le formulaire prévient aussi.
    const fresh = await db.selectFrom("family_tasks").select("version").where("id", "=", t.id).executeTakeFirstOrThrow();
    await updateTask(at("2054-11-04T09:30:00Z"), f.camilleSession, t.id, { title: "Acheter un cadeau", due: "2054-11-09", assigneeId: f.memberIds.julien }, { expectedVersion: fresh.version });
    expect(bodiesFor(f.devices.julien)).toEqual(["Camille vous a confié : Acheter un cadeau, avant lundi"]);
  });

  it("un invité secondaire sans appareil reçoit un email", async () => {
    const f = await family();
    await createTask(at("2054-11-04T09:00:00Z"), f.camilleSession, { title: "Ranger sa chambre", due: "2054-11-04", assigneeId: f.memberIds.elodie });
    const mails = await messagesTo(f.elodie.email);
    expect(mails.filter((m) => m.subject?.includes("Camille vous a confié : Ranger sa chambre, avant aujourd'hui"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("réglages personnels (US-97 RF8, US-98 RF7)", () => {
  it("valeurs par défaut, jour libre, heures de la liste, désactivation", async () => {
    const f = await family();
    expect(await getPersonalSettings(NOON, f.julienSession)).toMatchObject({ taskDaily: true, weeklyDigest: { enabled: true, weekday: 7, hour: 19 } });
    const changed = await setPersonalSettings(NOON, f.julienSession, { weeklyDigest: { weekday: 3, hour: 12 } });
    expect(changed.weeklyDigest).toEqual({ enabled: true, weekday: 3, hour: 12 });
    expect((await setPersonalSettings(NOON, f.julienSession, { weeklyDigest: { enabled: false } })).weeklyDigest).toEqual({ enabled: false, weekday: 3, hour: 12 });
    expect((await failure(setPersonalSettings(NOON, f.julienSession, { weeklyDigest: { hour: 10 } }))).code).toBe("invalid_setting");
    expect((await failure(setPersonalSettings(NOON, f.julienSession, { weeklyDigest: { weekday: 8 } }))).code).toBe("invalid_setting");
    expect((await getPersonalSettings(NOON, f.camilleSession)).weeklyDigest.weekday).toBe(7); // propre à chaque profil
    expect((await setPersonalSettings(NOON, f.elodieSession, { taskDaily: false })).taskDaily).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("point de la semaine : calendrier d'envoi (US-98 RF1, RF7, RF8, D47)", () => {
  const sunday = { enabled: true, weekday: 7, hour: 19 };
  it("couvre le lundi-dimanche qui suit l'envoi", () => {
    expect(mondayAfter("2054-11-08")).toBe("2054-11-09"); // un dimanche
    expect(mondayAfter("2054-11-09")).toBe("2054-11-16"); // un lundi : la semaine suivante
    expect(mondayAfter("2054-11-11")).toBe("2054-11-16"); // un mercredi
  });
  it("l'envoi est en cours de une heure avant à douze heures après", () => {
    expect(digestSlot(sunday, TZ, new Date("2054-11-08T16:50:00Z"))).toBeNull(); // 17 h 50 : plus d'une heure avant 19 h
    expect(digestSlot(sunday, TZ, new Date("2054-11-08T17:30:00Z"))).toMatchObject({ weekStart: "2054-11-09" }); // 18 h 30 : à préparer
    expect(digestSlot(sunday, TZ, new Date("2054-11-08T17:10:00Z"))).toMatchObject({ weekStart: "2054-11-09" }); // 18 h 10
    expect(digestSlot(sunday, TZ, new Date("2054-11-08T18:00:00Z"))?.sendAt.toISOString()).toBe("2054-11-08T18:00:00.000Z"); // 19 h locales
    expect(digestSlot(sunday, TZ, new Date("2054-11-09T05:30:00Z"))).not.toBeNull(); // le lendemain 6 h 30 : encore dans les 12 h
    expect(digestSlot(sunday, TZ, new Date("2054-11-09T08:00:00Z"))).toBeNull(); // 9 h : trop tard
    expect(digestSlot({ enabled: true, weekday: 3, hour: 12 }, TZ, new Date("2054-11-11T11:00:00Z"))).toMatchObject({ weekStart: "2054-11-16" }); // mercredi 12 h
  });
  it("le point du dernier envoi reste consultable jusqu'au suivant", () => {
    expect(currentDigestWeek(sunday, TZ, new Date("2054-11-11T10:00:00Z"))).toBe("2054-11-09"); // mercredi : envoyé dimanche 8
    expect(currentDigestWeek(sunday, TZ, new Date("2054-11-08T17:00:00Z"))).toBe("2054-11-02"); // dimanche 18 h : celui de la semaine précédente
    expect(currentDigestWeek(sunday, TZ, new Date("2054-11-08T18:30:00Z"))).toBe("2054-11-09");
  });
  it("texte de la notification", () => {
    expect(digestBody(5, 3)).toBe("Votre semaine est prête : 5 RDV, 3 tâches");
    expect(digestBody(0, 1)).toBe("Votre semaine est prête : 0 RDV, 1 tâche");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
async function seedEvent(f: Family, s: { title: string; start: string; type?: EventType; status?: EventStatus; members: string[]; by?: string }): Promise<string> {
  const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE[s.type ?? "family"]).executeTakeFirstOrThrow();
  const status = STATUS_CODE[s.status ?? "confirmed"];
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: s.type === "medical" ? null : seal(s.title), starts_at: localToUtc(s.start, TZ), ends_at: localToUtc(s.start.replace(/T(\d\d):/, (_m, h: string) => `T${String(Number(h) + 1).padStart(2, "0")}:`), TZ),
      status, source: "chat_text", whole_family: false, requested_by_user_id: s.by ?? f.camille.id, fingerprint: randomBytes(16),
      ...(status === "confirmed" ? { confirmed_at: new Date("2054-11-01T10:00:00Z"), confirmed_by_user_id: f.camille.id } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.insertInto("family_event_members").values(s.members.map((m) => ({ event_id: row.id, member_id: m, account_id: f.accountId }))).execute();
  return row.id;
}

function fakeModel(reply: () => string | Error): AssistantModel & { inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    async send(request) {
      inputs.push(JSON.stringify(request.messages));
      const out = reply();
      if (out instanceof Error) throw out;
      return { content: [{ type: "text", text: out }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 }, requestId: null };
    },
  };
}

describe("point de la semaine : résumé, envoi et écran (US-98)", () => {
  async function week(f: Family) {
    // Semaine du lundi 9 au dimanche 15 novembre 2054.
    const medical = await seedEvent(f, { title: "x", start: "2054-11-10T10:00", type: "medical", members: [f.leoId] });
    const piscine = await seedEvent(f, { title: "Piscine", start: "2054-11-11T17:30", members: [f.miaId] });
    const apero = await seedEvent(f, { title: "Apéro des voisins", start: "2054-11-12T19:00", members: [f.memberIds.camille, f.memberIds.julien] });
    const elodieEvent = await seedEvent(f, { title: "Yoga d'Élodie", start: "2054-11-13T18:00", members: [f.memberIds.elodie], by: f.elodie.id });
    const aConfirmer = await seedEvent(f, { title: "Brocante", start: "2054-11-14T09:00", status: "provisional", members: [f.memberIds.camille] });
    const sac = await task(f, f.camilleSession, { title: "Préparer le sac de piscine", due: "2054-11-11", assigneeId: f.memberIds.julien });
    const orphan = await task(f, f.camilleSession, { title: "Ranger le garage", due: "2054-11-14" });
    const mine = await task(f, f.camilleSession, { title: "Arroser les plantes d'Élodie", due: "2054-11-12", assigneeId: f.memberIds.elodie });
    // Semaine passée : une tâche faite, une encore ouverte.
    const done = await task(f, f.camilleSession, { title: "Faite", due: "2054-11-05", assigneeId: f.memberIds.camille });
    await setTaskDone(at("2054-11-05T10:00:00Z"), f.camilleSession, done.id, true);
    const open = await task(f, f.camilleSession, { title: "Encore ouverte", due: "2054-11-03", assigneeId: f.memberIds.camille });
    return { medical, piscine, apero, elodieEvent, aConfirmer, sac, orphan, mine, open };
  }
  const SUNDAY_1830 = at("2054-11-08T17:30:00Z");
  const SUNDAY_1905 = at("2054-11-08T18:05:00Z");

  it("prépare le résumé une heure avant, sans titre ni prénom ; envoie à chaque profil ses chiffres (CA 1.1, 4.1)", async () => {
    const f = await family();
    const ids = await week(f);
    send.mockClear();
    const ref = `evt-${ids.piscine.slice(0, 8)}`;
    const medical = `evt-${ids.medical.slice(0, 8)}`;
    const model = fakeModel(() => `Semaine chargée jeudi : [[${ref}]] et [[${medical}]]. Parent 2 gère [[tch-${ids.sac.id.slice(0, 8)}]] pour Enfant 2.`);
    const first = await runDigests(SUNDAY_1830, { accountId: f.accountId, model });
    expect(first).toMatchObject({ prepared: 1, sent: 0 }); // 18 h 30 : préparé, pas encore envoyé
    // Le modèle n'a reçu aucun titre, aucun prénom, aucun lieu.
    const prompt = model.inputs[0];
    for (const forbidden of ["Piscine", "Apéro", "Brocante", "Camille", "Julien", "Léo", "Mia", "Élodie", "garage", "plantes"]) expect(prompt).not.toContain(forbidden);
    expect(prompt).toContain(ref);
    expect(prompt).toContain("Parent 1");
    const sent = await runDigests(SUNDAY_1905, { accountId: f.accountId, model });
    expect(sent.sent).toBe(3);
    expect(model.inputs).toHaveLength(1); // une seule préparation par famille
    expect(bodiesFor(f.devices.camille)).toEqual(["Votre semaine est prête : 5 RDV, 3 tâches"]); // elle voit tout : 5 RDV, 3 tâches
    expect(bodiesFor(f.devices.julien)).toEqual(["Votre semaine est prête : 5 RDV, 3 tâches"]);
    const elodieMail = (await messagesTo(f.elodie.email)).filter((m) => m.subject?.startsWith("Votre semaine est prête"));
    expect(elodieMail.map((m) => m.subject)).toEqual(["Votre semaine est prête : 1 RDV, 1 tâche"]); // ses RDV et ses tâches seulement
    // Rejoué : rien de plus (une seule fois par semaine couverte).
    await runDigests(at("2054-11-08T18:20:00Z"), { accountId: f.accountId, model });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("l'écran : résumé aux titres que le lecteur voit, chiffres, jours, points d'attention, semaine passée (CA 2.1 à 2.3, 4.1, 5.1)", async () => {
    const f = await family();
    const ids = await week(f);
    const model = fakeModel(() => `Chargé jeudi : [[evt-${ids.medical.slice(0, 8)}]] et [[evt-${ids.elodieEvent.slice(0, 8)}]]. Parent 2 gère [[tch-${ids.sac.id.slice(0, 8)}]] pour Enfant 2.`);
    await runDigests(SUNDAY_1905, { accountId: f.accountId, model });
    const view = await getDigest(at("2054-11-10T08:00:00Z"), f.camilleSession);
    expect(view.weekStart).toBe("2054-11-09");
    expect(view.summary?.source).toBe("agent");
    expect(view.summary?.text).toBe("Chargé jeudi : RDV médical — Léo et Yoga d'Élodie. Julien gère Préparer le sac de piscine pour Mia.");
    expect(view.counts).toMatchObject({ events: 5, tasks: 3, toConfirm: 1 });
    expect(view.days.map((d) => d.date)).toEqual(["2054-11-09", "2054-11-10", "2054-11-11", "2054-11-12", "2054-11-13", "2054-11-14", "2054-11-15"]);
    expect(view.days[0]).toMatchObject({ events: [], tasks: [] }); // « Rien de prévu »
    expect(view.days[1].events[0].title).toBe("RDV médical — Léo");
    expect(view.attention.map((a) => a.kind).sort()).toEqual(["to_confirm", "unassigned"]);
    expect(view.attention.find((a) => a.kind === "unassigned")?.text).toBe("Sans personne : Ranger le garage");
    expect(view.lastWeek).toMatchObject({ doneTasks: 1 });
    expect(view.lastWeek.open.map((t) => t.title)).toEqual(["Encore ouverte"]);
    expect(view.calm).toBe(false);
    // Un invité secondaire : ses RDV et ses tâches, le résumé de MAAQ, rien de l'agent ni des autres (RF3, CA 3.1).
    const elodie = await getDigest(at("2054-11-10T08:00:00Z"), f.elodieSession);
    expect(elodie.parent).toBe(false);
    expect(elodie.summary?.source).toBe("maaq");
    expect(elodie.summary?.text).toBe("Cette semaine : 1 RDV et 1 tâche pour vous.");
    expect(elodie.days.flatMap((d) => d.events.map((e) => e.title))).toEqual(["Yoga d'Élodie"]);
    expect(elodie.days.flatMap((d) => d.tasks.map((t) => t.title))).toEqual(["Arroser les plantes d'Élodie"]);
    expect(elodie.attention).toEqual([]);
    // Un RDV que le lecteur ne voit pas devient « un rendez-vous » dans le résumé de l'agent (D39) : testé sur le point d'un parent via une référence inconnue.
    await db.updateTable("weekly_digests").set({ agent_summary: seal("Voir [[evt-00000000]] et [[tch-00000000]].") }).where("account_id", "=", f.accountId).execute();
    expect((await getDigest(at("2054-11-10T08:00:00Z"), f.camilleSession)).summary?.text).toBe("Voir un rendez-vous et une tâche.");
  });

  it("le point est envoyé sans résumé quand l'agent n'a pas répondu (CA 9.1) ; une semaine calme l'est aussi (RF6, CA 6.1)", async () => {
    const f = await family();
    const model = fakeModel(() => new Error("indisponible"));
    const out = await runDigests(SUNDAY_1905, { accountId: f.accountId, model });
    expect(out).toMatchObject({ prepared: 0, sent: 3 });
    expect(bodiesFor(f.devices.camille)).toEqual(["Votre semaine est prête : 0 RDV, 0 tâche"]);
    const row = await db.selectFrom("weekly_digests").select(["summary_status"]).where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    expect(row.summary_status).toBe("failed");
    const view = await getDigest(at("2054-11-10T08:00:00Z"), f.camilleSession);
    expect(view.summary).toBeNull();
    expect(view.calm).toBe(true);
  });

  it("jour et heure choisis par profil, désactivation (CA 7.1, 7.2)", async () => {
    const f = await family();
    await seedEvent(f, { title: "Piscine", start: "2054-11-17T17:30", members: [f.miaId] });
    await setPersonalSettings(NOON, f.julienSession, { weeklyDigest: { enabled: false } });
    await setPersonalSettings(NOON, f.camilleSession, { weeklyDigest: { weekday: 3, hour: 12 } }); // mercredi 12 h
    const model = fakeModel(() => "Une semaine calme.");
    send.mockClear();
    await runDigests(at("2054-11-08T18:05:00Z"), { accountId: f.accountId, model }); // dimanche 19 h : Julien désactivé, Camille attend mercredi, Élodie reçoit
    expect(bodiesFor(f.devices.camille)).toEqual([]);
    expect(bodiesFor(f.devices.julien)).toEqual([]);
    const wednesday = await runDigests(at("2054-11-11T11:05:00Z"), { accountId: f.accountId, model }); // mercredi 12 h 05
    expect(wednesday.sent).toBe(1);
    expect(bodiesFor(f.devices.camille)).toEqual(["Votre semaine est prête : 1 RDV, 0 tâche"]); // couvre le lundi 16 au dimanche 22
    const view = await getDigest(at("2054-11-12T08:00:00Z"), f.camilleSession);
    expect(view.weekStart).toBe("2054-11-16");
  });

  it("refuse une semaine qui n'est pas un lundi ; purge les résumés de plus de 4 semaines", async () => {
    const f = await family();
    expect((await failure(getDigest(NOON, f.camilleSession, "2054-11-10"))).code).toBe("invalid_week");
    expect((await failure(getDigest(NOON, f.camilleSession, "hier"))).code).toBe("invalid_week");
    await prepareDigest(NOON, f.accountId, "2020-01-06", TZ, fakeModel(() => "Ancien."));
    await sql`select purge_expired_weekly_digests()`.execute(db);
    expect(await db.selectFrom("weekly_digests").select("id").where("account_id", "=", f.accountId).execute()).toEqual([]);
  });
});
