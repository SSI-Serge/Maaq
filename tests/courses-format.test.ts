import { describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { comparatif, computeScenarios, scenarioLines } from "@/server/courses/engine";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { fromDto } from "@/server/courses/list/dto";
import { myList } from "@/server/courses/list/mine";
import { prepareList, validateList } from "@/server/courses/list/service";
import { menuPropose, menuStart, menuValidate } from "@/server/courses/menu/service";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

const db = testDb();
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const at = (): Ctx => ({ db, now: NOW });

describe("Format du conditionnement d'une référence (US-166 RF2)", () => {
  it("le format suit la référence retenue jusque dans Ma liste, pour le couple et pour l'invité secondaire (sans prix)", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const options = (await getSettings(at(), f.sophie)).options;
    await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "Carrefour", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }] });
    const pick = (await menuStart(at(), f.sophie)).groups.flatMap((g) => g.dishes).find((d) => d.id === "F4")!;
    const menu = await menuPropose(at(), f.sophie, { picks: [pick.id] });
    await menuValidate(at(), f.sophie, { picks: [pick.id], dinners: menu.days.map((d) => d.dish.id), express: [] });

    const list = await prepareList(at(), f.sophie);
    const model = fromDto(list.model!);
    const priced = model.items.flatMap((i) => i.choices.filter((c) => c.kind === "reference" && c.price !== null).map((c) => ({ item: i, choice: c })));
    expect(priced.length).toBeGreaterThan(0);
    const target = priced[0];
    // on donne un format à la référence que le scénario retiendra
    const ref = await db
      .selectFrom("grocery_product_references as r")
      .innerJoin("grocery_products as p", "p.id", "r.product_id")
      .select(["r.id"])
      .where("r.reference_name", "=", target.choice.ref)
      .where("r.store_chain", "=", String(target.choice.store).toLowerCase())
      .executeTakeFirstOrThrow();
    await db.updateTable("grocery_product_references").set({ package_format: "sachet de 250 g" }).where("id", "=", ref.id).execute();
    try {
      const again = fromDto((await prepareList(at(), f.sophie)).model!);
      const withFormat = again.items.find((i) => i.name === target.item.name)!.choices.find((c) => c.kind === "reference" && c.ref === target.choice.ref)!;
      expect(withFormat.format).toBe("sachet de 250 g");
      expect(comparatif(again, {}).length).toBeGreaterThanOrEqual(0);
      const scenario = computeScenarios(again, {}, list.stores.map((s) => s.chain))[1];
      const lines = scenarioLines(again, {}, scenario);
      expect(lines.find((l) => l.name === target.item.name)?.format).toBe("sachet de 250 g");
      await validateList(at(), f.sophie, { scenario: 2, lines: lines.map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, source: "menu" as const })) });

      const couple = (await myList(at(), f.sophie)).stores.flatMap((s) => s.aisles.flatMap((a) => a.lines));
      expect(couple.find((l) => l.name === target.item.name)).toMatchObject({ reference: target.choice.ref, format: "sachet de 250 g" });
      const guest = (await myList(at(), f.elodie)).stores.flatMap((s) => s.aisles.flatMap((a) => a.lines));
      const seen = guest.find((l) => l.name === target.item.name)!;
      expect(seen.format).toBe("sachet de 250 g");
      expect(seen.price).toBeNull();
    } finally {
      await db.updateTable("grocery_product_references").set({ package_format: null }).where("id", "=", ref.id).execute();
    }
  });
});
