import { sql, type Kysely } from "kysely";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { nameKey, placeKey } from "../catalog/seed";
import { buildListModel, buildRefProducts, computeScenarios, DAYS, dishItems, fmtMin, gapType, norm, type BuyRow, type Dish, type DishMode } from "../engine";
import { courseError, loadSettings, requireAccess, translateCourseError, type CourseAccess } from "../household/settings";
import { loadEngineData } from "../menu/data";
import { weekLabel } from "../menu/weeks";
import { aiDishId, loadAiDishes, loadEntryIngredients, loadMenuEntries, loadSession, recipeSteps, type SessionView } from "../menu-ia/entries";
import { groupMenusOf, groupOfMenu, leftoversFor, listOfMenu, pickMenu, weekChoices, weekStartLabel, type Leftover, type WeekChoice, type WeekMenu } from "./weeks";
import { allocate, mergeRows, splitGroupRows, toBuyRow, type GroupRow } from "./group";
import { loadCommonPrices, loadHistory, loadLightVersions, loadReferences, type References } from "./data";
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
  /** Pense-bête « Pas encore acheté » : semaine de la liste d'origine (« semaine du 9 nov. ») ; vide pour un produit de cette semaine (CR-55). */
  leftoverOf: string | null;
  /** Semaine (lundi) du produit ajouté, pour le retirer dans une liste du mois qui en regroupe plusieurs (CR-56). */
  week?: string | null;
}

export interface MenuSummary {
  week: string;
  weekLabel: string;
  days: { day: string; name: string; time: string }[];
  session: { label: string; theme: string; estimated: boolean; overCap: boolean };
  express: { name: string; time: string }[];
  /** Recette de chaque dîner et plat express (pour 4 personnes) : ingrédients et étapes ; vide si la recette n'est pas renseignée (CR-46). */
  recipes: { name: string; kind: "dinner" | "express"; day: string; time: string; ingredients: { label: string; quantity: number | null; unit: string | null }[]; steps: string[] }[];
  /** Nombre de personnes pour lequel les recettes et les quantités sont écrites (« Pour 6 personnes ») ; vide pour un menu validé avant CR-49. */
  servings: number | null;
  /** Déroulé de la séance et conservation (CR-47). */
  batch: SessionView;
  /** Le menu n'a pas de déroulé et l'IA peut le rédiger : « Rédiger le déroulé » est proposé (CR-57, couple seulement, MENU_IA ouvert). */
  canWriteSteps: boolean;
}

export interface ListPrepared {
  access: CourseAccess;
  menu: MenuSummary | null;
  /** Semaine affichée (lundi) et les deux semaines proposées ; une seule semaine affichée si l'autre n'a ni menu ni liste (CR-54). */
  week: string | null;
  weeks: WeekChoice[];
  /** Une liste est déjà validée pour ce menu. */
  validated: boolean;
  /** Liste du mois (CR-56) : semaines regroupées et produits frais des semaines suivantes « À acheter plus tard » ; vide pour la liste d'une semaine. */
  group: null | { weeks: string[]; later: { week: string; label: string; names: string[]; subtotal: number | null }[] };
  model: ListModelDto | null;
  /** Version choisie par plat (nom du plat → version), reprise de la dernière fois. */
  modes: Record<string, DishMode>;
  stores: { chain: string; city: string }[];
  sharing: boolean;
  householdSize: number | null;
  added: AddedLine[];
  /** Additifs exclus par MAAQ : les critères actifs de la console, les mêmes pour tous les foyers (CR-65). */
  criteria: { label: string; reason: string }[];
  now: string;
}

