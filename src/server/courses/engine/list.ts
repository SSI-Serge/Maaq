import { dishItems, findProd, type PackageFormat, type RefProduct } from "./products";
import { emptyNeed, packagesFor, singleMeasure, type Need } from "./quantities";
import { has, norm } from "./text";
import { isTotaled, perUnitOf, type PerUnitPrice, type PriceUnit } from "./unitprice";
import type { Dish } from "./types";

/** Ancienneté d'un prix affichée aux foyers (CR-20, US-166 RF3). */
export type PriceAge = "lt6" | "lt12" | "unknown";

export const AGE_LABEL: Record<PriceAge, string> = { lt6: "< 6 mois", lt12: "< 12 mois", unknown: "" };

function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
  return out;
}

function parseDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Ancienneté d'un prix à la date `now` : moins de 6 mois, moins de 12 mois, inconnue (pas de date), ou `null` au-delà de 12 mois :
 * le prix n'est alors plus affiché (CR-20).
 */
export function priceAge(priceDate: string | null | undefined, now: Date): PriceAge | null {
  if (!priceDate) return "unknown";
  const day = parseDay(priceDate);
  if (day >= addMonths(now, -6)) return "lt6";
  if (day >= addMonths(now, -12)) return "lt12";
  return null;
}

export type ChoiceKind = "reference" | "history" | "common";

/** Un choix de prix pour un produit du comparatif (US-157 RF4). Chaque prix est affiché avec son enseigne, sa ville et son ancienneté (CR-21). */
export interface Choice {
  kind: ChoiceKind;
  ref: string;
  price: number | null;
  store: string | null;
  city: string | null;
  age: PriceAge;
  /** « Composition à vérifier sur l'étiquette » (référence au statut « à vérifier », CR-37). */
  labelCheck?: boolean;
  /** Format du conditionnement de la référence. */
  format?: string | null;
  /** Prix au kilo ou au litre, quand il existe (CR-39). */
  perUnit?: PerUnitPrice | null;
  /** Unité du prix : par article (défaut), au kilo ou au litre. Un prix au kilo n'entre dans le total que si le poids du besoin est connu (CR-40, CR-50). */
  priceUnit?: PriceUnit;
  /** Contenu d'une unité d'achat de cette référence : le besoin du menu est divisé par lui (CR-50). */
  package?: PackageFormat | null;
}

/** Prix d'une enseigne pour le scénario « tout dans un magasin ». */
export interface StorePriceEntry {
  ref: string;
  price: number | null;
  priceUnit?: PriceUnit;
  package?: PackageFormat | null;
}

export type ItemGroup = "menu" | "ajout" | "habituel" | "sante";

export interface ListItem {
  id: number;
  name: string;
  rayon: string;
  group: ItemGroup;
  /** Plats du menu qui utilisent ce produit. */
  pour: string[];
  by: string;
  qty: number;
  /** Case cochée au départ. */
  checked: boolean;
  /** Choix du comparatif (références conformes, dernier équivalent acheté, base commune). */
  choices: Choice[];
  /** Prix de référence par enseigne : sert au scénario « tout dans un magasin ». */
  storePrices: Map<string, StorePriceEntry>;
  /** Produit issu d'une version allégée absent du catalogue : références de la version standard, à vérifier. */
  approx: boolean;
  /** « pas acheté la dernière fois » (CR-28). */
  notBoughtLastTime: boolean;
  /** Pense-bête d'une liste de la semaine d'avant : lundi de cette semaine (CR-55). */
  leftoverWeek?: string;
  /** Besoin du menu pour ce produit, en kilos, litres, pièces (CR-50) ; vide pour un ajout à la main, l'historique, ou quand il n'est pas calculable. */
  need: Need | null;
  /** « Quantité à vérifier » : 1 unité, conversion impossible. */
  toCheck: boolean;
  /** Produit « placard » : décoché au départ, « Vous en avez peut-être déjà ». */
  pantry: boolean;
}

