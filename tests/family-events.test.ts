import { randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATUS_CODE, TYPE_CODE, type EventStatus, type EventType } from "@/server/assistant/calendar";
import { cancelEvent, confirmEvent, getEvent, listEvents, listPending, listUpcoming, setAsideEvent, updateEvent, type EventChanges } from "@/server/assistant/events";
import { addChild, listFamilyMembers, loadPseudoMembers } from "@/server/assistant/family";
import { seal, sealOptional } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
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

// Lundi 2 novembre 2054, 09:00 à Paris (dates décalées de 28 ans : mêmes jours de semaine, mais toujours dans le futur de l'horloge de la base).
const NOW = new Date("2054-11-02T08:00:00Z");
const TZ = "Europe/Paris";
const at = (now = NOW): Ctx => ({ db, now });

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Foyer : Sophie (principale), Marc (invité core), Élodie (invitée secondaire), Léo et Mia (enfants). */
async function family() {
  const primary = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Sophie" }).where("id", "=", primary.id).execute();
  const marc = await createGuest(db, primary.accountId!, "Marc", "core");
  const elodie = await createGuest(db, primary.accountId!, "Élodie");
  const sophieSession = await sessionFor(db, primary.id);
  const leo = await addChild(at(), sophieSession, { firstName: "Léo", birth: "2046-06" });
  const mia = await addChild(at(), sophieSession, { firstName: "Mia", birth: "2049-02" });
  const members = await listFamilyMembers(at(), sophieSession);
  const sophieMember = members.find((m) => m.firstName === "Sophie")!;
  const marcMember = members.find((m) => m.firstName === "Marc")!;
  // Élodie a sa fiche « membre » (rôle « autre »), créée avec son profil : elle voit les rendez-vous où elle est concernée.
  const elodieMember = await db.selectFrom("family_members").select("id").where("user_id", "=", elodie.id).executeTakeFirstOrThrow();
  return {
    accountId: primary.accountId!, sophie: sophieSession, marc: await sessionFor(db, marc.id), elodie: await sessionFor(db, elodie.id),
    ids: { sophie: sophieMember.id, marc: marcMember.id, elodie: elodieMember.id, leo: leo.id, mia: mia.id },
    userIds: { sophie: primary.id, marc: marc.id, elodie: elodie.id },
  };
}
type Family = Awaited<ReturnType<typeof family>>;

interface Seed {
  title?: string;
  type?: EventType;
  start: string;
  end?: string;
  status?: EventStatus;
  members?: string[];
  allFamily?: boolean;
  allDay?: boolean;
  by?: string | null;
  place?: string | null;
  notes?: string | null;
}
/** Insère un rendez-vous directement en base (heures locales de Paris). */
async function seed(f: Family, s: Seed): Promise<string> {
  const status = STATUS_CODE[s.status ?? "provisional"];
  const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE[s.type ?? "personal"]).executeTakeFirstOrThrow();
  const requestedBy = s.by === undefined ? f.userIds.sophie : s.by;
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal(s.title ?? "Rendez-vous"), starts_at: localToUtc(s.start, TZ),
      ends_at: localToUtc(s.end ?? s.start.replace(/T(\d\d):/, (_m, h: string) => `T${String(Number(h) + 1).padStart(2, "0")}:`), TZ), all_day: s.allDay ?? false,
      location: sealOptional(s.place), note: sealOptional(s.notes), status, source: "chat_text", whole_family: s.allFamily ?? false,
      requested_by_user_id: requestedBy, fingerprint: randomBytes(16),
      ...(status === "confirmed" || status === "cancelled" ? { confirmed_at: NOW, confirmed_by_user_id: f.userIds.sophie } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const members = s.allFamily ? [] : (s.members ?? [f.ids.leo]);
  if (members.length) await db.insertInto("family_event_members").values(members.map((m) => ({ event_id: row.id, member_id: m, account_id: f.accountId }))).execute();
  return row.id;
}

const statusOf = async (id: string) => (await db.selectFrom("family_events").select(["status", "version"]).where("id", "=", id).executeTakeFirstOrThrow());
const history = async (id: string) => (await db.selectFrom("family_event_history").select(["action", "from_status", "to_status", "user_id"]).where("event_id", "=", id).orderBy("occurred_at").orderBy("id").execute());

