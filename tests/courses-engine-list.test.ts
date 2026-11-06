import { describe, expect, it } from "vitest";
import {
  applyTicket,
  buildBudget,
  buildListModel,
  buildRefProducts,
  comparatif,
  computeScenarios,
  currentItems,
  deriveDishTags,
  dishItems,
  gapType,
  isDuplicateTicket,
  needed,
  priceAge,
  scenarioLines,
  selectedChoice,
  unitPrice,
  type BuyRow,
  type Dish,
  type LightVersion,
  type ListInput,
  type ListSelection,
  type ReferenceRow,
} from "@/server/courses/engine";

const NOW = new Date(2026, 10, 5);

function ref(product: string, store: string, refName: string, price: number | null, priceDate: string | null, over: Partial<ReferenceRow> = {}): ReferenceRow {
  return { product, rayon: "Épicerie", used: "", store, ref: refName, price, priceDate, conform: true, ...over };
}

const REFS: ReferenceRow[] = [
  ref("Lait", "Lidl", "Lait demi-écrémé 1L", 1.05, "2026-09-01", { rayon: "Crèmerie" }),
  ref("Lait", "Carrefour", "Lait Carrefour 1L", 1.1, "2026-10-01", { rayon: "Crèmerie" }),
  ref("Sel", "Lidl", "Sel fin 1kg", 0.5, "2026-10-01"),
  ref("Creme", "Lidl", "Crème 20 cl", 1.2, "2026-10-01", { rayon: "Crèmerie" }),
  ref("Beurre", "Lidl", "Beurre doux 250g", 2.5, "2025-01-01", { rayon: "Crèmerie" }),
  ref("Farine", "Lidl", "Farine T55", 1.0, "2026-10-01", { conform: false }),
];

function dish(id: string, name: string, ing: string, extra: Partial<Dish> = {}): Dish {
  return { id, cuisine: "Français", name, ing, recipe: "", health: "", batch: "", time: "30 min", minutes: 30, tags: deriveDishTags(name, ing), ...extra };
}

const LASAGNES = dish("F1", "Lasagnes", "pates, creme, sel");
const GRATIN = dish("F2", "Gratin", "creme, lait");

function buy(name: string, over: Partial<BuyRow> = {}): BuyRow {
  return { name, qty: null, by: "menu", source: "menu", status: "à acheter", ...over };
}

function input(over: Partial<ListInput> = {}): ListInput {
  return {
    dishes: [LASAGNES, GRATIN],
    prods: buildRefProducts(REFS),
    buy: [buy("Lait", { qty: 2 }), buy("Sel"), buy("Creme"), buy("Pates")],
    history: [],
    light: new Map<string, LightVersion>(),
    stores: ["Lidl", "Carrefour"],
    sharing: false,
    now: NOW,
    ...over,
  };
}

const LIGHT = new Map<string, LightVersion>([
  ["F1", { dishId: "F1", remove: ["Pates", "Creme"], add: ["Pates semi-completes"], text: "Version allégée" }],
]);

function byName(model: ReturnType<typeof buildListModel>, name: string) {
  const item = model.items.find((i) => i.name === name);
  if (!item) throw new Error(`produit ${name} absent`);
  return item;
}

describe("Moteur Courses et repas : ancienneté des prix (CR-20)", () => {
  it("moins de 6 mois, moins de 12 mois, au-delà : masqué", () => {
    expect(priceAge("2026-06-01", NOW)).toBe("lt6");
    expect(priceAge("2026-03-01", NOW)).toBe("lt12");
    expect(priceAge("2025-10-01", NOW)).toBeNull();
    expect(priceAge(null, NOW)).toBe("unknown");
  });
});

describe("Moteur Courses et repas : produits et ingrédients du menu", () => {
  it("les ingrédients d'un plat sont rapprochés des produits du catalogue, les autres restent libres", () => {
    const prods = buildRefProducts(REFS);
    const items = dishItems({ name: "Gratin", ing: "creme, lait, noix de muscade, sel" }, prods);
    expect(items.found).toEqual(["Creme", "Lait", "Sel"]);
    expect(items.free).toEqual(["noix de muscade"]);
  });

  it("un produit sans référence conforme est noté : inconnu ou sans référence", () => {
    const prods = buildRefProducts(REFS);
    expect(gapType(prods, "Lait")).toBeNull();
    expect(gapType(prods, "Farine")).toBe("sans_reference");
    expect(gapType(prods, "Riz basmati complet")).toBe("inconnu");
  });
});