export interface BuyRow {
  name: string;
  qty: number | null;
  by: string;
  source: "menu" | "manuel" | "version allégée" | "rapport" | "report";
  status: "à acheter" | "différé" | "remplacé";
  notBoughtLastTime?: boolean;
  /** Pense-bête « Pas encore acheté » : lundi de la semaine de la liste d'origine (CR-55). */
  leftoverWeek?: string;
  /** Besoin du menu (g, ml ou pièce) lu en base (CR-50). */
  needed?: { amount: number; unit: "g" | "ml" | "piece" } | null;
  toCheck?: boolean;
  pantry?: boolean;
  /** Coché pour l'achat ; faux au départ pour un produit « placard ». */
  selected?: boolean;
}

export interface HistoryPrice {
  product: string;
  ref: string;
  /** Prix d'une unité au ticket (ou au kilo, au litre, selon `priceUnit`) ; vide quand le produit a seulement été coché « acheté » en magasin. */
  unitPrice: number | null;
  /** Une ligne pesée au ticket donne un prix au kilo ou au litre (jamais le poids). */
  priceUnit?: PriceUnit;
  store: string;
  /** « AAAA-MM-JJ » */
  date: string;
  city?: string | null;
}

export interface CommonPrice {
  product: string;
  ref: string;
  price: number;
  store: string;
  city: string;
  /** Lundi de la semaine du relevé. */
  week: string;
  priceUnit?: PriceUnit;
  perMeasure?: PerUnitPrice | null;
}

/** Version allégée d'un plat (US-172) : produits à retirer et à ajouter. */
export interface LightVersion {
  dishId: string;
  remove: string[];
  add: string[];
  text: string;
}

export interface ListInput {
  /** Plats du menu validé, dans l'ordre. */
  dishes: Dish[];
  prods: Map<string, RefProduct>;
  buy: BuyRow[];
  history: HistoryPrice[];
  /** Rayon par produit, d'après les tickets déjà enregistrés. */
  journalRayon?: Map<string, string>;
  common?: CommonPrice[];
  light: Map<string, LightVersion>;
  /** Enseignes de proximité du foyer (US-153 RF3) ; vide = toutes celles du catalogue. */
  stores: string[];
  /** Le foyer partage ses prix : il voit la base commune (CR-12). */
  sharing: boolean;
  now: Date;
  /** Durée de l'historique proposé en pense-bête, en mois (3, CR-27). */
  historyMonths?: number;
}

export interface DishLight {
  dishId: string;
  name: string;
  text: string;
  removeIds: number[];
  addIds: number[];
  hasAdaptation: boolean;
  removeNames: string[];
  addNames: string[];
}

export interface ListModel {
  items: ListItem[];
  dishes: DishLight[];
}

/** Même produit : noms identiques ou l'un contenu dans l'autre (courses.py, same_item). */
export function sameItem(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  return na === nb || has(na, nb) || has(nb, na);
}

function keywordsOf(name: string, prods: Map<string, RefProduct>): string[] {
  const p = findProd(prods, name);
  return p ? prods.get(p)!.kwFull : [norm(name)];
}

function inProximity(store: string, stores: string[]): boolean {
  return !stores.length || stores.map(norm).includes(norm(store));
}

