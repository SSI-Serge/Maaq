import { randomBytes, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import webpush from "web-push";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmEvent, setAsideEvent } from "@/server/assistant/events";
import { addChild } from "@/server/assistant/family";
import { seal, sealOptional } from "@/server/assistant/fields";
import { getPersonalSettings, IMMEDIATE_WAIT_MS, runEventNotices, setPersonalSettings } from "@/server/assistant/notices";
import { eventAddedBody, eventToConfirmBody } from "@/server/assistant/reminder-text";
import { getReminderSettings, setReminderSetting } from "@/server/assistant/reminders";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { saveSubscription } from "@/server/push/service";
import { createGuest, createProfile, messagesTo, sessionFor, testDb } from "./helpers/fixtures";

// Les clés ne servent à rien ici : l'envoi est simulé. Elles doivent seulement exister pour que les notifications soient « configurées ».
process.env.VAPID_PUBLIC_KEY = "BPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTe";
process.env.VAPID_PRIVATE_KEY = "PrivateKeyDeTestPrivateKeyDeTestPrivateKeyDeTe";

vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
const send = vi.mocked(webpush.sendNotification);

let db: Kysely<DB>;
beforeAll(async () => {
  db = testDb();
  // Mise en service (RT5) : seuls les RDV proposés après cette date sont notifiés.
  await setActivation("2020-01-01T00:00:00Z");
});
afterAll(async () => {
  await setActivation(null);
  await db.destroy();
});
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
});

async function setActivation(value: string | null) {
  await db.updateTable("platform_settings").set({ value_text: value }).where("setting_key", "=", "event_notice_activation_at").execute();
}

// Les RDV sont en 2054 (les fonctions de la base lisent l'horloge réelle : ils restent « à venir »).
const NOW = new Date("2054-11-02T08:00:00Z");
const ctx: Ctx = { get db() { return db; }, now: NOW } as Ctx;
const fcm = () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
const payloads = () => send.mock.calls.map((c) => JSON.parse(c[1] as string) as { title: string; body: string; url: string; tag: string });

/** Fuseau de la famille où il est `hour` heures maintenant (horloge réelle de la base) : rend la règle de nuit (21 h – 8 h) indépendante de l'heure d'exécution du test. */
function zoneWhereItIs(hour: number): string {
  let offset = hour - new Date().getUTCHours();
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

async function onDevice(userId: string): Promise<SessionContext> {
  const session = await sessionFor(db, userId);
  await db.insertInto("devices").values({ id: session.device.id, user_id: userId, device_type: "android" }).execute();
  return session;
}

/** Foyer : Camille (demandeuse), Julien (invité 1, notifications autorisées), Élodie (invitée secondaire, notifications autorisées), et Léo. Il est midi pour la famille. */
async function family(options: { julienDevice?: boolean; zone?: string } = {}) {
  const camille = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: options.zone ?? zoneWhereItIs(12) }).where("id", "=", camille.accountId!).execute();
  await db.updateTable("users").set({ first_name: "Camille" }).where("id", "=", camille.id).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const camilleSession = await onDevice(camille.id);
  const julienSession = await onDevice(julien.id);
  const elodieSession = await onDevice(elodie.id);
  if (options.julienDevice !== false) await saveSubscription(ctx, julienSession, fcm());
  await saveSubscription(ctx, elodieSession, fcm());
  const leo = await addChild(ctx, camilleSession, { firstName: "Léo" });
  const elodieMember = await db.selectFrom("family_members").select("id").where("user_id", "=", elodie.id).executeTakeFirstOrThrow();
  return { accountId: camille.accountId!, camille, julien, elodie, camilleSession, julienSession, elodieSession, leoId: leo.id, elodieMemberId: elodieMember.id };
}
type Family = Awaited<ReturnType<typeof family>>;

