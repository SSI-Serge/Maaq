import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { isoDate } from "../engine";
import { courseError } from "../household/settings";

/**
 * Deux semaines à la fois (CR-54) : chaque semaine a son menu et sa liste. Ce fichier dit quelle semaine un écran affiche : celle qu'il demande (`?week=` : le lundi de cette
 * semaine ou de la suivante), sinon la première semaine qui a un menu (en cours, puis les suivantes), sinon la dernière semaine passée qui a encore un menu (comme avant CR-54).
 */

const DAYS = 86_400_000;
/** Semaines préparées à l'avance (CR-56) : la semaine en cours et les quatre suivantes. */
export const WEEKS_AHEAD = 4;
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** Lundi de la semaine de `date`, « AAAA-MM-JJ ». */
export function mondayIso(date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}

export const addDaysIso = (iso: string, n: number): string => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAYS).toISOString().slice(0, 10);

/** « du 9 au 15 nov. » ; « du 30 nov. au 6 déc. » quand la semaine change de mois. */
export function weekRange(week: string): string {
  const end = addDaysIso(week, 6);
  const [, m1, d1] = week.split("-").map(Number);
  const [, m2, d2] = end.split("-").map(Number);
  return m1 === m2 ? `du ${d1} au ${d2} ${MONTHS[m2 - 1]}` : `du ${d1} ${MONTHS[m1 - 1]} au ${d2} ${MONTHS[m2 - 1]}`;
}