describe("Moteur Courses et repas : comparatif des prix", () => {
  const model = buildListModel(input());

  it("une ligne par produit qui a au moins 2 choix ; un seul choix = retenu d'office", () => {
    const lines = comparatif(model, {}).map((i) => i.name);
    expect(lines).toEqual(["Lait"]);
    expect(selectedChoice(byName(model, "Sel"), {})).toMatchObject({ ref: "Sel fin 1kg", price: 0.5, store: "Lidl" });
  });

  it("le moins cher est coché par défaut ; chaque prix a son enseigne et son ancienneté", () => {
    const lait = byName(model, "Lait");
    expect(selectedChoice(lait, {})).toMatchObject({ store: "Lidl", price: 1.05, age: "lt6" });
    expect(lait.choices.map((c) => c.store)).toEqual(["Lidl", "Carrefour"]);
  });

  it("décocher tous les choix : le produit reste, sans prix", () => {
    const sel: ListSelection = { selected: new Map([[byName(model, "Lait").id, null]]) };
    expect(selectedChoice(byName(model, "Lait"), sel)).toBeNull();
    const s2 = computeScenarios(model, sel, ["Lidl", "Carrefour"]).find((s) => s.id === 2)!;
    expect(s2.withoutPrice).toBe(2); // lait (décoché) et pâtes (aucun prix)
    expect(currentItems(model, sel).map((i) => i.name)).toContain("Lait");
  });

  it("un prix de plus de 12 mois n'est plus proposé : le produit montre « N/A »", () => {
    const beurre = buildListModel(input({ buy: [buy("Beurre")] }));
    const item = byName(beurre, "Beurre");
    expect(item.choices.every((c) => c.price === null)).toBe(true);
    expect(selectedChoice(item, {})!.price).toBeNull();
  });

  it("la base commune n'est visible que si le foyer partage, avec enseigne et ville", () => {
    const common = [{ product: "Lait", ref: "Lait bio 1L", price: 0.95, store: "Lidl", city: "Rezé", week: "2026-10-26" }];
    const closed = buildListModel(input({ common, sharing: false }));
    expect(byName(closed, "Lait").choices.some((c) => c.kind === "common")).toBe(false);
    const open = buildListModel(input({ common, sharing: true }));
    const c = byName(open, "Lait").choices.find((x) => x.kind === "common")!;
    expect(c).toMatchObject({ price: 0.95, store: "Lidl", city: "Rezé", age: "lt6" });
    expect(selectedChoice(byName(open, "Lait"), {})).toMatchObject({ kind: "common", price: 0.95 });
  });

  it("une enseigne hors des enseignes de proximité du foyer n'est pas proposée", () => {
    const m = buildListModel(input({ stores: ["Carrefour"] }));
    expect(byName(m, "Lait").choices.map((c) => c.store)).toEqual(["Carrefour"]);
  });
});

