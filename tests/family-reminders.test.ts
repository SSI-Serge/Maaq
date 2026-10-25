import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messenger } from "@/server/adapters/messaging";
import type { EventStatus, EventType } from "@/server/assistant/calendar";
import { cancelEvent, getEvent, updateEvent } from "@/server/assistant/events";
import { addChild } from "@/server/assistant/family";
import { seal, sealOptional } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import { getReminderSettings, nudgeDueAt, reminderDueAt, runReminders, setAsideExpiry, setReminderSetting } from "@/server/assistant/reminders";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { purgeExpired } from "@/server/jobs";
import { createProfile, messagesTo, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

const TZ = "Europe/Paris";
/** Heure de Paris en novembre 2026 (heure d'hiver, UTC+1) → instant. */
const paris = (local: string) => localToUtc(local, TZ);
const ctxAt = (local: string): Ctx => ({ db, now: paris(local) });

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Foyer : Camille (principale), Julien (invité 1), Élodie (invitée secondaire), et Léo. */
async function family() {
  const camille = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Camille" }).where("id", "=", camille.id).execute();
  const julien = await createProfile(db, { role: "guest" });
  await db.updateTable("users").set({ first_name: "Julien", account_id: camille.accountId, guest_rank: "core" }).where("id", "=", julien.id).execute();
  const elodie = await createProfile(db, { role: "guest" });
  await db.updateTable("users").set({ first_name: "Élodie", account_id: camille.accountId }).where("id", "=", elodie.id).execute();
  const session = await sessionFor(db, camille.id);
  const leo = await addChild(ctxAt("2026-11-02T09:00"), session, { firstName: "Léo" });
  return {
    accountId: camille.accountId!,
    session,
    julienSession: await sessionFor(db, julien.id),
    elodieSession: await sessionFor(db, elodie.id),
    emails: { camille: camille.email, julien: julien.email, elodie: elodie.email },
    userIds: { camille: camille.id },
    leoId: leo.id,
  };
}
type Family = Awaited<ReturnType<typeof family>>;

interface Seed {
  title?: string;
  type?: EventType;
  /** Heure de Paris. */
  start: string;
  status?: EventStatus;
  allDay?: boolean;
  place?: string | null;
  /** Création du rendez-vous (heure de Paris) ; par défaut, bien avant tout. */
  created?: string;
  /** Début de validité des rappels (heure de Paris) ; par défaut, la création. */
  remindersFrom?: string;
  statusChanged?: string;
}
async function seed(f: Family, s: Seed): Promise<string> {
  const created = paris(s.created ?? "2026-10-01T09:00");
  const start = paris(s.start);
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, title_encrypted: seal(s.title ?? "RDV médical — Léo"), event_type: s.type ?? "medical", starts_at: start, ends_at: new Date(start.getTime() + 3_600_000),
      all_day: s.allDay ?? false, place_encrypted: sealOptional(s.place), status: s.status ?? "confirmed", source: "typed", created_by_user_id: f.userIds.camille,
      created_at: created, status_changed_at: paris(s.statusChanged ?? s.created ?? "2026-10-01T09:00"), reminders_from: s.remindersFrom ? paris(s.remindersFrom) : created,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.insertInto("family_event_members").values({ event_id: row.id, member_id: f.leoId }).execute();
  return row.id;
}

const run = (f: Family, local: string) => runReminders(ctxAt(local), { accountId: f.accountId });
const subjects = async (email: string) => (await messagesTo(email)).map((m) => m.subject).sort();

describe("échéances (US-81 RF2, US-83 RF1 et RF4)", () => {
  const start = (local: string, allDay = false) => ({ startsAt: paris(local), allDay });

  it("place J-7 à 9 h, J-1 à 18 h et le jour J à 7 h 30", () => {
    const e = start("2026-11-10T17:00");
    expect(reminderDueAt("d7", e, TZ)).toEqual(paris("2026-11-03T09:00"));
    expect(reminderDueAt("d1", e, TZ)).toEqual(paris("2026-11-09T18:00"));
    expect(reminderDueAt("d0", e, TZ)).toEqual(paris("2026-11-10T07:30"));
  });

  it("avance le rappel du jour à 2 heures avant un rendez-vous qui commence avant 9 h 30 (CA 2.3)", () => {
    expect(reminderDueAt("d0", start("2026-11-10T08:30"), TZ)).toEqual(paris("2026-11-10T06:30"));
    expect(reminderDueAt("d0", start("2026-11-10T09:29"), TZ)).toEqual(paris("2026-11-10T07:29"));
    expect(reminderDueAt("d0", start("2026-11-10T09:30"), TZ)).toEqual(paris("2026-11-10T07:30"));
  });

  it("garde 7 h 30 pour un rendez-vous sur toute la journée, et suit le changement d'heure", () => {
    expect(reminderDueAt("d0", start("2026-11-10T00:00", true), TZ)).toEqual(paris("2026-11-10T07:30"));
    // Le dimanche 25 octobre 2026, l'heure d'hiver revient : J-1 reste à 18 h locales.
    expect(reminderDueAt("d1", start("2026-10-26T10:00"), TZ)).toEqual(paris("2026-10-25T18:00"));
    expect(reminderDueAt("d7", start("2026-11-01T10:00"), TZ)).toEqual(paris("2026-10-25T09:00"));
  });

  it("place la relance 24 h et 48 h après la création, décalée à 8 h si elle tombe de nuit (CA 4.1)", () => {
    const created = paris("2026-11-02T10:00");
    expect(nudgeDueAt("nudge24", created, TZ)).toEqual(paris("2026-11-03T10:00"));
    expect(nudgeDueAt("nudge48", created, TZ)).toEqual(paris("2026-11-04T10:00"));
    expect(nudgeDueAt("nudge24", paris("2026-11-02T23:00"), TZ)).toEqual(paris("2026-11-04T08:00")); // 23 h → 8 h le surlendemain
    expect(nudgeDueAt("nudge24", paris("2026-11-02T05:00"), TZ)).toEqual(paris("2026-11-03T08:00")); // 5 h → 8 h le même jour
    expect(nudgeDueAt("nudge24", paris("2026-11-02T20:30"), TZ)).toEqual(paris("2026-11-03T20:30")); // avant 21 h : inchangé
  });

  it("fait disparaître un rendez-vous écarté à la relance suivante, sinon 24 h après (US-77 RF3)", () => {
    const created = paris("2026-11-02T10:00");
    expect(setAsideExpiry(created, paris("2026-11-02T14:00"), TZ)).toEqual(paris("2026-11-03T10:00"));
    expect(setAsideExpiry(created, paris("2026-11-03T12:00"), TZ)).toEqual(paris("2026-11-04T10:00"));
    expect(setAsideExpiry(created, paris("2026-11-04T12:00"), TZ)).toEqual(paris("2026-11-05T12:00"));
  });
});

describe("rappels d'un rendez-vous confirmé (US-81)", () => {
  it("envoie le rappel J-1 aux deux parents, pas à l'invitée secondaire, et une seule fois (CA 2.1, 3.1, 3.3, 7.1)", async () => {
    const f = await family();
    // Confirmé le 9 au matin : J-7 est passé (non applicable), J-1 part à 18 h.
    await seed(f, { start: "2026-11-10T17:00", place: "Cabinet du Dr Martin", remindersFrom: "2026-11-09T09:00" });
    await run(f, "2026-11-09T17:59");
    expect(await messagesTo(f.emails.camille)).toHaveLength(0);

    await run(f, "2026-11-09T18:00");
    for (const email of [f.emails.camille, f.emails.julien]) {
      const [mail] = await messagesTo(email);
      expect(mail.subject).toBe("Demain 17h00 — RDV médical — Léo");
      expect(mail.text).toContain("/calendrier/rdv/");
    }
    expect(await messagesTo(f.emails.elodie)).toHaveLength(0);

    await run(f, "2026-11-09T18:05");
    await Promise.all([run(f, "2026-11-09T18:10"), run(f, "2026-11-09T18:10")]);
    expect(await messagesTo(f.emails.camille)).toHaveLength(1);
    expect(await messagesTo(f.emails.julien)).toHaveLength(1);
  });

  it("n'envoie jamais deux fois un rappel, même quand deux passages se chevauchent (CA 7.1)", async () => {
    const f = await family();
    await seed(f, { start: "2026-11-10T17:00" });
    await Promise.all([run(f, "2026-11-09T18:01"), run(f, "2026-11-09T18:01"), run(f, "2026-11-09T18:01")]);
    expect(await messagesTo(f.emails.camille)).toHaveLength(1);
    expect(await messagesTo(f.emails.julien)).toHaveLength(1);
  });

  it("envoie le rappel du jour à 7 h 30, ou 2 heures avant un rendez-vous tôt le matin (CA 2.2, 2.3)", async () => {
    const f = await family();
    await seed(f, { title: "Réunion", type: "work", start: "2026-11-10T14:00", remindersFrom: "2026-11-09T19:00" });
    await seed(f, { title: "Prise de sang", type: "personal", start: "2026-11-11T08:30", remindersFrom: "2026-11-10T19:00" });
    await run(f, "2026-11-10T07:29");
    expect(await messagesTo(f.emails.camille)).toHaveLength(0);
    await run(f, "2026-11-10T07:30");
    expect(await subjects(f.emails.camille)).toEqual(["Aujourd'hui 14h00 — Réunion"]);
    await run(f, "2026-11-11T06:30");
    expect(await subjects(f.emails.camille)).toEqual(["Aujourd'hui 14h00 — Réunion", "Aujourd'hui 8h30 — Prise de sang"]);
  });

  it("n'envoie aucun rappel pour un rendez-vous provisoire (CA 1.1)", async () => {
    const f = await family();
    await seed(f, { start: "2026-11-10T17:00", status: "provisional", created: "2026-11-09T09:00" });
    await run(f, "2026-11-09T18:00");
    expect(await messagesTo(f.emails.camille)).toHaveLength(0);
  });

  it("ne donne pas le lieu d'un rendez-vous médical, mais celui des autres (D31)", async () => {
    const f = await family();
    await seed(f, { start: "2026-11-10T17:00", type: "medical", place: "Cabinet du Dr Martin" });
    await seed(f, { title: "Spectacle", start: "2026-11-10T18:00", type: "school", place: "École Jules Ferry" });
    await run(f, "2026-11-09T18:00");
    const mails = await messagesTo(f.emails.camille);
    expect(mails).toHaveLength(2);
    expect(mails.find((m) => m.subject?.includes("RDV médical"))!.text).not.toContain("Cabinet");
    expect(mails.find((m) => m.subject?.includes("Spectacle"))!.text).toContain("Lieu : École Jules Ferry");
  });

  it("n'envoie pas un rappel dont l'heure était déjà passée à la confirmation, et le marque « Non applicable » (CA 5.1, 10.1)", async () => {
    const f = await family();
    // Confirmé le 7 novembre à 10 h pour le 10 : J-7 (le 3) est passé, J-1 et Jour J restent.
    const id = await seed(f, { start: "2026-11-10T17:00", created: "2026-11-02T10:00", statusChanged: "2026-11-07T10:00", remindersFrom: "2026-11-07T10:00" });
    const view = await getEvent(ctxAt("2026-11-08T10:00"), f.session, id);
    expect(view.reminders.map((r) => [r.label, r.state])).toEqual([["J-7", "not_applicable"], ["J-1", "planned"], ["Jour J", "planned"]]);
    expect(view.reminders[1].at).toBe("2026-11-09T18:00");

    await run(f, "2026-11-09T18:00");
    const later = await getEvent(ctxAt("2026-11-09T18:30"), f.session, id);
    expect(later.reminders.map((r) => r.state)).toEqual(["not_applicable", "sent", "planned"]);
    expect(await messagesTo(f.emails.camille)).toHaveLength(1);
  });

  it("rattrape un rappel manqué tant que le rendez-vous n'a pas commencé, puis l'abandonne (CA 8.1, 8.2)", async () => {
    const f = await family();
    await seed(f, { start: "2026-11-10T14:00" });
    await run(f, "2026-11-10T09:00"); // le service reprend à 9 h
    expect(await subjects(f.emails.camille)).toEqual(["Aujourd'hui 14h00 — RDV médical — Léo"]);

    const g = await family();
    await seed(g, { start: "2026-11-10T14:00" });
    await run(g, "2026-11-10T14:00"); // le rendez-vous a commencé
    await run(g, "2026-11-10T15:00");
    expect(await messagesTo(g.emails.camille)).toHaveLength(0);
  });

  it("ne rattrape qu'un seul rappel après un long incident : le plus récent", async () => {
    const f = await family();
    await seed(f, { start: "2026-11-10T17:00" });
    await run(f, "2026-11-09T20:00"); // J-7 et J-1 sont dus et n'ont rien envoyé
    expect(await subjects(f.emails.camille)).toEqual(["Demain 17h00 — RDV médical — Léo"]);
    await run(f, "2026-11-09T20:10");
    expect(await messagesTo(f.emails.camille)).toHaveLength(1);
  });

  it("dit « Dans 7 jours » pour J-7, et compte les jours à l'envoi", async () => {
    const f = await family();
    await seed(f, { title: "Contrôle technique", type: "admin", start: "2026-11-10T09:00" });
    await run(f, "2026-11-03T09:00");
    expect(await subjects(f.emails.camille)).toEqual(["Dans 7 jours 9h00 — Contrôle technique"]);
  });

  it("réessaie après un échec d'envoi, tant que le rendez-vous n'a pas commencé (RF8, RF11)", async () => {
    const f = await family();
    await seed(f, { start: "2026-11-10T17:00" });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.spyOn(messenger(), "sendEmail").mockRejectedValueOnce(new Error("SMTP indisponible")).mockRejectedValueOnce(new Error("SMTP indisponible"));
    try {
      expect(await run(f, "2026-11-09T18:00")).toMatchObject({ sent: 0, failed: 2 });
      expect(await messagesTo(f.emails.camille)).toHaveLength(0);
    } finally {
      failing.mockRestore();
      quiet.mockRestore();
    }
    expect(await run(f, "2026-11-09T18:05")).toMatchObject({ sent: 2, failed: 0 });
    expect(await messagesTo(f.emails.camille)).toHaveLength(1);
  });

  it("reprend une réservation restée sans envoi au bout de 10 minutes, mais pas avant", async () => {
    const f = await family();
    const id = await seed(f, { start: "2026-11-10T17:00" });
    const users = await db.selectFrom("users").select("id").where("account_id", "=", f.accountId).where("role", "!=", "guest").execute();
    const julien = await db.selectFrom("users").select("id").where("account_id", "=", f.accountId).where("guest_rank", "=", "core").executeTakeFirstOrThrow();
    await db.insertInto("family_notifications").values([
      { account_id: f.accountId, event_id: id, kind: "d1", recipient_user_id: users[0].id, claimed_at: paris("2026-11-09T17:55") }, // 5 minutes : encore en cours
      { account_id: f.accountId, event_id: id, kind: "d1", recipient_user_id: julien.id, claimed_at: paris("2026-11-09T17:40") }, // 20 minutes : abandonnée
    ]).execute();
    await run(f, "2026-11-09T18:00");
    expect(await messagesTo(f.emails.camille)).toHaveLength(0);
    expect(await messagesTo(f.emails.julien)).toHaveLength(1);
  });

  it("recalcule les rappels quand l'horaire change, et n'en envoie plus après une annulation (CA 9.1)", async () => {
    const f = await family();
    const id = await seed(f, { start: "2026-11-10T17:00", created: "2026-11-02T10:00" });
    await run(f, "2026-11-03T09:00"); // J-7 envoyé pour le 10
    expect(await messagesTo(f.emails.camille)).toHaveLength(1);

    // Le 5 novembre, le rendez-vous passe du 10 au 20 novembre.
    const moved = await updateEvent(ctxAt("2026-11-05T10:00"), f.session, id, { title: "RDV médical — Léo", type: "medical", allFamily: false, memberIds: [f.leoId], start: "2026-11-20T17:00", end: "2026-11-20T18:00", allDay: false }, { expectedVersion: 1 });
    expect(moved.reminders.map((r) => r.state)).toEqual(["planned", "planned", "planned"]); // J-7 (le 13) est de nouveau à venir
    await run(f, "2026-11-09T18:00"); // l'ancien J-1 ne part pas
    expect(await messagesTo(f.emails.camille)).toHaveLength(1);
    await run(f, "2026-11-13T09:00");
    expect(await subjects(f.emails.camille)).toEqual(["Dans 7 jours 17h00 — RDV médical — Léo", "Dans 7 jours 17h00 — RDV médical — Léo"]);

    await cancelEvent(ctxAt("2026-11-14T10:00"), f.session, id);
    await run(f, "2026-11-19T18:00");
    expect(await messagesTo(f.emails.camille)).toHaveLength(2);
  });
});

describe("délais de rappel par type (US-82)", () => {
  it("liste les six types, tous actifs par défaut (CA 1.1, 2.1)", async () => {
    const f = await family();
    const { settings, canEdit } = await getReminderSettings(ctxAt("2026-11-02T09:00"), f.session);
    expect(settings.map((s) => s.type)).toEqual(["school", "medical", "work", "family", "personal", "admin"]);
    expect(settings.every((s) => s.d7 && s.d1 && s.d0)).toBe(true);
    expect(canEdit).toBe(true);
  });

  it("est commun aux deux parents, qui peuvent tous deux le modifier ; pas l'invitée secondaire (CA 3.1, 4.1, 4.2)", async () => {
    const f = await family();
    const now = ctxAt("2026-11-02T09:00");
    expect(await setReminderSetting(now, f.julienSession, { type: "family", kind: "d7", enabled: false })).toEqual({ type: "family", d7: false, d1: true, d0: true });
    expect((await getReminderSettings(now, f.session)).settings.find((s) => s.type === "family")).toMatchObject({ d7: false });
    expect((await failure(getReminderSettings(now, f.elodieSession))).status).toBe(403);
    expect((await failure(setReminderSetting(now, f.elodieSession, { type: "family", kind: "d7", enabled: true }))).status).toBe(403);
    expect((await failure(setReminderSetting(now, f.session, { type: "inconnu", kind: "d7", enabled: true }))).code).toBe("invalid_type");
    expect((await failure(setReminderSetting(now, f.session, { type: "family", kind: "d3", enabled: true }))).code).toBe("invalid_kind");
  });

  it("supprime le rappel désactivé pour les rendez-vous existants, pour tous les destinataires (CA 3.1, 6.1)", async () => {
    const f = await family();
    const id = await seed(f, { title: "Rendez-vous à la mairie", type: "admin", start: "2026-11-12T10:00", created: "2026-11-01T10:00" });
    await setReminderSetting(ctxAt("2026-11-02T09:00"), f.session, { type: "admin", kind: "d7", enabled: false });
    await run(f, "2026-11-05T09:00"); // J-7 : désactivé
    expect(await messagesTo(f.emails.camille)).toHaveLength(0);
    expect(await messagesTo(f.emails.julien)).toHaveLength(0);
    expect((await getEvent(ctxAt("2026-11-05T10:00"), f.session, id)).reminders.map((r) => r.state)).toEqual(["off", "planned", "planned"]);
    await run(f, "2026-11-11T18:00"); // J-1 reste actif
    expect(await subjects(f.emails.camille)).toEqual(["Demain 10h00 — Rendez-vous à la mairie"]);
  });

  it("ne rattrape pas un rappel réactivé après son échéance", async () => {
    const f = await family();
    await seed(f, { start: "2026-11-12T10:00", created: "2026-11-01T10:00" });
    await setReminderSetting(ctxAt("2026-11-02T09:00"), f.session, { type: "medical", kind: "d7", enabled: false });
    await setReminderSetting(ctxAt("2026-11-06T09:00"), f.session, { type: "medical", kind: "d7", enabled: true }); // J-7 était le 5
    await run(f, "2026-11-06T09:05");
    expect(await messagesTo(f.emails.camille)).toHaveLength(0);
  });
});

describe("relances d'un rendez-vous provisoire (US-83)", () => {
  const provisional = (f: Family, over: Seed = { start: "2026-11-06T17:00" }) => seed(f, { status: "provisional", created: "2026-11-02T10:00", ...over });

  it("relance les deux parents à 24 h puis à 48 h, sans doublon, avec le lien de confirmation (CA 1.1, 1.2, 7.2)", async () => {
    const f = await family();
    const id = await provisional(f);
    await run(f, "2026-11-03T09:59");
    expect(await messagesTo(f.emails.camille)).toHaveLength(0);
    await run(f, "2026-11-03T10:00");
    await run(f, "2026-11-03T10:05");
    for (const email of [f.emails.camille, f.emails.julien]) {
      const [mail] = await messagesTo(email);
      expect(mail.subject).toBe("À confirmer : RDV médical — Léo, vendredi 17h00");
      expect(mail.text).toContain(`/calendrier/rdv/${id}`);
    }
    expect(await messagesTo(f.emails.elodie)).toHaveLength(0);

    expect((await getEvent(ctxAt("2026-11-03T11:00"), f.session, id)).nudge).toEqual({ kind: "nudge24", sentAt: paris("2026-11-03T10:00").toISOString() });
    await run(f, "2026-11-04T10:00");
    expect(await messagesTo(f.emails.camille)).toHaveLength(2);
    expect((await getEvent(ctxAt("2026-11-04T11:00"), f.session, id)).nudge?.kind).toBe("nudge48");
  });

  it("n'envoie que la dernière relance due après un incident, et décale celles de la nuit à 8 h (CA 4.1, 9.1)", async () => {
    const f = await family();
    await provisional(f);
    await run(f, "2026-11-04T12:00"); // 24 h et 48 h sont dues : la seconde seule part
    expect(await messagesTo(f.emails.camille)).toHaveLength(1);

    const g = await family();
    await provisional(g, { start: "2026-11-10T17:00", created: "2026-11-02T23:00" });
    await run(g, "2026-11-03T23:30");
    expect(await messagesTo(g.emails.camille)).toHaveLength(0);
    await run(g, "2026-11-04T07:59");
    expect(await messagesTo(g.emails.camille)).toHaveLength(0);
    await run(g, "2026-11-04T08:00");
    expect(await messagesTo(g.emails.camille)).toHaveLength(1);
  });

  it("n'envoie rien si le rendez-vous est confirmé, écarté, modifié par un parent, ou commence avant la relance (CA 5.1, 5.2)", async () => {
    const f = await family();
    await seed(f, { status: "confirmed", created: "2026-11-02T10:00", start: "2026-11-06T17:00", remindersFrom: "2026-11-03T06:00", statusChanged: "2026-11-03T06:00", title: "Confirmé" });
    await seed(f, { status: "set_aside", created: "2026-11-02T10:00", start: "2026-11-06T17:00", statusChanged: "2026-11-02T14:00", title: "Écarté" });
    await provisional(f, { start: "2026-11-03T09:00", title: "Trop proche" }); // commence avant la relance de 10 h
    const modified = await provisional(f, { start: "2026-11-06T17:00", title: "Modifié" });
    await db.insertInto("family_event_history").values({ account_id: f.accountId, event_id: modified, action: "modified", from_status: "provisional", to_status: "provisional", by_user_id: f.userIds.camille }).execute();
    await run(f, "2026-11-03T10:00");
    expect((await messagesTo(f.emails.camille)).filter((m) => m.subject?.startsWith("À confirmer"))).toHaveLength(0);
  });
});

describe("passage automatique au statut Ignoré (US-83 RF6, US-77 RF3)", () => {
  const statusOf = async (id: string) => db.selectFrom("family_events").select(["status", "version", "status_changed_by_user_id"]).where("id", "=", id).executeTakeFirstOrThrow();

  it("ignore un rendez-vous provisoire jamais confirmé à son début, avec le motif « sans réponse » (CA 6.1)", async () => {
    const f = await family();
    const waiting = await seed(f, { status: "provisional", created: "2026-11-02T10:00", start: "2026-11-05T15:00" });
    const confirmed = await seed(f, { status: "confirmed", start: "2026-11-05T15:00" });
    await run(f, "2026-11-05T14:59");
    expect((await statusOf(waiting)).status).toBe("provisional");
    expect(await run(f, "2026-11-05T15:00")).toMatchObject({ ignored: 1 });
    expect(await statusOf(waiting)).toMatchObject({ status: "ignored", version: 2, status_changed_by_user_id: null });
    expect((await statusOf(confirmed)).status).toBe("confirmed");
    const [entry] = await db.selectFrom("family_event_history").select(["action", "from_status", "to_status", "by_user_id", "reason"]).where("event_id", "=", waiting).execute();
    expect(entry).toEqual({ action: "ignored", from_status: "provisional", to_status: "ignored", by_user_id: null, reason: "sans réponse" });
    expect((await failure(getEvent(ctxAt("2026-11-05T16:00"), f.session, waiting))).code).toBe("gone");
    await run(f, "2026-11-05T16:00");
    expect((await db.selectFrom("family_event_history").select("id").where("event_id", "=", waiting).execute())).toHaveLength(1);
  });

  it("fait disparaître un rendez-vous écarté à la relance suivante, sans relance (CA 3.1)", async () => {
    const f = await family();
    const id = await seed(f, { status: "set_aside", created: "2026-11-02T10:00", statusChanged: "2026-11-02T14:00", start: "2026-11-09T15:00" });
    await run(f, "2026-11-03T09:59");
    expect((await statusOf(id)).status).toBe("set_aside");
    await run(f, "2026-11-03T10:00");
    expect((await statusOf(id)).status).toBe("ignored");
    expect(await messagesTo(f.emails.camille)).toHaveLength(0);
  });

  it("fait disparaître un rendez-vous écarté après la seconde relance 24 h plus tard (CA 3.2)", async () => {
    const f = await family();
    const id = await seed(f, { status: "set_aside", created: "2026-11-02T10:00", statusChanged: "2026-11-04T12:00", start: "2026-11-09T15:00" });
    await run(f, "2026-11-05T11:59");
    expect((await statusOf(id)).status).toBe("set_aside");
    await run(f, "2026-11-05T12:00");
    expect((await statusOf(id)).status).toBe("ignored");
  });

  it("supprime les rendez-vous ignorés 30 jours après (US-77 RT1)", async () => {
    const f = await family();
    const old = await seed(f, { status: "ignored", start: "2026-10-01T15:00", statusChanged: "2026-10-01T15:00" });
    const recent = await seed(f, { status: "ignored", start: "2026-10-20T15:00", statusChanged: "2026-10-20T15:00" });
    await purgeExpired(ctxAt("2026-11-02T09:00"));
    expect(await db.selectFrom("family_events").select("id").where("id", "in", [old, recent]).execute()).toEqual([{ id: recent }]);
  });
});