/** Construit les choix d'un produit (US-157 RF4) : références conformes, dernier équivalent acheté, moins cher de la base commune. */
function buildChoices(name: string, input: ListInput): { choices: Choice[]; storePrices: Map<string, StorePriceEntry>; rayon: string | null } {
  const { prods, stores, now } = input;
  const productName = findProd(prods, name);
  const product = productName ? prods.get(productName)! : null;
  const kws = keywordsOf(name, prods);
  const choices: Choice[] = [];
  const storePrices = new Map<string, StorePriceEntry>();

  if (product) {
    const refs = [...product.stores].filter(([store]) => inProximity(store, stores));
    const priced = refs
      .map(([store, v]) => ({ store, v, age: v.price !== null ? priceAge(v.priceDate, now) : "unknown" as PriceAge | null }))
      .filter((x) => x.v.price !== null && x.age !== null);
    for (const x of priced) {
      choices.push({ kind: "reference", ref: x.v.ref, price: x.v.price, store: x.store, city: null, age: x.age as PriceAge, labelCheck: x.v.labelCheck, format: x.v.format, priceUnit: x.v.priceUnit, perUnit: perUnitOf(x.v.price, x.v.priceUnit, x.v.perMeasure) , package: x.v.package });
      storePrices.set(x.store, { ref: x.v.ref, price: x.v.price, priceUnit: x.v.priceUnit, package: x.v.package });
    }
    if (!priced.length && refs.length) {
      // références sans prix connu : on garde la première, le prix sera « N/A »
      const [store, v] = refs[0];
      choices.push({ kind: "reference", ref: v.ref, price: null, store, city: null, age: "unknown", labelCheck: v.labelCheck, format: v.format, priceUnit: v.priceUnit , package: v.package });
    }
  }

  const bought = input.history
    .filter((r) => r.unitPrice !== null && kws.some((k) => has(k, norm(r.product))))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (bought.length) {
    // un choix « Dernier acheté » PAR ENSEIGNE, au prix le plus récent de chacune (CR-39) ; le plus récent toutes enseignes confondues vient en premier
    const latest = new Map<string, HistoryPrice>();
    for (const r of bought) latest.set(norm(r.store), r); // trié par date croissante : le dernier écrase les précédents
    const perStore = [...latest.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    for (const r of perStore) {
      choices.push({ kind: "history", ref: r.ref || r.product, price: r.unitPrice, store: r.store, city: r.city ?? null, age: priceAge(r.date, now) ?? "lt12", priceUnit: r.priceUnit, perUnit: perUnitOf(r.unitPrice, r.priceUnit, null) });
      // prix du scénario « tout dans un magasin » : l'achat le plus récent de l'enseigne, sauf si une référence conforme y a déjà un prix
      if (!storePrices.has(r.store)) storePrices.set(r.store, { ref: r.ref || r.product, price: r.unitPrice, priceUnit: r.priceUnit });
    }
  }

  if (input.sharing) {
    const rows = (input.common ?? [])
      .filter((r) => kws.some((k) => has(k, norm(r.product))) && inProximity(r.store, stores))
      .map((r) => ({ r, age: priceAge(r.week, now) }))
      .filter((x) => x.age !== null);
    if (rows.length) {
      const cheapest = rows.reduce((m, x) => (x.r.price < m.r.price ? x : m));
      choices.push({ kind: "common", ref: cheapest.r.ref || cheapest.r.product, price: cheapest.r.price, store: cheapest.r.store, city: cheapest.r.city, age: cheapest.age as PriceAge, priceUnit: cheapest.r.priceUnit, perUnit: perUnitOf(cheapest.r.price, cheapest.r.priceUnit, cheapest.r.perMeasure) });
    }
  }
  return { choices, storePrices, rayon: product?.rayon ?? null };
}

/** Index du choix coché au départ : le moins cher parmi ceux qui ont un prix ; à défaut le premier ; aucun si le produit n'a aucun choix. */
export function defaultChoice(choices: Choice[]): number | null {
  if (!choices.length) return null;
  // produits au poids : si tous les choix à prix ont un prix au kilo (ou au litre) de même unité, on compare ces prix-là (CR-39)
  const priced = choices.filter((c) => c.price !== null);
  const unit = priced[0]?.perUnit?.unit;
  const byMeasure = !!unit && priced.every((c) => c.perUnit?.unit === unit);
  const cost = (c: Choice) => (byMeasure ? (c.perUnit as PerUnitPrice).value : (c.price as number));
  let best = -1;
  choices.forEach((c, i) => {
    if (c.price !== null && (best < 0 || cost(c) < cost(choices[best]))) best = i;
  });
  return best >= 0 ? best : 0;
}

/**
 * Construit la liste de courses (US-157 RF1) à partir du menu validé, des produits ajoutés et de l'historique des 3 derniers mois,
 * avec les produits que les versions allégées retirent ou ajoutent. Reprend build_report de courses.py.
 */
/** Besoin en base (g, ml, pièce) → kilos, litres, pièces. */
function needOf(needed: BuyRow["needed"]): Need | null {
  if (!needed) return null;
  const need = emptyNeed();
  if (needed.unit === "g") need.kg = needed.amount / 1000;
  else if (needed.unit === "ml") need.l = needed.amount / 1000;
  else need.piece = needed.amount;
  return need;
}

export function buildListModel(input: ListInput): ListModel {
  const { dishes, prods, buy, history, light } = input;
  const items: ListItem[] = [];
  const seen = new Set<string>();
  const pour = new Map<string, string[]>();
  for (const d of dishes) {
    const { found, free } = dishItems(d, prods);
    for (const n of [...found, ...free]) pour.set(norm(n), [...(pour.get(norm(n)) ?? []), d.name]);
  }

  const make = (name: string, group: ItemGroup, extra: Partial<ListItem> & { rayonHint?: string | null }): ListItem => {
    const built = buildChoices(name, input);
    const item: ListItem = {
      id: items.length,
      name,
      rayon: extra.rayonHint ?? built.rayon ?? "Autres",
      group,
      pour: [],
      by: "",
      qty: 1,
      checked: false,
      choices: built.choices,
      storePrices: built.storePrices,
      approx: false,
      notBoughtLastTime: false,
      need: null,
      toCheck: false,
      pantry: false,
      ...extra,
    };
    items.push(item);
    return item;
  };

  for (const r of buy) {
    const k = norm(r.name);
    if (seen.has(k) || r.source === "version allégée") continue;
    seen.add(k);
    make(r.name, pour.has(k) || r.source === "menu" ? "menu" : "ajout", {
      pour: [...new Set(pour.get(k) ?? [])].sort(),
      by: r.by,
      qty: r.qty && r.qty > 0 ? r.qty : 1,
      checked: r.status !== "différé" && r.status !== "remplacé" && r.selected !== false,
      notBoughtLastTime: !!r.notBoughtLastTime,
      leftoverWeek: r.leftoverWeek,
      need: needOf(r.needed),
      toCheck: !!r.toCheck,
      pantry: !!r.pantry,
      rayonHint: input.journalRayon?.get(r.name) ?? null,
    });
  }

  // produits de l'historique du foyer (3 derniers mois), à cocher comme pense-bête
  const months = input.historyMonths ?? 3;
  const since = addMonths(input.now, -months);
  for (const h of history) {
    const k = norm(h.product);
    if (seen.has(k) || parseDay(h.date) < since) continue;
    seen.add(k);
    make(h.product, "habituel", { rayonHint: input.journalRayon?.get(h.product) ?? null });
  }

  // versions allégées : produits retirés (déjà dans la liste) et ajoutés, par plat
  const catalogNames = new Set([...prods.keys()].map(norm));
  const addedByName = new Map<string, ListItem>();
  const dishLights: DishLight[] = [];
  for (const d of dishes) {
    const x = light.get(d.id) ?? { dishId: d.id, remove: [], add: [], text: "" };
    const removeIds: number[] = [];
    const addIds: number[] = [];
    for (const nm of x.remove) {
      for (const it of items) {
        if ((it.group === "menu" || it.group === "ajout") && it.pour.includes(d.name) && sameItem(nm, it.name) && !removeIds.includes(it.id)) removeIds.push(it.id);
      }
    }
    for (const nm of x.add) {
      let existing = items.find((it) => (it.group === "menu" || it.group === "ajout") && norm(it.name) === norm(nm)) ?? addedByName.get(norm(nm));
      if (!existing) {
        existing = make(nm, "sante", { checked: true, approx: !!findProd(prods, nm) && !catalogNames.has(norm(nm)) });
        addedByName.set(norm(nm), existing);
      }
      addIds.push(existing.id);
    }
    dishLights.push({
      dishId: d.id,
      name: d.name,
      text: d.health || x.text || "",
      removeIds,
      addIds,
      hasAdaptation: x.remove.length > 0 || x.add.length > 0,
      removeNames: x.remove,
      addNames: x.add,
    });
  }
  return { items, dishes: dishLights };
}

export type DishMode = "standard" | "light";

/** État choisi par le foyer dans l'écran de la liste. */
export interface ListSelection {
  /** Case cochée par produit ; à défaut, la valeur de départ. */
  checked?: Map<number, boolean>;
  deleted?: Set<number>;
  /** Choix du comparatif par produit : index dans `choices`, ou null pour « aucun » (le produit reste, sans prix). */
  selected?: Map<number, number | null>;
  qty?: Map<number, number>;
  /** Version standard ou allégée par nom de plat. */
  modes?: Map<string, DishMode>;
  /** « Actualiser » a été touché : les versions allégées s'appliquent à la liste (US-157 RF5). */
  applied?: boolean;
}

function overrideOf(item: ListItem, sel: ListSelection): number | undefined {
  const v = sel.qty?.get(item.id);
  return v === undefined || Number.isNaN(v) ? undefined : v;
}

/** Choix de prix d'une ligne : ce dont le calcul de quantité a besoin. */
export interface LineChoice {
  price: number | null;
  priceUnit?: PriceUnit;
  package?: PackageFormat | null;
}

export interface LineAmount {
  /** Unités d'achat (paquets) ; 1 pour un produit au poids. */
  qty: number;
  /** Produit au poids : poids en kilos ou litres (celui du besoin, ou celui que le foyer a saisi) ; null s'il n'est pas connu. */
  weight: number | null;
  /** Montant de la ligne compté dans le total ; null quand il n'y en a pas (prix inconnu, produit au kilo sans poids connu). */
  total: number | null;
  /** « Quantité à vérifier » : 1 unité, conversion impossible. */
  toCheck: boolean;
}

/**
 * Quantité et montant d'une ligne pour une référence donnée (CR-50). Ordre : la quantité saisie par le foyer d'abord ; sinon le besoin du menu divisé par le format de la référence en
 * arrondissant au paquet supérieur ; sinon 1 (produit ajouté à la main, historique). Un produit au poids dont le poids est connu compte poids × prix au kilo dans le total (modifie CR-40) ;
 * sans poids connu, son prix au kilo n'est pas totalisé.
 */
export function lineAmount(item: ListItem, sel: ListSelection, choice: LineChoice | null): LineAmount {
  const price = choice?.price ?? null;
  const weighed = choice?.priceUnit === "kg" || choice?.priceUnit === "l";
  const override = overrideOf(item, sel);
  if (weighed) {
    const measure = item.need ? singleMeasure(item.need) : null;
    const known = measure && measure.unit === choice!.priceUnit && !item.toCheck ? measure.amount : null;
    const weight = override ?? known;
    return { qty: 1, weight, total: weight !== null && price !== null ? round2(weight * price) : null, toCheck: false };
  }
  if (override !== undefined) return { qty: override, weight: null, total: price !== null ? round2(price * override) : null, toCheck: false };
  const packages = item.need || item.toCheck ? packagesFor(item.need, item.toCheck, choice?.package ?? null) : { qty: item.qty, check: false };
  return { qty: packages.qty, weight: null, total: price !== null ? round2(price * packages.qty) : null, toCheck: packages.check };
}

/** Le produit est remplacé : tous les plats qui l'utilisent sont en version allégée et la retirent (un produit commun à deux plats reste). */
function replaced(item: ListItem, model: ListModel, sel: ListSelection): boolean {
  if (!sel.applied || !item.pour.length) return false;
  return item.pour.every((name) => {
    const d = model.dishes.find((x) => x.name === name);
    return !!d && (sel.modes?.get(name) ?? "standard") === "light" && d.removeIds.includes(item.id);
  });
}

function addedByLight(item: ListItem, model: ListModel, sel: ListSelection): boolean {
  return !!sel.applied && model.dishes.some((d) => (sel.modes?.get(d.name) ?? "standard") === "light" && d.addIds.includes(item.id));
}

/** Le produit fait partie de la liste à acheter. */
export function needed(item: ListItem, model: ListModel, sel: ListSelection): boolean {
  if (item.group === "sante") return addedByLight(item, model, sel);
  return !replaced(item, model, sel) || addedByLight(item, model, sel);
}

export function isReplaced(item: ListItem, model: ListModel, sel: ListSelection): boolean {
  return replaced(item, model, sel);
}

/** Produits cochés, non retirés et nécessaires : la liste sur laquelle les scénarios sont calculés. */
export function currentItems(model: ListModel, sel: ListSelection): ListItem[] {
  return model.items.filter((i) => (sel.checked?.get(i.id) ?? i.checked) && !sel.deleted?.has(i.id) && needed(i, model, sel));
}

/** Comparatif des prix : une ligne par produit qui a au moins 2 choix. Un produit à un seul choix est retenu d'office (US-157 RF4). */
export function comparatif(model: ListModel, sel: ListSelection): ListItem[] {
  return currentItems(model, sel).filter((i) => i.choices.length >= 2);
}

/** Choix retenu pour un produit : celui que le foyer a coché, sinon le moins cher ; null = aucun choix (produit sans prix). */
export function selectedChoice(item: ListItem, sel: ListSelection): Choice | null {
  const idx = sel.selected?.has(item.id) ? (sel.selected.get(item.id) as number | null) : defaultChoice(item.choices);
  return idx === null || idx === undefined ? null : (item.choices[idx] ?? null);
}

export interface Scenario {
  /** 1 : tout dans un magasin ; 2 : chaque référence choisie ; 3 : mes produits habituels. */
  id: 1 | 2 | 3;
  label: string;
  /** Magasin du scénario 1. */
  store: string | null;
  /** Total estimé : prix d'une unité × quantité (US-157 RF8). */
  total: number;
  /** Nombre de produits sans prix. */
  withoutPrice: number;
  /** Produits au kilo ou au litre : un prix, mais hors du total (CR-40). */
  notTotaled: number;
}

export interface ScenarioLine {
  itemId: number;
  name: string;
  rayon: string;
  qty: number;
  store: string | null;
  ref: string | null;
  city: string | null;
  price: number | null;
  age: PriceAge | null;
  labelCheck: boolean;
  format: string | null;
  /** Unité du prix de la ligne : « kg » ou « l » = prix au kilo (compté dans le total seulement si `weight` est connu). */
  priceUnit: PriceUnit;
  /** Produit au poids : poids en kilos ou litres compté dans le total ; null s'il n'est pas connu (prix au kilo non totalisé). */
  weight: number | null;
  /** Montant de la ligne compté dans le total (quantité × prix, ou poids × prix au kilo) ; null sinon. */
  lineTotal: number | null;
  /** « Quantité à vérifier » : 1 unité, conversion impossible. */
  toCheck: boolean;
  /** Produit « placard » : « Vous en avez peut-être déjà ». */
  pantry: boolean;
  /** Coché pour l'achat : faux pour un produit « placard » que le foyer n'a pas coché (hors du total). */
  checked: boolean;
  /** Besoin du menu (pour afficher « 900 g pour le menu ») ; null pour un ajout à la main ou l'historique. */
  need: { amount: number; unit: "kg" | "l" | "piece" } | null;
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

/** Les trois scénarios d'achat (US-157 RF6), recalculés à chaque changement. Le nombre de paquets dépend de la référence de chaque scénario (CR-50). */
export function computeScenarios(model: ListModel, sel: ListSelection, stores: string[]): Scenario[] {
  const list = currentItems(model, sel);
  const names = stores.length ? stores : [...new Set(list.flatMap((i) => [...i.storePrices.keys()]))];
  let best: { store: string; n: number; total: number; loose: number } | null = null;
  for (const store of names) {
    const priced = list.filter((i) => i.storePrices.get(store)?.price != null);
    const amounts = priced.map((i) => lineAmount(i, sel, i.storePrices.get(store)!));
    const total = amounts.reduce((sum, a) => sum + (a.total ?? 0), 0);
    if (!best || priced.length > best.n) best = { store, n: priced.length, total, loose: amounts.filter((a) => a.total === null).length };
  }
  const out: Scenario[] = [];
  if (best) out.push({ id: 1, label: `Tout dans ${best.store}`, store: best.store, total: round2(best.total), withoutPrice: list.length - best.n, notTotaled: best.loose });
  const chosen = list.map((i) => selectedChoice(i, sel));
  const chosenAmounts = chosen.map((c, k) => lineAmount(list[k], sel, c));
  out.push({
    id: 2,
    label: "Chaque référence choisie dans son magasin",
    store: null,
    total: round2(chosenAmounts.reduce((sum, a) => sum + (a.total ?? 0), 0)),
    withoutPrice: chosen.filter((c) => c?.price == null).length,
    notTotaled: chosen.filter((c, k) => c?.price != null && chosenAmounts[k].total === null).length,
  });
  const habitual = list.map((i) => i.choices.find((c) => c.kind === "history") ?? null);
  const habitualAmounts = habitual.map((c, k) => lineAmount(list[k], sel, c));
  out.push({
    id: 3,
    label: "Mes produits habituels dans mes magasins",
    store: null,
    total: round2(habitualAmounts.reduce((sum, a) => sum + (a.total ?? 0), 0)),
    withoutPrice: habitual.filter((c) => c?.price == null).length,
    notTotaled: habitual.filter((c, k) => c?.price != null && habitualAmounts[k].total === null).length,
  });
  return out;
}

/** Les produits du scénario choisi (US-157 RF7), regroupés par magasin puis par rayon par l'écran. */
export function scenarioLines(model: ListModel, sel: ListSelection, scenario: Scenario): ScenarioLine[] {
  // les produits « placard » décochés figurent dans la liste du scénario (pour pouvoir les cocher) mais n'entrent pas dans les totaux (CR-50)
  const current = currentItems(model, sel);
  const unticked = model.items.filter((i) => i.pantry && !current.includes(i) && !sel.deleted?.has(i.id) && needed(i, model, sel) && !(sel.checked?.get(i.id) ?? i.checked) && i.group !== "habituel");
  return [...current, ...unticked].map((i) => {
    let choice: { ref: string; price: number | null; store: string | null; city: string | null; age: PriceAge | null; labelCheck?: boolean; format?: string | null; priceUnit?: PriceUnit; package?: PackageFormat | null } | null;
    if (scenario.id === 1) {
      const p = scenario.store ? i.storePrices.get(scenario.store) : undefined;
      const src = i.choices.find((c) => c.store === scenario.store && c.price !== null);
      choice = p ? { ref: p.ref, price: p.price, store: scenario.store, city: src?.city ?? null, age: src?.age ?? null, labelCheck: src?.labelCheck, format: src?.format, priceUnit: p.priceUnit, package: p.package } : null;
    } else if (scenario.id === 2) {
      choice = selectedChoice(i, sel);
    } else {
      choice = i.choices.find((c) => c.kind === "history") ?? null;
    }
    const amount = lineAmount(i, sel, choice);
    const measure = i.need ? singleMeasure(i.need) : null;
    return {
      itemId: i.id,
      name: i.name,
      rayon: i.rayon,
      qty: amount.qty,
      weight: amount.weight,
      lineTotal: amount.total,
      toCheck: amount.toCheck,
      pantry: i.pantry,
      checked: current.includes(i),
      need: measure && !i.toCheck ? { amount: measure.amount, unit: measure.unit } : null,
      store: choice?.store ?? null,
      ref: choice?.ref ?? null,
      city: choice?.city ?? null,
      price: choice?.price ?? null,
      age: choice?.age ?? null,
      labelCheck: !!choice?.labelCheck,
      format: choice?.format ?? null,
      priceUnit: choice?.priceUnit ?? "unit",
    };
  });
}
