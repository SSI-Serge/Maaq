import { sql } from "kysely";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { courseError, displayPlace, loadSettings, requireAccess, translateCourseError, type CourseAccess } from "../household/settings";
import { weekLabel } from "../menu/weeks";
import { addedLinesOf } from "./service";
import { checkWeek, groupOfMenu, listOfMenu, menuOfWeek, menusForTicking, pickMenu, weekChoices, weekStartLabel, type WeekChoice } from "./weeks";
import type { AddedLine } from "./service";

/**
 * « Ma liste de courses » (US-158) : la liste validée par magasin et par rayon, que l'on coche en magasin. Un produit acheté sort de la liste et rejoint l'historique ; un
 * produit ajouté depuis la validation reste sans magasin ni prix (CR-28). L'invité secondaire voit la liste sans prix ni total, la coche comme le couple et ne retire que
 * ses propres ajouts (CR-38) ; la lecture passe par grocery_list_for, qui lui rend un prix vide.
 */

export interface MyLine {
  key: string;
  name: string;
  reference: string | null;
  /** Format du conditionnement de la référence retenue (visible aussi de l'invité secondaire). */
  format: string | null;
  qty: number;
  /** Prix de la ligne (prix d'un article × quantité) ; vide pour l'invité secondaire, sans prix connu ou pour un article au kilo. */
  price: number | null;
  /** Article vendu au kilo ou au litre : prix au kilo ou au litre, non totalisé (CR-40). Vide pour l'invité secondaire. */
  perMeasure: { value: number; unit: "kg" | "l" } | null;
  /** Produit au poids dont le poids est connu (besoin du menu ou poids saisi) : en kilos ou en litres ; son montant, poids × prix au kilo, entre dans le total (CR-50). */
  weight: number | null;
  /** Besoin du menu (« 2 paquets · 900 g pour le menu ») : visible aussi de l'invité secondaire, sans prix. */
  need: { amount: number; unit: "g" | "ml" | "piece" } | null;
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
  /** Semaine affichée (lundi) et choix « Cette semaine / Semaine prochaine » ; le sélecteur n'apparaît que si les deux semaines ont une liste (CR-54). */
  week: string | null;
  weeks: WeekChoice[];
  /** Aucune liste validée pour le menu en cours. */
  empty: boolean;
  /** Un menu est validé (sinon « Préparer le menu », sinon « Préparer la liste »). */
  hasMenu: boolean;
  weekLabel: string | null;
  /** Liste du mois à laquelle la semaine affichée est regroupée (CR-56) ; `scope` dit si l'écran montre le regroupement ou la semaine seule. */
  group: null | { weeks: string[] };
  scope: "week" | "group";
  /** Produits frais des semaines suivantes d'une liste du mois : « À acheter plus tard (semaine du …) », décochés, sans prix (CR-56). */
  later: { week: string; label: string; names: string[] }[];
  late: AddedLine[];
  stores: MyStore[];
  /** Reste à acheter, pour le couple ; vide si tout est acheté. */
  remaining: number | null;
  /** Coût réel du menu (CR-58) : prix des tickets pour les produits achetés, prix estimés pour le reste ; vide pour l'invité secondaire ou tant que rien n'est acheté. */
  cost: null | { real: number; estimated: number; atValidation: number };
  allBought: boolean;
}

const round2 = (n: number) => Number(n.toFixed(2));

/** Poids (kilos ou litres) d'un produit au poids, d'après le besoin du menu gardé à la validation ; null si inconnu. */
function weightOf(r: { price_unit: string | null; needed_amount: string | null; needed_unit: "g" | "ml" | "piece" | null }): number | null {
  if (r.needed_amount === null) return null;
  const amount = Number(r.needed_amount);
  if (r.price_unit === "kg" && r.needed_unit === "g") return Math.round(amount) / 1000;
  if (r.price_unit === "l" && r.needed_unit === "ml") return Math.round(amount) / 1000;
  return null;
}

