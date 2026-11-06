import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { courseError, displayPlace, loadSettings, requireAccess, translateCourseError, type CourseAccess } from "../household/settings";
import { weekLabel } from "../menu/weeks";
import { addedLinesOf } from "./service";
import type { AddedLine } from "./service";

/**
 * « Ma liste de courses » (US-158) : la liste validée par magasin et par rayon, que l'on coche en magasin. Un produit acheté sort de la liste et rejoint l'historique ; un
 * produit ajouté depuis la validation reste sans magasin ni prix (CR-28). L'invité secondaire voit la liste sans prix ni total et n'a pas de case à cocher : la base ne lui
 * permet que d'ajouter un produit ou d'augmenter une quantité (CR-10).
 */

export interface MyLine {
  key: string;
  name: string;
  reference: string | null;
  qty: number;
  /** Prix de la ligne (prix d'une unité × quantité) ; vide pour l'invité secondaire ou sans prix connu. */
  price: number | null;
}

export interface MyStore {
  /** Enseigne, ou « À trouver sur place » pour les produits sans magasin. */
  name: string;
  city: string | null;
  subtotal: number | null;
  aisles: { name: string; lines: MyLine[] }[];
}

export interface MyList {
  access: CourseAccess;
  /** Aucune liste validée pour le menu en cours. */
  empty: boolean;
  /** Un menu est validé (sinon « Préparer le menu », sinon « Préparer la liste »). */
  hasMenu: boolean;
  weekLabel: string | null;
  late: AddedLine[];
  stores: MyStore[];
  /** Reste à acheter, pour le couple ; vide si tout est acheté. */
  remaining: number | null;
  allBought: boolean;
}

const round2 = (n: number) => Number(n.toFixed(2));
const isoDay = (value: Date | string) => (typeof value === "string" ? value.slice(0, 10) : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`);

export async function myList(ctx: Ctx, session: SessionContext): Promise<MyList> {
  const who = await requireAccess(ctx, session, "list");
  const since = new Date(ctx.now.getFullYear(), ctx.now.getMonth(), ctx.now.getDate() - 14);
  const menu = await ctx.db.selectFrom("meal_menus").select(["id", "week_start"]).where("account_id", "=", who.accountId).where("week_start", ">=", isoDay(since) as never).orderBy("week_start", "desc").limit(1).executeTakeFirst();
  const list = menu ? await ctx.db.selectFrom("grocery_lists").select("id").where("account_id", "=", who.accountId).where("menu_id", "=", menu.id).executeTakeFirst() : undefined;
  const base = { access: who.access, hasMenu: !!menu, weekLabel: menu ? weekLabel(isoDay(menu.week_start as Date | string)) : null };
  if (!list) return { ...base, empty: true, late: [], stores: [], remaining: null, allBought: false };

  const [rows, added, aisles] = await Promise.all([
    ctx.db
      .selectFrom("grocery_list_items")
      .select(["name_key", "label", "quantity", "state", "store_chain", "reference_name", "unit_price", "aisle_id", "created_at"])
      .where("account_id", "=", who.accountId)
      .where("list_id", "=", list.id)
      .where("state", "=", "validated")
      .orderBy("created_at")
      .execute(),
    addedLinesOf(ctx.db, who.accountId, who.userId),
    ctx.db.selectFrom("grocery_aisles").select(["id", "name", "sort_order"]).execute(),
  ]);
  const settings = who.access === "couple" ? await loadSettings(ctx.db, who.accountId) : null;
  const cityOf = (chain: string) => settings?.stores.find((s) => s.chain.toLowerCase() === displayPlace(chain).toLowerCase())?.city ?? null;
  const aisleOf = new Map(aisles.map((a) => [a.id, a]));
  const showPrices = who.access === "couple";

  const byStore = new Map<string, typeof rows>();
  for (const r of rows) byStore.set(r.store_chain ?? "", [...(byStore.get(r.store_chain ?? "") ?? []), r]);
  const stores: MyStore[] = [...byStore]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "fr")))
    .map(([chain, items]) => {
      const byAisle = new Map<number | null, typeof rows>();
      for (const r of items) byAisle.set(r.aisle_id, [...(byAisle.get(r.aisle_id) ?? []), r]);
      const aisleList = [...byAisle]
        .sort(([a], [b]) => (aisleOf.get(a ?? -1)?.sort_order ?? 9999) - (aisleOf.get(b ?? -1)?.sort_order ?? 9999))
        .map(([id, lines]) => ({
          name: aisleOf.get(id ?? -1)?.name ?? "Autres",
          lines: lines.map((r) => ({
            key: r.name_key,
            name: r.label,
            reference: r.reference_name,
            qty: r.quantity,
            price: showPrices && r.unit_price !== null ? round2(Number(r.unit_price) * r.quantity) : null,
          })),
        }));
      const sum = items.reduce((s, r) => s + (r.unit_price !== null ? Number(r.unit_price) * r.quantity : 0), 0);
      return { name: chain ? displayPlace(chain) : "À trouver sur place", city: chain ? cityOf(chain) : null, subtotal: showPrices && chain ? round2(sum) : null, aisles: aisleList };
    });
  const remaining = showPrices ? round2(rows.reduce((s, r) => s + (r.unit_price !== null ? Number(r.unit_price) * r.quantity : 0), 0)) : null;
  const late = added.filter((a) => a.late);
  return { ...base, empty: false, late, stores, remaining, allBought: rows.length === 0 && late.length === 0 };
}

/**
 * Coche un produit « acheté » (il sort de la liste et rejoint l'historique) ou annule. Réservé au couple. `late` : le produit venait de « Ajoutés depuis la validation »,
 * pour le remettre au bon endroit à l'annulation.
 */
export async function setBought(ctx: Ctx, session: SessionContext, input: { key: string; bought: boolean; late: boolean }): Promise<void> {
  const who = await requireAccess(ctx, session, "couple");
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      if (input.bought) {
        const done = await trx
          .updateTable("grocery_list_items")
          .set({ state: "bought", bought_at: ctx.now, bought_by_user_id: who.userId, updated_at: ctx.now })
          .where("account_id", "=", who.accountId)
          .where("name_key", "=", input.key)
          .where("state", "in", ["validated", "added_after_validation"])
          .executeTakeFirst();
        if (!done.numUpdatedRows) throw courseError("not_in_list", "Ce produit n'est plus dans la liste.", 404);
      } else {
        const back = await trx
          .updateTable("grocery_list_items")
          .set({ state: input.late ? "added_after_validation" : "validated", bought_at: null, bought_by_user_id: null, updated_at: ctx.now })
          .where("account_id", "=", who.accountId)
          .where("name_key", "=", input.key)
          .where("state", "=", "bought")
          .executeTakeFirst();
        if (!back.numUpdatedRows) throw courseError("not_bought", "Ce produit n'est pas marqué acheté.", 404);
      }
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw courseError("already_in_list", "Ce produit est déjà revenu dans la liste.", 409);
    throw translateCourseError(error);
  }
}
