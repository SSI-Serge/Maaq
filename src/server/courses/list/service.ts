import { sql, type Kysely } from "kysely";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { nameKey, placeKey } from "../catalog/seed";
import { buildListModel, buildRefProducts, DAYS, dishItems, fmtMin, gapType, norm, type BuyRow, type Dish, type DishMode } from "../engine";
import { courseError, loadSettings, requireAccess, translateCourseError, type CourseAccess } from "../household/settings";
import { loadEngineData } from "../menu/data";
import { weekLabel } from "../menu/weeks";
import { loadCommonPrices, loadHistory, loadLightVersions, loadReferences, type ExcludedReference, type References } from "./data";
import { toDto, type ListModelDto } from "./dto";

/**
 * Liste de courses (US-157, US-158) : préparation après la validation du menu (ingrédients, versions allégées, produits ajoutés, historique, comparatif, trois scénarios),
 * puis validation du scénario choisi. L'invité secondaire ne voit que les produits ajoutés et peut en ajouter ou retirer les siens (CR-10).
 */

export interface AddedLine {
  key: string;
  name: string;
  by: string;
  qty: number;
  notBoughtLastTime: boolean;
  /** Ajouté par le profil connecté. */
  mine: boolean;
  /** Ajouté depuis la validation de la liste (sans magasin ni prix). */
  late: boolean;
}

export interface MenuSummary {
  week: string;
  weekLabel: string;
  days: { day: string; name: string; time: string }[];
  session: { label: string; theme: string; estimated: boolean };
  express: { name: string; time: string }[];
}

export interface ListPrepared {
  access: CourseAccess;
  menu: MenuSummary | null;
  /** Une liste est déjà validée pour ce menu. */
  validated: boolean;
  model: ListModelDto | null;
  /** Version choisie par plat (nom du plat → version), reprise de la dernière fois. */
  modes: Record<string, DishMode>;
  stores: { chain: string; city: string }[];
  sharing: boolean;
  householdSize: number | null;
  added: AddedLine[];
  excluded: ExcludedReference[];
  criteria: { label: string; reason: string }[];
  now: string;
}