interface Seed {
  status?: "provisional" | "confirmed" | "set_aside";
  /** Minutes écoulées depuis la proposition (horloge réelle de la base). */
  ageMinutes?: number;
  confirmedBy?: "camille" | "julien";
  type?: string;
  members?: string[];
  place?: string;
  title?: string;
}
async function seed(f: Family, s: Seed = {}): Promise<string> {
  const status = s.status ?? "provisional";
  const created = new Date(Date.now() - (s.ageMinutes ?? 0) * 60_000);
  const type = await db.selectFrom("event_types").select("id").where("code", "=", s.type ?? "school").executeTakeFirstOrThrow();
  const confirmer = s.confirmedBy === "julien" ? f.julien.id : f.camille.id;
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: s.type === "medical" ? null : seal(s.title ?? "Réunion parents-professeurs"), location: sealOptional(s.place),
      starts_at: new Date("2054-11-05T17:00:00Z"), ends_at: new Date("2054-11-05T18:00:00Z"), status, source: "chat_text", requested_by_user_id: f.camille.id,
      created_at: created, fingerprint: randomBytes(16),
      ...(status === "confirmed" ? { confirmed_at: new Date(created.getTime() + 60_000), confirmed_by_user_id: confirmer } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.insertInto("family_event_members").values((s.members ?? [f.leoId]).map((member_id) => ({ event_id: row.id, member_id, account_id: f.accountId }))).execute();
  return row.id;
}

const notices = (id: string) => db.selectFrom("scheduled_notifications").select(["recipient_user_id", "kind", "status", "channel", "push_sent_at", "email_sent_at"]).where("event_id", "=", id).where("kind", "in", ["event_added", "event_to_confirm"]).execute();
const forUser = (rows: Awaited<ReturnType<typeof notices>>, userId: string) => rows.find((r) => r.recipient_user_id === userId);

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

describe("textes des notifications (US-113 RF2, RF3, RF8)", () => {
  const event = { id: "x", title: "Réunion parents-professeurs — Léa", type: "school" as const, place: "École Jules Ferry", startsAt: new Date("2054-11-05T17:00:00Z"), allDay: false };
  const now = new Date("2054-11-02T08:00:00Z");

  it("dit qui a ajouté quoi, le jour et l'heure, sans le lieu", () => {
    expect(eventAddedBody(event, "Camille", "Europe/Paris", now)).toBe("Camille a ajouté : Réunion parents-professeurs — Léa, jeudi 18h00");
    expect(eventToConfirmBody(event, "Camille", "Europe/Paris", now)).toBe("À confirmer — Camille a demandé : Réunion parents-professeurs — Léa, jeudi 18h00");
    expect(eventAddedBody(event, "Camille", "Europe/Paris", now)).not.toContain("Jules Ferry");
  });
});

describe("prévenir l'autre parent (US-113)", () => {
  it("CA 1.1, 2.1, 6.1 : un RDV confirmé par la demandeuse prévient l'autre parent une seule fois, jamais elle-même", async () => {
    const f = await family();
    const id = await seed(f);
    await confirmEvent(ctx, f.camilleSession, id);
    const calls = payloads();
    expect(calls).toHaveLength(1); // Julien ; ni Camille (demandeuse), ni Élodie (RDV qui ne la concerne pas, CA 10.3)
    expect(calls[0]).toMatchObject({ title: "Assistant Famille", body: expect.stringMatching(/^Camille a ajouté : Réunion parents-professeurs, \S+ \d+h\d\d$/), url: `/calendrier/rdv/${id}`, tag: `notice-${id}` });
    const rows = await notices(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_user_id: f.julien.id, kind: "event_added", status: "sent", channel: "push" });
    expect(rows[0].push_sent_at).not.toBeNull();
    expect(rows[0].email_sent_at).toBeNull(); // jamais par email (RF11)
    expect(await messagesTo(f.julien.email)).toHaveLength(0);
  });

  it("CA 6.1 : quand le second parent confirme lui-même, personne n'est prévenu (D59)", async () => {
    const f = await family();
    const id = await seed(f);
    await confirmEvent(ctx, f.julienSession, id);
    expect(send).not.toHaveBeenCalled();
    expect(await notices(id)).toEqual([]);
  });

  it("CA 3.1, 4.1 : un RDV resté provisoire 10 minutes est annoncé « à confirmer », puis plus rien quand il est confirmé", async () => {
    const f = await family();
    const id = await seed(f, { ageMinutes: 11 });
    const result = await runEventNotices(ctx);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const calls = payloads().filter((c) => c.tag === `notice-${id}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatch(/^À confirmer — Camille a demandé : Réunion parents-professeurs, /);
    expect(forUser(await notices(id), f.julien.id)).toMatchObject({ kind: "event_to_confirm", status: "sent" });
    expect(forUser(await notices(id), f.camille.id)).toBeUndefined();
    expect(forUser(await notices(id), f.elodie.id)).toBeUndefined(); // CA 10.2 : jamais « à confirmer » pour une invitée secondaire

    // Camille confirme le lendemain : Julien ne reçoit rien de plus (RF4).
    await confirmEvent(ctx, f.camilleSession, id);
    await runEventNotices(ctx);
    expect(payloads().filter((c) => c.tag === `notice-${id}`)).toHaveLength(1);
    expect(await notices(id)).toHaveLength(1);
  });

  it("CA 5.1 : un RDV écarté ou pas encore vieux de 10 minutes ne prévient personne", async () => {
    const f = await family();
    const recent = await seed(f, { ageMinutes: 2 });
    const aside = await seed(f, { ageMinutes: 11 });
    await setAsideEvent(ctx, f.camilleSession, aside);
    await runEventNotices(ctx);
    expect(payloads().filter((c) => c.tag === `notice-${recent}` || c.tag === `notice-${aside}`)).toHaveLength(0);
  });

  it("CA 8.1 : un RDV médical est désigné par son titre générique, sans lieu", async () => {
    const f = await family();
    const id = await seed(f, { type: "medical", place: "12 rue des Lilas, cabinet du Dr Martin" });
    await confirmEvent(ctx, f.camilleSession, id);
    const [call] = payloads();
    expect(call.body).toMatch(/^Camille a ajouté : RDV médical — Léo, /);
    expect(JSON.stringify(call)).not.toMatch(/Lilas|Martin/);
  });

  it("CA 10.1, 10.2, 10.3 : l'invitée secondaire n'est prévenue que d'un RDV confirmé qui la concerne", async () => {
    const f = await family();
    const concerned = await seed(f, { members: [f.elodieMemberId, f.leoId] });
    const other = await seed(f, { members: [f.leoId] });
    // Le RDV de l'invitée reste provisoire 11 minutes : Julien est averti « à confirmer », pas Élodie.
    await db.updateTable("family_events").set({ created_at: new Date(Date.now() - 11 * 60_000) }).where("id", "in", [concerned, other]).execute();
    await runEventNotices(ctx);
    expect(forUser(await notices(concerned), f.elodie.id)).toBeUndefined();
    expect(forUser(await notices(concerned), f.julien.id)).toMatchObject({ kind: "event_to_confirm" });
    // Camille confirme : Élodie reçoit « a ajouté » pour le RDV qui la concerne seulement.
    await confirmEvent(ctx, f.camilleSession, concerned, { allowConflict: true }); // les deux RDV ont le même créneau
    await confirmEvent(ctx, f.camilleSession, other, { allowConflict: true });
    expect(forUser(await notices(concerned), f.elodie.id)).toMatchObject({ kind: "event_added", status: "sent" });
    expect(forUser(await notices(other), f.elodie.id)).toBeUndefined();
  });

  it("CA 11.1 : sans appareil autorisé, ni notification ni email, et aucune nouvelle tentative", async () => {
    const f = await family({ julienDevice: false });
    const id = await seed(f);
    await confirmEvent(ctx, f.camilleSession, id);
    expect(payloads().filter((c) => c.tag === `notice-${id}`)).toHaveLength(0);
    expect(await messagesTo(f.julien.email)).toHaveLength(0);
    expect(forUser(await notices(id), f.julien.id)).toMatchObject({ channel: "none", status: "not_applicable", push_sent_at: null, email_sent_at: null });
    await runEventNotices(ctx);
    expect(await notices(id)).toHaveLength(1); // ligne écrite quand même : pas de rafale si un appareil est autorisé plus tard
  });

  it("CA 14.1, 14.2 : le réglage personnel désactivé coupe la notification d'ajout", async () => {
    const f = await family();
    await setPersonalSettings(ctx, f.julienSession, { notifyEventsAdded: false });
    const id = await seed(f);
    await confirmEvent(ctx, f.camilleSession, id);
    expect(await notices(id)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("CA 16.1 : deux passages en même temps n'envoient qu'une notification", async () => {
    const f = await family();
    const id = await seed(f, { ageMinutes: 11 });
    await Promise.all([runEventNotices(ctx), runEventNotices(ctx), runEventNotices(ctx, { eventId: id })]);
    expect(payloads().filter((c) => c.tag === `notice-${id}`)).toHaveLength(1);
    await runEventNotices(ctx);
    expect(payloads().filter((c) => c.tag === `notice-${id}`)).toHaveLength(1);
  });

  it("CA 16.2 : une notification qui n'a pas pu partir est reprise au passage suivant, tant que le RDV n'a pas commencé", async () => {
    const f = await family();
    const id = await seed(f, { ageMinutes: 11 });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockRejectedValue(Object.assign(new Error("VAPID refusé"), { statusCode: 403 }));
    await runEventNotices(ctx);
    quiet.mockRestore();
    expect(forUser(await notices(id), f.julien.id)).toMatchObject({ status: "scheduled", push_sent_at: null });
    send.mockReset();
    send.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    await runEventNotices(ctx);
    expect(forUser(await notices(id), f.julien.id)).toMatchObject({ status: "sent" });
    expect(payloads().filter((c) => c.tag === `notice-${id}`)).toHaveLength(1);
  });

  it("abandonne une notification dont le RDV a commencé", async () => {
    const f = await family();
    const id = await seed(f, { ageMinutes: 11 });
    send.mockRejectedValue(Object.assign(new Error("indisponible"), { statusCode: 403 }));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await runEventNotices(ctx);
    quiet.mockRestore();
    const late: Ctx = { db, now: new Date("2054-11-05T17:30:00Z") };
    const result = await runEventNotices(late);
    expect(result.abandoned).toBeGreaterThanOrEqual(1);
    expect(forUser(await notices(id), f.julien.id)).toMatchObject({ status: "abandoned" });
  });
});

describe("heures de nuit (US-113 RF12)", () => {
  it("CA 12.1 : une heure entre 21 h et 8 h devient 8 h dans le fuseau de la famille", async () => {
    const f = await family({ zone: "Europe/Paris" });
    const shifted = async (at: string) => (await sql<{ at: Date }>`select shift_to_morning(${f.accountId}::uuid, ${at}::timestamptz) as at`.execute(db)).rows[0].at.toISOString();
    expect(await shifted("2054-11-02T21:30:00+01:00")).toBe("2054-11-03T07:00:00.000Z"); // 22 h → 8 h le lendemain
    expect(await shifted("2054-11-03T03:00:00+01:00")).toBe("2054-11-03T07:00:00.000Z"); // 3 h → 8 h le même jour
    expect(await shifted("2054-11-03T12:00:00+01:00")).toBe("2054-11-03T11:00:00.000Z"); // en journée : inchangé
  });

  it("CA 12.2 : la nuit, c'est l'état du RDV à 8 h qui décide — « à confirmer » devient « ajouté » si le RDV a été confirmé entre-temps", async () => {
    const f = await family({ zone: zoneWhereItIs(23) }); // il est 23 h pour la famille : tout part à 8 h
    const id = await seed(f, { ageMinutes: 11 });
    await runEventNotices(ctx);
    expect(send).not.toHaveBeenCalled();
    expect(forUser(await notices(id), f.julien.id)).toMatchObject({ kind: "event_to_confirm", status: "scheduled" });

    await confirmEvent(ctx, f.camilleSession, id); // le lendemain à 7 h 30, avant l'envoi
    await runEventNotices(ctx);
    expect(forUser(await notices(id), f.julien.id)).toMatchObject({ kind: "event_added", status: "scheduled" });

    await db.updateTable("scheduled_notifications").set({ due_at: new Date(Date.now() - 60_000) }).where("event_id", "=", id).execute(); // 8 h arrive
    await runEventNotices(ctx);
    const calls = payloads().filter((c) => c.tag === `notice-${id}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatch(/^Camille a ajouté : /);
    expect(calls[0].body).not.toContain("À confirmer");
  });
});

describe("mise en service (US-113 RT5)", () => {
  it("ne prévient personne tant que la date de mise en service n'est pas renseignée, ni pour un RDV proposé avant elle", async () => {
    const f = await family();
    await setActivation(null);
    const before = await seed(f);
    await confirmEvent(ctx, f.camilleSession, before);
    expect(await notices(before)).toEqual([]);
    await setActivation("2999-01-01T00:00:00Z");
    const early = await seed(f, { ageMinutes: 11 });
    await runEventNotices(ctx);
    expect(await notices(early)).toEqual([]);
    await setActivation("2020-01-01T00:00:00Z");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("planificateur", () => {
  // Le passage complet (`runDueJobs`) n'est pas lancé ici : il synchronise aussi le carnet de bord, dont l'état est partagé avec d'autres fichiers de test.
  it("n'attend pas plus de 3 secondes après une confirmation", () => {
    expect(IMMEDIATE_WAIT_MS).toBe(3000);
  });
});

describe("réglages personnels (US-113 RF14, D58, RT6)", () => {
  it("sont ouverts à tout profil de la famille : actif par défaut, propre à chacun", async () => {
    const f = await family();
    expect(await getPersonalSettings(ctx, f.julienSession)).toEqual({ notifyEventsAdded: true, taskDaily: true, weeklyDigest: { enabled: true, weekday: 7, hour: 19 }, audience: "parent" });
    expect(await getPersonalSettings(ctx, f.elodieSession)).toMatchObject({ notifyEventsAdded: true, audience: "guest" });
    await setPersonalSettings(ctx, f.elodieSession, { notifyEventsAdded: false });
    expect((await getPersonalSettings(ctx, f.elodieSession)).notifyEventsAdded).toBe(false);
    expect((await getPersonalSettings(ctx, f.julienSession)).notifyEventsAdded).toBe(true);
    await setPersonalSettings(ctx, f.elodieSession, { notifyEventsAdded: true });
    expect((await getPersonalSettings(ctx, f.elodieSession)).notifyEventsAdded).toBe(true);
    const admin = await createProfile(db, { role: "admin" });
    expect((await failure(getPersonalSettings(ctx, await sessionFor(db, admin.id)))).status).toBe(403);
  });

  it("laissent l'invitée secondaire lire les réglages familiaux, sans les modifier", async () => {
    const f = await family();
    const read = await getReminderSettings(ctx, f.elodieSession);
    expect(read.canEdit).toBe(false);
    expect(read.settings).toHaveLength(6);
    expect((await getReminderSettings(ctx, f.julienSession)).canEdit).toBe(true);
    expect((await failure(setReminderSetting(ctx, f.elodieSession, { type: "family", kind: "d7", enabled: false }))).status).toBe(403);
  });
});