const base: Omit<EventChanges, "start" | "end"> = { title: "Dentiste", type: "medical", allFamily: false, memberIds: [], allDay: false };

// ---------------------------------------------------------------------------------------------------------------------------
describe("calendrier familial (US-78)", () => {
  it("rend les rendez-vous provisoires, confirmés et écartés, jamais les annulés ni les ignorés, avec les couleurs des membres", async () => {
    const f = await family();
    await seed(f, { start: "2054-11-03T17:00", status: "confirmed", members: [f.ids.leo] });
    await seed(f, { start: "2054-11-04T10:00", status: "provisional", members: [f.ids.mia] });
    await seed(f, { start: "2054-11-05T10:00", status: "set_aside" });
    await seed(f, { start: "2054-11-06T10:00", status: "canceled" });
    await seed(f, { start: "2054-11-07T10:00", status: "ignored" });
    const list = await listEvents(at(), f.sophie, { from: "2054-11-02", to: "2054-11-08" });
    expect(list.map((e) => e.status)).toEqual(["confirmed", "provisional", "set_aside"]);
    expect(list[0].members.map((m) => m.firstName)).toEqual(["Léo"]);
    expect(list[0].members[0].color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(new Set((await listFamilyMembers(at(), f.sophie)).map((m) => m.color)).size).toBe(4); // une couleur par membre
  });

  it("D26 : les deux parents voient tout ; l'invitée secondaire voit ses rendez-vous, ceux de toute la famille et ses propres demandes", async () => {
    const f = await family();
    await seed(f, { title: "RDV médical — Sophie", type: "medical", start: "2054-11-03T09:00", status: "confirmed", members: [f.ids.sophie] });
    await seed(f, { title: "Garde de Mia", start: "2054-11-03T10:00", status: "confirmed", members: [f.ids.elodie, f.ids.mia] });
    await seed(f, { title: "Repas chez Mamie", start: "2054-11-03T12:00", status: "confirmed", allFamily: true });
    await seed(f, { title: "Sa demande", start: "2054-11-03T14:00", status: "provisional", members: [f.ids.leo], by: f.userIds.elodie });
    const range = { from: "2054-11-03", to: "2054-11-03" };
    expect((await listEvents(at(), f.sophie, range)).map((e) => e.title)).toHaveLength(4);
    expect((await listEvents(at(), f.marc, range)).map((e) => e.title)).toHaveLength(4);
    expect((await listEvents(at(), f.elodie, range)).map((e) => e.title).sort()).toEqual(["Garde de Mia", "Repas chez Mamie", "Sa demande"]);
  });

  it("signale les rendez-vous en conflit, sans compter les rendez-vous simultanés de membres différents", async () => {
    const f = await family();
    const a = await seed(f, { start: "2054-11-03T17:00", end: "2054-11-03T18:00", status: "confirmed", members: [f.ids.leo] });
    const b = await seed(f, { start: "2054-11-03T17:30", end: "2054-11-03T18:30", status: "confirmed", members: [f.ids.leo, f.ids.sophie] });
    const c = await seed(f, { start: "2054-11-03T17:00", end: "2054-11-03T18:00", status: "confirmed", members: [f.ids.mia] });
    const list = await listEvents(at(), f.sophie, { from: "2054-11-03", to: "2054-11-03" });
    const clash = (id: string) => list.find((e) => e.id === id)!.conflictsWith;
    expect(clash(a)).toEqual([b]);
    expect(clash(b)).toEqual([a]);
    expect(clash(c)).toEqual([]);
  });

  it("refuse une période invalide et le profil sans foyer", async () => {
    const f = await family();
    expect((await failure(listEvents(at(), f.sophie, { from: "2054-11-09", to: "2054-11-02" }))).code).toBe("invalid_range");
    expect((await failure(listEvents(at(), f.sophie, { from: "demain", to: "2054-11-02" }))).code).toBe("invalid_range");
    const admin = await createProfile(db, { role: "admin" });
    expect((await failure(listEvents(at(), await sessionFor(db, admin.id), { from: "2054-11-02", to: "2054-11-03" }))).status).toBe(403);
  });

  it("isole les foyers", async () => {
    const f = await family();
    const stranger = await family();
    const id = await seed(stranger, { start: "2054-11-03T17:00", status: "confirmed" });
    expect(await listEvents(at(), f.sophie, { from: "2054-11-01", to: "2054-11-30" })).toEqual([]);
    expect((await failure(getEvent(at(), f.sophie, id))).code).toBe("not_found");
    expect((await failure(confirmEvent(at(), f.sophie, id))).code).toBe("not_found");
  });

  it("chiffre le titre, le lieu et la note en base", async () => {
    const f = await family();
    const id = await seed(f, { title: "Orthophoniste de Léo", start: "2054-11-03T17:00", place: "12 rue des Lilas", notes: "Carte vitale" });
    const raw = await db.selectFrom("family_events").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    for (const column of [raw.title!, raw.location!, raw.note!]) expect(column.toString("utf8")).not.toMatch(/Orthophoniste|Lilas|vitale/);
    const event = await getEvent(at(), f.sophie, id);
    expect([event.title, event.place, event.notes]).toEqual(["Orthophoniste de Léo", "12 rue des Lilas", "Carte vitale"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("détail, conflits et créneaux alternatifs (US-74, US-79)", () => {
  it("donne les droits d'action et l'origine du rendez-vous", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00", status: "provisional", by: f.userIds.elodie });
    const parent = await getEvent(at(), f.marc, id);
    expect(parent.can).toEqual({ confirm: true, modify: true, setAside: true, cancel: false });
    expect(parent.requestedBy).toBe("Élodie");
    const owner = await getEvent(at(), f.elodie, id);
    expect(owner.can.confirm).toBe(true); // ses propres demandes
    const other = await seed(f, { start: "2054-11-03T18:00", status: "provisional", by: f.userIds.sophie, members: [f.ids.elodie] });
    const seen = await getEvent(at(), f.elodie, other);
    expect(seen.can).toEqual({ confirm: false, modify: false, setAside: false, cancel: false }); // membre concerné d'une demande d'un parent : résumé sans boutons
  });

  it("propose jusqu'à 3 créneaux libres proches, entre 8 h et 20 h, en cas de conflit", async () => {
    const f = await family();
    await seed(f, { title: "Foot", start: "2054-11-03T17:00", end: "2054-11-03T18:00", status: "confirmed", members: [f.ids.leo] });
    const id = await seed(f, { start: "2054-11-03T17:00", end: "2054-11-03T18:00", status: "provisional", members: [f.ids.leo] });
    const event = await getEvent(at(), f.sophie, id);
    expect(event.conflicts).toEqual([{ id: expect.any(String), title: "Foot", start: "2054-11-03T17:00", end: "2054-11-03T18:00" }]);
    expect(event.alternatives).toHaveLength(3);
    for (const slot of event.alternatives) {
      expect(slot.start.slice(11) >= "08:00" && slot.end.slice(11) <= "20:00").toBe(true);
      expect(slot.start).not.toBe("2054-11-03T17:00");
      expect(slot.start < "2054-11-03T17:00" ? slot.start >= "2054-11-03T08:00" : true).toBe(true);
    }
    const distance = (s: { start: string }) => Math.abs(Date.parse(`${s.start}:00Z`) - Date.parse("2054-11-03T17:00:00Z"));
    expect(event.alternatives.map(distance)).toEqual([...event.alternatives.map(distance)].sort((a, b) => a - b)); // les plus proches d'abord
    expect((await getEvent(at(), f.sophie, id)).conflicts).toHaveLength(1);
  });

  it("ne signale aucun conflit sans membre commun, ni avec un rendez-vous annulé ou écarté, mais avec un « toute la famille »", async () => {
    const f = await family();
    await seed(f, { start: "2054-11-03T17:00", status: "confirmed", members: [f.ids.mia] });
    await seed(f, { start: "2054-11-03T17:00", status: "canceled", members: [f.ids.leo] });
    await seed(f, { start: "2054-11-03T17:00", status: "set_aside", members: [f.ids.leo] });
    const id = await seed(f, { start: "2054-11-03T17:15", status: "provisional", members: [f.ids.leo] });
    expect((await getEvent(at(), f.sophie, id)).conflicts).toEqual([]);
    await seed(f, { title: "Repas chez Mamie", start: "2054-11-03T16:30", end: "2054-11-03T17:30", status: "confirmed", allFamily: true });
    expect((await getEvent(at(), f.sophie, id)).conflicts.map((c) => c.title)).toEqual(["Repas chez Mamie"]);
  });

  it("US-74 RF10 : un conflit avec un rendez-vous que le profil ne voit pas est signalé sans titre", async () => {
    const f = await family();
    await seed(f, { title: "RDV médical — Sophie", type: "medical", start: "2054-11-03T17:00", end: "2054-11-03T18:00", status: "confirmed", members: [f.ids.sophie, f.ids.elodie].slice(0, 1) });
    const mine = await seed(f, { start: "2054-11-03T17:00", end: "2054-11-03T18:00", status: "provisional", members: [f.ids.sophie, f.ids.elodie], by: f.userIds.elodie });
    const view = await getEvent(at(), f.elodie, mine);
    expect(view.conflicts).toEqual([{ id: expect.any(String), title: null, start: "2054-11-03T17:00", end: "2054-11-03T18:00" }]);
  });

  it("rend « n'existe plus » pour un rendez-vous annulé ou ignoré, avec son statut", async () => {
    const f = await family();
    const canceled = await seed(f, { start: "2054-11-03T17:00", status: "canceled" });
    const error = await failure(getEvent(at(), f.sophie, canceled));
    expect([error.status, error.code, error.message]).toEqual([404, "gone", "Ce rendez-vous n'existe plus ou ne vous est pas accessible."]);
    expect((await failure(getEvent(at(), f.sophie, randomUUID()))).code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("confirmer (US-75)", () => {
  it("confirme, incrémente la version, garde l'auteur et historise", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00" });
    const event = await confirmEvent(at(), f.marc, id, { expectedVersion: 1 });
    expect([event.status, event.version, event.statusChange?.byFirstName]).toEqual(["confirmed", 2, "Marc"]);
    expect(event.can).toEqual({ confirm: false, modify: true, setAside: false, cancel: true });
    expect(await history(id)).toEqual([{ action: "confirmed", from_status: "provisional", to_status: "confirmed", user_id: f.userIds.marc }]);
  });

  it("D28 : l'autre parent voit « déjà traité par … » et le statut ne change pas", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00" });
    await confirmEvent(at(), f.marc, id);
    const error = await failure(confirmEvent(at(), f.sophie, id));
    expect([error.status, error.code, error.message]).toEqual([409, "already_handled", "Ce rendez-vous a déjà été traité par Marc."]);
    expect((await statusOf(id)).version).toBe(2);
    expect((await failure(setAsideEvent(at(), f.sophie, id))).code).toBe("already_handled");
  });

  it("RT2 : deux parents qui confirment au même instant, une seule confirmation est enregistrée", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00" });
    const results = await Promise.allSettled([confirmEvent(at(), f.sophie, id), confirmEvent(at(), f.marc, id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as Rejection).code).toBe("already_handled");
    expect((await history(id)).filter((h) => h.action === "confirmed")).toHaveLength(1);
    expect((await statusOf(id)).version).toBe(2);
  });

  it("US-74 RF9 : un conflit apparu entre-temps bloque la confirmation, sauf choix explicite de garder le créneau", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00", end: "2054-11-03T18:00", members: [f.ids.leo] });
    await seed(f, { title: "Foot", start: "2054-11-03T17:30", end: "2054-11-03T18:30", status: "confirmed", members: [f.ids.leo] });
    const error = await failure(confirmEvent(at(), f.sophie, id));
    expect([error.status, error.code]).toEqual([409, "conflict"]);
    expect((error.details as { conflicts: { title: string }[]; alternatives: unknown[] }).conflicts.map((c) => c.title)).toEqual(["Foot"]);
    expect((error.details as { alternatives: unknown[] }).alternatives.length).toBeGreaterThan(0);
    expect((await statusOf(id)).status).toBe("provisional");
    const forced = await confirmEvent(at(), f.sophie, id, { allowConflict: true });
    expect(forced.status).toBe("confirmed");
    expect(forced.conflicts).toHaveLength(1); // les deux rendez-vous coexistent dans le calendrier
  });

  it("refuse une version dépassée, un rendez-vous passé et un profil non autorisé", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00" });
    expect((await failure(confirmEvent(at(), f.sophie, id, { expectedVersion: 7 }))).code).toBe("stale_version");
    const past = await seed(f, { start: "2054-11-01T17:00" });
    expect((await failure(confirmEvent(at(), f.sophie, past))).code).toBe("event_past");
    const parentsRequest = await seed(f, { start: "2054-11-04T17:00", members: [f.ids.elodie] });
    expect((await failure(confirmEvent(at(), f.elodie, parentsRequest))).status).toBe(403); // résumé sans boutons (US-75 RF11)
    const hidden = await seed(f, { start: "2054-11-04T18:00", members: [f.ids.leo] });
    expect((await failure(confirmEvent(at(), f.elodie, hidden))).code).toBe("not_found");
    const own = await seed(f, { start: "2054-11-05T18:00", members: [f.ids.leo], by: f.userIds.elodie });
    expect((await confirmEvent(at(), f.elodie, own)).status).toBe("confirmed");
  });

  it("liste les confirmations en attente d'un profil : provisoires à venir et traitables, sans les écartés", async () => {
    const f = await family();
    await seed(f, { title: "À confirmer", start: "2054-11-03T17:00" });
    await seed(f, { title: "Écarté", start: "2054-11-03T18:00", status: "set_aside" });
    await seed(f, { title: "Passé", start: "2054-11-01T18:00" });
    await seed(f, { title: "Déjà confirmé", start: "2054-11-03T19:00", status: "confirmed" });
    await seed(f, { title: "Demande d'Élodie", start: "2054-11-04T19:00", by: f.userIds.elodie });
    expect((await listPending(at(), f.sophie)).map((e) => e.title).sort()).toEqual(["Demande d'Élodie", "À confirmer"]);
    expect((await listPending(at(), f.elodie)).map((e) => e.title)).toEqual(["Demande d'Élodie"]);
    expect((await listUpcoming(at(), f.sophie)).map((e) => e.title)).toEqual(["À confirmer", "Déjà confirmé", "Demande d'Élodie"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("ignorer, puis confirmer quand même (US-77)", () => {
  it("écarte un provisoire : il reste visible, quitte les confirmations en attente et peut encore être confirmé", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00" });
    const event = await setAsideEvent(at(), f.sophie, id);
    expect([event.status, event.statusChange?.byFirstName]).toEqual(["set_aside", "Sophie"]);
    expect(event.can).toEqual({ confirm: true, modify: false, setAside: false, cancel: false }); // « Confirmer quand même »
    expect(await listPending(at(), f.marc)).toEqual([]);
    expect((await listEvents(at(), f.marc, { from: "2054-11-03", to: "2054-11-03" })).map((e) => e.status)).toEqual(["set_aside"]);
    const again = await confirmEvent(at(), f.marc, id);
    expect(again.status).toBe("confirmed");
    expect((await history(id)).map((h) => h.action)).toEqual(["set_aside", "confirmed"]);
  });

  it("refuse d'écarter un rendez-vous déjà traité ou sans droit", async () => {
    const f = await family();
    const confirmed = await seed(f, { start: "2054-11-03T17:00", status: "confirmed" });
    expect((await failure(setAsideEvent(at(), f.sophie, confirmed))).code).toBe("already_handled");
    const parents = await seed(f, { start: "2054-11-04T17:00", members: [f.ids.elodie] });
    expect((await failure(setAsideEvent(at(), f.elodie, parents))).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("annuler (US-80)", () => {
  it("annule un rendez-vous confirmé : il disparaît du calendrier et ne peut pas être rétabli", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00", status: "confirmed" });
    expect(await cancelEvent(at(), f.marc, id, { expectedVersion: 1 })).toEqual({ id, status: "canceled", retiredTasks: 0 });
    expect(await listEvents(at(), f.sophie, { from: "2054-11-03", to: "2054-11-03" })).toEqual([]);
    expect((await failure(getEvent(at(), f.sophie, id))).code).toBe("gone");
    expect((await failure(confirmEvent(at(), f.sophie, id))).code).toBe("already_handled");
    expect((await failure(cancelEvent(at(), f.sophie, id))).code).toBe("stale_version");
    expect((await history(id)).map((h) => h.action)).toEqual(["cancelled"]);
  });

  it("refuse l'annulation d'un provisoire, d'un rendez-vous passé ou d'une version dépassée", async () => {
    const f = await family();
    expect((await failure(cancelEvent(at(), f.sophie, await seed(f, { start: "2054-11-03T17:00" })))).code).toBe("not_confirmed");
    expect((await failure(cancelEvent(at(), f.sophie, await seed(f, { start: "2054-11-01T17:00", status: "confirmed" })))).code).toBe("event_past");
    const id = await seed(f, { start: "2054-11-04T17:00", status: "confirmed" });
    expect((await failure(cancelEvent(at(), f.sophie, id, { expectedVersion: 3 }))).code).toBe("stale_version");
    expect((await statusOf(id)).status).toBe("confirmed");
  });

  it("D26 : l'invitée secondaire n'annule que les rendez-vous issus de ses propres demandes", async () => {
    const f = await family();
    const parents = await seed(f, { start: "2054-11-03T17:00", status: "confirmed", members: [f.ids.elodie] });
    expect((await failure(cancelEvent(at(), f.elodie, parents))).status).toBe(403);
    const own = await seed(f, { start: "2054-11-04T17:00", status: "confirmed", by: f.userIds.elodie });
    expect((await cancelEvent(at(), f.elodie, own)).status).toBe("canceled");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("modifier (US-76, US-80)", () => {
  it("modifie un provisoire sans le confirmer, avec un nouveau numéro de version et une trace", async () => {
    const f = await family();
    const id = await seed(f, { title: "RDV médical — Léo", type: "medical", start: "2054-11-03T17:00", members: [f.ids.leo] });
    const event = await updateEvent(at(), f.sophie, id, { ...base, title: "RDV médical — Léo", memberIds: [f.ids.leo, f.ids.mia], start: "2054-11-04T17:30", end: "2054-11-04T18:00", place: "Cabinet", notes: "Carte vitale" }, { expectedVersion: 1 });
    expect([event.status, event.version, event.start, event.end, event.place, event.notes]).toEqual(["provisional", 2, "2054-11-04T17:30", "2054-11-04T18:00", "Cabinet", "Carte vitale"]);
    expect(event.members.map((m) => m.firstName).sort()).toEqual(["Léo", "Mia"]);
    expect((await history(id)).map((h) => h.action)).toEqual(["modified"]);
  });

  it("applique les limites des écrans et les règles de validation", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00" });
    const change = (over: Partial<EventChanges>) => updateEvent(at(), f.sophie, id, { ...base, memberIds: [f.ids.leo], start: "2054-11-03T17:00", end: "2054-11-03T18:00", ...over }, { expectedVersion: 1 });
    expect((await failure(change({ type: "personal", title: "   " }))).code).toBe("invalid_title");
    expect((await failure(change({ title: "x".repeat(101) }))).code).toBe("invalid_title");
    expect((await failure(change({ place: "x".repeat(201) }))).code).toBe("invalid_place");
    expect((await failure(change({ notes: "x".repeat(501) }))).code).toBe("invalid_notes");
    expect((await failure(change({ memberIds: [] }))).code).toBe("invalid_members");
    expect((await failure(change({ memberIds: [randomUUID()] }))).code).toBe("invalid_members");
    const range = await failure(change({ start: "2054-11-03T17:00", end: "2054-11-03T16:00" }));
    expect([range.code, range.message]).toEqual(["invalid_range", "L'heure de fin doit être après l'heure de début."]);
    expect((await failure(change({ start: "2054-02-30T10:00" }))).code).toBe("invalid_date");
    expect((await statusOf(id)).version).toBe(1);
  });

  it("gère « toute la famille » et « toute la journée »", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00" });
    const event = await updateEvent(at(), f.sophie, id, { ...base, type: "family", title: "Journée pédagogique", allFamily: true, allDay: true, start: "2054-11-20", end: "2054-11-20" }, { expectedVersion: 1 });
    expect([event.allFamily, event.allDay, event.start, event.end, event.members]).toEqual([true, true, "2054-11-20T00:00", "2054-11-20T23:59", expect.arrayContaining([])]);
    expect(event.members).toHaveLength(5); // les cinq membres du foyer
  });

  it("refuse une version dépassée : modifié entre-temps", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00" });
    await confirmEvent(at(), f.marc, id);
    const error = await failure(updateEvent(at(), f.sophie, id, { ...base, memberIds: [f.ids.leo], start: "2054-11-03T18:00", end: "2054-11-03T19:00" }, { expectedVersion: 1 }));
    expect([error.code, error.message]).toEqual(["stale_version", "Ce rendez-vous a été modifié entre-temps."]);
  });

  it("US-80 RF3 : pour un rendez-vous confirmé, un conflit demande de confirmer l'enregistrement ; le statut ne change pas", async () => {
    const f = await family();
    const id = await seed(f, { start: "2054-11-03T17:00", status: "confirmed", members: [f.ids.leo] });
    await seed(f, { title: "Foot", start: "2054-11-04T17:00", end: "2054-11-04T18:00", status: "confirmed", members: [f.ids.leo] });
    const move: EventChanges = { ...base, title: "Dentiste", memberIds: [f.ids.leo], start: "2054-11-04T17:00", end: "2054-11-04T18:00" };
    const error = await failure(updateEvent(at(), f.sophie, id, move, { expectedVersion: 1 }));
    expect(error.code).toBe("conflict");
    expect((await statusOf(id)).version).toBe(1);
    const saved = await updateEvent(at(), f.sophie, id, move, { expectedVersion: 1, allowConflict: true });
    expect([saved.status, saved.version, saved.start]).toEqual(["confirmed", 2, "2054-11-04T17:00"]);
  });

  it("refuse de modifier un rendez-vous passé, écarté ou sans droit", async () => {
    const f = await family();
    const change = (id: string, session: SessionContext) => updateEvent(at(), session, id, { ...base, memberIds: [f.ids.leo], start: "2054-11-09T17:00", end: "2054-11-09T18:00" }, { expectedVersion: 1 });
    expect((await failure(change(await seed(f, { start: "2054-11-01T17:00", status: "confirmed" }), f.sophie))).code).toBe("event_past");
    expect((await failure(change(await seed(f, { start: "2054-11-05T17:00", status: "set_aside" }), f.sophie))).code).toBe("already_handled");
    expect((await failure(change(await seed(f, { start: "2054-11-05T18:00", members: [f.ids.elodie] }), f.elodie))).status).toBe(403);
  });

  it("D31 : le titre, le lieu et la note qu'un parent saisit pour un rendez-vous médical sont conservés, mais l'agent ne les voit jamais", async () => {
    const f = await family();
    const id = await seed(f, { title: "RDV médical — Léo", type: "medical", start: "2054-11-03T17:00", members: [f.ids.leo] });
    await updateEvent(at(), f.sophie, id, { ...base, title: "Orthodontiste Dr Martin", memberIds: [f.ids.leo], start: "2054-11-03T17:00", end: "2054-11-03T18:00", place: "12 rue des Lilas" }, { expectedVersion: 1 });
    expect((await getEvent(at(), f.sophie, id)).title).toBe("Orthodontiste Dr Martin");
    const { executeTool } = await import("@/server/assistant/tools");
    const { Pseudonymizer } = await import("@/server/assistant/pseudonymize");
    const result = await executeTool("lister_evenements", { date_debut: "2054-11-03", date_fin: "2054-11-03" }, {
      db, accountId: f.accountId, userId: f.userIds.sophie, timeZone: TZ, now: NOW, requestId: randomUUID(), source: "typed",
      pseudo: new Pseudonymizer(await loadPseudoMembers(db, f.accountId)), created: { ids: [] }, proposals: [],
    });
    expect(result.content).not.toMatch(/Orthodontiste|Martin|Lilas/);
  });
});
