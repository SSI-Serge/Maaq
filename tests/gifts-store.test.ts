import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DB } from "@/server/db/schema.generated";
import { DbGiftStore } from "@/server/gifts/db-store";
import { DbPrefsStore } from "@/server/gifts/prefs";
import { VersionConflict } from "@/server/gifts/store";
import { createProfile, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;

beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

describe("kdo_help — stockage en base", () => {
  it("crée, modifie avec verrou de version, supprime en cascade, restaure et purge", async () => {
    const user = await createProfile(db);
    let clock = new Date("2026-10-07T10:00:00Z");
    const store = new DbGiftStore(db, () => clock);

    const sam = await store.createPerson(user.id, { name: "Sam", relationship: "frère", birthDay: 14, birthMonth: 3, birthYear: 1992, budgetAmount: 200, details: { interests: ["vélo"] } });
    expect(sam).toMatchObject({ name: "Sam", birthYear: 1992, budgetAmount: 200, details: { interests: ["vélo"] }, version: 1, deletedAt: null });

    const updated = await store.updatePerson(user.id, sam.id, { budgetAmount: 150, details: { lifeEvents: ["premier enfant"] } }, 1);
    expect(updated).toMatchObject({ budgetAmount: 150, details: { interests: ["vélo"], lifeEvents: ["premier enfant"] }, version: 2 });
    await expect(store.updatePerson(user.id, sam.id, { name: "Samuel" }, 1)).rejects.toBeInstanceOf(VersionConflict);

    const event = await store.createEvent(user.id, { personId: sam.id, kind: "other", title: "Crémaillère", eventDay: 20, eventMonth: 10, eventYear: 2026 });
    const [idea] = await store.addIdeas(user.id, [{ personId: sam.id, occasionKey: `person:${sam.id}:2027`, title: "Siège vélo", why: "Rouler ensemble", priceMin: 25, priceMax: 30 }]);
    expect(await store.setIdeaStatus(user.id, idea.id, "saved")).toMatchObject({ status: "saved", priceMin: 25 });
    await store.setState(user.id, `person:${sam.id}:2027`, { sortedAt: clock.toISOString() });
    await store.setState(user.id, `person:${sam.id}:2027`, { snoozedUntil: "2027-03-01" });
    expect(await store.listStates(user.id)).toEqual([{ occasionKey: `person:${sam.id}:2027`, sortedAt: clock.toISOString(), snoozedUntil: "2027-03-01" }]);

    await store.deletePerson(user.id, sam.id);
    expect(await store.listPeople(user.id)).toEqual([]);
    expect(await store.listEvents(user.id)).toEqual([]);
    expect((await store.listPeople(user.id, { includeDeleted: true }))[0].deletedAt).toBe(clock.toISOString());

    expect(await store.restorePerson(user.id, sam.id)).toMatchObject({ name: "Sam" });
    expect((await store.listEvents(user.id)).map((e) => e.id)).toEqual([event.id]);

    await store.deleteEvent(user.id, event.id);
    clock = new Date("2026-11-20T10:00:00Z");
    // La purge est globale : d'autres tests peuvent avoir laissé des effacements doux, d'où « au moins un ».
    expect(await store.purgeDeleted(new Date("2026-11-07T00:00:00Z"))).toBeGreaterThanOrEqual(1);
    expect(await store.listEvents(user.id, { includeDeleted: true })).toEqual([]);

    // Les données d'un autre profil restent invisibles.
    const other = await createProfile(db);
    expect(await store.listPeople(other.id)).toEqual([]);
    expect(await store.listIdeas(other.id)).toEqual([]);
  });

  it("lit et écrit les préférences de rappel", async () => {
    const user = await createProfile(db);
    const prefs = new DbPrefsStore(db);
    expect(await prefs.get(user.id)).toEqual({ timezone: "Europe/Paris", quietHoursStart: "21:00", quietHoursEnd: "08:00", reminderChannel: "app" });
    expect(await prefs.set(user.id, { reminderChannel: "both", quietHoursStart: "22:30", timezone: "America/Montreal" })).toEqual({ timezone: "America/Montreal", quietHoursStart: "22:30", quietHoursEnd: "08:00", reminderChannel: "both" });
    await expect(prefs.set(user.id, { quietHoursEnd: "25:00" })).rejects.toThrow("Heure invalide");
  });
});
