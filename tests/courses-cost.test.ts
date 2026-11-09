import { describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { nameKey } from "@/server/courses/catalog/seed";
import { computeScenarios, scenarioLines } from "@/server/courses/engine";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { fromDto } from "@/server/courses/list/dto";
import { myList, setBought } from "@/server/courses/list/mine";
import { prepareList, validateList } from "@/server/courses/list/service";
import { confirmTicket } from "@/server/courses/tickets/service";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";
import { validateTestMenu } from "./helpers/menu";

/** CR-58 (US-177 RF5) : le produit coché par un ticket garde le lien vers sa ligne ; « Ma liste » affiche le coût réel du menu. */
const db = testDb();
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const W1 = "2026-11-09";
const at = (): Ctx => ({ db, now: NOW });

async function validatedList(): Promise<{ f: CoupleFamily; priced: { name: string; price: number; qty: number }[] }> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }] });
  await validateTestMenu(db, f, { picks: ["F4"], week: W1, now: NOW });
  const list = await prepareList(at(), f.sophie, W1);
  const model = fromDto(list.model!);
  const lines = scenarioLines(model, {}, computeScenarios(model, {}, [])[1]).map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, priceUnit: l.priceUnit, source: "menu" as const }));
  await validateList(at(), f.sophie, { scenario: 2, lines, week: W1 });
  return { f, priced: lines.filter((l) => l.price !== null && (l.priceUnit ?? "unit") === "unit").map((l) => ({ name: l.name, price: l.price as number, qty: Math.round(l.qty) || 1 })) };
}

const row = (f: CoupleFamily, key: string) => db.selectFrom("grocery_list_items").select(["id", "state", "receipt_line_id"]).where("account_id", "=", f.accountId).where("name_key", "=", key).executeTakeFirstOrThrow();

describe("Coût réel du menu (CR-58)", () => {
  it("un ticket garde le lien vers sa ligne ; coché à la main, le produit reste estimé ; annuler défait le lien ; Ma liste affiche le coût réel", async () => {
    const { f, priced } = await validatedList();
    expect(priced.length).toBeGreaterThan(2);
    const [first, second] = priced;
    const estimate = (p: { price: number; qty: number }) => Math.round(p.price * p.qty * 100) / 100;

    // avant tout achat : pas de coût réel
    expect((await myList(at(), f.sophie, W1)).cost).toBeNull();

    // un ticket coche le premier produit : le prix du ticket remplace l'estimation
    const done = await confirmTicket(at(), f.sophie, { store: "Lidl", city: "Nantes", date: "2026-11-05", time: "10:00:00", lines: [{ product: first.name, reference: null, total: 7.4, qty: 1, aisle: "Autres" }, { product: "Produit hors liste", reference: null, total: 20, qty: 1, aisle: "Autres" }] } as never);
    expect(done.removed).toEqual([first.name]);
    const line = await db.selectFrom("grocery_receipt_lines").select("id").where("receipt_id", "=", done.receiptId!).where("label", "=", first.name).executeTakeFirstOrThrow();
    expect(Number((await row(f, nameKey(first.name))).receipt_line_id)).toBe(Number(line.id));

    // coché à la main : pas de ligne de ticket, le prix reste estimé
    await setBought(at(), f.sophie, { key: nameKey(second.name), bought: true, late: false, week: W1 });
    expect((await row(f, nameKey(second.name))).receipt_line_id).toBeNull();

    const cost = (await myList(at(), f.sophie, W1)).cost!;
    const all = priced.reduce((s, p) => s + estimate(p), 0);
    expect(cost.atValidation).toBeGreaterThanOrEqual(Math.round(all * 100) / 100 - 0.01);
    // le produit hors liste ne compte pas ; seule la ligne du premier produit entre en entier
    expect(cost.real).toBeCloseTo(cost.atValidation - estimate(first) + 7.4, 1);
    expect(cost.estimated).toBeCloseTo(cost.atValidation - estimate(first), 1);
    expect(cost.estimated).toBeLessThan(cost.real);

    // annuler la coche défait le lien (la base le garantit)
    await setBought(at(), f.sophie, { key: nameKey(first.name), bought: false, late: false, week: W1 });
    expect((await row(f, nameKey(first.name))).receipt_line_id).toBeNull();
    const back = (await myList(at(), f.sophie, W1)).cost!;
    expect(back.real).toBeCloseTo(back.atValidation, 1);

    // l'invité secondaire ne voit aucun prix
    expect((await myList(at(), f.elodie, W1)).cost).toBeNull();
  });
});