const isoDay = (value: Date | string) => (typeof value === "string" ? value.slice(0, 10) : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`);

/**
 * Produits ajoutés à la main de la semaine affichée (CR-54) et, avec `leftovers`, pense-bêtes « Pas encore acheté (semaine du …) » de la liste précédente, décochés (CR-55).
 * Sans menu, ce sont les ajouts faits avant tout menu : le premier menu validé les reprend.
 */
export async function addedLinesOf(db: Kysely<DB>, accountId: string, userId: string, menuId: string | null, leftovers: Leftover[] = [], week: string | null = null): Promise<AddedLine[]> {
  let q = db
    .selectFrom("grocery_list_items as i")
    .leftJoin("users as u", "u.id", "i.added_by_user_id")
    .select(["i.name_key", "i.label", "i.quantity", "i.added_by_user_id", "i.state", "u.first_name"])
    .where("i.account_id", "=", accountId)
    .where("i.source", "=", "added")
    .where("i.state", "in", ["preparing", "added_after_validation"]);
  q = menuId ? q.where("i.menu_id", "=", menuId) : q.where("i.menu_id", "is", null);
  const rows = await q.orderBy("i.created_at").execute();
  const lines: AddedLine[] = rows.map((r) => ({
    key: r.name_key,
    name: r.label,
    by: r.first_name ?? "",
    qty: r.quantity,
    notBoughtLastTime: false,
    mine: r.added_by_user_id === userId,
    late: r.state === "added_after_validation",
    leftoverOf: null,
    week,
  }));
  for (const l of leftovers) lines.push({ key: l.nameKey, name: l.label, by: "", qty: l.quantity, notBoughtLastTime: false, mine: false, late: false, leftoverOf: `semaine du ${weekStartLabel(l.originWeek)}` });
  return lines;
}

/** L'écran de préparation de la liste. */
export async function prepareList(ctx: Ctx, session: SessionContext, requestedWeek?: string | null, groupWeeks?: string[] | null): Promise<ListPrepared> {
  const who = await requireAccess(ctx, session, "list");
  // liste du mois : plusieurs semaines regroupées (couple seulement) ; la première sert de semaine affichée
  const groupMenus: WeekMenu[] | null = who.access === "couple" && groupWeeks && groupWeeks.length ? await groupMenusOf(ctx.db, who.accountId, groupWeeks, ctx.now) : null;
  const menu = groupMenus ? groupMenus[0] : await pickMenu(ctx.db, who.accountId, ctx.now, requestedWeek);
  const weeks = await weekChoices(ctx.db, who.accountId, ctx.now);
  const leftovers = menu ? await leftoversFor(ctx.db, who.userId, menu.id) : [];
  const added = await addedLinesOf(ctx.db, who.accountId, who.userId, menu?.id ?? null, who.access === "couple" ? leftovers : [], menu?.week_start ?? null);
  if (groupMenus) {
    for (const m of groupMenus.slice(1)) {
      for (const a of await addedLinesOf(ctx.db, who.accountId, who.userId, m.id, [], m.week_start)) if (!added.some((x) => !x.leftoverOf && x.key === a.key)) added.push(a);
    }
  }
  const week = menu?.week_start ?? null;
  if (who.access === "list") {
    return { access: "list", menu: null, week, weeks, validated: false, group: null, model: null, modes: {}, stores: [], sharing: false, householdSize: null, added, criteria: [], now: ctx.now.toISOString() };
  }
  const settings = await loadSettings(ctx.db, who.accountId);
  const stores = settings.stores;
  const base = { access: who.access, stores, sharing: settings.sharePrices, householdSize: settings.householdSize, added, week, weeks, now: ctx.now.toISOString() };
  if (!menu) return { ...base, menu: null, validated: false, group: null, model: null, modes: {}, criteria: [] };
  const menus = groupMenus ?? [menu];

  const [data, refs, history, entries, rows, criteria, list] = await Promise.all([
    loadEngineData(ctx.db, who.accountId, settings, { all: true }),
    loadReferences(ctx.db),
    loadHistory(ctx.db, who.accountId),
    loadMenuEntries(ctx.db, menu.id),
    ctx.db
      .selectFrom("grocery_list_items as i")
      .leftJoin("users as u", "u.id", "i.added_by_user_id")
      .select(["i.label", "i.name_key", "i.quantity", "i.source", "u.first_name", "i.needed_amount", "i.needed_unit", "i.quantity_to_check", "i.is_pantry", "i.is_selected", "i.menu_id", "i.aisle_id"])
      .where("i.account_id", "=", who.accountId)
      .where("i.menu_id", "in", menus.map((m) => m.id))
      .where("i.state", "in", ["preparing", "validated", "added_after_validation"])
      .orderBy("i.created_at")
      .execute(),
    ctx.db.selectFrom("grocery_additive_criteria").select(["label", "reason"]).where("is_active", "=", true).orderBy("label").execute(),
    listOfMenu(ctx.db, who.accountId, menu.id),
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
  // liste du mois : les plats de toutes les semaines regroupées entrent dans la liste ; le résumé (recettes, séance) reste celui de la première semaine
  const otherEntries = groupMenus ? (await Promise.all(groupMenus.slice(1).map((m) => loadMenuEntries(ctx.db, m.id)))).flat() : [];
  const allEntries = [...entries, ...otherEntries];
  // plats libres du menu (composés par l'IA) : ils entrent dans la liste comme les autres plats, avec leur version allégée
  const aiLoad = await loadAiDishes(ctx.db, allEntries);
  const dishOf = (e: (typeof entries)[number]): Dish | undefined => (e.dish_origin === "ai" ? aiLoad.dishes.get(aiDishId(e.id)) : byId.get(codeOf(e) ?? ""));
  const menuDishes = allEntries.filter((e) => e.kind === "dinner").map(dishOf).filter((d): d is Dish => !!d);
  const unique = [...new Map(menuDishes.map((d) => [d.id, d])).values()];

  const light = await loadLightVersions(
    ctx.db,
    unique.flatMap((d) => (data.refs.get(d.id)?.kind === "catalog" ? [{ dishId: data.refs.get(d.id)!.dishId, code: d.id }] : [])),
  );
  for (const [id, version] of aiLoad.light) if (unique.some((d) => d.id === id)) light.set(id, version);
  const prods = buildRefProducts(refs.rows);
  // liste du mois : les produits frais des semaines suivantes sont mis à part, les autres additionnés par produit (besoins sommés, paquet supérieur sur le total)
  const freshAisles = groupMenus ? new Set((await ctx.db.selectFrom("grocery_aisles").select("id").where("is_fresh", "=", true).execute()).map((a) => a.id)) : new Set<number>();
  const split = groupMenus ? splitGroupRows(rows as GroupRow[], menu.id, freshAisles) : null;
  // quantités du menu (CR-50) : besoin, « Quantité à vérifier », placard décoché
  const buy: BuyRow[] = split ? mergeRows(split.main) : (rows as GroupRow[]).map(toBuyRow);
  // pense-bêtes de la liste précédente (CR-55) : décochés, hors total et scénarios tant qu'ils ne sont pas cochés ; ils restent sur leur liste d'origine
  for (const l of leftovers) {
    buy.push({
      name: l.label,
      qty: l.quantity,
      by: "",
      source: "manuel",
      status: "différé",
      leftoverWeek: l.originWeek,
      needed: l.neededAmount !== null && l.neededUnit ? { amount: l.neededAmount, unit: l.neededUnit } : null,
      toCheck: l.quantityToCheck,
      pantry: l.isPantry,
      selected: false,
    });
  }
  const chains = [...new Set(stores.map((s) => s.chain))];
  const model = buildListModel({ dishes: unique, prods, buy, history, light, stores: chains, sharing: settings.sharePrices, common, now: ctx.now });
  // « À acheter plus tard (semaine du 23 nov.) » : produits frais des semaines suivantes, décochés et hors total, avec leur sous-total estimé
  const laterGroups: NonNullable<ListPrepared["group"]>["later"] = [];
  if (split && groupMenus) {
    for (const m of groupMenus.slice(1)) {
      const laterRows = split.later.get(m.id) ?? [];
      if (!laterRows.length) continue;
      const laterModel = buildListModel({ dishes: [], prods, buy: mergeRows(laterRows), history: [], light: new Map(), stores: chains, sharing: settings.sharePrices, common, now: ctx.now });
      const total = laterModel.items.length ? computeScenarios(laterModel, {}, chains)[1]?.total : null;
      laterGroups.push({ week: m.week_start, label: `semaine du ${weekStartLabel(m.week_start)}`, names: [...new Set(laterRows.map((r) => r.label))], subtotal: total === undefined || total === null || total === 0 ? null : total });
    }
  }

  const choices = await ctx.db.selectFrom("meal_light_choices").select(["dish_id", "choice"]).where("account_id", "=", who.accountId).execute();
  const choiceOf = new Map(choices.map((c) => [String(c.dish_id), c.choice]));
  const modes: Record<string, DishMode> = {};
  for (const d of unique) {
    const ref = data.refs.get(d.id);
    if (ref?.kind === "catalog" && choiceOf.get(ref.dishId) === "light") modes[d.name] = "light";
    if (aiLoad.chosenLight.has(d.name)) modes[d.name] = "light";
  }

  const entryIngredients = await loadEntryIngredients(ctx.db, entries.map((e) => e.id));
  const minutesOf = (e: (typeof entries)[number]) => dishOf(e)?.minutes ?? e.duration_minutes ?? 0;
  const dishNames = new Map(entries.map((e) => [e.id, e.dish_name]));
  const batch = await loadSession(ctx.db, { id: menu.id, batch_week_id: menu.batch_week_id === null ? null : String(menu.batch_week_id) }, dishNames);
  const sessionTheme = menu.batch_week_id ? (await ctx.db.selectFrom("meal_batch_weeks").select("theme").where("id", "=", menu.batch_week_id).executeTakeFirst())?.theme ?? "" : "";
  const summary: MenuSummary = {
    week: isoDay(menu.week_start as Date | string),
    weekLabel: weekLabel(isoDay(menu.week_start as Date | string)),
    days: dinners.map((e, i) => ({ day: DAYS[i] ?? "", name: e.dish_name, time: fmtMin(minutesOf(e)) })),
    session: { label: menu.session_minutes ? fmtMin(menu.session_minutes) : "", theme: sessionTheme, estimated: menu.session_is_estimated, overCap: menu.session_over_cap },
    express: entries.filter((e) => e.kind === "express").map((e) => ({ name: e.dish_name, time: fmtMin(minutesOf(e)) })),
    recipes: entries
      .filter((e) => e.kind === "dinner" || e.kind === "express")
      .map((e) => {
        const dish = dishOf(e);
        return {
          name: e.dish_name,
          kind: e.kind as "dinner" | "express",
          day: e.kind === "dinner" ? (DAYS[e.slot - 1] ?? "") : `Express ${e.slot}`,
          time: fmtMin(minutesOf(e)),
          // menu écrit pour le foyer (CR-49) : ingrédients avec quantités et recette de la ligne de menu ; sinon ceux du plat (menus validés avant)
          ingredients: entryIngredients.get(e.id) ?? (dish?.ing ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((label) => ({ label, quantity: null, unit: null })),
          steps: recipeSteps(e.recipe ?? dish?.recipe ?? ""),
        };
      }),
    servings: menu.servings,
    batch,
    canWriteSteps: who.access === "couple" && env().MENU_IA === "live" && menu.batch_week_id === null && batch.steps.length === 0 && batch.storage.length === 0 && dinners.length >= 2,
  };
  // une liste validée avant la dernière validation du menu est à refaire (CR-45) : la page se rouvre
  let stale = !!list && !!menu.validated_at && list.validated_at < menu.validated_at;
  let validated = !!list && !stale;
  if (groupMenus) {
    // la liste du mois est validée quand toutes ses semaines ont une liste du même regroupement, plus récente que leur menu
    const groups = await Promise.all(groupMenus.map(async (m) => ({ m, list: await listOfMenu(ctx.db, who.accountId, m.id), group: await groupOfMenu(ctx.db, who.accountId, m.id) })));
    validated = groups.every((g) => !!g.list && g.list.validated_at >= g.m.validated_at && g.group?.id === groups[0].group?.id) && !!groups[0].group;
    stale = !validated;
  }
  return { ...base, menu: summary, validated, group: groupMenus ? { weeks: groupMenus.map((m) => m.week_start), later: laterGroups } : null, model: toDto(model), modes, criteria };
}

/**
 * À la validation d'un menu : les produits non achetés de la liste précédente reviennent en préparation (« pas acheté la dernière fois », CR-28), les ingrédients du
 * menu remplacent ceux du menu précédent, et les produits sans référence conforme sont notés pour l'administration, sans foyer (US-173). `repeat` : le menu de cette semaine
 * est validé de nouveau, il ne compte pas deux fois.
 */
export async function seedListFromMenu(trx: Kysely<DB>, accountId: string, userId: string, menuId: string, dishes: Dish[], options: { repeat: boolean }): Promise<number> {
  const refs = await loadReferences(trx);
  const prods = buildRefProducts(refs.rows);
  // les ajouts à la main faits avant tout menu sont repris par le premier menu validé (CR-54)
  await trx.updateTable("grocery_list_items").set({ menu_id: menuId }).where("account_id", "=", accountId).where("menu_id", "is", null).execute();
  // la liste de cette semaine repart du menu : les ingrédients précédents du MÊME menu sont remplacés ; les autres semaines ne sont jamais touchées
  await trx.deleteFrom("grocery_list_items").where("account_id", "=", accountId).where("menu_id", "=", menuId).where("state", "=", "preparing").where("source", "=", "menu").execute();
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
  const open = new Set((await trx.selectFrom("grocery_list_items").select("name_key").where("account_id", "=", accountId).where("menu_id", "=", menuId).where("state", "<>", "bought").execute()).map((r) => r.name_key));
  const fresh = names.filter((n) => !open.has(nameKey(n)));
  if (!fresh.length) return 0;
  const products = await trx.selectFrom("grocery_products").select(["id", "name_key", "aisle_id"]).where("name_key", "in", fresh.map(nameKey)).execute();
  const byKey = new Map(products.map((p) => [p.name_key, p]));
  await trx
    .insertInto("grocery_list_items")
    .values(
      fresh.map((n) => {
        const p = byKey.get(nameKey(n));
        return { account_id: accountId, menu_id: menuId, state: "preparing" as const, source: "menu", label: n.slice(0, 120), name_key: nameKey(n).slice(0, 120), product_id: p?.id ?? null, aisle_id: p?.aisle_id ?? null, added_by_user_id: userId };
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
export async function addProduct(ctx: Ctx, session: SessionContext, input: { name: string; week?: string | null }): Promise<{ duplicate: { name: string; quantity: number } | null; added: AddedLine[] }> {
  const who = await requireAccess(ctx, session, "list");
  const menu = await pickMenu(ctx.db, who.accountId, ctx.now, input.week);
  const label = input.name.trim().replace(/\s+/g, " ");
  if (!label || label.length > 120) throw courseError("invalid_name", "Indiquez le nom du produit (120 caractères au plus).", 422);
  const key = nameKey(label);
  let duplicate: { name: string; quantity: number } | null = null;
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      let openQuery = trx.selectFrom("grocery_list_items").select(["id", "label", "name_key", "quantity"]).where("account_id", "=", who.accountId).where("state", "<>", "bought");
      openQuery = menu ? openQuery.where("menu_id", "=", menu.id) : openQuery.where("menu_id", "is", null);
      const open = await openQuery.orderBy("created_at").execute();
      const same = open.find((r) => r.name_key === key) ?? open.find((r) => r.name_key.startsWith(key));
      if (same) {
        const quantity = Math.min(same.quantity + 1, 99);
        await trx.updateTable("grocery_list_items").set({ quantity, updated_at: ctx.now }).where("id", "=", same.id).execute();
        duplicate = { name: same.label, quantity };
        return;
      }
      // une liste déjà validée pour le menu en cours : le produit est « ajouté depuis la validation », sans magasin ni prix (CR-28)
      const list = menu ? await listOfMenu(trx, who.accountId, menu.id) : null;
      const product = await trx.selectFrom("grocery_products").select(["id", "aisle_id"]).where("name_key", "=", key).executeTakeFirst();
      await trx
        .insertInto("grocery_list_items")
        .values({
          account_id: who.accountId,
          menu_id: menu?.id ?? null,
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
  return { duplicate, added: await addedLinesOf(ctx.db, who.accountId, who.userId, menu?.id ?? null) };
}

/** Retire un produit ajouté : un invité secondaire retire les siens, le couple retire ceux qu'il veut. Les ingrédients du menu ne se retirent pas ici. */
export async function removeProduct(ctx: Ctx, session: SessionContext, key: string, week?: string | null): Promise<AddedLine[]> {
  const who = await requireAccess(ctx, session, "list");
  const menu = await pickMenu(ctx.db, who.accountId, ctx.now, week);
  await asProfile(ctx.db, who.userId, async (trx) => {
    let q = trx.deleteFrom("grocery_list_items").where("account_id", "=", who.accountId).where("name_key", "=", key).where("source", "=", "added").where("state", "in", ["preparing", "added_after_validation"]);
    q = menu ? q.where("menu_id", "=", menu.id) : q.where("menu_id", "is", null);
    if (who.access === "list") q = q.where("added_by_user_id", "=", who.userId);
    await q.execute();
  });
  return addedLinesOf(ctx.db, who.accountId, who.userId, menu?.id ?? null);
}

/** Retient la version standard ou allégée de chaque plat, reprise au menu suivant (US-157 RF9). `modes` : nom du plat → version. */
export async function saveLightChoices(ctx: Ctx, session: SessionContext, modes: Record<string, DishMode>, week?: string | null): Promise<void> {
  const who = await requireAccess(ctx, session, "couple");
  const settings = await loadSettings(ctx.db, who.accountId);
  const data = await loadEngineData(ctx.db, who.accountId, settings, { all: true });
  const dishes = data.dishes.filter((d) => modes[d.name] && data.refs.get(d.id)?.kind === "catalog");
  const menu = await pickMenu(ctx.db, who.accountId, ctx.now, week);
  if (menu) {
    // un plat libre garde son choix dans sa ligne de menu (version proposée par l'IA)
    const entries = await ctx.db.selectFrom("meal_menu_entries").select(["id", "dish_name"]).where("menu_id", "=", menu.id).where("light_by_ai", "=", true).execute();
    await asProfile(ctx.db, who.userId, async (trx) => {
      for (const e of entries) if (modes[e.dish_name]) await trx.updateTable("meal_menu_entries").set({ light_chosen: modes[e.dish_name] === "light" }).where("id", "=", e.id).execute();
    });
  }
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
  /** Unité du prix : par article (défaut), au kilo ou au litre ; un article au kilo n'entre pas dans le total (CR-40). */
  priceUnit?: "unit" | "kg" | "l";
  /** D'où vient le produit : menu, ajouté, historique (pour une ligne qui n'existe pas encore en base). */
  source: "menu" | "added" | "habit";
  /** Besoin du menu (kilos, litres ou pièces) et poids retenu pour un produit au poids : gardés pour afficher « 2 paquets · 900 g pour le menu » (CR-50). */
  need?: { amount: number; unit: "kg" | "l" | "piece" } | null;
  weight?: number | null;
  toCheck?: boolean;
  pantry?: boolean;
}

/** Besoin en kilos, litres ou pièces → grammes, millilitres ou pièces (unités de la base). */
function neededOf(need: ValidateLine["need"], weight: number | null | undefined, priceUnit: string | undefined): { amount: string; unit: "g" | "ml" | "piece" } | null {
  const amount = priceUnit === "kg" || priceUnit === "l" ? (weight ?? (need && need.unit === priceUnit ? need.amount : null)) : (need?.amount ?? null);
  const unit = priceUnit === "kg" || priceUnit === "l" ? priceUnit : (need?.unit ?? null);
  if (amount === null || unit === null || !(amount > 0)) return null;
  const base = unit === "kg" ? { amount: amount * 1000, unit: "g" as const } : unit === "l" ? { amount: amount * 1000, unit: "ml" as const } : { amount, unit: "piece" as const };
  return base.amount < 100_000_000 ? { amount: base.amount.toFixed(3), unit: base.unit } : null;
}

/** Valide le scénario choisi : chaque produit retenu prend son magasin, sa référence et son prix estimé ; la liste passe dans « Ma liste de courses ». */
export async function validateList(ctx: Ctx, session: SessionContext, input: { scenario: 1 | 2 | 3; lines: ValidateLine[]; week?: string | null }): Promise<{ listId: string; count: number }> {
  const who = await requireAccess(ctx, session, "couple");
  if (!input.lines.length || input.lines.length > 400) throw courseError("invalid_list", "La liste est vide ou trop longue.", 422);
  const menu = await pickMenu(ctx.db, who.accountId, ctx.now, input.week);
  if (!menu) throw courseError("no_menu", "Validez d'abord le menu de la semaine.", 409);
  let result = { listId: "", count: 0 };
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      // une seule liste par menu (CR-54) : revalider la remet à jour, sans créer de seconde liste
      const existing = await listOfMenu(trx, who.accountId, menu.id);
      const list = existing
        ? await trx.updateTable("grocery_lists").set({ scenario: input.scenario, validated_at: ctx.now, validated_by_user_id: who.userId, group_id: null }).where("id", "=", existing.id).returning("id").executeTakeFirstOrThrow()
        : await trx
            .insertInto("grocery_lists")
            .values({ account_id: who.accountId, menu_id: menu.id, scenario: input.scenario, validated_at: ctx.now, validated_by_user_id: who.userId })
            .returning("id")
            .executeTakeFirstOrThrow();
      // les produits ouverts de CETTE semaine seulement ; un pense-bête de la semaine d'avant, coché, arrive ici comme une ligne ordinaire et devient un produit de la nouvelle semaine (CR-55)
      const open = await trx.selectFrom("grocery_list_items").select(["id", "name_key"]).where("account_id", "=", who.accountId).where("menu_id", "=", menu.id).where("state", "<>", "bought").execute();
      const openId = new Map(open.map((r) => [r.name_key, r.id]));
      const done = new Set<string>();
      for (const line of input.lines) {
        const key = nameKey(line.name).slice(0, 120);
        if (!key || done.has(key)) continue;
        done.add(key);
        const store = line.store && line.price !== null ? placeKey(line.store).slice(0, 80) : null;
        const price = store && line.price !== null && line.price > 0 && line.price <= 10000 ? Number(line.price.toFixed(2)) : null;
        const fields = { state: "validated" as const, list_id: list.id, quantity: Math.min(Math.max(Math.round(line.qty) || 1, 1), 99), store_chain: price === null ? null : store, reference_name: price === null ? null : (line.ref ?? "").slice(0, 160) || null, unit_price: price === null ? null : String(price), price_unit: price === null ? null : (line.priceUnit ?? "unit"), updated_at: ctx.now, ...(line.source === "menu" ? (() => { const n = neededOf(line.need, line.weight, line.priceUnit); return { needed_amount: n?.amount ?? null, needed_unit: n?.unit ?? null, quantity_to_check: !!line.toCheck, is_pantry: !!line.pantry, is_selected: true }; })() : {}) };
        const id = openId.get(key);
        if (id) {
          await trx.updateTable("grocery_list_items").set(fields).where("id", "=", id).execute();
        } else {
          const product = await trx.selectFrom("grocery_products").select(["id", "aisle_id"]).where("name_key", "=", key).executeTakeFirst();
          await trx
            .insertInto("grocery_list_items")
            .values({ account_id: who.accountId, menu_id: menu.id, source: line.source, label: line.name.trim().slice(0, 120), name_key: key, product_id: product?.id ?? null, aisle_id: product?.aisle_id ?? null, added_by_user_id: who.userId, ...fields })
            .execute();
        }
      }
      result = { listId: list.id, count: done.size };
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return result;
}

/**
 * « Valider la liste du mois » (CR-56, US-157 RF9ter) : un seul scénario d'achat et une seule date pour toutes les semaines regroupées. Le regroupement se crée d'abord, puis les listes de chaque
 * semaine lui sont rattachées. Chaque produit reste rattaché à sa semaine : les paquets du total sont répartis entre les semaines au prorata de leur besoin (une semaine qui n'en reçoit aucun perd la
 * ligne, couverte par les paquets d'une autre), un produit au poids répartit son poids de la même façon. Les produits frais des semaines suivantes restent « à acheter plus tard » : en préparation.
 */
export async function validateGroup(ctx: Ctx, session: SessionContext, input: { weeks: string[]; scenario: 1 | 2 | 3; lines: ValidateLine[] }): Promise<{ groupId: string; listIds: string[]; count: number }> {
  const who = await requireAccess(ctx, session, "couple");
  if (!input.lines.length || input.lines.length > 400) throw courseError("invalid_list", "La liste est vide ou trop longue.", 422);
  const menus = await groupMenusOf(ctx.db, who.accountId, input.weeks, ctx.now);
  const first = menus[0];
  const order = new Map(menus.map((m, i) => [m.id, i]));
  const fresh = new Set((await ctx.db.selectFrom("grocery_aisles").select("id").where("is_fresh", "=", true).execute()).map((a) => a.id));
  let result = { groupId: "", listIds: [] as string[], count: 0 };
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      const group = await trx.insertInto("grocery_list_groups").values({ account_id: who.accountId, scenario: input.scenario, validated_at: ctx.now, validated_by_user_id: who.userId }).returning("id").executeTakeFirstOrThrow();
      const listOf = new Map<string, string>();
      for (const m of menus) {
        const existing = await listOfMenu(trx, who.accountId, m.id);
        const list = existing
          ? await trx.updateTable("grocery_lists").set({ scenario: input.scenario, validated_at: ctx.now, validated_by_user_id: who.userId, group_id: group.id }).where("id", "=", existing.id).returning("id").executeTakeFirstOrThrow()
          : await trx.insertInto("grocery_lists").values({ account_id: who.accountId, menu_id: m.id, group_id: group.id, scenario: input.scenario, validated_at: ctx.now, validated_by_user_id: who.userId }).returning("id").executeTakeFirstOrThrow();
        listOf.set(m.id, list.id);
      }
      const open = await trx
        .selectFrom("grocery_list_items")
        .select(["id", "name_key", "quantity", "source", "needed_amount", "needed_unit", "menu_id", "aisle_id"])
        .where("account_id", "=", who.accountId)
        .where("menu_id", "in", menus.map((m) => m.id))
        .where("state", "<>", "bought")
        .execute();
      // les produits frais des semaines suivantes restent à acheter plus tard : ils ne sont pas validés ici
      const counted = open.filter((r) => !(r.menu_id !== first.id && r.aisle_id !== null && fresh.has(r.aisle_id)));
      const byKey = new Map<string, typeof counted>();
      for (const r of counted) byKey.set(r.name_key, [...(byKey.get(r.name_key) ?? []), r]);
      const done = new Set<string>();
      for (const line of input.lines) {
        const key = nameKey(line.name).slice(0, 120);
        if (!key || done.has(key)) continue;
        done.add(key);
        const store = line.store && line.price !== null ? placeKey(line.store).slice(0, 80) : null;
        const price = store && line.price !== null && line.price > 0 && line.price <= 10000 ? Number(line.price.toFixed(2)) : null;
        const priced = {
          store_chain: price === null ? null : store,
          reference_name: price === null ? null : (line.ref ?? "").slice(0, 160) || null,
          unit_price: price === null ? null : String(price),
          price_unit: price === null ? null : (line.priceUnit ?? "unit"),
          updated_at: ctx.now,
        };
        const rows = (byKey.get(key) ?? []).sort((a, b) => (order.get(a.menu_id ?? "") ?? 0) - (order.get(b.menu_id ?? "") ?? 0));
        if (!rows.length) {
          // produit ajouté à la liste du mois (pense-bête coché, historique) : il entre dans la première semaine
          const product = await trx.selectFrom("grocery_products").select(["id", "aisle_id"]).where("name_key", "=", key).executeTakeFirst();
          await trx
            .insertInto("grocery_list_items")
            .values({ account_id: who.accountId, menu_id: first.id, source: line.source, label: line.name.trim().slice(0, 120), name_key: key, product_id: product?.id ?? null, aisle_id: product?.aisle_id ?? null, added_by_user_id: who.userId, state: "validated", list_id: listOf.get(first.id)!, quantity: Math.min(Math.max(Math.round(line.qty) || 1, 1), 99), ...priced })
            .execute();
          continue;
        }
        const weights = rows.map((r) => (r.needed_amount !== null ? Number(r.needed_amount) : r.source === "menu" ? 1 : r.quantity));
        const weighed = line.priceUnit === "kg" || line.priceUnit === "l";
        const wsum = weights.reduce((x, w) => x + w, 0) || rows.length;
        const qtyTotal = Math.min(Math.max(Math.round(line.qty) || 1, 1), 99 * rows.length);
        const quantities = weighed ? rows.map(() => 1) : allocate(qtyTotal, weights);
        for (const [i, r] of rows.entries()) {
          let qty = quantities[i];
          if (qty < 1) {
            // cette semaine n'a besoin d'aucun paquet de plus : ses besoins sont couverts par ceux d'une autre ; un produit ajouté à la main reste
            if (r.source === "added") qty = 1;
            else {
              await trx.deleteFrom("grocery_list_items").where("id", "=", r.id).execute();
              continue;
            }
          }
          const share = (weights[i] || 1) / wsum;
          const menuFields =
            r.source === "menu"
              ? (() => {
                  const own = r.needed_amount !== null && r.needed_unit ? Number(r.needed_amount) : null;
                  const need = own === null || !r.needed_unit ? null : r.needed_unit === "g" ? { amount: own / 1000, unit: "kg" as const } : r.needed_unit === "ml" ? { amount: own / 1000, unit: "l" as const } : { amount: own, unit: "piece" as const };
                  const n = weighed ? neededOf(need, line.weight === null || line.weight === undefined ? null : line.weight * share, line.priceUnit) : null;
                  return { ...(weighed ? { needed_amount: n?.amount ?? null, needed_unit: n?.unit ?? null } : {}), quantity_to_check: !!line.toCheck, is_pantry: !!line.pantry, is_selected: true };
                })()
              : {};
          await trx
            .updateTable("grocery_list_items")
            .set({ state: "validated", list_id: listOf.get(r.menu_id ?? first.id)!, quantity: Math.min(qty, 99), ...priced, ...menuFields })
            .where("id", "=", r.id)
            .execute();
        }
      }
      result = { groupId: group.id, listIds: [...listOf.values()], count: done.size };
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return result;
}

export type { References };
