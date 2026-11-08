import { describe, expect, it } from "vitest";
import { onlyPantryUnits, packagesFor, plausible, sumNeeds, toBase, weighedTotal } from "@/server/courses/engine";

describe("CR-50 : quantités des recettes (moteur)", () => {
  it("convertit en kilos, litres, pièces, cuillères et pincées ; refuse l'inconnu", () => {
    expect(toBase(900, "g")).toEqual({ amount: 0.9, unit: "kg" });
    expect(toBase(1.5, "kg")).toEqual({ amount: 1.5, unit: "kg" });
    expect(toBase(250, "ml")).toEqual({ amount: 0.25, unit: "l" });
    expect(toBase(33, "cl")).toEqual({ amount: 0.33, unit: "l" });
    expect(toBase(6, "piece")).toEqual({ amount: 6, unit: "piece" });
    expect(toBase(2, "spoon")).toEqual({ amount: 2, unit: "spoon" });
    expect(toBase(1, "pinch")).toEqual({ amount: 1, unit: "pinch" });
    expect(toBase(0, "g")).toBeNull();
    expect(toBase(-5, "g")).toBeNull();
    expect(toBase(3, "tasse")).toBeNull();
    expect(toBase(Number.NaN, "g")).toBeNull();
  });

  it("additionne par produit sur tous les plats, plats express compris ; une ligne sans quantité valable rend le produit « à vérifier »", () => {
    const sums = sumNeeds([
      { product: "pâtes", quantity: 500, unit: "g" },
      { product: "pâtes", quantity: 400, unit: "g" },
      { product: "lait", quantity: 25, unit: "cl" },
      { product: "lait", quantity: 0.5, unit: "l" },
      { product: "œufs", quantity: 4, unit: "piece" },
      { product: "sel", quantity: 1, unit: "pinch" },
      { product: "huile", quantity: 2, unit: "spoon" },
      { product: "poivre", quantity: null, unit: null },
    ]);
    expect(sums.get("pâtes")).toEqual({ need: { kg: 0.9, l: 0, piece: 0, spoon: 0, pinch: 0 }, unknown: false });
    expect(sums.get("lait")!.need.l).toBe(0.75);
    expect(sums.get("œufs")!.need.piece).toBe(4);
    expect(sums.get("poivre")!.unknown).toBe(true);
    expect(onlyPantryUnits(sums.get("sel")!.need)).toBe(true);
    expect(onlyPantryUnits(sums.get("huile")!.need)).toBe(true);
    expect(onlyPantryUnits(sums.get("pâtes")!.need)).toBe(false);
  });

  it("900 g de pâtes en paquets de 500 g : 2 paquets ; 900 g en paquets de 300 g : 3, pas 4", () => {
    const pasta = sumNeeds([{ product: "pâtes", quantity: 900, unit: "g" }]).get("pâtes")!;
    expect(packagesFor(pasta.need, pasta.unknown, { amount: 0.5, unit: "kg" })).toEqual({ qty: 2, check: false });
    expect(packagesFor(pasta.need, pasta.unknown, { amount: 0.3, unit: "kg" })).toEqual({ qty: 3, check: false });
    expect(packagesFor(pasta.need, pasta.unknown, { amount: 1, unit: "kg" })).toEqual({ qty: 1, check: false });
    // le format change d'une référence à l'autre : la quantité aussi
    expect(packagesFor(pasta.need, pasta.unknown, { amount: 0.25, unit: "kg" }).qty).toBe(4);
  });

  it("conversion impossible : 1 unité avec « Quantité à vérifier » (format inconnu, unité incompatible, pièces, besoin mélangé, quantité manquante)", () => {
    const flour = sumNeeds([{ product: "farine", quantity: 300, unit: "g" }]).get("farine")!;
    expect(packagesFor(flour.need, flour.unknown, null)).toEqual({ qty: 1, check: true });
    expect(packagesFor(flour.need, flour.unknown, { amount: 1, unit: "l" })).toEqual({ qty: 1, check: true });
    const eggs = sumNeeds([{ product: "œufs", quantity: 6, unit: "piece" }]).get("œufs")!;
    expect(packagesFor(eggs.need, eggs.unknown, { amount: 0.5, unit: "kg" })).toEqual({ qty: 1, check: true });
    const mixed = sumNeeds([{ product: "oignons", quantity: 300, unit: "g" }, { product: "oignons", quantity: 2, unit: "piece" }]).get("oignons")!;
    expect(packagesFor(mixed.need, mixed.unknown, { amount: 1, unit: "kg" })).toEqual({ qty: 1, check: true });
    const missing = sumNeeds([{ product: "riz", quantity: 200, unit: "g" }, { product: "riz", quantity: null, unit: null }]).get("riz")!;
    expect(packagesFor(missing.need, missing.unknown, { amount: 1, unit: "kg" })).toEqual({ qty: 1, check: true });
    // aucun besoin connu (produit de l'historique ou ajouté à la main) : 1 par défaut, sans alerte
    expect(packagesFor(null, false, { amount: 1, unit: "kg" })).toEqual({ qty: 1, check: false });
  });

  it("produit au poids : poids connu × prix au kilo, compté dans le total ; sinon rien", () => {
    const need = sumNeeds([{ product: "carottes", quantity: 800, unit: "g" }]).get("carottes")!;
    expect(weighedTotal(need.need, need.unknown, { value: 1.49, unit: "kg" })).toBe(1.19);
    expect(weighedTotal(need.need, need.unknown, { value: 1.49, unit: "l" })).toBeNull();
    expect(weighedTotal(need.need, need.unknown, null)).toBeNull();
    const pieces = sumNeeds([{ product: "carottes", quantity: 4, unit: "piece" }]).get("carottes")!;
    expect(weighedTotal(pieces.need, pieces.unknown, { value: 1.49, unit: "kg" })).toBeNull();
    expect(weighedTotal(null, false, { value: 1.49, unit: "kg" })).toBeNull();
  });

  it("bornes plausibles par personne : une faute d'unité est repérée, une recette normale passe", () => {
    expect(plausible(900, "g", 6)).toBe(true);
    expect(plausible(900, "kg", 6)).toBe(false);
    expect(plausible(2, "l", 4)).toBe(true);
    expect(plausible(40, "l", 4)).toBe(false);
    expect(plausible(12, "piece", 6)).toBe(true);
    expect(plausible(100, "piece", 2)).toBe(false);
    expect(plausible(3, "spoon", 4)).toBe(true);
    expect(plausible(30, "spoon", 4)).toBe(false);
    expect(plausible(2, "pinch", 4)).toBe(true);
    expect(plausible(0, "g", 4)).toBe(false);
    expect(plausible(5, "tasse", 4)).toBe(false);
  });
});
