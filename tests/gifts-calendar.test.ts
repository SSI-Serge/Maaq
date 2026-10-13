import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DB } from "@/server/db/schema.generated";
import { createEvent, createPerson, deletePerson, monthView, updateEvent, updatePerson } from "@/server/gifts/calendar";
import { occurrencesInMonth, type Person } from "@/server/gifts/model";
import { Rejection } from "@/server/http";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;

beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

function person(overrides: Partial<Person> = {}): Person {
  return { id: "p1", name: "Léa", relationship: "fille", birthDay: 15, birthMonth: 10, birthYear: 2019, budgetAmount: null, details: {}, version: 1, deletedAt: null, ...overrides };
}

describe("Calendrier — occurrences d'un mois", () => {
  it("place les anniversaires et les occasions du mois, chaque année ou une seule fois", () => {
    const items = occurrencesInMonth(
      {
        people: [person(), person({ id: "p2", name: "Noé", birthDay: 3, birthMonth: 7, birthYear: null }), person({ id: "p3", name: "Futur", birthDay: 1, birthMonth: 10, birthYear: 2030 })],
        events: [
          { id: "e1", personId: "p1", kind: "other", title: "Spectacle de Léa", eventDay: 20, eventMonth: 10, eventYear: 2026, budgetAmount: null, version: 1, deletedAt: null },
          { id: "e2", personId: null, kind: "namesday", title: "Fête des grands-pères", eventDay: 4, eventMonth: 10, eventYear: null, budgetAmount: 20, version: 1, deletedAt: null },
          { id: "e3", personId: null, kind: "other", title: "Effacée", eventDay: 5, eventMonth: 10, eventYear: null, budgetAmount: null, version: 1, deletedAt: "2026-01-01T00:00:00Z" },
        ],
        states: [{ occasionKey: "person:p1:2026", sortedAt: "2026-10-01T00:00:00Z", snoozedUntil: null }],
      },
      2026,
      10,
    );
    expect(items.map((i) => [i.date, i.title, i.age, i.recurring, i.sorted])).toEqual([
      ["2026-10-04", "Fête des grands-pères", null, true, false],
      ["2026-10-15", "Anniversaire de Léa", 7, true, true],
      ["2026-10-20", "Spectacle de Léa", null, false, false],
    ]);
    expect(occurrencesInMonth({ people: [person()], events: [], states: [] }, 2027, 10)[0].age).toBe(8);
    expect(occurrencesInMonth({ people: [], events: [{ id: "e1", personId: null, kind: "other", title: "Unique", eventDay: 20, eventMonth: 10, eventYear: 2026, budgetAmount: null, version: 1, deletedAt: null }], states: [] }, 2027, 10)).toEqual([]);
  });
});

describe("Calendrier — ajout, modification, suppression", () => {
  it("ajoute un anniversaire et une occasion, les retrouve dans le mois, les modifie et les efface", async () => {
    const user = await createProfile(db);
    const session = await sessionFor(db, user.id);
    const ctx = { db, now: new Date("2026-10-07T10:00:00Z") };

    const lea = await createPerson(ctx, session, { name: "Léa", relationship: "fille", birthDay: 15, birthMonth: 10, birthYear: 2019, budgetAmount: 30 });
    const noel = await createEvent(ctx, session, { title: "Noël", kind: "christmas", eventDay: 25, eventMonth: 12, budgetAmount: 300 });
    await createEvent(ctx, session, { title: "Spectacle", kind: "other", eventDay: 20, eventMonth: 10, eventYear: 2026, personId: lea.id });

    const october = await monthView(ctx, session, 2026, 10);
    expect(october.today).toBe("2026-10-07");
    expect(october.items.map((i) => [i.date, i.title, i.personName, i.budgetAmount])).toEqual([
      ["2026-10-15", "Anniversaire de Léa", "Léa", 30],
      ["2026-10-20", "Spectacle", "Léa", 30],
    ]);
    expect(october.people).toEqual([{ id: lea.id, name: "Léa", relationship: "fille" }]);
    expect((await monthView(ctx, session, 2026, 12)).items.map((i) => i.title)).toEqual(["Noël"]);
    expect((await monthView(ctx, session, 2027, 10)).items.map((i) => i.title)).toEqual(["Anniversaire de Léa"]);

    await updatePerson(ctx, session, lea.id, { birthDay: 16 });
    await updateEvent(ctx, session, noel.id, { eventDay: 24, budgetAmount: null });
    expect((await monthView(ctx, session, 2026, 10)).items[0].date).toBe("2026-10-16");
    expect((await monthView(ctx, session, 2026, 12)).items[0]).toMatchObject({ date: "2026-12-24", budgetAmount: null });

    await deletePerson(ctx, session, lea.id);
    expect((await monthView(ctx, session, 2026, 10)).items).toEqual([]);
    expect((await monthView(ctx, session, 2026, 12)).items.map((i) => i.title)).toEqual(["Noël"]);
  });

  it("refuse les dates impossibles, l'anniversaire sans mois, le proche inconnu et l'administrateur", async () => {
    const user = await createProfile(db);
    const session = await sessionFor(db, user.id);
    const ctx = { db, now: new Date("2026-10-07T10:00:00Z") };

    await expect(createPerson(ctx, session, { name: "X", birthDay: 31, birthMonth: 4 })).rejects.toMatchObject({ code: "invalid_date" });
    await expect(createPerson(ctx, session, { name: "X", birthDay: 12 })).rejects.toMatchObject({ code: "invalid_date" });
    await expect(createEvent(ctx, session, { title: "X", kind: "other", eventDay: 29, eventMonth: 2, eventYear: 2027 })).rejects.toMatchObject({ code: "invalid_date" });
    await expect(createEvent(ctx, session, { title: "X", kind: "other", eventDay: 29, eventMonth: 2 })).resolves.toMatchObject({ eventDay: 29 });
    await expect(createEvent(ctx, session, { title: "X", kind: "other", eventDay: 1, eventMonth: 1, personId: "00000000-0000-0000-0000-000000000000" })).rejects.toMatchObject({ code: "not_found" });
    await expect(updatePerson(ctx, session, "00000000-0000-0000-0000-000000000000", { name: "Y" })).rejects.toBeInstanceOf(Rejection);
    await expect(monthView(ctx, session, 2026, 13)).rejects.toMatchObject({ code: "invalid_month" });

    const admin = await createProfile(db, { role: "admin" });
    await expect(monthView(ctx, await sessionFor(db, admin.id), 2026, 10)).rejects.toMatchObject({ code: "forbidden" });
  });
});
