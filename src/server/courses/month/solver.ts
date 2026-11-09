import { estimateMinutes, type Need } from "../engine";

/**
 * Menu du mois dans le budget (CR-59, US-178 RF4 à RF8) : choix de 4 semaines (7 dîners et 4 plats express chacune) parmi les plats utilisables, au meilleur coût. Pur et déterministe (graine) : essayé seul.
 * Le coût n'est pas la somme des coûts des plats : le besoin de chaque produit est additionné sur les 4 semaines, puis arrondi au paquet supérieur (les plats qui partagent des ingrédients coûtent moins).
 * Méthode : remplissage glouton puis recherche locale par remplacements et échanges (recuit simulé court). Dans le budget, on cherche d'abord la variété ; au-dessus, le coût passe avant tout.
 */

export interface PoolDish {
  key: string;
  name: string;
  minutes: number;
  cuisine: string;
  /** Peut tenir une place de plat express. */
  express: boolean;
  /** Besoin par produit du catalogue (pour le foyer). */
  needs: Map<string, Need>;
  /** Ingrédients sans produit du catalogue : non chiffrés. */
  unpriced: number;
}

/** Coût d'un produit pour un besoin donné ; null quand le prix est inconnu ; 0 pour un placard. */
export type PriceFn = (product: string, need: Need) => number | null;

export interface SolveOptions {
  weeks: number;
  dinnersPerWeek: number;
  expressPerWeek: number;
  /** Plafond de la séance (minutes) pour les cinq premiers dîners de chaque semaine ; null = pas de plafond. */
  sessionCap: number | null;
  budget: number | null;
  seed: number;
  /** Plats déjà proposés par les propositions précédentes : un peu moins attrayants (« Autre proposition »). */
  avoid?: Set<string>;
  iterations?: number;
}

export interface Slot {
  week: number;
  kind: "dinner" | "express";
  index: number;
}

export interface Solution {
  /** Un plat par place (null : réservoir insuffisant). */
  weeks: { dinners: (PoolDish | null)[]; express: (PoolDish | null)[] }[];
  total: number;
  /** Produits sans prix connu. */
  unpricedProducts: number;
  /** Coût de chaque semaine : le total réparti au prorata du coût de chaque semaine seule. */
  weekCosts: number[];
  missingDinners: number;
  missingExpress: number;
}

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addInto = (target: Map<string, Need>, needs: Map<string, Need>, sign: 1 | -1) => {
  for (const [p, n] of needs) {
    const cur = target.get(p) ?? { kg: 0, l: 0, piece: 0, spoon: 0, pinch: 0 };
    cur.kg = Math.max(0, Math.round((cur.kg + sign * n.kg) * 1e6) / 1e6);
    cur.l = Math.max(0, Math.round((cur.l + sign * n.l) * 1e6) / 1e6);
    cur.piece = Math.max(0, Math.round((cur.piece + sign * n.piece) * 1e6) / 1e6);
    cur.spoon = Math.max(0, cur.spoon + sign * n.spoon);
    cur.pinch = Math.max(0, cur.pinch + sign * n.pinch);
    target.set(p, cur);
  }
};

const isEmpty = (n: Need) => n.kg === 0 && n.l === 0 && n.piece === 0 && n.spoon === 0 && n.pinch === 0;

/** Coût d'un ensemble de plats : besoins additionnés par produit, arrondis au paquet supérieur ; les produits sans prix sont comptés à part. */
export function costOf(dishes: PoolDish[], price: PriceFn): { total: number; unpricedProducts: number } {
  const need = new Map<string, Need>();
  for (const d of dishes) addInto(need, d.needs, 1);
  let total = 0;
  let unpriced = 0;
  for (const [p, n] of need) {
    if (isEmpty(n)) continue;
    const c = price(p, n);
    if (c === null) unpriced += 1;
    else total += c;
  }
  return { total: Math.round(total * 100) / 100, unpricedProducts: unpriced };
}