/** Montant d'une ligne : quantité × prix d'un article, ou poids × prix au kilo quand le poids est connu ; null sinon (prix au kilo sans poids : non totalisé, CR-40). */
function lineTotal(r: { unit_price: string | null; price_unit: string | null; quantity: number; needed_amount: string | null; needed_unit: "g" | "ml" | "piece" | null }): number | null {
  if (r.unit_price === null) return null;
  if (!r.price_unit || r.price_unit === "unit") return round2(Number(r.unit_price) * r.quantity);
  const weight = weightOf(r);
  return weight === null ? null : round2(weight * Number(r.unit_price));
}

export async function myList(ctx: Ctx, session: SessionContext, requestedWeek?: string | null, scopeAsked: "week" | "group" = "week"): Promise<MyList> {
  const who = await requireAccess(ctx, session, "list");
  const weeks = await weekChoices(ctx.db, who.accountId, ctx.now);
  // semaine demandée ; sinon la semaine en cours si elle a une liste, puis la suivante, puis ce que l'écran affichait avant (dernier menu récent)
  const asked = checkWeek(requestedWeek, ctx.now);
  const fallbackWeek = asked ?? weeks.find((w) => w.hasList)?.week ?? null;
  const menu = fallbackWeek ? await menuOfWeek(ctx.db, who.accountId, fallbackWeek) : await pickMenu(ctx.db, who.accountId, ctx.now);
  const list = menu ? await listOfMenu(ctx.db, who.accountId, menu.id) : null;
  const group = menu && list ? await groupOfMenu(ctx.db, who.accountId, menu.id) : null;
  const scope = group && scopeAsked === "group" ? "group" : "week";
  const base = { access: who.access, week: menu?.week_start ?? null, weeks, hasMenu: !!menu, weekLabel: menu ? weekLabel(menu.week_start) : null, group: group ? { weeks: group.weeks } : null, scope: scope as "week" | "group", later: [] as MyList["later"] };
  if (!list) return { ...base, empty: true, late: [], stores: [], remaining: null, cost: null, allBought: false };
  // liste du mois : les listes de toutes les semaines regroupées, les produits identiques additionnés
  const groupLists = scope === "group" ? await ctx.db.selectFrom("grocery_lists as l").innerJoin("meal_menus as m", "m.id", "l.menu_id").select(["l.id", "l.menu_id", "m.week_start"]).where("l.account_id", "=", who.accountId).where("l.group_id", "=", (await ctx.db.selectFrom("grocery_lists").select("group_id").where("id", "=", list.id).executeTakeFirstOrThrow()).group_id!).orderBy("m.week_start").execute() : null;
  const listIds = groupLists ? groupLists.map((l) => l.id) : [list.id];

  const [rows, added, aisles] = await Promise.all([
    // lecture par grocery_list_for : le prix estimé n'est rendu qu'au couple (CR-38), le magasin et la référence restent visibles pour l'invité secondaire
    sql<{ name_key: string; label: string; quantity: number; state: string; store_chain: string | null; reference_name: string | null; unit_price: string | null; aisle_id: number | null; created_at: Date; package_format: string | null; price_unit: string | null; needed_amount: string | null; needed_unit: "g" | "ml" | "piece" | null }>`
      select name_key, label, quantity, state, store_chain, reference_name, unit_price, aisle_id, bought_at as created_at, package_format, price_unit, needed_amount, needed_unit
        from grocery_list_for(${who.userId}::uuid)
       where list_id = any(${listIds}::uuid[]) and state = 'validated'
       order by label`.execute(ctx.db).then((r) => r.rows),
    addedLines(ctx, who, groupLists ? groupLists.map((l) => ({ id: String(l.menu_id), week: typeof l.week_start === "string" ? (l.week_start as string).slice(0, 10) : isoIso(l.week_start as Date) })) : [{ id: menu!.id, week: menu!.week_start }]),
    ctx.db.selectFrom("grocery_aisles").select(["id", "name", "sort_order"]).execute(),
  ]);
  const settings = who.access === "couple" ? await loadSettings(ctx.db, who.accountId) : null;
  const cityOf = (chain: string) => settings?.stores.find((s) => s.chain.toLowerCase() === displayPlace(chain).toLowerCase())?.city ?? null;
  const aisleOf = new Map(aisles.map((a) => [a.id, a]));
  const showPrices = who.access === "couple";

  // une liste du mois additionne les produits identiques des semaines regroupées (même magasin et même référence)
  const merged = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = scope === "group" ? `${r.name_key}|${r.store_chain ?? ""}|${r.reference_name ?? ""}|${r.price_unit ?? ""}` : `${merged.size}:${r.name_key}`;
    const seen = merged.get(key);
    if (!seen) merged.set(key, { ...r });
    else {
      seen.quantity += r.quantity;
      if (seen.needed_amount !== null && r.needed_amount !== null && seen.needed_unit === r.needed_unit) seen.needed_amount = String(Number(seen.needed_amount) + Number(r.needed_amount));
    }
  }
  const lines = [...merged.values()];
  const byStore = new Map<string, typeof rows>();
  for (const r of lines) byStore.set(r.store_chain ?? "", [...(byStore.get(r.store_chain ?? "") ?? []), r]);
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
            format: r.package_format,
            qty: r.quantity,
            price: showPrices ? lineTotal(r) : null,
            weight: weightOf(r),
            need: r.needed_amount !== null && r.needed_unit ? { amount: Number(r.needed_amount), unit: r.needed_unit } : null,
            perMeasure: showPrices && r.unit_price !== null && (r.price_unit === "kg" || r.price_unit === "l") ? { value: Number(r.unit_price), unit: r.price_unit === "kg" ? ("kg" as const) : ("l" as const) } : null,
          })),
        }));
      const sum = items.reduce((s, r) => s + (lineTotal(r) ?? 0), 0);
      return { name: chain ? displayPlace(chain) : "À trouver sur place", city: chain ? cityOf(chain) : null, subtotal: showPrices && chain ? round2(sum) : null, aisles: aisleList };
    });
  const remaining = showPrices ? round2(lines.reduce((s, r) => s + (lineTotal(r) ?? 0), 0)) : null;
  const late = added.filter((a) => a.late);
  // « À acheter plus tard (semaine du …) » : produits frais des semaines suivantes de la liste du mois, encore en préparation (CR-56)
  const later: MyList["later"] = [];
  if (groupLists && groupLists.length > 1) {
    const fresh = new Set((await ctx.db.selectFrom("grocery_aisles").select("id").where("is_fresh", "=", true).execute()).map((a) => a.id));
    const others = groupLists.slice(1);
    const pending = await ctx.db.selectFrom("grocery_list_items").select(["label", "menu_id", "aisle_id"]).where("account_id", "=", who.accountId).where("menu_id", "in", others.map((l) => l.menu_id as string)).where("state", "=", "preparing").orderBy("label").execute();
    for (const l of others) {
      const names = pending.filter((r) => r.menu_id === l.menu_id && r.aisle_id !== null && fresh.has(r.aisle_id)).map((r) => r.label);
      const week = typeof l.week_start === "string" ? (l.week_start as string).slice(0, 10) : isoIso(l.week_start as Date);
      if (names.length) later.push({ week, label: `semaine du ${weekStartLabel(week)}`, names });
    }
  }
  return { ...base, later, empty: false, late, stores, remaining, cost: showPrices ? await realCost(ctx, who.accountId, listIds) : null, allBought: lines.length === 0 && late.length === 0 };
}

