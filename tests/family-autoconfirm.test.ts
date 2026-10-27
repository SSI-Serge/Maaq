import { randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import webpush from "web-push";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEvent } from "@/server/assistant/events";
import { addChild } from "@/server/assistant/family";
import { seal } from "@/server/assistant/fields";
import { runAutoConfirm, runEventNotices } from "@/server/assistant/notices";
import { autoConfirmedHeadline, eventAddedAutoBody, AUTO_CONFIRM_WARNING } from "@/server/assistant/reminder-text";
import { runReminders } from "@/server/assistant/reminders";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { saveSubscription } from "@/server/push/service";
import { createGuest, createProfile, messagesTo, sessionFor, testDb } from "./helpers/fixtures";

// L'enregistrement sans réponse est livré éteint : ce fichier le met en service pour vérifier son comportement.
process.env.AUTO_CONFIRM_MODE = "on";
process.env.VAPID_PUBLIC_KEY = "BPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTestPublicKeyDeTe";
process.env.VAPID_PRIVATE_KEY = "PrivateKeyDeTestPrivateKeyDeTestPrivateKeyDeTe";

vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
const send = vi.mocked(webpush.sendNotification);

let db: Kysely<DB>;
beforeAll(async () => {
  db = testDb();
  await db.updateTable("platform_settings").set({ value_text: "2020-01-01T00:00:00Z" }).where("setting_key", "=", "event_notice_activation_at").execute();
});
afterAll(async () => {
  await db.updateTable("platform_settings").set({ value_text: null }).where("setting_key", "=", "event_notice_activation_at").execute();
  await db.destroy();
});
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
});

const NOW = new Date("2054-11-02T08:00:00Z");
const ctx: Ctx = { get db() { return db; }, now: NOW } as Ctx;
const fcm = () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
const payloads = () => send.mock.calls.map((c) => JSON.parse(c[1] as string) as { body: string; tag: string });

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

async function family(options: { julienDevice?: boolean; zone?: string } = {}) {
  const camille = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: options.zone ?? zoneWhereItIs(12) }).where("id", "=", camille.accountId!).execute();
  await db.updateTable("users").set({ first_name: "Camille" }).where("id", "=", camille.id).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const camilleSession = await onDevice(camille.id);
  const julienSession = await onDevice(julien.id);
  const elodieSession = await onDevice(elodie.id);
  await saveSubscription(ctx, camilleSession, fcm());
  if (options.julienDevice !== false) await saveSubscription(ctx, julienSession, fcm());
  await saveSubscription(ctx, elodieSession, fcm());
  const leo = await addChild(ctx, camilleSession, { firstName: "Léo" });
  const elodieMember = await db.selectFrom("family_members").select("id").where("user_id", "=", elodie.id).executeTakeFirstOrThrow();
  return { accountId: camille.accountId!, camille, julien, elodie, camilleSession, julienSession, leoId: leo.id, elodieMemberId: elodieMember.id };
}
type Family = Awaited<ReturnType<typeof family>>;

interface Seed {
  /** Heures écoulées depuis la proposition (horloge réelle de la base). */
  ageHours?: number;
  source?: "chat_text" | "voice" | "photo" | "forwarded_email" | "android_share";
  status?: "provisional" | "set_aside";
  members?: string[];
  start?: string;
}
async function seed(f: Family, s: Seed = {}): Promise<string> {
  const type = await db.selectFrom("event_types").select("id").where("code", "=", "school").executeTakeFirstOrThrow();
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal("Réunion parents-professeurs"), starts_at: new Date(s.start ?? "2054-11-05T17:00:00Z"), ends_at: new Date(new Date(s.start ?? "2054-11-05T17:00:00Z").getTime() + 3_600_000),
      status: s.status ?? "provisional", source: s.source ?? "chat_text", requested_by_user_id: f.camille.id, created_at: new Date(Date.now() - (s.ageHours ?? 72.5) * 3_600_000), fingerprint: randomBytes(16),
    })
    .returning(["id", "auto_confirm_at"])
    .executeTakeFirstOrThrow();
  const members = s.members ?? [f.leoId];
  if (members.length) await db.insertInto("family_event_members").values(members.map((member_id) => ({ event_id: row.id, member_id, account_id: f.accountId }))).execute();
  return row.id;
}