describe("Moteur Courses et repas : scénarios d'achat", () => {
  const model = buildListModel(input());
  const stores = ["Lidl", "Carrefour"];

  it("trois scénarios avec leur total et leurs produits sans prix", () => {
    const [s1, s2, s3] = computeScenarios(model, {}, stores);
    expect(s1).toMatchObject({ id: 1, store: "Lidl", total: 3.8, withoutPrice: 1 });
    expect(s2).toMatchObject({ id: 2, total: 3.8, withoutPrice: 1 });
    expect(s3).toMatchObject({ id: 3, total: 0, withoutPrice: 4 });
  });

  it("recalculés aussitôt : un autre choix, une autre quantité", () => {
    const lait = byName(model, "Lait");
    const sel: ListSelection = { selected: new Map([[lait.id, 1]]), qty: new Map([[byName(model, "Sel").id, 3]]) };
    const s2 = computeScenarios(model, sel, stores).find((s) => s.id === 2)!;
    expect(s2.total).toBe(Number((1.1 * 2 + 0.5 * 3 + 1.2).toFixed(2)));
  });

  it("l'historique du foyer alimente « mes produits habituels »", () => {
    const m = buildListModel(input({ history: [{ product: "Lait", ref: "Lait demi-écrémé 1L", unitPrice: 1.2, store: "Carrefour", date: "2026-10-20" }] }));
    const s3 = computeScenarios(m, {}, stores).find((s) => s.id === 3)!;
    expect(s3.total).toBe(2.4);
    expect(s3.withoutPrice).toBe(3);
  });

  it("le scénario choisi : tous les produits, chacun avec référence, enseigne et prix", () => {
    const [s1] = computeScenarios(model, {}, stores);
    const lines = scenarioLines(model, {}, s1);
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.name === "Lait")).toMatchObject({ store: "Lidl", ref: "Lait demi-écrémé 1L", price: 1.05, qty: 2 });
    expect(lines.find((l) => l.name === "Pates")).toMatchObject({ store: null, price: null });
  });

  it("décocher un produit dans le scénario le sort de la liste et du total", () => {
    const sel: ListSelection = { checked: new Map([[byName(model, "Sel").id, false]]) };
    expect(computeScenarios(model, sel, stores)[0].total).toBe(3.3);
  });
});

describe("Moteur Courses et repas : produits de mon historique (3 mois)", () => {
  it("seuls les achats des 3 derniers mois sont proposés, décochés, hors produits déjà dans la liste", () => {
    const m = buildListModel(
      input({
        history: [
          { product: "Café", ref: "Café moulu", unitPrice: 3.5, store: "Lidl", date: "2026-10-10" },
          { product: "Thé", ref: "Thé vert", unitPrice: 2, store: "Lidl", date: "2026-06-01" },
          { product: "Lait", ref: "Lait", unitPrice: 1, store: "Lidl", date: "2026-10-10" },
        ],
      }),
    );
    const habitual = m.items.filter((i) => i.group === "habituel").map((i) => i.name);
    expect(habitual).toEqual(["Café"]);
    expect(byName(m, "Café").checked).toBe(false);
    expect(currentItems(m, {}).map((i) => i.name)).not.toContain("Café");
    const cafe = byName(m, "Café");
    expect(currentItems(m, { checked: new Map([[cafe.id, true]]) }).map((i) => i.name)).toContain("Café");
  });
});

describe("Moteur Courses et repas : version standard ou allégée", () => {
  const model = buildListModel(input({ light: LIGHT }));
  const light: ListSelection = { applied: true, modes: new Map([["Lasagnes", "light" as const]]) };

  it("avant « Actualiser », rien ne change", () => {
    const sel: ListSelection = { applied: false, modes: new Map([["Lasagnes", "light" as const]]) };
    expect(currentItems(model, sel).map((i) => i.name)).not.toContain("Pates semi-completes");
    expect(needed(byName(model, "Pates"), model, sel)).toBe(true);
  });

  it("après « Actualiser » : les pâtes sont remplacées, les pâtes semi-complètes apparaissent", () => {
    expect(needed(byName(model, "Pates"), model, light)).toBe(false);
    expect(needed(byName(model, "Pates semi-completes"), model, light)).toBe(true);
    expect(currentItems(model, light).map((i) => i.name)).toContain("Pates semi-completes");
    expect(currentItems(model, light).map((i) => i.name)).not.toContain("Pates");
  });

  it("un produit commun à deux plats n'est retiré que si tous les plats qui l'utilisent sont en version allégée", () => {
    const creme = byName(model, "Creme");
    expect(creme.pour.sort()).toEqual(["Gratin", "Lasagnes"]);
    expect(needed(creme, model, light)).toBe(true);
    const both: ListSelection = { applied: true, modes: new Map([["Lasagnes", "light" as const], ["Gratin", "light" as const]]) };
    // le gratin n'a pas de version allégée qui retire la crème : elle reste
    expect(needed(creme, model, both)).toBe(true);
  });

  it("un plat sans adaptation affiche qu'il n'y en a pas", () => {
    const gratin = model.dishes.find((d) => d.dishId === "F2")!;
    expect(gratin.hasAdaptation).toBe(false);
    expect(model.dishes.find((d) => d.dishId === "F1")!.hasAdaptation).toBe(true);
  });

  it("revenir à la version standard rétablit la liste", () => {
    const back: ListSelection = { applied: true, modes: new Map([["Lasagnes", "standard" as const]]) };
    expect(needed(byName(model, "Pates"), model, back)).toBe(true);
    expect(needed(byName(model, "Pates semi-completes"), model, back)).toBe(false);
  });
});

