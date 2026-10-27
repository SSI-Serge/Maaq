import { randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { cancelEvent, confirmEvent, getEvent, listEvents, listPending, setAsideEvent, updateEvent, type EventChanges } from "@/server/assistant/events";
import { addChild } from "@/server/assistant/family";
import { seal } from "@/server/assistant/fields";
import { loadAgentDefinition } from "@/server/assistant/agent";
import { runEventNotices } from "@/server/assistant/notices";
import { Pseudonymizer } from "@/server/assistant/pseudonymize";
import { runReminders } from "@/server/assistant/reminders";
import { completeSeries, createSeries, expandOccurrences, ruleLabel, type SeriesRule } from "@/server/assistant/series";
import { ruleFromRepetition } from "@/server/assistant/series-ops";
import { getSchoolZone, setSchoolZone } from "@/server/assistant/school-zone";
import { executeTool, type ToolContext } from "@/server/assistant/tools";
import { loadPseudoMembers } from "@/server/assistant/family";
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
beforeAll(async () => {
  db = testDb();
  await db.updateTable("platform_settings").set({ value_text: "2020-01-01T00:00:00Z" }).where("setting_key", "=", "event_notice_activation_at").execute();
  // Vacances de la zone C, dans un futur lointain (les fonctions de la base lisent l'horloge réelle).
  await db.insertInto("school_holiday_periods").values([
    { zone: "C", school_year: "2054-2055", label: "Vacances de Noël", starts_on: "2054-12-20", ends_on: "2055-01-04" },
    { zone: "C", school_year: "2054-2055", label: "Vacances d'hiver", starts_on: "2055-02-20", ends_on: "2055-03-07" },
  ]).onConflict((oc) => oc.columns(["zone", "starts_on"]).doNothing()).execute();
});
afterAll(async () => {
  await db.updateTable("platform_settings").set({ value_text: null }).where("setting_key", "=", "event_notice_activation_at").execute();
  await db.destroy();
});
beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
});

const NOW = new Date("2054-11-02T08:00:00Z"); // lundi 2 novembre 2054, 9 h à Paris
const ctx: Ctx = { get db() { return db; }, now: NOW } as Ctx;
const payloads = () => send.mock.calls.map((c) => JSON.parse(c[1] as string) as { body: string; tag: string });
const fcm = () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });

function zoneWhereItIs(hour: number): string {
  let offset = hour - new Date().getUTCHours();
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

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

/** Foyer : Camille (demandeuse), Julien (invité 1, notifications autorisées), Élodie (invitée secondaire), Léo et Mia. */
async function family(options: { notifyZone?: boolean } = {}) {
  const camille = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Camille" }).where("id", "=", camille.id).execute();
  if (options.notifyZone) await db.updateTable("accounts").set({ family_timezone: zoneWhereItIs(12) }).where("id", "=", camille.accountId!).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const camilleSession = await onDevice(camille.id);
  const julienSession = await onDevice(julien.id);
  const elodieSession = await sessionFor(db, elodie.id);
  await saveSubscription(ctx, julienSession, fcm());
  const leo = await addChild(ctx, camilleSession, { firstName: "Léo" });
  const mia = await addChild(ctx, camilleSession, { firstName: "Mia" });
  return { accountId: camille.accountId!, camille, julien, elodie, camilleSession, julienSession, elodieSession, leoId: leo.id, miaId: mia.id };
}
type Family = Awaited<ReturnType<typeof family>>;

const wednesday: SeriesRule = { unit: "week", interval: 1, weekdays: [3], end: { kind: "never" }, skipSchoolHolidays: false };
const base = (f: Family) => ({ accountId: f.accountId, userId: f.camille.id, type: "personal" as const, title: "Foot", place: "Stade Léo Lagrange", notes: null, startTime: "14:00", durationMinutes: 60, allDay: false, allFamily: false, memberIds: [f.leoId], firstDate: "2054-11-04", rule: wednesday, timeZone: "Europe/Paris", source: "typed" as const, now: NOW });

const occurrences = (seriesId: string) => db.selectFrom("family_events").select(["id", "status", "starts_at", "is_modified"]).select((eb) => eb.fn<string>("to_char", ["occurrence_date", eb.val("YYYY-MM-DD")]).as("day")).where("series_id", "=", seriesId).orderBy("occurrence_date").execute();

// ---------------------------------------------------------------------------------------------------------------------------
describe("calcul des séances (US-109 RF2, RF3, RF4, RT4)", () => {
  it("chaque semaine, un ou plusieurs jours (CA 1.1, 2.1)", () => {
    expect(expandOccurrences(wednesday, "2054-11-04", "2054-11-25")).toEqual(["2054-11-04", "2054-11-11", "2054-11-18", "2054-11-25"]);
    const twice: SeriesRule = { ...wednesday, weekdays: [1, 4] };
    expect(expandOccurrences(twice, "2054-11-05", "2054-11-17")).toEqual(["2054-11-05", "2054-11-09", "2054-11-12", "2054-11-16"]); // lundi et jeudi, à partir du jeudi 5
  });

  it("toutes les deux semaines, à partir de la première séance", () => {
    const rule: SeriesRule = { ...wednesday, interval: 2 };
    expect(expandOccurrences(rule, "2054-11-04", "2054-12-10")).toEqual(["2054-11-04", "2054-11-18", "2054-12-02"]);
  });

  it("chaque mois le même jour (le 31 se replie sur le dernier jour du mois)", () => {
    const rule: SeriesRule = { unit: "month", interval: 1, monthMode: "day_of_month", monthDay: 31, end: { kind: "never" }, skipSchoolHolidays: false };
    expect(expandOccurrences(rule, "2054-10-31", "2055-03-31")).toEqual(["2054-10-31", "2054-11-30", "2054-12-31", "2055-01-31", "2055-02-28", "2055-03-31"]);
  });

  it("chaque mois le même jour de la semaine : le premier mardi (CA 2.2), le dernier vendredi", () => {
    const first: SeriesRule = { unit: "month", interval: 1, monthMode: "nth_weekday", monthNth: 1, monthWeekday: 2, end: { kind: "never" }, skipSchoolHolidays: false };
    expect(expandOccurrences(first, "2054-11-03", "2055-01-31")).toEqual(["2054-11-03", "2054-12-01", "2055-01-05"]);
    const last: SeriesRule = { ...first, monthNth: -1, monthWeekday: 5 };
    expect(expandOccurrences(last, "2054-11-01", "2055-01-31")).toEqual(["2054-11-27", "2054-12-25", "2055-01-29"]);
  });

  it("s'arrête à une date ou après un nombre de séances réellement tenues, vacances sautées exclues (D47)", () => {
    expect(expandOccurrences({ ...wednesday, end: { kind: "date", date: "2054-11-18" } }, "2054-11-04", "2055-06-30")).toEqual(["2054-11-04", "2054-11-11", "2054-11-18"]);
    const holidays = [["2054-11-10", "2054-11-24"]] as const;
    const counted: SeriesRule = { ...wednesday, end: { kind: "count", count: 3 }, skipSchoolHolidays: true };
    expect(expandOccurrences(counted, "2054-11-04", "2055-06-30", holidays)).toEqual(["2054-11-04", "2054-11-25", "2054-12-02"]); // 3 séances tenues : les 11 et 18 tombent pendant les vacances
    expect(expandOccurrences({ ...counted, skipSchoolHolidays: false }, "2054-11-04", "2055-06-30", holidays)).toEqual(["2054-11-04", "2054-11-11", "2054-11-18"]);
  });

  it("dit la règle en français (RF10)", () => {
    expect(ruleLabel({ ...wednesday, end: { kind: "date", date: "2055-06-30" } })).toBe("Chaque mercredi jusqu'au 30/06/2055");
    expect(ruleLabel({ ...wednesday, weekdays: [1, 4] })).toBe("Chaque lundi et jeudi");
    expect(ruleLabel({ ...wednesday, interval: 2 })).toBe("Toutes les deux semaines le mercredi");
    expect(ruleLabel(ruleFromRepetition({ frequency: "monthly_weekday", end: { kind: "count", count: 5 } }, "2054-11-03"))).toBe("Le premier mardi de chaque mois (5 séances)");
    expect(ruleLabel(ruleFromRepetition({ frequency: "monthly_day", end: { kind: "never" } }, "2054-11-05"))).toBe("Chaque mois le 5");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("création d'une série", () => {
  it("crée les séances des 6 prochains mois, provisoires, avec les mêmes membres et l'heure locale", async () => {
    const f = await family();
    const { seriesId, eventIds } = await createSeries(db, base(f));
    expect(eventIds.length).toBeGreaterThanOrEqual(25); // du 4/11/2054 au 2/5/2055, un mercredi sur deux jusqu'à fin avril
    const rows = await occurrences(seriesId);
    expect(rows.every((r) => r.status === "provisional")).toBe(true);
    expect(rows[0].day).toBe("2054-11-04".replace("04", "04"));
    expect(rows[0].starts_at.toISOString()).toBe("2054-11-04T13:00:00.000Z"); // 14 h à Paris, heure d'hiver
    const summer = rows.find((r) => r.day >= "2055-04-01")!;
    expect(summer.starts_at.toISOString().slice(11, 16)).toBe("12:00"); // 14 h à Paris, heure d'été : l'heure locale ne bouge pas (RT4)
    const members = await db.selectFrom("family_event_members").select("member_id").where("event_id", "=", rows[3].id).execute();
    expect(members.map((m) => m.member_id)).toEqual([f.leoId]);
  });

  it("refuse une règle sans séance, « sauf vacances » sans zone réglée (CA 4.2), et plafonne à 30 séries actives", async () => {
    const f = await family();
    await expect(createSeries(db, { ...base(f), firstDate: "2054-11-04", rule: { ...wednesday, end: { kind: "date", date: "2054-11-04" }, skipSchoolHolidays: true } })).rejects.toThrow(/zone scolaire/);
    await expect(createSeries(db, { ...base(f), rule: { ...wednesday, weekdays: [3], end: { kind: "date", date: "2054-11-03" } }, firstDate: "2054-11-04" })).rejects.toBeTruthy();
    for (let i = 0; i < 30; i++) await createSeries(db, { ...base(f), title: `Activité ${i}`, firstDate: "2054-11-04", rule: { ...wednesday, end: { kind: "count", count: 2 } }, durationMinutes: 30 + i });
    await expect(createSeries(db, { ...base(f), title: "La trente et unième" })).rejects.toThrow(/maximal/);
  });

  it("sauf vacances scolaires : aucune séance pendant les vacances de la zone (CA 4.1)", async () => {
    const f = await family();
    await setSchoolZone(ctx, f.camilleSession, "C");
    const { seriesId } = await createSeries(db, { ...base(f), rule: { ...wednesday, skipSchoolHolidays: true } });
    const days = (await occurrences(seriesId)).map((r) => r.day);
    expect(days).toContain("2054-12-16");
    expect(days).not.toContain("2054-12-23");
    expect(days).not.toContain("2054-12-30");
    expect(days).toContain("2055-01-06");
    expect(days.filter((d) => d >= "2055-02-20" && d <= "2055-03-07")).toEqual([]);
  });

  it("la zone scolaire se règle par les parents et se lit par tous (RF4)", async () => {
    const f = await family();
    expect(await getSchoolZone(ctx, f.elodieSession)).toEqual({ zone: null, canEdit: false, holidaysLoaded: false });
    expect((await setSchoolZone(ctx, f.julienSession, "C")).zone).toBe("C");
    expect(await getSchoolZone(ctx, f.elodieSession)).toMatchObject({ zone: "C", canEdit: false, holidaysLoaded: true });
    expect((await failure(setSchoolZone(ctx, f.elodieSession, "A"))).status).toBe(403);
    expect((await failure(setSchoolZone(ctx, f.camilleSession, "D"))).code).toBe("invalid_zone");
    expect((await setSchoolZone(ctx, f.camilleSession, null)).zone).toBeNull();
  });

  it("l'outil de l'agent crée une série provisoire, et refuse une règle incohérente", async () => {
    const f = await family();
    const pseudo = new Pseudonymizer(await loadPseudoMembers(db, f.accountId));
    const toolCtx: ToolContext = { db, accountId: f.accountId, userId: f.camille.id, timeZone: "Europe/Paris", now: NOW, requestId: randomUUID(), source: "typed", pseudo, created: { ids: [] }, proposals: [] };
    const input = { titre: "Foot", type: "perso", debut: "2054-11-04T14:00", fin: "2054-11-04T15:00", journee_entiere: false, membres: ["Enfant 1"], source: "saisie", repetition: { frequence: "hebdomadaire", jours: ["mercredi"], fin: { type: "date", date: "2054-12-02" } } };
    const result = await executeTool("creer_evenement_provisoire", input, toolCtx);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ statut: "provisoire", seances: 5 });
    expect(toolCtx.created.ids).toHaveLength(1);
    expect((await executeTool("creer_evenement_provisoire", { ...input, repetition: { frequence: "hebdomadaire" } }, toolCtx)).content).toContain("Jusqu'à quand");
    expect((await executeTool("creer_evenement_provisoire", { ...input, repetition: { frequence: "tous_les_jours", fin: { type: "jamais" } } }, toolCtx)).content).toContain("fréquence inconnue");
    expect((await executeTool("creer_evenement_provisoire", { ...input, debut: "2054-11-05T14:00", fin: "2054-11-05T15:00", repetition: { ...input.repetition, sauf_vacances_scolaires: true } }, toolCtx)).content).toContain("zone scolaire");
    const definition = loadAgentDefinition();
    const create = (definition.tools as { name: string; input_schema: { properties: Record<string, unknown> } }[]).find((t) => t.name === "creer_evenement_provisoire")!;
    expect(Object.keys(create.input_schema.properties)).toContain("repetition");
    expect(definition.instructions).toContain("Jusqu'à quand");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("confirmation de la série (US-109 RF5, RF6, RT2)", () => {
  it("CA 6.1, 1.1 US-113 : une confirmation confirme toutes les séances, et l'autre parent reçoit une seule notification de série (RF9)", async () => {
    const f = await family({ notifyZone: true });
    const { seriesId, eventIds } = await createSeries(db, base(f));
    const view = await getEvent(ctx, f.camilleSession, eventIds[0]);
    expect(view.recurring).toBe(true);
    expect(view.series).toMatchObject({ rule: "Chaque mercredi", status: "provisional", modified: false });
    await confirmEvent(ctx, f.camilleSession, eventIds[0]);
    const rows = await occurrences(seriesId);
    expect(rows.every((r) => r.status === "confirmed")).toBe(true);
    const series = await db.selectFrom("family_event_series").select(["status", "confirmed_by_user_id"]).where("id", "=", seriesId).executeTakeFirstOrThrow();
    expect(series).toMatchObject({ status: "confirmed", confirmed_by_user_id: f.camille.id });
    const notices = payloads().filter((c) => c.tag.startsWith("notice-"));
    expect(notices).toHaveLength(1); // une seule notification pour toute la série
    expect(notices[0].body).toMatch(/^Camille a ajouté : Foot, chaque mercredi à \d+h\d\d, à partir du 04\/11$/);
  });

  it("CA 5.1 : les séances en conflit sont comptées et listées ; sans accord explicite la série n'est pas confirmée", async () => {
    const f = await family();
    const type = await db.selectFrom("event_types").select("id").where("code", "=", "school").executeTakeFirstOrThrow();
    const clash = async (start: string) => {
      const row = await db.insertInto("family_events").values({ account_id: f.accountId, event_type_id: type.id, title: seal("Cours"), starts_at: new Date(start), ends_at: new Date(new Date(start).getTime() + 3_600_000), status: "confirmed", source: "chat_text", requested_by_user_id: f.camille.id, confirmed_at: NOW, fingerprint: randomBytes(16) }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("family_event_members").values({ event_id: row.id, member_id: f.leoId, account_id: f.accountId }).execute();
    };
    await clash("2054-11-11T13:00:00Z");
    await clash("2054-11-25T13:30:00Z");
    const { seriesId, eventIds } = await createSeries(db, base(f));
    const view = await getEvent(ctx, f.camilleSession, eventIds[0]);
    expect(view.series?.conflicts.count).toBe(2);
    expect(view.series?.conflicts.sessions.map((s) => s.start.slice(0, 10))).toEqual(["2054-11-11", "2054-11-25"]);
    const refused = await failure(confirmEvent(ctx, f.camilleSession, eventIds[0]));
    expect([refused.code, (refused.details as { sessions: string[] }).sessions]).toEqual(["conflict", ["2054-11-11T14:00", "2054-11-25T14:00"]]);
    expect((await occurrences(seriesId)).every((r) => r.status === "provisional")).toBe(true); // aucune séance confirmée (RF14)
    await confirmEvent(ctx, f.camilleSession, eventIds[0], { allowConflict: true });
    expect((await occurrences(seriesId)).every((r) => r.status === "confirmed")).toBe(true);
  });

  it("n'affiche qu'une confirmation en attente pour toute la série, et « Ignorer » l'écarte tout entière", async () => {
    const f = await family();
    const { seriesId, eventIds } = await createSeries(db, base(f));
    expect((await listPending(ctx, f.julienSession)).filter((e) => e.recurring)).toHaveLength(1);
    await setAsideEvent(ctx, f.julienSession, eventIds[2]);
    const rows = await occurrences(seriesId);
    expect(rows.every((r) => r.status === "dismissed")).toBe(true);
    expect((await db.selectFrom("family_event_series").select("status").where("id", "=", seriesId).executeTakeFirstOrThrow()).status).toBe("dismissed");
  });

  it("CA 12.1 : l'invitée secondaire ne peut pas confirmer ni modifier la série demandée par un parent", async () => {
    const f = await family();
    const { eventIds } = await createSeries(db, { ...base(f), memberIds: [(await db.selectFrom("family_members").select("id").where("user_id", "=", f.elodie.id).executeTakeFirstOrThrow()).id] });
    const view = await getEvent(ctx, f.elodieSession, eventIds[0]);
    expect(view.can).toEqual({ confirm: false, modify: false, setAside: false, cancel: false });
    expect((await failure(confirmEvent(ctx, f.elodieSession, eventIds[0]))).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("modifier et annuler avec une portée (US-109 RF7, RF8)", () => {
  const form = (f: Family, over: Partial<EventChanges> = {}): EventChanges => ({ title: "Foot", type: "personal", allFamily: false, memberIds: [f.leoId], start: "2054-11-11T14:00", end: "2054-11-11T15:00", allDay: false, place: "Stade", notes: null, ...over });

  async function confirmed(f: Family) {
    const { seriesId, eventIds } = await createSeries(db, base(f));
    await confirmEvent(ctx, f.camilleSession, eventIds[0]);
    return { seriesId, eventIds };
  }

  it("CA 7.1 : un RDV provisoire devient une série", async () => {
    const f = await family();
    const type = await db.selectFrom("event_types").select("id").where("code", "=", "personal").executeTakeFirstOrThrow();
    const single = await db.insertInto("family_events").values({ account_id: f.accountId, event_type_id: type.id, title: seal("Judo"), starts_at: new Date("2054-11-04T13:00:00Z"), ends_at: new Date("2054-11-04T14:00:00Z"), status: "provisional", source: "chat_text", requested_by_user_id: f.camille.id, fingerprint: randomBytes(16) }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("family_event_members").values({ event_id: single.id, member_id: f.leoId, account_id: f.accountId }).execute();
    const view = await updateEvent(ctx, f.camilleSession, single.id, { ...form(f, { title: "Judo", start: "2054-11-04T14:00", end: "2054-11-04T15:00" }), repetition: { frequency: "weekly", end: { kind: "count", count: 4 } } }, { expectedVersion: 1 });
    expect(view.recurring).toBe(true);
    expect(view.series?.rule).toBe("Chaque mercredi (4 séances)");
    expect(view.id).not.toBe(single.id);
    expect(await db.selectFrom("family_events").select("id").where("id", "=", single.id).execute()).toEqual([]);
    expect((await occurrences(view.series!.id)).map((r) => r.day)).toEqual(["2054-11-04", "2054-11-11", "2054-11-18", "2054-11-25"]);
  });

  it("CA 8.1 : « cette séance » ne change que cette séance, qui porte la mention « Modifiée »", async () => {
    const f = await family();
    const { seriesId, eventIds } = await confirmed(f);
    const second = (await occurrences(seriesId))[1];
    const view = await updateEvent(ctx, f.camilleSession, second.id, form(f, { start: "2054-11-11T15:00", end: "2054-11-11T16:00" }), { expectedVersion: 2, scope: "this" });
    expect([view.start, view.series?.modified]).toEqual(["2054-11-11T15:00", true]);
    const rows = await occurrences(seriesId);
    expect(rows.filter((r) => r.is_modified)).toHaveLength(1);
    expect(rows[0].starts_at.toISOString()).toBe("2054-11-04T13:00:00.000Z"); // les autres ne bougent pas
    expect(eventIds[0]).toBe(rows[0].id);
  });

  it("« toute la série » change l'heure des séances à venir sans toucher celles modifiées seules (D47)", async () => {
    const f = await family();
    const { seriesId } = await confirmed(f);
    const rows = await occurrences(seriesId);
    await updateEvent(ctx, f.camilleSession, rows[1].id, form(f, { start: "2054-11-11T16:00", end: "2054-11-11T17:00" }), { expectedVersion: 2, scope: "this" });
    const view = await updateEvent(ctx, f.camilleSession, rows[0].id, form(f, { start: "2054-11-04T17:00", end: "2054-11-04T18:00", place: "Gymnase" }), { expectedVersion: 2, scope: "all" });
    expect(view.start).toBe("2054-11-04T17:00");
    const after = await occurrences(seriesId);
    expect(after[1].starts_at.toISOString()).toBe("2054-11-11T15:00:00.000Z"); // la séance modifiée seule garde son heure (16 h)
    expect(after[1].is_modified).toBe(true);
    expect(after[2].starts_at.toISOString()).toBe("2054-11-18T16:00:00.000Z"); // 17 h à Paris
    expect(after.every((r) => r.status === "confirmed")).toBe(true);
    expect(after).toHaveLength((await occurrences(seriesId)).length);
  });

  it("« cette séance et les suivantes » scinde la série : l'ancienne s'arrête la veille, la nouvelle porte la modification", async () => {
    const f = await family();
    const { seriesId } = await confirmed(f);
    const rows = await occurrences(seriesId);
    const view = await updateEvent(ctx, f.camilleSession, rows[3].id, form(f, { start: "2054-11-25T18:00", end: "2054-11-25T19:00" }), { expectedVersion: 2, scope: "following" });
    expect(view.start).toBe("2054-11-25T18:00");
    expect(view.series?.id).not.toBe(seriesId);
    const old = await db.selectFrom("family_event_series").select(["end_kind", "until_date", "status"]).select((eb) => eb.fn<string>("to_char", ["until_date", eb.val("YYYY-MM-DD")]).as("until")).where("id", "=", seriesId).executeTakeFirstOrThrow();
    expect([old.end_kind, old.until, old.status]).toEqual(["date", "2054-11-24", "confirmed"]);
    expect((await occurrences(seriesId)).map((r) => r.day)).toEqual(["2054-11-04", "2054-11-11", "2054-11-18"]);
    const next = await occurrences(view.series!.id);
    expect(next[0].day).toBe("2054-11-25");
    expect(next.every((r) => r.status === "confirmed")).toBe(true);
    expect(next[0].starts_at.toISOString().slice(11, 16)).toBe("17:00"); // 18 h à Paris
    const split = await db.selectFrom("family_event_series").select("split_from_series_id").where("id", "=", view.series!.id).executeTakeFirstOrThrow();
    expect(split.split_from_series_id).toBe(seriesId);
  });

  it("CA 8.2 : annuler « cette séance et les suivantes » garde les séances passées", async () => {
    const f = await family();
    const { seriesId } = await confirmed(f);
    const rows = await occurrences(seriesId);
    await cancelEvent(ctx, f.camilleSession, rows[4].id, { scope: "following" });
    const after = await occurrences(seriesId);
    expect(after.filter((r) => r.status === "confirmed").map((r) => r.day)).toEqual(["2054-11-04", "2054-11-11", "2054-11-18", "2054-11-25"]);
    expect(after.slice(4).every((r) => r.status === "cancelled")).toBe(true);
    const until = await db.selectFrom("family_event_series").select(["end_kind"]).select((eb) => eb.fn<string>("to_char", ["until_date", eb.val("YYYY-MM-DD")]).as("until")).where("id", "=", seriesId).executeTakeFirstOrThrow();
    expect([until.end_kind, until.until]).toEqual(["date", "2054-12-01"]); // la règle ne recrée rien au-delà
    await completeSeries(db, NOW, { accountId: f.accountId });
    expect((await occurrences(seriesId)).filter((r) => r.status === "confirmed")).toHaveLength(4);
  });

  it("annuler « cette séance » ou « toute la série »", async () => {
    const f = await family();
    const { seriesId } = await confirmed(f);
    const rows = await occurrences(seriesId);
    await cancelEvent(ctx, f.camilleSession, rows[2].id, { scope: "this" });
    expect((await occurrences(seriesId)).filter((r) => r.status === "cancelled")).toHaveLength(1);
    await cancelEvent(ctx, f.camilleSession, rows[1].id, { scope: "all" });
    const after = await occurrences(seriesId);
    expect(after.every((r) => r.status === "cancelled")).toBe(true);
    expect((await db.selectFrom("family_event_series").select("status").where("id", "=", seriesId).executeTakeFirstOrThrow()).status).toBe("cancelled");
    const view = await failure(getEvent(ctx, f.camilleSession, rows[1].id));
    expect(view.code).toBe("gone");
  });

  it("le calendrier rend chaque séance, marquée comme répétée (RF10)", async () => {
    const f = await family();
    const { eventIds } = await confirmed(f);
    const list = await listEvents(ctx, f.camilleSession, { from: "2054-11-01", to: "2054-12-31" });
    expect(list.filter((e) => e.recurring)).toHaveLength(9);
    expect(eventIds.length).toBeGreaterThan(9);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("rappels, relances et planificateur (US-109 RF9, RT1, D47, D51)", () => {
  it("CA 9.1, 9.2 : une série hebdomadaire n'envoie que le rappel J-1 ; une série mensuelle suit les délais du type", async () => {
    const f = await family({ notifyZone: true });
    const weekly = await createSeries(db, { ...base(f), title: "Foot", firstDate: "2054-11-11", type: "family" });
    const monthly = await createSeries(db, { ...base(f), title: "Club", firstDate: "2054-11-10", type: "school", startTime: "17:00", rule: { unit: "month", interval: 1, monthMode: "day_of_month", monthDay: 10, end: { kind: "never" }, skipSchoolHolidays: false } });
    await confirmEvent(ctx, f.camilleSession, weekly.eventIds[0]);
    await confirmEvent(ctx, f.camilleSession, monthly.eventIds[0], { allowConflict: true });
    send.mockClear();
    // Les rappels valent à partir de la dernière modification des séances (confirmation) : la base les a datées avec l'horloge réelle.
    const at = (local: string): Ctx => ({ db, now: new Date(local) });
    const tags = () => payloads().map((c) => c.tag);
    await runReminders(at("2054-11-03T09:00:00Z"), { accountId: f.accountId }); // J-7 du 10 (mensuelle, école) ; le 11 est à J-8
    await runReminders(at("2054-11-04T09:00:00Z"), { accountId: f.accountId }); // J-7 du 11 (hebdomadaire) : pas de J-7
    expect(tags()).toContain(`d7-${monthly.eventIds[0]}`); // J-7 de la série mensuelle
    expect(tags().filter((t) => t.startsWith("d7-") && t.endsWith(weekly.eventIds[0]))).toEqual([]); // jamais de J-7 pour la série hebdomadaire
    await runReminders(at("2054-11-11T08:00:00Z"), { accountId: f.accountId }); // J-1 du 11 (18 h locales la veille, selon le fuseau d'essai) : dû, et le RDV n'a pas commencé
    expect(tags()).toContain(`d1-${weekly.eventIds[0]}`);
    expect((await messagesTo(f.julien.email)).filter((m) => m.subject?.includes("Foot"))).toHaveLength(1); // le J-1 est doublé par un email
  });

  it("D47 : une série provisoire n'est relancée qu'une fois, pour sa première séance", async () => {
    const f = await family();
    await db.updateTable("accounts").set({ family_timezone: "Europe/Paris" }).where("id", "=", f.accountId).execute();
    const { eventIds } = await createSeries(db, base(f));
    await db.updateTable("family_events").set({ created_at: new Date("2054-10-30T09:00:00Z") }).where("series_id", "is not", null).where("account_id", "=", f.accountId).execute();
    await runReminders({ db, now: new Date("2054-11-02T09:00:00Z") }, { accountId: f.accountId }); // 24 h écoulées
    await runReminders({ db, now: new Date("2054-11-03T12:00:00Z") }, { accountId: f.accountId }); // et la seconde relance serait due
    const nudges = payloads().filter((c) => c.tag.startsWith("nudge"));
    expect(nudges).toHaveLength(1);
    expect(nudges[0].tag).toBe(`nudge24-${eventIds[0]}`);
    expect(eventIds.length).toBeGreaterThan(20);
  });

  it("complète les séances vers l'avant sans recréer une séance annulée, et ferme une série jamais confirmée à sa première séance (D51)", async () => {
    const f = await family();
    const { seriesId, eventIds } = await createSeries(db, base(f));
    const before = (await occurrences(seriesId)).length;
    expect((await completeSeries(db, NOW, { accountId: f.accountId })).created).toBe(0); // rien de plus à créer le jour même
    const later = await completeSeries(db, new Date("2054-12-02T08:00:00Z"), { accountId: f.accountId }); // un mois plus tard : l'horizon avance
    expect(later.created).toBeGreaterThanOrEqual(4);
    expect((await occurrences(seriesId)).length).toBe(before + later.created);
    // Première séance commencée sans confirmation : la série est fermée, sans rien confirmer.
    await db.updateTable("family_events").set({ starts_at: new Date(Date.now() - 3_600_000), ends_at: new Date(Date.now() - 1_800_000) }).where("id", "=", eventIds[0]).execute();
    const closed = await completeSeries(db, NOW, { accountId: f.accountId });
    expect(closed.dismissed).toBeGreaterThanOrEqual(1);
    expect((await db.selectFrom("family_event_series").select("status").where("id", "=", seriesId).executeTakeFirstOrThrow()).status).toBe("dismissed");
    expect((await occurrences(seriesId)).filter((r) => r.status === "confirmed")).toEqual([]);
  });

  it("ne passe pas une séance d'une série à « Ignoré » séance par séance (le planificateur de rappels la laisse)", async () => {
    const f = await family();
    const { seriesId } = await createSeries(db, base(f));
    await runReminders({ db, now: new Date("2054-12-01T12:00:00Z") }, { accountId: f.accountId });
    expect((await occurrences(seriesId)).filter((r) => r.status === "dismissed")).toEqual([]);
  });

  it("la notification de série passe par le planificateur quand la série reste provisoire (CA 3.1 de la US-113)", async () => {
    const f = await family({ notifyZone: true });
    const { eventIds } = await createSeries(db, base(f));
    await db.updateTable("family_events").set({ created_at: new Date(Date.now() - 11 * 60_000) }).where("account_id", "=", f.accountId).execute();
    await runEventNotices(ctx);
    const calls = payloads().filter((c) => c.tag.startsWith("notice-"));
    expect(calls).toHaveLength(1);
    expect(calls[0].tag).toBe(`notice-${eventIds[0]}`);
    expect(calls[0].body).toMatch(/^À confirmer — Camille a demandé : Foot, chaque mercredi à \d+h\d\d, à partir du 04\/11$/);
  });
});