/** « 9 nov. » : le lundi d'une semaine, pour « Pas encore acheté (semaine du 9 nov.) ». */
export function weekStartLabel(week: string): string {
  const [, m, d] = week.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export interface WeekChoice {
  /** Lundi, « AAAA-MM-JJ ». */
  week: string;
  /** « Cette semaine (du 9 au 15 nov.) » pour la semaine en cours, « Semaine du 16 au 22 nov. » pour les suivantes. */
  label: string;
  /** « du 9 au 15 nov. ». */
  range: string;
  current: boolean;
  /** Un menu est validé pour cette semaine. */
  hasMenu: boolean;
  /** Une liste est validée pour cette semaine. */
  hasList: boolean;
  /** La liste de cette semaine est regroupée dans une liste du mois validée (CR-56). */
  grouped: boolean;
}

export interface WeekMenu {
  id: string;
  week_start: string;
  validated_at: Date;
  batch_week_id: string | null;
  servings: number | null;
  session_minutes: number | null;
  session_is_estimated: boolean;
  session_over_cap: boolean;
}

const asWeekMenu = (r: { id: string; week_start: Date | string; validated_at: Date; batch_week_id: string | number | null; servings: number | null; session_minutes: number | null; session_is_estimated: boolean; session_over_cap: boolean }): WeekMenu => ({
  id: r.id,
  week_start: typeof r.week_start === "string" ? r.week_start.slice(0, 10) : isoDate(r.week_start),
  validated_at: r.validated_at,
  batch_week_id: r.batch_week_id === null ? null : String(r.batch_week_id),
  servings: r.servings,
  session_minutes: r.session_minutes,
  session_is_estimated: r.session_is_estimated,
  session_over_cap: r.session_over_cap,
});

/** La semaine en cours et les quatre suivantes, avec leur menu et leur liste. */
export const weekMondays = (now: Date): string[] => Array.from({ length: WEEKS_AHEAD + 1 }, (_, i) => addDaysIso(mondayIso(now), 7 * i));

export async function weekChoices(db: Kysely<DB>, accountId: string, now: Date): Promise<WeekChoice[]> {
  const mondays = weekMondays(now);
  const menus = await db.selectFrom("meal_menus").select(["id", "week_start"]).where("account_id", "=", accountId).where("week_start", "in", mondays as never[]).execute();
  const lists = menus.length ? await db.selectFrom("grocery_lists").select(["menu_id", "group_id"]).where("account_id", "=", accountId).where("menu_id", "in", menus.map((m) => m.id)).execute() : [];
  const listed = new Set(lists.map((l) => l.menu_id));
  const grouped = new Set(lists.filter((l) => l.group_id !== null).map((l) => l.menu_id));
  const byWeek = new Map(menus.map((m) => [typeof m.week_start === "string" ? (m.week_start as string).slice(0, 10) : isoDate(m.week_start as Date), m.id]));
  return mondays.map((week, i) => ({
    week,
    label: i === 0 ? `Cette semaine (${weekRange(week)})` : `Semaine ${weekRange(week)}`,
    range: weekRange(week),
    current: i === 0,
    hasMenu: byWeek.has(week),
    hasList: listed.has(byWeek.get(week) ?? ""),
    grouped: grouped.has(byWeek.get(week) ?? ""),
  }));
}

const MENU_COLUMNS = ["id", "week_start", "validated_at", "batch_week_id", "servings", "session_minutes", "session_is_estimated", "session_over_cap"] as const;

export async function menuOfWeek(db: Kysely<DB>, accountId: string, week: string): Promise<WeekMenu | null> {
  const row = await db.selectFrom("meal_menus").select([...MENU_COLUMNS]).where("account_id", "=", accountId).where("week_start", "=", week as never).executeTakeFirst();
  return row ? asWeekMenu(row) : null;
}

/** Lundi demandé : seulement celui de cette semaine ou des quatre suivantes (une semaine passée n'a plus d'écran). */
export function checkWeek(requested: string | undefined | null, now: Date): string | null {
  if (!requested) return null;
  if (!weekMondays(now).includes(requested)) throw courseError("invalid_week", "Choisissez la semaine en cours ou l'une des quatre suivantes.", 422);
  return requested;
}

/** Menu affiché : la semaine demandée ; sinon la semaine en cours, la suivante, puis la dernière semaine passée qui a un menu. `null` : aucun menu. */
export async function pickMenu(db: Kysely<DB>, accountId: string, now: Date, requested?: string | null): Promise<WeekMenu | null> {
  const wanted = checkWeek(requested, now);
  if (wanted) return menuOfWeek(db, accountId, wanted);
  const current = mondayIso(now);
  for (const week of weekMondays(now)) {
    const menu = await menuOfWeek(db, accountId, week);
    if (menu) return menu;
  }
  const last = await db
    .selectFrom("meal_menus")
    .select([...MENU_COLUMNS])
    .where("account_id", "=", accountId)
    .where("week_start", "<", current as never)
    .where("week_start", ">=", addDaysIso(current, -7) as never)
    .orderBy("week_start", "desc")
    .limit(1)
    .executeTakeFirst();
  return last ? asWeekMenu(last) : null;
}

/** Liste validée d'un menu (une seule par menu). */
export async function listOfMenu(db: Kysely<DB>, accountId: string, menuId: string): Promise<{ id: string; validated_at: Date } | null> {
  const row = await db.selectFrom("grocery_lists").select(["id", "validated_at"]).where("account_id", "=", accountId).where("menu_id", "=", menuId).executeTakeFirst();
  return row ?? null;
}

/** Les deux semaines d'abord (en cours, puis suivante) : ordre où un achat ou « J'ai pris… » cherche le produit (CR-54). */
export async function menusForTicking(db: Kysely<DB>, accountId: string, now: Date): Promise<string[]> {
  const current = mondayIso(now);
  const rows = await db.selectFrom("meal_menus").select(["id", "week_start"]).where("account_id", "=", accountId).where("week_start", ">=", addDaysIso(current, -7) as never).orderBy("week_start").execute();
  const iso = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : isoDate(d));
  const rank = (week: string) => (week === current ? 0 : week > current ? 1 : 2);
  return rows.sort((a, b) => rank(iso(a.week_start as Date)) - rank(iso(b.week_start as Date)) || iso(a.week_start as Date).localeCompare(iso(b.week_start as Date))).map((r) => r.id);
}