export function solve(pool: PoolDish[], price: PriceFn, o: SolveOptions): Solution {
  const random = rng(o.seed);
  const slotsDinner = o.weeks * o.dinnersPerWeek;
  const slotsExpress = o.weeks * o.expressPerWeek;
  const dinners: (PoolDish | null)[] = Array(slotsDinner).fill(null);
  const express: (PoolDish | null)[] = Array(slotsExpress).fill(null);
  const used = new Set<string>();
  const cap = o.sessionCap;

  const need = new Map<string, Need>();
  const costOfProduct = new Map<string, number | null>();
  let total = 0;
  let unpriced = 0;
  const recost = (product: string) => {
    const n = need.get(product);
    const before = costOfProduct.get(product);
    if (before !== undefined) {
      if (before === null) unpriced -= 1;
      else total -= before;
      costOfProduct.delete(product);
    }
    if (!n || isEmpty(n)) return;
    const c = price(product, n);
    costOfProduct.set(product, c);
    if (c === null) unpriced += 1;
    else total += c;
  };
  const change = (add: PoolDish | null, remove: PoolDish | null) => {
    const touched = new Set<string>();
    if (remove) {
      addInto(need, remove.needs, -1);
      for (const p of remove.needs.keys()) touched.add(p);
    }
    if (add) {
      addInto(need, add.needs, 1);
      for (const p of add.needs.keys()) touched.add(p);
    }
    for (const p of touched) recost(p);
  };

  const weekOfDinner = (i: number) => Math.floor(i / o.dinnersPerWeek);
  const sessionOk = (week: number): boolean => {
    if (cap === null) return true;
    const first = dinners.slice(week * o.dinnersPerWeek, week * o.dinnersPerWeek + 5).filter((d): d is PoolDish => !!d);
    return estimateMinutes(first) <= cap + 1e-9;
  };
  const diversity = (): number => {
    let penalty = 0;
    for (let w = 0; w < o.weeks; w++) {
      const counts = new Map<string, number>();
      for (const d of dinners.slice(w * o.dinnersPerWeek, (w + 1) * o.dinnersPerWeek)) if (d) counts.set(d.cuisine, (counts.get(d.cuisine) ?? 0) + 1);
      for (const c of counts.values()) if (c > 3) penalty += (c - 3) * 2;
    }
    let reused = 0;
    if (o.avoid) for (const d of [...dinners, ...express]) if (d && o.avoid.has(d.key)) reused += 1;
    return penalty + reused * 1.5;
  };
  const budget = o.budget;
  const score = () => {
    const over = budget !== null ? Math.max(0, total - budget) : 0;
    // dans le budget : variété d'abord ; au-dessus : le coût passe avant tout
    const costWeight = budget !== null && total <= budget ? 0.02 : 1;
    return over * 10 + total * costWeight + unpriced * 4 + diversity();
  };

  // 1. remplissage glouton : les plats les moins chers d'abord, séance sous le plafond
  const standalone = new Map(pool.map((d) => [d.key, costOf([d], price).total + d.unpriced * 3]));
  const ranked = [...pool].sort((a, b) => (standalone.get(a.key)! - standalone.get(b.key)!) + (random() - 0.5) * 0.8);
  const place = (list: (PoolDish | null)[], i: number, d: PoolDish) => {
    list[i] = d;
    used.add(d.key);
    change(d, null);
  };
  for (let i = 0; i < slotsDinner; i++) {
    const week = weekOfDinner(i);
    const candidate = ranked.find((d) => !used.has(d.key));
    if (!candidate) break;
    dinners[i] = candidate;
    if (!sessionOk(week) && i % o.dinnersPerWeek < 5) {
      dinners[i] = null;
      const other = ranked.find((d) => {
        if (used.has(d.key)) return false;
        dinners[i] = d;
        const ok = sessionOk(week);
        dinners[i] = null;
        return ok;
      });
      if (!other) continue;
      place(dinners, i, other);
    } else {
      dinners[i] = null;
      place(dinners, i, candidate);
    }
  }
  for (let i = 0; i < slotsExpress; i++) {
    const candidate = ranked.find((d) => d.express && !used.has(d.key));
    if (!candidate) break;
    place(express, i, candidate);
  }

  // 2. recherche locale : remplacement d'un plat par un plat inutilisé, échange de deux dîners
  const iterations = o.iterations ?? 30_000;
  let current = score();
  let temperature = Math.max(1, Math.abs(current) * 0.02);
  const unusedPool = () => pool.filter((d) => !used.has(d.key));
  let free = unusedPool();
  for (let it = 0; it < iterations && pool.length; it++) {
    temperature *= 0.9998;
    const roll = random();
    if (roll < 0.7 && free.length) {
      const isExpress = random() < slotsExpress / (slotsExpress + slotsDinner);
      const list = isExpress ? express : dinners;
      const i = Math.floor(random() * list.length);
      const b = free[Math.floor(random() * free.length)];
      const a = list[i];
      if (isExpress && !b.express) continue;
      list[i] = b;
      if (!isExpress && !sessionOk(weekOfDinner(i))) {
        list[i] = a;
        continue;
      }
      change(b, a);
      const next = score();
      if (next <= current || random() < Math.exp((current - next) / temperature)) {
        current = next;
        used.add(b.key);
        if (a) used.delete(a.key);
        free = unusedPool();
      } else {
        list[i] = a;
        change(a, b);
      }
    } else if (slotsDinner > 1) {
      const i = Math.floor(random() * slotsDinner);
      const j = Math.floor(random() * slotsDinner);
      if (i === j) continue;
      const a = dinners[i];
      const b = dinners[j];
      if (!a && !b) continue;
      dinners[i] = b;
      dinners[j] = a;
      if (!sessionOk(weekOfDinner(i)) || !sessionOk(weekOfDinner(j))) {
        dinners[i] = a;
        dinners[j] = b;
        continue;
      }
      const next = score();
      if (next <= current || random() < Math.exp((current - next) / temperature)) current = next;
      else {
        dinners[i] = a;
        dinners[j] = b;
      }
    }
  }

  const weeks = Array.from({ length: o.weeks }, (_, w) => ({
    dinners: dinners.slice(w * o.dinnersPerWeek, (w + 1) * o.dinnersPerWeek),
    express: express.slice(w * o.expressPerWeek, (w + 1) * o.expressPerWeek),
  }));
  const alone = weeks.map((w) => costOf([...w.dinners, ...w.express].filter((d): d is PoolDish => !!d), price).total);
  const sumAlone = alone.reduce((s, x) => s + x, 0);
  const roundedTotal = Math.round(total * 100) / 100;
  const weekCosts = alone.map((c) => (sumAlone > 0 ? Math.round(((c / sumAlone) * roundedTotal) * 100) / 100 : 0));
  // l'arrondi ne doit pas faire perdre un centime au total
  if (weekCosts.length) weekCosts[weekCosts.length - 1] = Math.round((roundedTotal - weekCosts.slice(0, -1).reduce((s, x) => s + x, 0)) * 100) / 100;
  return {
    weeks,
    total: roundedTotal,
    unpricedProducts: unpriced,
    weekCosts,
    missingDinners: dinners.filter((d) => !d).length,
    missingExpress: express.filter((d) => !d).length,
  };
}

/** Les plats qui coûtent le plus dans une solution : coût du total avec ce plat moins le coût sans lui. */
export function mostExpensive(solution: Solution, price: PriceFn, count = 3): { key: string; name: string; cost: number }[] {
  const all = solution.weeks.flatMap((w) => [...w.dinners, ...w.express]).filter((d): d is PoolDish => !!d);
  const total = costOf(all, price).total;
  return all
    .map((d) => ({ key: d.key, name: d.name, cost: Math.round((total - costOf(all.filter((x) => x !== d), price).total) * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, count);
}