/**
 * Coche un produit « acheté » (il sort de la liste et rejoint l'historique) ou annule. Le couple et l'invité secondaire (CR-38) ; l'invité ne décoche que ses propres coches (la base le garantit). `late` : le produit venait de « Ajoutés depuis la validation »,
 * pour le remettre au bon endroit à l'annulation.
 */
export async function setBought(ctx: Ctx, session: SessionContext, input: { key: string; bought: boolean; late: boolean; week?: string | null }): Promise<void> {
  const who = await requireAccess(ctx, session, "list");
  // la semaine affichée d'abord ; sans semaine, la semaine en cours puis la suivante (CR-54)
  const asked = checkWeek(input.week, ctx.now);
  const asked_menu = asked ? await menuOfWeek(ctx.db, who.accountId, asked) : null;
  const menus = asked ? (asked_menu ? [asked_menu.id] : []) : await menusForTicking(ctx.db, who.accountId, ctx.now);
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      for (const menuId of menus) {
        if (input.bought) {
          const done = await trx
            .updateTable("grocery_list_items")
            .set({ state: "bought", bought_at: ctx.now, bought_by_user_id: who.userId, updated_at: ctx.now })
            .where("account_id", "=", who.accountId)
            .where("menu_id", "=", menuId)
            .where("name_key", "=", input.key)
            .where("state", "in", ["validated", "added_after_validation"])
            .executeTakeFirst();
          if (done.numUpdatedRows) return;
        } else {
          const back = await trx
            .updateTable("grocery_list_items")
            .set({ state: input.late ? "added_after_validation" : "validated", bought_at: null, bought_by_user_id: null, updated_at: ctx.now })
            .where("account_id", "=", who.accountId)
            .where("menu_id", "=", menuId)
            .where("name_key", "=", input.key)
            .where("state", "=", "bought")
            .executeTakeFirst();
          if (back.numUpdatedRows) return;
        }
      }
      if (input.bought) throw courseError("not_in_list", "Ce produit n'est plus dans la liste.", 404);
      throw courseError("not_bought", "Ce produit n'est pas marqué acheté.", 404);
    });
  } catch (error) {
    if (/seulement augmenter une quantité ou cocher/.test((error as Error).message ?? "")) throw courseError("not_yours", "Vous ne pouvez annuler que vos propres coches.", 403);
    if ((error as { code?: string }).code === "23505") throw courseError("already_in_list", "Ce produit est déjà revenu dans la liste.", 409);
    throw translateCourseError(error);
  }
}

const isoIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Produits ajoutés depuis la validation, de une ou plusieurs semaines (liste du mois) ; un produit de même nom n'est montré qu'une fois. */
async function addedLines(ctx: Ctx, who: { accountId: string; userId: string }, menus: { id: string; week: string }[]): Promise<AddedLine[]> {
  const out: AddedLine[] = [];
  for (const m of menus) for (const a of await addedLinesOf(ctx.db, who.accountId, who.userId, m.id, m.week)) if (!out.some((x) => x.key === a.key)) out.push(a);
  return out;
}

/**
 * Coût réel du menu (CR-58, US-177 RF5) : une ligne de ticket est comptée en entier dans la semaine dont elle coche le produit ; un produit acheté à la main, sans ligne de ticket, et tout produit
 * encore à acheter restent estimés ; les produits achetés hors liste ne comptent pas. Vide tant que rien n'est acheté. « Estimé à la validation » : le prix estimé de toute la liste.
 */
async function realCost(ctx: Ctx, accountId: string, listIds: string[]): Promise<MyList["cost"]> {
  const rows = await ctx.db
    .selectFrom("grocery_list_items as i")
    .leftJoin("grocery_receipt_lines as rl", (j) => j.onRef("rl.id", "=", "i.receipt_line_id").onRef("rl.account_id", "=", "i.account_id"))
    .select(["i.state", "i.quantity", "i.unit_price", "i.price_unit", "i.needed_amount", "i.needed_unit", "i.receipt_line_id", "rl.line_total"])
    .where("i.account_id", "=", accountId)
    .where("i.list_id", "in", listIds)
    .where("i.state", "in", ["validated", "bought"])
    .execute();
  if (!rows.some((r) => r.state === "bought")) return null;
  const lineSeen = new Set<string>();
  let real = 0;
  let estimated = 0;
  let atValidation = 0;
  for (const r of rows) {
    const guess = lineTotal({ unit_price: r.unit_price, price_unit: r.price_unit, quantity: r.quantity, needed_amount: r.needed_amount, needed_unit: r.needed_unit }) ?? 0;
    atValidation += guess;
    if (r.state === "bought" && r.receipt_line_id !== null && r.line_total !== null) {
      const id = String(r.receipt_line_id);
      if (!lineSeen.has(id)) {
        lineSeen.add(id);
        real += Number(r.line_total);
      }
    } else {
      real += guess;
      estimated += guess;
    }
  }
  return { real: round2(real), estimated: round2(estimated), atValidation: round2(atValidation) };
}
