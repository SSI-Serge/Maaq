import { describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { budgetView } from "@/server/courses/budget";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

const db = testDb();
const NOW = new Date(2026, 10, 6, 10, 0, 0);
const at = (): Ctx => ({ db, now: NOW });
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { status: number };
  }
  throw new Error("aucun refus");
};

async function receipt(f: CoupleFamily, date: string, store: string, lines: [string, string, number][]) {
  const aisles = new Map((await db.selectFrom("grocery_aisles").select(["id", "name"]).execute()).map((a) => [a.name, a.id]));
  const total = lines.reduce((s, l) => s + l[2], 0);
  const r = await db.insertInto("grocery_receipts").values({ account_id: f.accountId, store_chain: store, purchased_on: date as never, total_amount: String(total), recorded_by_user_id: f.userIds.sophie }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("grocery_receipt_lines").values(lines.map(([label, aisle, price], i) => ({ receipt_id: r.id, account_id: f.accountId, position: i + 1, label, name_key: label.toLowerCase(), line_total: String(price), aisle_id: aisles.get(aisle)! }))).execute();
}

describe("US-163 : budget par rayon", () => {
  it("sans ticket le budget est vide ; avec des tickets : mois passé, moyenne de l'année et d'une année précédente", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const none = await budgetView(at(), f.sophie);
    expect(none.empty).toBe(true);
    expect(none.budget.rows).toEqual([]);
    expect(none.budgetDay).toBe(1);

    await receipt(f, "2026-10-12", "lidl", [["Lait", "Crémerie", 3.18], ["Pommes", "Fruits et légumes", 1.29]]);
    await receipt(f, "2026-10-20", "lidl", [["Fromage", "Crémerie", 2.0]]);
    await receipt(f, "2026-09-05", "lidl", [["Lait", "Crémerie", 4.0]]);
    await receipt(f, "2025-06-05", "lidl", [["Lait", "Crémerie", 10.0]]);
    await receipt(f, "2024-06-05", "lidl", [["Lait", "Crémerie", 20.0]]);
    const view = await budgetView(at(), f.sophie);
    expect(view.empty).toBe(false);
    expect(view.monthLabel).toBe("Oct. 2026");
    expect(view.budget.previousYears).toEqual([2025, 2024]);
    const cremerie = view.budget.rows.find((r) => r.rayon === "Crémerie")!;
    expect(cremerie).toMatchObject({ lastMonth: 5.18, currentYearAverage: 4.59, previousYearAverage: 10 });
    expect(view.budget.total.lastMonth).toBe(6.47);
    const older = await budgetView(at(), f.sophie, 2024);
    expect(older.budget.previousYear).toBe(2024);
    expect(older.budget.rows.find((r) => r.rayon === "Crémerie")!.previousYearAverage).toBe(20);
  });

  it("réservé au couple, et chaque foyer ne voit que ses tickets", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const g = await coupleFamily(db);
    await receipt(f, "2026-10-12", "lidl", [["Lait", "Crémerie", 3.18]]);
    expect((await rejection(budgetView(at(), f.elodie))).status).toBe(403);
    expect((await budgetView(at(), f.marc)).empty).toBe(false);
    expect((await budgetView(at(), g.sophie)).empty).toBe(true);
  });
});