/** Pense-bêtes « Pas encore acheté » d'un menu : lus par la base (grocery_leftovers_for), sans copie (CR-55). */
export interface Leftover {
  sourceItemId: string;
  originWeek: string;
  label: string;
  nameKey: string;
  productId: string | null;
  aisleId: number | null;
  quantity: number;
  storeChain: string | null;
  referenceName: string | null;
  unitPrice: number | null;
  priceUnit: string | null;
  neededAmount: number | null;
  neededUnit: "g" | "ml" | "piece" | null;
  quantityToCheck: boolean;
  isPantry: boolean;
}

export async function leftoversFor(db: Kysely<DB>, viewerId: string, menuId: string): Promise<Leftover[]> {
  const rows = (
    await sql<{ source_item_id: string; origin_week_start: Date | string; label: string; name_key: string; product_id: string | null; aisle_id: number | null; quantity: number; store_chain: string | null; reference_name: string | null; unit_price: string | null; price_unit: string | null; needed_amount: string | null; needed_unit: "g" | "ml" | "piece" | null; quantity_to_check: boolean; is_pantry: boolean }>`
      select source_item_id, origin_week_start, label, name_key, product_id::text as product_id, aisle_id, quantity, store_chain, reference_name, unit_price, price_unit, needed_amount, needed_unit, quantity_to_check, is_pantry
        from grocery_leftovers_for(${viewerId}::uuid, ${menuId}::uuid) order by label`.execute(db)
  ).rows;
  return rows.map((r) => ({
    sourceItemId: r.source_item_id,
    originWeek: typeof r.origin_week_start === "string" ? r.origin_week_start.slice(0, 10) : isoDate(r.origin_week_start),
    label: r.label,
    nameKey: r.name_key,
    productId: r.product_id,
    aisleId: r.aisle_id,
    quantity: r.quantity,
    storeChain: r.store_chain,
    referenceName: r.reference_name,
    unitPrice: r.unit_price === null ? null : Number(r.unit_price),
    priceUnit: r.price_unit,
    neededAmount: r.needed_amount === null ? null : Number(r.needed_amount),
    neededUnit: r.needed_unit,
    quantityToCheck: r.quantity_to_check,
    isPantry: r.is_pantry,
  }));
}

/** Les menus des semaines regroupées (liste du mois, CR-56) : au moins deux semaines différentes, chacune de la fenêtre et avec un menu validé ; rendus de la plus proche à la plus lointaine. */
export async function groupMenusOf(db: Kysely<DB>, accountId: string, weeks: string[], now: Date): Promise<WeekMenu[]> {
  const unique = [...new Set(weeks.map((w) => checkWeek(w, now)).filter((w): w is string => !!w))].sort();
  if (unique.length < 2) throw courseError("invalid_group", "Choisissez au moins deux semaines à regrouper.", 422);
  const menus: WeekMenu[] = [];
  for (const week of unique) {
    const menu = await menuOfWeek(db, accountId, week);
    if (!menu) throw courseError("no_menu", `Il n'y a pas de menu pour la semaine ${weekRange(week)}.`, 404);
    menus.push(menu);
  }
  return menus;
}

/** Liste du mois à laquelle une semaine est regroupée : son identifiant et les lundis de toutes ses semaines. */
export async function groupOfMenu(db: Kysely<DB>, accountId: string, menuId: string): Promise<{ id: string; weeks: string[] } | null> {
  const own = await db.selectFrom("grocery_lists").select("group_id").where("account_id", "=", accountId).where("menu_id", "=", menuId).executeTakeFirst();
  if (!own?.group_id) return null;
  const rows = await db
    .selectFrom("grocery_lists as l")
    .innerJoin("meal_menus as m", "m.id", "l.menu_id")
    .select("m.week_start")
    .where("l.account_id", "=", accountId)
    .where("l.group_id", "=", own.group_id)
    .orderBy("m.week_start")
    .execute();
  return { id: own.group_id, weeks: rows.map((r) => (typeof r.week_start === "string" ? (r.week_start as string).slice(0, 10) : isoDate(r.week_start as Date))) };
}
