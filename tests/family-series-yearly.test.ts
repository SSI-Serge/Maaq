import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { confirmEvent, getEvent, updateEvent, type EventChanges } from "@/server/assistant/events";
import { addChild, loadPseudoMembers } from "@/server/assistant/family";
import { seal } from "@/server/assistant/fields";
import { Pseudonymizer } from "@/server/assistant/pseudonymize";
import { runReminders } from "@/server/assistant/reminders";
import { completeSeries, createSeries, expandOccurrences, ruleLabel, type SeriesRule } from "@/server/assistant/series";
import { ruleFromRepetition } from "@/server/assistant/series-ops";
import { executeTool, type ToolContext } from "@/server/assistant/tools";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { saveSubscription } from "@/server/push/service";
import { createGuest, createProfile, sessionFor, testDb } from "./helpers/fixtures";

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

const NOW = new Date("2054-11-02T08:00:00Z"); // lundi 2 novembre 2054, 9 h à Paris
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

async function family(options: { notifyZone?: boolean } = {}) {
  const camille = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Camille" }).where("id", "=", camille.id).execute();
  if (options.notifyZone) await db.updateTable("accounts").set({ family_timezone: zoneWhereItIs(12) }).where("id", "=", camille.accountId!).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const camilleSession = await onDevice(camille.id);
  const julienSession = await onDevice(julien.id);
  await saveSubscription(ctx, julienSession, fcm());
  const noah = await addChild(ctx, camilleSession, { firstName: "Noah" });
  return { accountId: camille.accountId!, camille, camilleSession, julienSession, noahId: noah.id };
}
type Family = Awaited<ReturnType<typeof family>>;

const yearly = (over: Partial<SeriesRule> = {}): SeriesRule => ({ unit: "year", interval: 1, end: { kind: "never" }, skipSchoolHolidays: false, ...over });
const base = (f: Family, over: Record<string, unknown> = {}) => ({
  accountId: f.accountId, userId: f.camille.id, type: "family" as const, title: "Anniversaire de Noah", place: null, notes: null, startTime: "00:00", durationMinutes: 60, allDay: true, allFamily: true,
  memberIds: [] as string[], firstDate: "2054-11-08", rule: yearly(), timeZone: "Europe/Paris", source: "typed" as const, now: NOW, ...over,
});
const occurrences = (seriesId: string) =>
  db.selectFrom("family_events").select(["id", "status"]).select((eb) => eb.fn<string>("to_char", ["occurrence_date", eb.val("YYYY-MM-DD")]).as("day")).where("series_id", "=", seriesId).orderBy("occurrence_date").execute();

describe("répétition annuelle : calcul des dates et libellé (D70)", () => {
  it("une date par an, même jour et même mois que la première séance", () => {
    expect(expandOccurrences(yearly(), "2054-11-08", "2057-12-31")).toEqual(["2054-11-08", "2055-11-08", "2056-11-08", "2057-11-08"]);
    expect(expandOccurrences(yearly(), "2054-11-08", "2056-11-07")).toEqual(["2054-11-08", "2055-11-08"]);
  });

  it("le 29 février devient le 28 les années non bissextiles et revient le 29 les bissextiles", () => {
    expect(expandOccurrences(yearly(), "2056-02-29", "2060-03-01")).toEqual(["2056-02-29", "2057-02-28", "2058-02-28", "2059-02-28", "2060-02-29"]);
  });

  it("s'arrête à une date ou après un nombre d'occurrences", () => {
    expect(expandOccurrences(yearly({ end: { kind: "date", date: "2056-11-08" } }), "2054-11-08", "2099-12-31")).toEqual(["2054-11-08", "2055-11-08", "2056-11-08"]);
    expect(expandOccurrences(yearly({ end: { kind: "count", count: 2 } }), "2054-11-08", "9999-12-31")).toEqual(["2054-11-08", "2055-11-08"]);
  });

  it("dit la règle en français : « Chaque année le 8 novembre », « le 1er mars »", () => {
    expect(ruleLabel(yearly(), "2054-11-08")).toBe("Chaque année le 8 novembre");
    expect(ruleLabel(yearly(), "2055-03-01")).toBe("Chaque année le 1er mars");
    expect(ruleLabel(yearly({ end: { kind: "date", date: "2060-11-08" } }), "2054-11-08")).toBe("Chaque année le 8 novembre jusqu'au 08/11/2060");
    expect(ruleLabel(ruleFromRepetition({ frequency: "yearly", end: { kind: "never" } }, "2054-11-08"), "2054-11-08")).toBe("Chaque année le 8 novembre");
  });
});

