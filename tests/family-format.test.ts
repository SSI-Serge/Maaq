import { describe, expect, it } from "vitest";
import { addDays, addMonths, birthLabel, clock, longDate, monthGrid, monthLabel, period, shortDate, todayLocal, weekStart, whenLabel } from "@/components/family/format";

describe("formats du calendrier familial", () => {
  it("lit les heures locales telles quelles et écrit les dates en français", () => {
    expect(clock("2026-10-27T17:00")).toBe("17h00");
    expect(clock("2026-10-27T08:05")).toBe("8h05");
    expect(longDate("2026-10-27")).toBe("mardi 27 octobre 2026");
    expect(shortDate("2026-11-01")).toBe("dim. 1 nov.");
    expect(monthLabel("2026-10-28")).toBe("octobre 2026");
    expect(birthLabel("2018-03-12")).toBe("12/03/2018");
  });

  it("décrit le moment d'un rendez-vous", () => {
    expect(whenLabel({ start: "2026-10-27T17:00", end: "2026-10-27T18:30", allDay: false })).toBe("17h00 – 18h30");
    expect(whenLabel({ start: "2026-11-20T00:00", end: "2026-11-20T23:59", allDay: true })).toBe("Toute la journée");
    expect(whenLabel({ start: "2026-11-20T00:00", end: "2026-11-22T23:59", allDay: true })).toBe("Du ven. 20 nov. au dim. 22 nov.");
  });

  it("calcule la semaine du lundi au dimanche (CA 6.1 : le mercredi 28 octobre, la semaine du 26 octobre au 1er novembre)", () => {
    expect(weekStart("2026-10-28")).toBe("2026-10-26");
    expect(weekStart("2026-11-01")).toBe("2026-10-26");
    expect(weekStart("2026-10-26")).toBe("2026-10-26");
    expect(addDays("2026-10-26", 6)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("construit la grille d'un mois en semaines entières", () => {
    const grid = monthGrid("2026-10-15");
    expect(grid[0]).toBe("2026-09-28"); // le 1er octobre 2026 est un jeudi
    expect(grid[grid.length - 1]).toBe("2026-11-01");
    expect(grid.length % 7).toBe(0);
    expect(grid).toContain("2026-10-31");
    expect(addMonths("2026-10-31", 1)).toBe("2026-11-01");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-01");
  });

  it("range les rendez-vous par période de la journée (vue Jour)", () => {
    expect(period("2026-10-27T09:30")).toBe("Matin");
    expect(period("2026-10-27T12:00")).toBe("Midi");
    expect(period("2026-10-27T15:00")).toBe("Après-midi");
    expect(period("2026-10-27T18:00")).toBe("Soir");
  });

  it("donne le jour de l'appareil", () => {
    expect(todayLocal(new Date(2026, 9, 5, 23, 30))).toBe("2026-10-05");
  });
});
