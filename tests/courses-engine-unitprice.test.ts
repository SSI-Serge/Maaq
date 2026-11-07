import { describe, expect, it } from "vitest";
import { buildListModel, buildRefProducts, computeScenarios, defaultChoice, isTotaled, perUnitOf, pricePerMeasure, scenarioLines, toMeasure, type Choice, type Dish } from "@/server/courses/engine";

describe("Prix au kilo ou au litre (CR-39, CR-40)", () => {
  it("convertit un poids ou un volume saisi en kilos ou en litres ; rien d'inventé quand l'unité n'est pas comprise", () => {
    expect(toMeasure(1.234, "kg")).toEqual({ amount: 1.234, unit: "kg" });
    expect(toMeasure(1234, "g")).toEqual({ amount: 1.234, unit: "kg" });
    expect(toMeasure(33, "cl")).toEqual({ amount: 0.33, unit: "l" });
    expect(toMeasure(500, "ml")).toEqual({ amount: 0.5, unit: "l" });
    expect(toMeasure(2, "pièce")).toBeNull();
    expect(toMeasure(0, "kg")).toBeNull();
    expect(toMeasure(-1, "kg")).toBeNull();
  });

  it("le prix au kilo lu sur le ticket l'emporte ; sinon prix de la ligne ÷ poids, arrondi à 2 décimales ; rien sans poids", () => {
    expect(pricePerMeasure(1.49, 1.84, 1.234)).toBe(1.49);
    expect(pricePerMeasure(null, 1.84, 1.234)).toBe(1.49);
    expect(pricePerMeasure(null, 1.84, null)).toBeNull();
    expect(pricePerMeasure(null, -0.5, 1)).toBeNull();
  });

  it("un prix déjà au kilo est son propre prix au kilo ; un prix par article prend celui que la base a déduit du format", () => {
    expect(perUnitOf(3.29, "kg", null)).toEqual({ value: 3.29, unit: "kg" });
    expect(perUnitOf(2.55, "unit", { value: 2.55, unit: "kg" })).toEqual({ value: 2.55, unit: "kg" });
    expect(perUnitOf(2.55, "unit", null)).toBeNull();
    expect(perUnitOf(null, "kg", null)).toBeNull();
    expect(isTotaled("unit")).toBe(true);
    expect(isTotaled(undefined)).toBe(true);
    expect(isTotaled("kg")).toBe(false);
    expect(isTotaled("l")).toBe(false);
  });

  it("le choix coché par défaut compare les prix au kilo quand tous les choix à prix en ont un, sinon les prix à l'article", () => {
    const choice = (price: number, perMeasure: number | null, priceUnit: "unit" | "kg" = "unit"): Choice => ({ kind: "reference", ref: "r", price, store: "x", city: null, age: "lt6", priceUnit, perUnit: perMeasure === null ? null : { value: perMeasure, unit: "kg" } });
    // 1,40 € le sachet de 250 g (5,60 €/kg) contre 2,50 € le kilo : le kilo gagne alors que son prix par article est plus haut
    expect(defaultChoice([choice(1.4, 5.6), choice(2.5, 2.5)])).toBe(1);
    // un choix sans prix au kilo : on compare les prix par article
    expect(defaultChoice([choice(1.4, 5.6), choice(2.5, null)])).toBe(0);
    expect(defaultChoice([choice(3.29, 3.29, "kg"), choice(1.8, 7.2)])).toBe(0);
    expect(defaultChoice([])).toBeNull();
  });

  it("un article vendu au kilo n'entre pas dans le total estimé ; il est compté à part, avec son unité", () => {
    const dish: Dish = { id: "T1", cuisine: "Français", name: "Plat", ing: "Riz, Bananes plantains", recipe: "", health: "", batch: "", time: "", minutes: 10, tags: new Set() };
    const prods = buildRefProducts([
      { product: "Riz", rayon: "Féculents", used: "", store: "Lidl", ref: "Riz long", price: 2.55, priceDate: "2026-10-23", conform: true, format: "1 kg", priceUnit: "unit", perMeasure: { value: 2.55, unit: "kg" } },
      { product: "Bananes plantains", rayon: "Fruits et légumes", used: "", store: "Lidl", ref: "Vrac", price: 3.29, priceDate: "2026-10-23", conform: true, priceUnit: "kg" },
    ]);
    const rows = ["Riz", "Bananes plantains"].map((name) => ({ name, qty: 1, by: "", source: "menu" as const, status: "à acheter" as const }));
    const model = buildListModel({ dishes: [dish], prods, buy: rows, history: [], light: new Map(), stores: ["Lidl"], sharing: false, now: new Date(2026, 10, 6) });
    const plantain = model.items.find((i) => i.name === "Bananes plantains")!;
    expect(plantain.choices[0]).toMatchObject({ priceUnit: "kg", perUnit: { value: 3.29, unit: "kg" } });
    const [one, two] = computeScenarios(model, {}, ["Lidl"]);
    expect(one).toMatchObject({ total: 2.55, withoutPrice: 0, notTotaled: 1 });
    expect(two).toMatchObject({ total: 2.55, withoutPrice: 0, notTotaled: 1 });
    expect(scenarioLines(model, {}, one).find((l) => l.name === "Bananes plantains")).toMatchObject({ price: 3.29, priceUnit: "kg" });
    expect(scenarioLines(model, {}, one).find((l) => l.name === "Riz")).toMatchObject({ price: 2.55, priceUnit: "unit" });
  });
});
