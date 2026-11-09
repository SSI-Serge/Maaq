import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { buildListModel, buildRefProducts, emptyNeed, findProd, lineAmount, onlyPantryUnits, selectedChoice, toBase, type ListItem, type ListSelection, type Need } from "../engine";
import { nameKey } from "../catalog/seed";
import type { SettingsView } from "../household/settings";
import { loadCommonPrices, loadHistory, loadReferences } from "../list/data";
import type { ProposalDish } from "../menu-ia/proposal";
import type { PoolDish, PriceFn } from "./solver";

/**
 * Chiffrage du menu du mois (CR-59, US-178 RF6) : pour chaque produit, le besoin des 4 semaines est additionné, arrondi au paquet supérieur et multiplié par le prix : le dernier prix du foyer (tickets),
 * sinon, si le foyer partage ses prix, le moins cher de la base commune dans ses enseignes de proximité. Les produits « placard » ne comptent pas ; un produit sans prix est signalé. Le calcul est celui de
 * la liste de courses (choix de la référence la moins chère, paquets, produits au poids) : un seul moteur.
 */

const EMPTY_SELECTION: ListSelection = { checked: new Map(), selected: new Map(), qty: new Map(), deleted: new Set(), modes: new Map(), applied: false };

export interface Book {
  /** Produits du catalogue reconnus par `findProd`. */
  prods: ReturnType<typeof buildRefProducts>;
  price: PriceFn;
}

/** Nom de produit du catalogue d'un ingrédient (ou null s'il n'est pas reconnu : non chiffré). */
export const productOf = (prods: Book["prods"], label: string): string | null => findProd(prods, label);

/** Besoins d'un plat par produit, en kilos, litres, pièces, cuillères, pincées ; les ingrédients hors catalogue sont comptés à part (non chiffrés). */
export function needsOfDish(dish: Pick<ProposalDish, "ingredients">, prods: Book["prods"]): { needs: Map<string, Need>; unpriced: number } {
  const needs = new Map<string, Need>();
  let unpriced = 0;
  for (const ing of dish.ingredients) {
    const product = productOf(prods, ing.label);
    if (!product) {
      unpriced += 1;
      continue;
    }
    const need = needs.get(product) ?? emptyNeed();
    const base = ing.quantity !== null && ing.unit ? toBase(ing.quantity, ing.unit) : null;
    if (base) need[base.unit] = Math.round((need[base.unit] + base.amount) * 1e6) / 1e6;
    else need.piece = Math.round((need.piece + 1) * 1e6) / 1e6; // quantité inconnue : une unité, « à vérifier »
    needs.set(product, need);
  }
  return { needs, unpriced };
}

/** Un plat de la proposition vu par le solveur. */
export const poolDishOf = (dish: ProposalDish, prods: Book["prods"], express: boolean): PoolDish => {
  const { needs, unpriced } = needsOfDish(dish, prods);
  return { key: nameKey(dish.name), name: dish.name, minutes: dish.minutes, cuisine: dish.cuisine, express, needs, unpriced };
};

/** Tarifs du foyer pour les produits donnés : même moteur que la liste de courses. */
export async function loadBook(db: Kysely<DB>, accountId: string, userId: string, settings: SettingsView, products: string[], now: Date): Promise<Book> {
  const [refs, history] = await Promise.all([loadReferences(db), loadHistory(db, accountId)]);
  const prods = buildRefProducts(refs.rows);
  const common = settings.sharePrices ? await loadCommonPrices(db, userId) : [];
  const chains = [...new Set(settings.stores.map((s) => s.chain))];
  const names = [...new Set(products)];
  const pantryKeys = names.length ? new Set((await db.selectFrom("grocery_products").select("name_key").where("name_key", "in", names.map((n) => nameKey(n))).where("is_pantry", "=", true).execute()).map((p) => p.name_key)) : new Set<string>();
  const model = buildListModel({
    dishes: [],
    prods,
    buy: names.map((name) => ({ name, qty: 1, by: "", source: "menu" as const, status: "à acheter" as const, notBoughtLastTime: false, needed: null, toCheck: false, pantry: false, selected: true })),
    history,
    light: new Map(),
    stores: chains,
    sharing: settings.sharePrices,
    common,
    now,
  });
  const items = new Map<string, { item: ListItem; choice: ReturnType<typeof selectedChoice> }>();
  for (const item of model.items) items.set(item.name, { item, choice: selectedChoice(item, EMPTY_SELECTION) });
  const price: PriceFn = (product, need) => {
    if (onlyPantryUnits(need) || pantryKeys.has(nameKey(product))) return 0;
    const entry = items.get(product);
    if (!entry || !entry.choice || entry.choice.price === null) return null;
    const amount = lineAmount({ ...entry.item, need, toCheck: false }, EMPTY_SELECTION, { price: entry.choice.price, priceUnit: entry.choice.priceUnit, package: entry.choice.package });
    return amount.total;
  };
  return { prods, price };
}
