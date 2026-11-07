import { describe, expect, it } from "vitest";
import { buildListModel, buildRefProducts, computeScenarios, scenarioLines, type Dish, type HistoryPrice } from "@/server/courses/engine";

/** CR-39 : le comparatif propose un « dernier acheté » PAR ENSEIGNE, au prix le plus récent de chacune (le port de courses.py gardait le plus ancien). */
const dish: Dish = { id: "T1", cuisine: "Français", name: "Compote", ing: "Pommes", recipe: "", health: "", batch: "", time: "10 min", minutes: 10, tags: new Set() };
const now = new Date(2026, 10, 6);
const history: HistoryPrice[] = [
  { product: "Pommes", ref: "Pommes Gala", unitPrice: 1.5, store: "Lidl", date: "2026-08-01", city: "Nantes" },
  { product: "Pommes", ref: "Pommes Gala", unitPrice: 1.9, store: "Lidl", date: "2026-10-20", city: "Nantes" },
  { product: "Pommes", ref: "Pommes bio", unitPrice: 2.4, store: "Intermarché", date: "2026-09-10", city: "Nantes" },
  { product: "Pommes", ref: "Pommes bio", unitPrice: 2.2, store: "Intermarché", date: "2026-10-05", city: "Nantes" },
];

function model(extra: HistoryPrice[] = history) {
  return buildListModel({ dishes: [dish], prods: buildRefProducts([]), buy: [{ name: "Pommes", qty: 1, by: "", source: "menu", status: "à acheter" }], history: extra, light: new Map(), stores: [], sharing: false, now });
}

describe("Comparatif : dernier achat par enseigne (CR-39)", () => {
  it("un choix « dernier acheté » par enseigne, au prix le plus récent, le plus récent d'abord", () => {
    const item = model().items[0];
    const last = item.choices.filter((c) => c.kind === "history");
    expect(last.map((c) => [c.store, c.price])).toEqual([["Lidl", 1.9], ["Intermarché", 2.2]]);
    expect(item.storePrices.get("Lidl")?.price).toBe(1.9);
    expect(item.storePrices.get("Intermarché")?.price).toBe(2.2);
  });

  it("le moins cher est coché par défaut ; « tout dans un magasin » et « produits habituels » prennent les prix les plus récents", () => {
    const m = model();
    const [one, two, three] = computeScenarios(m, {}, []);
    expect(one.total).toBe(1.9);
    expect(one.store).toBe("Lidl");
    expect(two.total).toBe(1.9);
    // habituels : l'achat le plus récent toutes enseignes confondues (Lidl, 20/10)
    expect(three.total).toBe(1.9);
    expect(scenarioLines(m, {}, three)[0]).toMatchObject({ store: "Lidl", price: 1.9 });
  });

  it("un seul magasin : un seul choix ; sans historique daté : aucun", () => {
    expect(model(history.slice(0, 2)).items[0].choices.filter((c) => c.kind === "history")).toHaveLength(1);
    expect(model([]).items[0].choices).toEqual([]);
  });
});