describe("répétition annuelle : séances, planificateur, rappels (D70)", () => {
  it("crée les deux prochaines occurrences, même au-delà des 6 mois d'horizon", async () => {
    const f = await family();
    const soon = await createSeries(db, base(f)); // 8 novembre 2054 : dans l'horizon ; la suivante, un an après
    expect((await occurrences(soon.seriesId)).map((r) => r.day)).toEqual(["2054-11-08", "2055-11-08"]);
    const far = await createSeries(db, base(f, { title: "Anniversaire de Mia", firstDate: "2055-08-20" })); // dans 9 mois : au-delà de l'horizon
    expect((await occurrences(far.seriesId)).map((r) => r.day)).toEqual(["2055-08-20", "2056-08-20"]);
    const row = await db.selectFrom("family_event_series").select(["repeat_unit", "repeat_interval"]).where("id", "=", far.seriesId).executeTakeFirstOrThrow();
    expect(row).toEqual({ repeat_unit: "yearly", repeat_interval: 1 });
  });

  it("le planificateur crée l'occurrence suivante quand l'année passe, sans recréer celles qui existent", async () => {
    const f = await family();
    const { seriesId } = await createSeries(db, base(f));
    expect((await completeSeries(db, NOW, { accountId: f.accountId })).created).toBe(0);
    const later = await completeSeries(db, new Date("2055-11-09T08:00:00Z"), { accountId: f.accountId });
    expect(later.created).toBe(2); // les deux prochaines : 2056 et 2057
    expect((await occurrences(seriesId)).map((r) => r.day)).toEqual(["2054-11-08", "2055-11-08", "2056-11-08", "2057-11-08"]);
    expect((await completeSeries(db, new Date("2055-11-10T08:00:00Z"), { accountId: f.accountId })).created).toBe(0);
  });

  it("une série qui se termine à une date n'a pas d'occurrence au-delà ; sans occurrence, la création est refusée", async () => {
    const f = await family();
    const { seriesId } = await createSeries(db, base(f, { rule: yearly({ end: { kind: "date", date: "2055-11-08" } }) }));
    expect((await occurrences(seriesId)).map((r) => r.day)).toEqual(["2054-11-08", "2055-11-08"]);
    await expect(createSeries(db, base(f, { rule: yearly({ end: { kind: "date", date: "2054-11-01" } }) }))).rejects.toThrow(/aucune séance/);
  });

  it("« sauf vacances scolaires » est refusé pour une répétition annuelle (même sans zone réglée), et la base le refuse aussi", async () => {
    const f = await family();
    await expect(createSeries(db, base(f, { rule: yearly({ skipSchoolHolidays: true }) }))).rejects.toThrow(/annuelle/);
    const { seriesId } = await createSeries(db, base(f));
    await expect(db.updateTable("family_event_series").set({ skip_school_holidays: true }).where("id", "=", seriesId).execute()).rejects.toMatchObject({ constraint: "ck_event_series_yearly" });
  });

  it("une série annuelle suit les délais du type de RDV (pas seulement J-1), comme une série mensuelle", async () => {
    const f = await family({ notifyZone: true });
    const { eventIds } = await createSeries(db, base(f, { title: "Réunion annuelle", type: "school", firstDate: "2054-11-10", allDay: false, startTime: "17:00", allFamily: false, memberIds: [f.noahId] }));
    await confirmEvent(ctx, f.camilleSession, eventIds[0], { allowConflict: true });
    send.mockClear();
    const at = (local: string): Ctx => ({ db, now: new Date(local) });
    await runReminders(at("2054-11-03T09:00:00Z"), { accountId: f.accountId }); // J-7 du 10 novembre, type école
    expect(payloads().map((c) => c.tag)).toContain(`d7-${eventIds[0]}`);
  });

  it("un RDV provisoire devient une série annuelle ; le détail la présente ainsi", async () => {
    const f = await family();
    const type = await db.selectFrom("event_types").select("id").where("code", "=", "family").executeTakeFirstOrThrow();
    const single = await db
      .insertInto("family_events")
      .values({ account_id: f.accountId, event_type_id: type.id, title: seal("Anniversaire de Noah"), starts_at: new Date("2054-11-07T23:00:00Z"), ends_at: new Date("2054-11-08T22:59:00Z"), all_day: true, whole_family: true, status: "provisional", source: "chat_text", fingerprint: Buffer.from(randomUUID().replace(/-/g, ""), "hex") })
      .returning("id")
      .executeTakeFirstOrThrow();
    const changes: EventChanges = { title: "Anniversaire de Noah", type: "family", allFamily: true, memberIds: [], start: "2054-11-08", end: "2054-11-08", allDay: true, place: null, notes: null };
    const view = await updateEvent(ctx, f.camilleSession, single.id, { ...changes, repetition: { frequency: "yearly", end: { kind: "never" } } }, { expectedVersion: 1 });
    expect(view.series?.rule).toBe("Chaque année le 8 novembre");
    expect(view.series?.repetition.frequency).toBe("yearly");
    expect((await occurrences(view.series!.id)).map((r) => r.day)).toEqual(["2054-11-08", "2055-11-08"]);
    expect((await getEvent(ctx, f.camilleSession, view.id)).series?.rule).toBe("Chaque année le 8 novembre");
  });
});