const statusOf = (id: string) => db.selectFrom("family_events").select(["status", "auto_confirmed", "auto_confirm_at", "confirmed_by_user_id"]).where("id", "=", id).executeTakeFirstOrThrow();
const notices = (id: string) => db.selectFrom("scheduled_notifications").select(["recipient_user_id", "kind", "status", "push_sent_at", "email_sent_at", "due_at"]).where("event_id", "=", id).where("kind", "in", ["auto_confirmed", "event_added", "event_to_confirm"]).execute();

describe("enregistrement sans réponse (AT-8, D49)", () => {
  it("est éteint tant que l'interrupteur n'est pas allumé : rien n'est confirmé", async () => {
    const f = await family();
    const id = await seed(f);
    expect(await runAutoConfirm(ctx, { enabled: false })).toBe(0);
    expect((await statusOf(id)).status).toBe("provisional");
  });

  it("confirme au nom de « MAAQ (sans réponse) » un RDV resté 72 heures sans réponse", async () => {
    const f = await family();
    const id = await seed(f);
    expect((await statusOf(id)).auto_confirm_at).not.toBeNull();
    expect(await runAutoConfirm(ctx)).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toMatchObject({ status: "confirmed", auto_confirmed: true, confirmed_by_user_id: null });
    const [entry] = await db.selectFrom("family_event_history").select(["action", "user_id", "reason"]).where("event_id", "=", id).execute();
    expect(entry).toEqual({ action: "confirmed", user_id: null, reason: "no_response" });
    const view = await getEvent(ctx, f.camilleSession, id);
    expect(view.statusChange).toMatchObject({ byFirstName: null, auto: true });
    expect(view.autoConfirm).toBeNull();
    expect(await runAutoConfirm(ctx)).toBeGreaterThanOrEqual(0); // sans danger à relancer
    expect((await db.selectFrom("family_event_history").select("id").where("event_id", "=", id).execute())).toHaveLength(1);
  });

  it("prévient les deux parents (« RDV ajouté automatiquement »), l'invitée concernée a son propre texte, personne n'est prévenu deux fois", async () => {
    const f = await family();
    const id = await seed(f, { members: [f.leoId, f.elodieMemberId] });
    await runAutoConfirm(ctx);
    await runEventNotices(ctx);
    const rows = await notices(id);
    const kinds = Object.fromEntries(rows.map((r) => [r.recipient_user_id, r.kind]));
    expect(kinds[f.camille.id]).toBe("auto_confirmed"); // la demandeuse aussi
    expect(kinds[f.julien.id]).toBe("auto_confirmed");
    expect(kinds[f.elodie.id]).toBe("event_added"); // invitée concernée : « RDV ajouté au calendrier »
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    const bodies = payloads().filter((c) => c.tag === `auto-${id}` || c.tag === `notice-${id}`).map((c) => c.body).sort();
    expect(bodies).toHaveLength(3);
    expect(bodies.filter((b) => b.startsWith("RDV ajouté automatiquement : Réunion parents-professeurs, "))).toHaveLength(2);
    expect(bodies.filter((b) => b.startsWith("RDV ajouté au calendrier : Réunion parents-professeurs, "))).toHaveLength(1);
    await runEventNotices(ctx);
    expect(payloads().filter((c) => c.tag === `auto-${id}` || c.tag === `notice-${id}`)).toHaveLength(3);
  });

  it("passe par l'email pour un parent sans appareil autorisé", async () => {
    const f = await family({ julienDevice: false });
    const id = await seed(f);
    await runAutoConfirm(ctx);
    await runEventNotices(ctx);
    const julien = (await notices(id)).find((r) => r.recipient_user_id === f.julien.id)!;
    expect(julien).toMatchObject({ kind: "auto_confirmed", status: "sent" });
    expect(julien.push_sent_at).toBeNull();
    expect(julien.email_sent_at).not.toBeNull();
    const [mail] = await messagesTo(f.julien.email);
    expect(mail.subject).toMatch(/^RDV ajouté automatiquement : Réunion parents-professeurs, /);
    expect(mail.text).toContain("Personne n'a confirmé ni écarté ce RDV après deux relances");
  });

  it("la nuit, l'avis part à 8 h (le RDV, lui, est confirmé à l'heure prévue)", async () => {
    const f = await family({ zone: zoneWhereItIs(23) });
    const id = await seed(f);
    await runAutoConfirm(ctx);
    expect((await statusOf(id)).status).toBe("confirmed");
    await runEventNotices(ctx);
    const rows = (await notices(id)).filter((r) => r.kind === "auto_confirmed");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "scheduled" && r.due_at.getTime() > Date.now())).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("n'enregistre jamais d'office : un RDV en conflit, sans membre précisé, écarté, issu d'un mail ou d'un partage, ou arrivé trop tard (D51)", async () => {
    const f = await family();
    const a = await seed(f); // deux RDV provisoires de Léo au même créneau : en conflit
    const b = await seed(f);
    const noMember = await seed(f, { members: [], start: "2054-11-06T17:00:00Z" });
    const aside = await seed(f, { status: "set_aside", start: "2054-11-07T17:00:00Z" });
    const mail = await seed(f, { source: "forwarded_email", start: "2054-11-08T17:00:00Z" });
    const share = await seed(f, { source: "android_share", start: "2054-11-09T17:00:00Z" });
    const late = await seed(f, { ageHours: 74, start: "2054-11-10T17:00:00Z" }); // échéance dépassée de plus de 60 minutes
    expect((await statusOf(mail)).auto_confirm_at).toBeNull();
    expect((await statusOf(share)).auto_confirm_at).toBeNull();
    expect((await statusOf(aside)).auto_confirm_at).toBeNull();
    await runAutoConfirm(ctx);
    for (const id of [a, b, noMember, aside, mail, share, late]) expect((await statusOf(id)).auto_confirmed).toBe(false);
    expect((await statusOf(late)).status).toBe("provisional"); // reste à confirmer jusqu'à son début
  });

  it("accepte un texte, une dictée ou une photo envoyés dans le tchat", async () => {
    const f = await family();
    const ids = [
      await seed(f, { source: "chat_text", start: "2054-11-05T17:00:00Z", members: [f.leoId] }),
      await seed(f, { source: "voice", start: "2054-11-06T17:00:00Z", members: [f.leoId] }),
      await seed(f, { source: "photo", start: "2054-11-07T17:00:00Z", members: [f.leoId] }),
    ];
    await runAutoConfirm(ctx);
    for (const id of ids) expect((await statusOf(id)).auto_confirmed).toBe(true);
  });
});

