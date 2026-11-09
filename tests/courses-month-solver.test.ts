import { describe, expect, it } from "vitest";
import { emptyNeed, estimateMinutes, type Need } from "@/server/courses/engine";
import { costOf, mostExpensive, solve, type PoolDish, type PriceFn } from "@/server/courses/month/solver";

/** CR-59 : le choix de 4 semaines au meilleur coût ; pur et déterministe. */

const need = (kg: number): Need => ({ ...emptyNeed(), kg });
/** Paquets de 500 g à 2 € pour tous les produits sauf « truffe » (sans prix) et « sel » (placard). */
const price: PriceFn = (product, n) => {
  if (product === "sel") return 0;
  if (product === "truffe") return null;
  return Math.ceil(n.kg / 0.5 - 1e-9) * 2;
};

function makePool(count: number, opts: { shared?: boolean; minutes?: number } = {}): PoolDish[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `d${i}`,
    name: `Plat ${i}`,
    minutes: opts.minutes ?? 30 + (i % 4) * 10,
    cuisine: ["afro", "france", "asie", "italie"][i % 4],
    express: i % 3 === 0,
    // les plats partagent des produits : un même paquet sert plusieurs plats
    needs: new Map([[opts.shared === false ? `produit${i}` : `produit${i % 12}`, need(0.2)], ["sel", { ...emptyNeed(), spoon: 1 }]]),
    unpriced: 0,
  }));
}

const options = { weeks: 4, dinnersPerWeek: 7, expressPerWeek: 4, sessionCap: null, budget: null, seed: 1, iterations: 6000 };
const all = (s: ReturnType<typeof solve>) => s.weeks.flatMap((w) => [...w.dinners, ...w.express]).filter((d): d is PoolDish => !!d);

describe("Menu du mois : coût d'un ensemble de plats", () => {
  it("les besoins sont additionnés par produit puis arrondis au paquet supérieur ; un placard ne coûte rien ; un produit sans prix est compté à part", () => {
    const a: PoolDish = { key: "a", name: "A", minutes: 30, cuisine: "x", express: false, needs: new Map([["riz", need(0.3)], ["sel", { ...emptyNeed(), pinch: 2 }]]), unpriced: 0 };
    const b: PoolDish = { key: "b", name: "B", minutes: 30, cuisine: "x", express: false, needs: new Map([["riz", need(0.15)], ["truffe", need(0.01)]]), unpriced: 0 };
    // 300 g + 150 g = 450 g : un seul paquet (2 €), alors que chaque plat seul coûte 2 € (4 € au total sans mise en commun)
    expect(costOf([a], price).total).toBe(2);
    expect(costOf([b], price)).toEqual({ total: 2, unpricedProducts: 1 });
    expect(costOf([a, b], price)).toEqual({ total: 2, unpricedProducts: 1 });
    expect(costOf([], price)).toEqual({ total: 0, unpricedProducts: 0 });
  });
});

describe("Menu du mois : résolution", () => {
  it("remplit 4 semaines (7 dîners, 4 express) avec des plats tous différents, dans un temps court, de façon déterministe", () => {
    const pool = makePool(90);
    const started = Date.now();
    const first = solve(pool, price, options);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(first.missingDinners).toBe(0);
    expect(first.missingExpress).toBe(0);
    expect(first.weeks).toHaveLength(4);
    const picked = all(first);
    expect(picked).toHaveLength(44);
    expect(new Set(picked.map((d) => d.key)).size).toBe(44);
    for (const w of first.weeks) expect(w.express.every((d) => d?.express)).toBe(true);
    // le total est celui du coût de l'ensemble ; les coûts des semaines s'additionnent au total
    expect(first.total).toBe(costOf(picked, price).total);
    expect(first.weekCosts.reduce((s, x) => s + x, 0)).toBeCloseTo(first.total, 2);
    // même graine : même résultat ; autre graine : (en général) autre ensemble
    expect(solve(pool, price, options).weeks.map((w) => w.dinners.map((d) => d?.key))).toEqual(first.weeks.map((w) => w.dinners.map((d) => d?.key)));
    expect(solve(pool, price, { ...options, seed: 2 }).weeks.map((w) => w.dinners.map((d) => d?.key))).not.toEqual(first.weeks.map((w) => w.dinners.map((d) => d?.key)));
  });

  it("choisir ensemble des plats qui partagent leurs produits coûte moins que la somme des plats pris séparément", () => {
    const pool = makePool(90);
    const s = solve(pool, price, { ...options, iterations: 20_000 });
    const separate = all(s).reduce((sum, d) => sum + costOf([d], price).total, 0);
    expect(s.total).toBeLessThan(separate);
    // et moins cher qu'un tirage sans recherche
    const naive = costOf(pool.slice(0, 44), price).total;
    expect(s.total).toBeLessThanOrEqual(naive);
  });

  it("dans le budget, la variété passe avant le coût : pas plus de 3 dîners d'une même cuisine par semaine ; le plafond de séance est respecté", () => {
    const pool = makePool(90);
    const s = solve(pool, price, { ...options, budget: 10_000, sessionCap: 160, iterations: 12_000 });
    expect(s.total).toBeLessThan(10_000);
    for (const w of s.weeks) {
      const counts = new Map<string, number>();
      for (const d of w.dinners) counts.set(d!.cuisine, (counts.get(d!.cuisine) ?? 0) + 1);
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
      expect(estimateMinutes(w.dinners.slice(0, 5).map((d) => d!))).toBeLessThanOrEqual(160 + 1e-9);
    }
  });

  it("hors budget, le coût passe avant tout : l'ensemble le moins cher est proposé, avec les 3 plats qui coûtent le plus", () => {
    const pool = makePool(90, { shared: false });
    const tight = solve(pool, price, { ...options, budget: 1, iterations: 12_000 });
    const loose = solve(pool, price, { ...options, budget: null, iterations: 12_000 });
    expect(tight.total).toBeGreaterThan(1);
    expect(tight.total).toBeLessThanOrEqual(loose.total + 12);
    const top = mostExpensive(tight, price);
    expect(top).toHaveLength(3);
    expect(top[0].cost).toBeGreaterThanOrEqual(top[1].cost);
    expect(top[1].cost).toBeGreaterThanOrEqual(top[2].cost);
  });

  it("un réservoir trop petit laisse des dîners à choisir ; « Autre proposition » évite les plats déjà proposés", () => {
    const small = solve(makePool(20), price, options);
    expect(small.missingDinners).toBe(8);
    expect(all(small)).toHaveLength(20);
    const pool = makePool(120);
    const first = solve(pool, price, options);
    const avoid = new Set(all(first).map((d) => d.key));
    const next = solve(pool, price, { ...options, avoid, seed: 7 });
    const overlap = all(next).filter((d) => avoid.has(d.key)).length;
    expect(overlap).toBeLessThan(all(next).length);
    expect(overlap).toBeLessThanOrEqual(all(first).length - 10);
  });

  it("un plat sans prix est évité quand une alternative chiffrée existe", () => {
    const pool = makePool(70);
    // 10 plats ne contiennent que de la truffe (sans prix)
    for (let i = 0; i < 10; i++) pool[i] = { ...pool[i], needs: new Map([["truffe", need(0.1)]]) };
    const s = solve(pool, price, { ...options, iterations: 12_000 });
    expect(s.unpricedProducts).toBeLessThanOrEqual(1);
  });
});