describe("Moteur Courses et repas : tickets de caisse", () => {
  const ticket = {
    store: "Lidl",
    date: "2026-11-02",
    lines: [
      { product: "Lait", total: 2.1, qty: 2, rayon: "Crèmerie" },
      { product: "Oeufs x6", total: 2.5 },
    ],
  };

  it("prix d'une unité : total de la ligne divisé par la quantité, au centime", () => {
    expect(unitPrice({ total: 2.1, qty: 2 })).toBe(1.05);
    expect(unitPrice({ total: 3.0, qty: 0 })).toBe(3);
    expect(unitPrice({ total: 1, qty: 3 })).toBe(0.33);
  });

  it("les produits trouvés sortent de la liste ; les doublons sont ignorés", () => {
    const first = applyTicket(ticket, [], ["Lait", "Oeufs", "Piles"]);
    expect(first.newLines).toHaveLength(2);
    expect(first.removedFromList).toEqual(["Lait", "Oeufs"]);
    const journal = first.newLines.map((l) => ({ date: ticket.date, store: ticket.store, product: l.product, total: l.total }));
    const second = applyTicket(ticket, journal, ["Piles"]);
    expect(second.newLines).toHaveLength(0);
    expect(second.duplicates).toBe(2);
  });

  it("un ticket déjà enregistré se reconnaît au même magasin, à la même date et au même total", () => {
    expect(isDuplicateTicket(ticket, [{ store: "lidl", date: "2026-11-02", total: 4.6 }])).toBe(true);
    expect(isDuplicateTicket(ticket, [{ store: "Lidl", date: "2026-11-03", total: 4.6 }])).toBe(false);
    expect(isDuplicateTicket(ticket, [{ store: "Lidl", date: "2026-11-02", total: 4.7 }])).toBe(false);
  });
});

describe("Moteur Courses et repas : budget par rayon", () => {
  const lines = [
    { date: "2026-10-03", rayon: "Crèmerie", total: 20 },
    { date: "2026-10-20", rayon: "Crèmerie", total: 10 },
    { date: "2026-10-05", rayon: "Boucherie", total: 40 },
    { date: "2026-09-12", rayon: "Crèmerie", total: 30 },
    { date: "2025-03-01", rayon: "Crèmerie", total: 60 },
    { date: "2025-04-01", rayon: "Crèmerie", total: 40 },
  ];

  it("mois passé, moyenne mensuelle de l'année et d'une année précédente, par rayon et au total", () => {
    const b = buildBudget(lines, NOW);
    expect(b.lastMonth).toBe("2026-10");
    expect(b.previousYears).toEqual([2025]);
    expect(b.rows.map((r) => r.rayon)).toEqual(["Boucherie", "Crèmerie"]);
    expect(b.rows[0]).toMatchObject({ lastMonth: 40, currentYearAverage: 20, previousYearAverage: 0 });
    expect(b.rows[1]).toMatchObject({ lastMonth: 30, currentYearAverage: 30, previousYearAverage: 50 });
    expect(b.total).toMatchObject({ lastMonth: 70, currentYearAverage: 50, previousYearAverage: 50 });
  });

  it("sans ticket : aucune ligne", () => {
    const b = buildBudget([], NOW);
    expect(b.rows).toEqual([]);
    expect(b.total.currentYearAverage).toBeNull();
  });
});
