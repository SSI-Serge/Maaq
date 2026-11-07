import { describe, expect, it } from "vitest";
import { buildListModel, buildRefProducts, defaultChoice, packageContent, perKiloFromWeight, perUnitPrice, type Choice, type Dish } from "@/server/courses/engine";

describe("Prix au kilo (CR-39)", () => {
  it("lit le contenu d'un format : kilos, grammes, litres, multipacks ; rien d'inventé quand le format n'est pas compris", () => {
    expect(packageContent("1 kg")).toEqual({ amount: 1, unit: "kg" });
    expect(packageContent("500 g")?.amount).toBeCloseTo(0.5);
    expect(packageContent("sachet de 250g")?.amount).toBeCloseTo(0.25);
    expect(packageContent("3 x 600 g")?.amount).toBeCloseTo(1.8);
    expect(packageContent("1,5 kg")).toEqual({ amount: 1.5, unit: "kg" });
    expect(packageContent("500 g, 8 personnes")?.amount).toBeCloseTo(0.5);
    expect(packageContent("1 L")).toEqual({ amount: 1, unit: "l" });
    expect(packageContent("25 cl")?.amount).toBeCloseTo(0.25);
    for (const unknown of ["la pièce", "barquette", "pack de bouteilles (contenance non indiquée)", "à la pièce (poids non indiqué)", "", null, undefined]) expect(packageContent(unknown)).toBeNull();
  });

  it("calcule le prix au kilo ou au litre, ou rien sans prix ni format", () => {
    expect(perUnitPrice(2.55, "1 kg")).toEqual({ value: 2.55, unit: "kg" });
    expect(perUnitPrice(1.79, "250 g")).toEqual({ value: 7.16, unit: "kg" });
    expect(perUnitPrice(0.95, "1 L")).toEqual({ value: 0.95, unit: "l" });
    expect(perUnitPrice(null, "1 kg")).toBeNull();
    expect(perUnitPrice(3, "la pièce")).toBeNull();
    expect(perKiloFromWeight(1.84, 1.234)).toEqual({ value: 1.49, unit: "kg" });
    expect(perKiloFromWeight(1.84, 0)).toBeNull();
  });

  it("le choix coché par défaut compare les prix au kilo quand tous les choix à prix en ont un, sinon les prix à l'unité", () => {
    const choice = (price: number, format: string | null): Choice => ({ kind: "reference", ref: "r", price, store: "x", city: null, age: "lt6", format, perUnit: perUnitPrice(price, format) });
    // 1,40 € le sachet de 250 g (5,60 €/kg) contre 2,50 € le kilo : le kilo gagne alors que son prix à l'unité est plus haut
    expect(defaultChoice([choice(1.4, "250 g"), choice(2.5, "1 kg")])).toBe(1);
    // un choix sans format : on compare les prix à l'unité
    expect(defaultChoice([choice(1.4, "250 g"), choice(2.5, null)])).toBe(0);
    expect(defaultChoice([])).toBeNull();
  });

  it("la référence du comparatif porte son prix au kilo", () => {
    const dish: Dish = { id: "T1", cuisine: "Français", name: "Riz", ing: "Riz", recipe: "", health: "", batch: "", time: "", minutes: 10, tags: new Set() };
    const prods = buildRefProducts([{ product: "Riz", rayon: "Féculents", used: "", store: "Lidl", ref: "Riz long", price: 2.55, priceDate: "2026-10-23", conform: true, format: "1 kg" }]);
    const item = buildListModel({ dishes: [dish], prods, buy: [{ name: "Riz", qty: 1, by: "", source: "menu", status: "à acheter" }], history: [], light: new Map(), stores: [], sharing: false, now: new Date(2026, 10, 6) }).items[0];
    expect(item.choices[0]).toMatchObject({ format: "1 kg", perUnit: { value: 2.55, unit: "kg" } });
  });
});