describe("mention dans l'application et dans la seconde relance (AT-8)", () => {
  it("annonce l'échéance sous le bouton de confirmation, ou « jamais »", async () => {
    const f = await family();
    const normal = await seed(f, { ageHours: 1 });
    expect((await getEvent(ctx, f.julienSession, normal)).autoConfirm).toEqual({ at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) });
    const mail = await seed(f, { ageHours: 1, source: "forwarded_email", start: "2054-11-08T17:00:00Z" });
    expect((await getEvent(ctx, f.julienSession, mail)).autoConfirm).toEqual({ never: true });
    const clash = await seed(f, { ageHours: 1 }); // même créneau que `normal` : en conflit, donc jamais d'office
    expect((await getEvent(ctx, f.julienSession, clash)).autoConfirm).toEqual({ never: true });
  });

  it("la seconde relance prévient que le RDV sera ajouté dans 24 h ; la première ne le dit pas", async () => {
    const f = await family();
    const id = await seed(f, { ageHours: 49 });
    const created = (await db.selectFrom("family_events").select("created_at").where("id", "=", id).executeTakeFirstOrThrow()).created_at;
    const at = (hours: number): Ctx => ({ db, now: new Date(created.getTime() + hours * 3_600_000) });
    await runReminders(at(25), { accountId: f.accountId });
    expect(payloads().filter((c) => c.tag.startsWith("nudge24"))).toHaveLength(2);
    expect(payloads().every((c) => !c.body.includes(AUTO_CONFIRM_WARNING))).toBe(true);
    send.mockClear();
    await runReminders(at(49), { accountId: f.accountId });
    const second = payloads().filter((c) => c.tag.startsWith("nudge48"));
    expect(second.length).toBeGreaterThanOrEqual(1);
    expect(second.every((c) => c.body.includes(AUTO_CONFIRM_WARNING))).toBe(true);
  });

  it("textes de l'avis", () => {
    const event = { id: "x", title: "Réunion parents-professeurs", type: "school" as const, place: "École", startsAt: new Date("2054-11-05T17:00:00Z"), allDay: false };
    expect(autoConfirmedHeadline(event, "Europe/Paris")).toBe("RDV ajouté automatiquement : Réunion parents-professeurs, jeudi 5 novembre à 18h00");
    expect(eventAddedAutoBody(event, "Europe/Paris", new Date("2054-11-02T08:00:00Z"))).toBe("RDV ajouté au calendrier : Réunion parents-professeurs, jeudi à 18h00");
  });
});
