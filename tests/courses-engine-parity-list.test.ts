import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyTicket, buildBudget, buildListModel, buildRefProducts, dishItems, norm, type BuyRow, type Dish, type LightVersion, type ReferenceRow } from "@/server/courses/engine";

/** Parité avec courses.py, cas 1 (menu F4, F14, F17, F5, F9, F19, F10 validé : données du rapport de courses) et cas 9 (ticket fictif puis budget). */
const dir = path.join(process.cwd(), "tests", "fixtures", "courses");
const read = <T>(file: string) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T;
const catalog = read<{ dishes: (Omit<Dish, "tags"> & { tags: string[] })[]; refs: ReferenceRow[]; allege: { id: string; plat: string; remove: string[]; add: string[]; text: string }[] }>("catalog.json");
const report = read<{
  items: { name: string; rayon: string; group: string; pour: string[]; stores: Record<string, { ref: string; prix: number | null }>; opts: { prop: { ref: string; prix: number | null; store: string } | null } }[];
  dishes: { id: string; name: string; text: string; rem: number[]; add: number[]; has: boolean; retn: string[]; addn: string[] }[];
}>("rapport-cas1.json");

const dishes: Dish[] = catalog.dishes.map((d) => ({ ...d, tags: new Set(d.tags) }));
const byId = new Map(dishes.map((d) => [d.id, d]));
const MENU_IDS = ["F4", "F14", "F17", "F5", "F9", "F19", "F10"];
const menuDishes = MENU_IDS.map((id) => byId.get(id)!);
const prods = buildRefProducts(catalog.refs.map((r) => ({ ...r, priceDate: null })));
const light = new Map<string, LightVersion>(catalog.allege.map((a) => [a.id, { dishId: a.id, remove: a.remove, add: a.add, text: a.text }]));

/** La liste « Produits à acheter » après la validation du menu : produits de référence puis ingrédients libres, plat par plat (cmd_validate). */
function validatedList(): BuyRow[] {
  const have = new Set<string>();
  const rows: BuyRow[] = [];
  for (const d of menuDishes) {
    const { found, free } = dishItems(d, prods);
    for (const name of [...found, ...free]) {
      if (have.has(norm(name))) continue;
      have.add(norm(name));
      rows.push({ name, qty: null, by: "menu", source: "menu", status: "à acheter" });
    }
  }
  return rows;
}

describe("Parité avec courses.py : liste de courses du cas 1", () => {
  const rows = validatedList();
  const model = buildListModel({ dishes: menuDishes, prods, buy: rows, history: [], light, stores: [], sharing: false, now: new Date(2026, 10, 6) });
  const menuItems = model.items.filter((i) => i.group === "menu");
  const expectedMenu = report.items.filter((i) => i.group === "menu");

  it("44 produits issus du menu, mêmes noms dans le même ordre, même rayon, mêmes plats", () => {
    expect(rows).toHaveLength(44);
    expect(menuItems.map((i) => i.name)).toEqual(expectedMenu.map((i) => i.name));
    expect(menuItems.map((i) => i.rayon)).toEqual(expectedMenu.map((i) => i.rayon));
    expect(menuItems.map((i) => [...i.pour].sort())).toEqual(expectedMenu.map((i) => [...i.pour].sort()));
  });

  it("mêmes prix par enseigne que le script, et la référence cochée est la moins chère", () => {
    menuItems.forEach((item, k) => {
      const exp = expectedMenu[k];
      const got = Object.fromEntries([...item.storePrices].map(([store, v]) => [store, v.price]));
      const want = Object.fromEntries(Object.entries(exp.stores).map(([store, v]) => [store, v.prix]));
      expect(got, item.name).toEqual(want);
    });
  });

  it("versions allégées : mêmes produits retirés et ajoutés que le script, plat par plat", () => {
    expect(model.items.filter((i) => i.group === "sante")).toHaveLength(report.items.filter((i) => i.group === "sante").length);
    expect(model.dishes.map((d) => d.dishId)).toEqual(report.dishes.map((d) => d.id));
    expect(model.dishes.map((d) => d.removeIds)).toEqual(report.dishes.map((d) => d.rem));
    expect(model.dishes.map((d) => d.addIds)).toEqual(report.dishes.map((d) => d.add));
    expect(model.dishes.map((d) => d.hasAdaptation)).toEqual(report.dishes.map((d) => d.has));
    expect(model.dishes.map((d) => d.text)).toEqual(report.dishes.map((d) => d.text));
  });
});

describe("Parité avec courses.py : ticket du cas 9 puis budget", () => {
  const raw = read<{ magasin: string; date: string; lignes: { produit: string; ref: string; prix: number; qte: number; rayon: string }[] }>("ticket-cas9.json");
  const ticket = { store: raw.magasin, date: raw.date, lines: raw.lignes.map((l) => ({ product: l.produit, ref: l.ref, total: l.prix, qty: l.qte, rayon: l.rayon })) };

  it("4 lignes enregistrées, les pâtes sortent de la liste, puis 4 doublons ignorés", () => {
    const first = applyTicket(ticket, [], ["Pâtes (spaghetti, penne)", "Piles"]);
    expect(first.newLines).toHaveLength(4);
    expect(first.duplicates).toBe(0);
    expect(first.removedFromList).toEqual(["Pâtes (spaghetti, penne)"]);
    expect(first.newLines[0].unit).toBe(1.06);
    const journal = first.newLines.map((l) => ({ date: ticket.date, store: ticket.store, product: l.product, total: l.total }));
    const again = applyTicket(ticket, journal, ["Piles"]);
    expect(again.newLines).toHaveLength(0);
    expect(again.duplicates).toBe(4);
    expect(again.removedFromList).toEqual([]);
  });

  it("budget d'octobre 2026 par rayon, mois de référence 2026-10", () => {
    const b = buildBudget(ticket.lines.map((l) => ({ date: ticket.date, rayon: l.rayon, total: l.total })), new Date(2026, 10, 6));
    expect(b.lastMonth).toBe("2026-10");
    expect(Object.fromEntries(b.rows.map((r) => [r.rayon, r.lastMonth]))).toEqual({ Crèmerie: 3.18, Entretien: 6.49, Féculents: 0.89, "Fruits et légumes": 1.29 });
    expect(b.total.lastMonth).toBe(11.85);
    expect(b.total.currentYearAverage).toBe(11.85);
  });
});