const monday = (date: Date) => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
};
const isoDay = (value: Date | string) => (typeof value === "string" ? value.slice(0, 10) : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`);

/** Menu dont on prépare les courses : le plus récent des semaines à venir ou de la semaine passée. */
async function currentMenu(db: Kysely<DB>, accountId: string, now: Date) {
  const since = monday(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));
  return db
    .selectFrom("meal_menus")
    .selectAll()
    .where("account_id", "=", accountId)
    .where("week_start", ">=", isoDay(since) as never)
    .orderBy("week_start", "desc")
    .limit(1)
    .executeTakeFirst();
}

export async function addedLinesOf(db: Kysely<DB>, accountId: string, userId: string): Promise<AddedLine[]> {
  const rows = await db
    .selectFrom("grocery_list_items as i")
    .leftJoin("users as u", "u.id", "i.added_by_user_id")
    .select(["i.name_key", "i.label", "i.quantity", "i.not_bought_last_time", "i.added_by_user_id", "i.state", "u.first_name"])
    .where("i.account_id", "=", accountId)
    .where("i.source", "=", "added")
    .where("i.state", "in", ["preparing", "added_after_validation"])
    .orderBy("i.created_at")
    .execute();
  return rows.map((r) => ({
    key: r.name_key,
    name: r.label,
    by: r.first_name ?? "",
    qty: r.quantity,
    notBoughtLastTime: r.not_bought_last_time,
    mine: r.added_by_user_id === userId,
    late: r.state === "added_after_validation",
  }));
}

/** L'écran de préparation de la liste. */
export async function prepareList(ctx: Ctx, session: SessionContext): Promise<ListPrepared> {
  const who = await requireAccess(ctx, session, "list");
  const added = await addedLinesOf(ctx.db, who.accountId, who.userId);
  if (who.access === "list") {
    return { access: "list", menu: null, validated: false, model: null, modes: {}, stores: [], sharing: false, householdSize: null, added, excluded: [], criteria: [], now: ctx.now.toISOString() };
  }
  const settings = await loadSettings(ctx.db, who.accountId);
  const menu = await currentMenu(ctx.db, who.accountId, ctx.now);
  const stores = settings.stores;
  const base = { access: who.access, stores, sharing: settings.sharePrices, householdSize: settings.householdSize, added, now: ctx.now.toISOString() };
  if (!menu) return { ...base, menu: null, validated: false, model: null, modes: {}, excluded: [], criteria: [] };

  const [data, refs, history, entries, rows, criteria, list] = await Promise.all([
    loadEngineData(ctx.db, who.accountId, settings, { all: true }),
    loadReferences(ctx.db),
    loadHistory(ctx.db, who.accountId),
    ctx.db.selectFrom("meal_menu_entries").select(["kind", "slot", "dish_name", "dish_id", "household_dish_id"]).where("menu_id", "=", menu.id).orderBy("kind").orderBy("slot").execute(),
    ctx.db
      .selectFrom("grocery_list_items as i")
      .leftJoin("users as u", "u.id", "i.added_by_user_id")
      .select(["i.label", "i.quantity", "i.source", "i.not_bought_last_time", "u.first_name"])
      .where("i.account_id", "=", who.accountId)
      .where("i.state", "in", ["preparing", "validated", "added_after_validation"])
      .orderBy("i.created_at")
      .execute(),
    ctx.db.selectFrom("grocery_additive_criteria").select(["label", "reason"]).where("is_active", "=", true).orderBy("label").execute(),
    ctx.db.selectFrom("grocery_lists").select("id").where("account_id", "=", who.accountId).where("menu_id", "=", menu.id).executeTakeFirst(),
  ]);
  const common = settings.sharePrices ? await loadCommonPrices(ctx.db, who.userId) : [];
  // les produits cochés « acheté » en magasin rejoignent l'historique, sans prix tant qu'aucun ticket ne l'a donné (CR-28)
  const boughtItems = await ctx.db
    .selectFrom("grocery_list_items")
    .select(["label", "bought_at"])
    .where("account_id", "=", who.accountId)
    .where("state", "=", "bought")
    .where("bought_at", ">=", new Date(ctx.now.getFullYear(), ctx.now.getMonth() - 3, ctx.now.getDate()))
    .execute();
  const pricedNames = new Set(history.map((h) => norm(h.product)));
  for (const b of boughtItems) if (b.bought_at && !pricedNames.has(norm(b.label))) history.push({ product: b.label, ref: b.label, unitPrice: null, store: "", date: isoDay(b.bought_at) });

  const byId = new Map(data.dishes.map((d) => [d.id, d]));
  const codeOf = (e: { dish_id: string | null; household_dish_id: string | null }) => {
    if (e.household_dish_id) return `H:${e.household_dish_id}`;
    if (!e.dish_id) return null;
    for (const [code, ref] of data.refs) if (ref.kind === "catalog" && ref.dishId === String(e.dish_id)) return code;
    return null;
  };
  const dinners = entries.filter((e) => e.kind === "dinner");
  const menuDishes = dinners.map(codeOf).filter((c): c is string => !!c).map((c) => byId.get(c)).filter((d): d is Dish => !!d);
  const unique = [...new Map(menuDishes.map((d) => [d.id, d])).values()];

  const light = await loadLightVersions(
    ctx.db,
    unique.flatMap((d) => (data.refs.get(d.id)?.kind === "catalog" ? [{ dishId: data.refs.get(d.id)!.dishId, code: d.id }] : [])),
  );
  const prods = buildRefProducts(refs.rows);
  const buy: BuyRow[] = rows.map((r) => ({ name: r.label, qty: r.quantity, by: r.first_name ?? "", source: r.source === "menu" ? "menu" : "manuel", status: "à acheter", notBoughtLastTime: r.not_bought_last_time }));
  const model = buildListModel({ dishes: unique, prods, buy, history, light, stores: [...new Set(stores.map((s) => s.chain))], sharing: settings.sharePrices, common, now: ctx.now });

  const choices = await ctx.db.selectFrom("meal_light_choices").select(["dish_id", "choice"]).where("account_id", "=", who.accountId).execute();
  const choiceOf = new Map(choices.map((c) => [String(c.dish_id), c.choice]));
  const modes: Record<string, DishMode> = {};
  for (const d of unique) {
    const ref = data.refs.get(d.id);
    if (ref?.kind === "catalog" && choiceOf.get(ref.dishId) === "light") modes[d.name] = "light";
  }

  const inList = new Set(model.items.map((i) => norm(i.name)));
  const excluded = refs.excluded.filter((e) => inList.has(norm(e.product)) || model.items.some((i) => norm(i.name).includes(norm(e.product))));

  const times = new Map(dinners.map((e) => [e.slot, codeOf(e)]));
  const sessionTheme = menu.batch_week_id ? (await ctx.db.selectFrom("meal_batch_weeks").select("theme").where("id", "=", menu.batch_week_id).executeTakeFirst())?.theme ?? "" : "";
  const summary: MenuSummary = {
    week: isoDay(menu.week_start as Date | string),
    weekLabel: weekLabel(isoDay(menu.week_start as Date | string)),
    days: dinners.map((e, i) => ({ day: DAYS[i] ?? "", name: e.dish_name, time: fmtMin(byId.get(times.get(e.slot) ?? "")?.minutes ?? 0) })),
    session: { label: menu.session_minutes ? fmtMin(menu.session_minutes) : "", theme: sessionTheme, estimated: menu.session_is_estimated },
    express: entries.filter((e) => e.kind === "express").map((e) => ({ name: e.dish_name, time: fmtMin(byId.get(codeOf(e) ?? "")?.minutes ?? 0) })),
  };
  return { ...base, menu: summary, validated: !!list, model: toDto(model), modes, excluded, criteria };
}

/**
 * À la validation d'un menu : les produits non achetés de la liste précédente reviennent en préparation (« pas acheté la dernière fois », CR-28), les ingrédients du
 * menu remplacent ceux du menu précédent, et les produits sans référence conforme sont notés pour l'administration, sans foyer (US-173). `repeat` : le menu de cette semaine
 * est validé de nouveau, il ne compte pas deux fois.
 */
export async function seedListFromMenu(trx: Kysely<DB>, accountId: string, userId: string, dishes: Dish[], options: { repeat: boolean }): Promise<number> {
  const refs = await loadReferences(trx);
  const prods = buildRefProducts(refs.rows);
  await sql`select grocery_carry_over_unbought(${accountId}::uuid)`.execute(trx);
  await trx.deleteFrom("grocery_list_items").where("account_id", "=", accountId).where("state", "=", "preparing").where("source", "=", "menu").execute();
  const names: string[] = [];
  const seen = new Set<string>();
  for (const d of dishes) {
    const { found, free } = dishItems(d, prods);
    for (const n of [...found, ...free]) {
      const key = nameKey(n);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      names.push(n);
    }
  }
  const open = new Set((await trx.selectFrom("grocery_list_items").select("name_key").where("account_id", "=", accountId).where("state", "<>", "bought").execute()).map((r) => r.name_key));
  const fresh = names.filter((n) => !open.has(nameKey(n)));
  if (!fresh.length) return 0;
  const products = await trx.selectFrom("grocery_products").select(["id", "name_key", "aisle_id"]).where("name_key", "in", fresh.map(nameKey)).execute();
  const byKey = new Map(products.map((p) => [p.name_key, p]));
  await trx
    .insertInto("grocery_list_items")
    .values(
      fresh.map((n) => {
        const p = byKey.get(nameKey(n));
        return { account_id: accountId, state: "preparing" as const, source: "menu", label: n.slice(0, 120), name_key: nameKey(n).slice(0, 120), product_id: p?.id ?? null, aisle_id: p?.aisle_id ?? null, added_by_user_id: userId };
      }),
    )
    .execute();
  if (!options.repeat) {
    for (const n of fresh) {
      if (gapType(prods, n) === null) continue;
      const p = byKey.get(nameKey(n));
      await sql`select note_grocery_unreferenced(${accountId}::uuid, ${n}, ${p ? "no_reference" : "unknown"}::grocery_unreferenced_kind, 'menu'::grocery_unreferenced_source, ${p?.aisle_id ?? null}::integer)`.execute(trx);
    }
  }
  return fresh.length;
}

/** Ajoute un produit à la liste : quantité augmentée si un produit de ce nom (ou commençant par la saisie) y est déjà. */
export async function addProduct(ctx: Ctx, session: SessionContext, input: { name: string }): Promise<{ duplicate: { name: string; quantity: number } | null; added: AddedLine[] }> {
  const who = await requireAccess(ctx, session, "list");
  const label = input.name.trim().replace(/\s+/g, " ");
  if (!label || label.length > 120) throw courseError("invalid_name", "Indiquez le nom du produit (120 caractères au plus).", 422);
  const key = nameKey(label);
  let duplicate: { name: string; quantity: number } | null = null;
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      const open = await trx
        .selectFrom("grocery_list_items")
        .select(["id", "label", "name_key", "quantity"])
        .where("account_id", "=", who.accountId)
        .where("state", "<>", "bought")
        .orderBy("created_at")
        .execute();
      const same = open.find((r) => r.name_key === key) ?? open.find((r) => r.name_key.startsWith(key));
      if (same) {
        const quantity = Math.min(same.quantity + 1, 99);
        await trx.updateTable("grocery_list_items").set({ quantity, updated_at: ctx.now }).where("id", "=", same.id).execute();
        duplicate = { name: same.label, quantity };
        return;
      }
      // une liste déjà validée pour le menu en cours : le produit est « ajouté depuis la validation », sans magasin ni prix (CR-28)
      const menu = await currentMenu(trx, who.accountId, ctx.now);
      const list = menu ? await trx.selectFrom("grocery_lists").select("id").where("account_id", "=", who.accountId).where("menu_id", "=", menu.id).executeTakeFirst() : undefined;
      const product = await trx.selectFrom("grocery_products").select(["id", "aisle_id"]).where("name_key", "=", key).executeTakeFirst();
      await trx
        .insertInto("grocery_list_items")
        .values({
          account_id: who.accountId,
          state: list ? "added_after_validation" : "preparing",
          list_id: list?.id ?? null,
          source: "added",
          label,
          name_key: key.slice(0, 120),
          product_id: product?.id ?? null,
          aisle_id: product?.aisle_id ?? null,
          added_by_user_id: who.userId,
        })
        .execute();
      if (!product) await sql`select note_grocery_unreferenced(${who.accountId}::uuid, ${label}, 'unknown'::grocery_unreferenced_kind, 'list'::grocery_unreferenced_source)`.execute(trx);
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return { duplicate, added: await addedLinesOf(ctx.db, who.accountId, who.userId) };
}

/** Retire un produit ajouté : un invité secondaire retire les siens, le couple retire ceux qu'il veut. Les ingrédients du menu ne se retirent pas ici. */
export async function removeProduct(ctx: Ctx, session: SessionContext, key: string): Promise<AddedLine[]> {
  const who = await requireAccess(ctx, session, "list");
  await asProfile(ctx.db, who.userId, async (trx) => {
    let q = trx.deleteFrom("grocery_list_items").where("account_id", "=", who.accountId).where("name_key", "=", key).where("source", "=", "added").where("state", "in", ["preparing", "added_after_validation"]);
    if (who.access === "list") q = q.where("added_by_user_id", "=", who.userId);
    await q.execute();
  });
  return addedLinesOf(ctx.db, who.accountId, who.userId);
}

/** Retient la version standard ou allégée de chaque plat, reprise au menu suivant (US-157 RF9). `modes` : nom du plat → version. */
export async function saveLightChoices(ctx: Ctx, session: SessionContext, modes: Record<string, DishMode>): Promise<void> {
  const who = await requireAccess(ctx, session, "couple");
  const settings = await loadSettings(ctx.db, who.accountId);
  const data = await loadEngineData(ctx.db, who.accountId, settings, { all: true });
  const dishes = data.dishes.filter((d) => modes[d.name] && data.refs.get(d.id)?.kind === "catalog");
  if (!dishes.length) return;
  await asProfile(ctx.db, who.userId, async (trx) => {
    for (const d of dishes) {
      const choice = modes[d.name] === "light" ? "light" : "standard";
      await trx
        .insertInto("meal_light_choices")
        .values({ account_id: who.accountId, dish_id: data.refs.get(d.id)!.dishId, choice, updated_at: ctx.now })
        .onConflict((oc) => oc.columns(["account_id", "dish_id"]).doUpdateSet({ choice, updated_at: ctx.now }))
        .execute();
    }
  });
}

export interface ValidateLine {
  name: string;
  qty: number;
  store: string | null;
  ref: string | null;
  price: number | null;
  /** D'où vient le produit : menu, ajouté, historique (pour une ligne qui n'existe pas encore en base). */
  source: "menu" | "added" | "habit";
}

/** Valide le scénario choisi : chaque produit retenu prend son magasin, sa référence et son prix estimé ; la liste passe dans « Ma liste de courses ». */
export async function validateList(ctx: Ctx, session: SessionContext, input: { scenario: 1 | 2 | 3; lines: ValidateLine[] }): Promise<{ listId: string; count: number }> {
  const who = await requireAccess(ctx, session, "couple");
  if (!input.lines.length || input.lines.length > 400) throw courseError("invalid_list", "La liste est vide ou trop longue.", 422);
  const menu = await currentMenu(ctx.db, who.accountId, ctx.now);
  if (!menu) throw courseError("no_menu", "Validez d'abord le menu de la semaine.", 409);
  let result = { listId: "", count: 0 };
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      const list = await trx
        .insertInto("grocery_lists")
        .values({ account_id: who.accountId, menu_id: menu.id, scenario: input.scenario, validated_at: ctx.now, validated_by_user_id: who.userId })
        .returning("id")
        .executeTakeFirstOrThrow();
      const open = await trx.selectFrom("grocery_list_items").select(["id", "name_key"]).where("account_id", "=", who.accountId).where("state", "<>", "bought").execute();
      const openId = new Map(open.map((r) => [r.name_key, r.id]));
      const done = new Set<string>();
      for (const line of input.lines) {
        const key = nameKey(line.name).slice(0, 120);
        if (!key || done.has(key)) continue;
        done.add(key);
        const store = line.store && line.price !== null ? placeKey(line.store).slice(0, 80) : null;
        const price = store && line.price !== null && line.price > 0 && line.price <= 10000 ? Number(line.price.toFixed(2)) : null;
        const fields = { state: "validated" as const, list_id: list.id, quantity: Math.min(Math.max(Math.round(line.qty) || 1, 1), 99), store_chain: price === null ? null : store, reference_name: price === null ? null : (line.ref ?? "").slice(0, 160) || null, unit_price: price === null ? null : String(price), updated_at: ctx.now };
        const id = openId.get(key);
        if (id) {
          await trx.updateTable("grocery_list_items").set(fields).where("id", "=", id).execute();
        } else {
          const product = await trx.selectFrom("grocery_products").select(["id", "aisle_id"]).where("name_key", "=", key).executeTakeFirst();
          await trx
            .insertInto("grocery_list_items")
            .values({ account_id: who.accountId, source: line.source, label: line.name.trim().slice(0, 120), name_key: key, product_id: product?.id ?? null, aisle_id: product?.aisle_id ?? null, added_by_user_id: who.userId, ...fields })
            .execute();
        }
      }
      await trx.deleteFrom("grocery_lists").where("account_id", "=", who.accountId).where("menu_id", "=", menu.id).where("id", "<>", list.id).where((eb) => eb.not(eb.exists(eb.selectFrom("grocery_list_items").select("id").whereRef("list_id", "=", "grocery_lists.id")))).execute();
      result = { listId: list.id, count: done.size };
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return result;
}

export type { References };