describe("répétition annuelle : outils de l'agent (D70)", () => {
  async function toolCtx(f: Family): Promise<ToolContext> {
    const pseudo = new Pseudonymizer(await loadPseudoMembers(db, f.accountId));
    return { db, accountId: f.accountId, userId: f.camille.id, timeZone: "Europe/Paris", now: NOW, requestId: randomUUID(), source: "typed", pseudo, created: { ids: [] }, proposals: [] };
  }
  const input = { titre: "Anniversaire de Noah", type: "familial", debut: "2054-11-08T00:00", fin: "2054-11-08T23:59", journee_entiere: true, membres: ["Enfant 1"], source: "saisie" };

  it("« annuelle » crée une série annuelle ; la fin reste obligatoire ; « sauf vacances » est refusé", async () => {
    const f = await family();
    const context = await toolCtx(f);
    const result = await executeTool("creer_evenement_provisoire", { ...input, repetition: { frequence: "annuelle", fin: { type: "jamais" } } }, context);

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ statut: "provisoire", seances: 2 });
    expect((await executeTool("creer_evenement_provisoire", { ...input, repetition: { frequence: "annuelle" } }, context)).content).toContain("Jusqu'à quand");
    expect((await executeTool("creer_evenement_provisoire", { ...input, repetition: { frequence: "annuelle", fin: { type: "jamais" }, sauf_vacances_scolaires: true } }, context)).content).toContain("annuelle");
  });

  it("une tâche ne se répète pas chaque année", async () => {
    const f = await family();
    const context = await toolCtx(f);
    const result = await executeTool("proposer_tache", { titre: "Acheter un cadeau", echeance: "2054-11-07", repetition: { frequence: "annuelle", fin: { type: "jamais" } } }, context);
    expect(result.content).toContain("tâche");
  });
});
