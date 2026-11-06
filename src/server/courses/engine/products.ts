import { GENERIC, has, ingPhrases, norm, plist, SINGLE_DENY, STOP_ING } from "./text";
import type { Dish } from "./types";

/** Une ligne du catalogue des références (US-166) : un produit, une enseigne, une référence conforme ou non, son prix et la date du prix. */
export interface ReferenceRow {
  product: string;
  rayon: string;
  /** Mots des plats qui utilisent ce produit, séparés par des virgules. */
  used: string;
  store: string;
  ref: string;
  price: number | null;
  /** « AAAA-MM-JJ » ou null quand la date est inconnue. */
  priceDate: string | null;
  conform: boolean;
}

export interface StorePrice {
  ref: string;
  price: number | null;
  priceDate: string | null;
}

export interface RefProduct {
  name: string;
  rayon: string;
  used: string;
  /** Références conformes par enseigne. */
  stores: Map<string, StorePrice>;
  /** Mots qui rapprochent un texte de ce produit. */
  kw: string[];
  /** Noms complets (variantes) du produit. */
  kwFull: string[];
}

export function buildRefProducts(rows: ReferenceRow[]): Map<string, RefProduct> {
  const prods = new Map<string, RefProduct>();
  for (const r of rows) {
    if (!r.product) continue;
    let p = prods.get(r.product);
    if (!p) {
      p = { name: r.product, rayon: r.rayon, used: r.used ?? "", stores: new Map(), kw: [], kwFull: [] };
      prods.set(r.product, p);
    }
    if (r.conform) p.stores.set(r.store, { ref: r.ref, price: r.price, priceDate: r.priceDate });
  }
  for (const [name, p] of prods) {
    const alts = name
      .split(/[/(),]| ou /)
      .map((x) => norm(x).trim())
      .filter((x) => !SINGLE_DENY.has(x));
    const kws = new Set(alts.filter((a) => a.length >= 3));
    for (const a of alts) {
      const first = a ? a.split(/\s+/)[0] : "";
      if (a && first.length >= 4 && !GENERIC.has(first)) kws.add(first);
    }
    p.kw = [...kws].sort((a, b) => b.length - a.length);
    p.kwFull = [...new Set(alts.filter((a) => a.length >= 3))].sort((a, b) => b.length - a.length);
  }
  return prods;
}

export function prodMatches(p: RefProduct, text: string): boolean {
  return p.kw.some((k) => has(k, text));
}

export function findProd(prods: Map<string, RefProduct>, name: string): string | null {
  const t = norm(name);
  for (const [n, p] of prods) if (p.kwFull.some((k) => has(k, t))) return n;
  return null;
}

/** Produits de référence et ingrédients libres d'un plat (liste de courses issue du menu validé, US-156 RF12). */
export function dishItems(dish: Pick<Dish, "name" | "ing">, prods: Map<string, RefProduct>): { found: string[]; free: string[] } {
  const found = new Set<string>();
  const free: string[] = [];
  const nm = norm(dish.name);
  for (const [n, p] of prods) {
    for (const tok of plist(p.used)) {
      if (norm(tok).length >= 4 && nm.includes(norm(tok))) found.add(n);
    }
  }
  for (const phrase of ingPhrases(dish.ing)) {
    const t = norm(phrase);
    const hit = [...prods].filter(([, p]) => prodMatches(p, t)).map(([n]) => n);
    if (hit.length) {
      for (const n of hit.slice(0, 2)) found.add(n);
    } else if (t && !STOP_ING.has(t) && !STOP_ING.has(t.split(/\s+/)[0])) {
      free.push(phrase.trim().replace(/^[ .]+|[ .]+$/g, ""));
    }
  }
  return { found: [...found].sort(), free };
}

/** Le produit a au moins une référence conforme (sinon il est noté pour l'administration, US-173). */
export function hasReference(prods: Map<string, RefProduct>, name: string): boolean {
  const p = findProd(prods, name);
  return !!p && prods.get(p)!.stores.size > 0;
}

/** Type d'un produit sans référence conforme (US-173 RF1). */
export function gapType(prods: Map<string, RefProduct>, name: string): "inconnu" | "sans_reference" | null {
  if (hasReference(prods, name)) return null;
  return findProd(prods, name) ? "sans_reference" : "inconnu";
}
