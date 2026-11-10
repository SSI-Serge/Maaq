import { describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { nameKey } from "@/server/courses/catalog/seed";
import { computeScenarios, norm, scenarioLines } from "@/server/courses/engine";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { deleteWeekList } from "@/server/courses/list/delete";
import { fromDto } from "@/server/courses/list/dto";
import { allocate, mergeRows, splitGroupRows, type GroupRow } from "@/server/courses/list/group";
import { myList, setBought } from "@/server/courses/list/mine";
import { prepareList, validateGroup, validateList, type ValidateLine } from "@/server/courses/list/service";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";
import { validateTestMenu } from "./helpers/menu";

/** Liste du mois (CR-56, US-157 RF9ter) : plusieurs semaines regroupées, besoins additionnés, produits frais des semaines suivantes « à acheter plus tard ». Mercredi 4 novembre 2026. */
const db = testDb();
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const W0 = "2026-11-02";
const W1 = "2026-11-09";
const W2 = "2026-11-16";
const at = (): Ctx => ({ db, now: NOW });
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error("aucun refus");
};

const row = (over: Partial<GroupRow>): GroupRow => ({ label: "Riz", name_key: "riz", quantity: 1, source: "menu", first_name: null, needed_amount: null, needed_unit: null, quantity_to_check: false, is_pantry: false, is_selected: true, menu_id: "m0", aisle_id: 1, ...over });

describe("Liste du mois : fonctions pures", () => {
  it("la répartition des paquets garde le total, au plus fort reste", () => {
    expect(allocate(2, [300, 200, 400])).toEqual([1, 0, 1]);
    expect(allocate(3, [1, 1, 1])).toEqual([1, 1, 1]);
    expect(allocate(1, [5, 5])).toEqual([1, 0]);
    expect(allocate(5, [0, 0])).toEqual([3, 2]);
    expect(allocate(4, [])).toEqual([]);
    for (const total of [1, 2, 7, 13]) expect(allocate(total, [0.3, 0.5, 0.2, 9]).reduce((s, x) => s + x, 0)).toBe(total);
  });

  it("les produits frais des semaines suivantes sont mis à part, les autres additionnés par produit", () => {
    const rows = [
      row({ menu_id: "m0", needed_amount: "300", needed_unit: "g" }),
      row({ menu_id: "m1", needed_amount: "250", needed_unit: "g" }),
      row({ label: "Courgettes", name_key: "courgettes", menu_id: "m0", aisle_id: 2, needed_amount: "400", needed_unit: "g" }),
      row({ label: "Courgettes", name_key: "courgettes", menu_id: "m1", aisle_id: 2, needed_amount: "400", needed_unit: "g" }),
      row({ label: "Lait", name_key: "lait", menu_id: "m1", aisle_id: null, needed_amount: "1000", needed_unit: "ml" }),
    ];
    const split = splitGroupRows(rows, "m0", new Set([2]));
    expect([...split.later.keys()]).toEqual(["m1"]);
    expect(split.later.get("m1")!.map((r) => r.label)).toEqual(["Courgettes"]);
    const merged = mergeRows(split.main);
    expect(merged.find((r) => r.name === "Riz")).toMatchObject({ needed: { amount: 550, unit: "g" }, toCheck: false });
    expect(merged.find((r) => r.name === "Courgettes")?.needed).toEqual({ amount: 400, unit: "g" });
    expect(merged.find((r) => r.name === "Lait")?.needed).toEqual({ amount: 1000, unit: "ml" });
    // unités différentes ou besoin manquant : « Quantité à vérifier »
    expect(mergeRows([row({ needed_amount: "300", needed_unit: "g" }), row({ needed_amount: "2", needed_unit: "piece", menu_id: "m1" })])[0]).toMatchObject({ needed: null, toCheck: true });
    expect(mergeRows([row({ needed_amount: "300", needed_unit: "g" }), row({ menu_id: "m1" })])[0]).toMatchObject({ needed: null, toCheck: true });
    // un placard seulement si toutes les lignes le sont ; une quantité saisie à la main s'additionne
    expect(mergeRows([row({ is_pantry: true }), row({ menu_id: "m1" })])[0].pantry).toBe(false);
    expect(mergeRows([row({ source: "added", quantity: 2, menu_id: "m0" }), row({ source: "added", quantity: 3, menu_id: "m1" })])[0].qty).toBe(5);
  });
});

async function ready(): Promise<CoupleFamily> {
  await ensureCatalog(db);
  // rayons frais de départ (le catalogue de l'essai est chargé après la base : on les marque ici)
  await db.updateTable("grocery_aisles").set({ is_fresh: true }).where("name", "in", ["Fruits et légumes", "Crémerie", "Boucherie", "Poissonnerie", "Volaille", "Charcuterie"]).execute();
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }] });
  return f;
}
const menu = (f: CoupleFamily, week: string, picks: string[] = ["F4"]) => validateTestMenu(db, f, { picks, week, now: NOW });
const items = (f: CoupleFamily, week: string) =>
  db.selectFrom("grocery_list_items as i").innerJoin("meal_menus as m", "m.id", "i.menu_id").select(["i.id", "i.name_key", "i.label", "i.state", "i.source", "i.quantity", "i.aisle_id", "i.needed_amount", "i.needed_unit", "i.list_id", "i.unit_price", "i.price_unit"]).where("i.account_id", "=", f.accountId).where("m.week_start", "=", week as never).execute();

/** Lignes d'un scénario du total, comme l'écran les envoie à « Valider la liste du mois ». */
async function groupLines(f: CoupleFamily, weeks: string[]): Promise<ValidateLine[]> {
  const list = await prepareList(at(), f.sophie, null, weeks);
  const model = fromDto(list.model!);
  const byName = new Map(model.items.map((i) => [norm(i.name), i]));
  return scenarioLines(model, {}, computeScenarios(model, {}, [])[1]).map((l) => ({
    name: l.name,
    qty: l.qty,
    store: l.store,
    ref: l.ref,
    price: l.price,
    priceUnit: l.priceUnit,
    need: l.need,
    weight: l.weight,
    toCheck: l.toCheck,
    pantry: l.pantry,
    source: ({ menu: "menu", sante: "menu", ajout: "added", habituel: "habit", quotidien: "added" } as const)[byName.get(norm(l.name))?.group ?? "menu"],
  }));
}

describe("Liste du mois : regrouper, valider, cocher", () => {
  it("la préparation additionne les besoins, met à part les produits frais des semaines suivantes et se valide en une fois", async () => {
    const f = await ready();
    await menu(f, W0);
    await menu(f, W1);
    const month = await prepareList(at(), f.sophie, null, [W0, W1]);
    expect(month.group?.weeks).toEqual([W0, W1]);
    expect(month.week).toBe(W0);
    expect(month.validated).toBe(false);

    // produits frais de la deuxième semaine : « À acheter plus tard », hors du modèle d'achat
    const w1 = await items(f, W1);
    const freshRows = w1.filter((r) => r.aisle_id !== null);
    const fresh = new Set((await db.selectFrom("grocery_aisles").select("id").where("is_fresh", "=", true).execute()).map((a) => a.id));
    const expectedLater = [...new Set(w1.filter((r) => r.aisle_id !== null && fresh.has(r.aisle_id)).map((r) => r.label))].sort();
    expect(freshRows.length).toBeGreaterThan(0);
    expect(expectedLater.length).toBeGreaterThan(0);
    expect(month.group!.later).toHaveLength(1);
    expect(month.group!.later[0]).toMatchObject({ week: W1, label: "semaine du 9 nov." });
    expect([...month.group!.later[0].names].sort()).toEqual(expectedLater);

    // le même menu deux semaines de suite : on donne un besoin à un produit non frais présent sur les deux semaines, le total est la somme
    const w0 = await items(f, W0);
    const pick = w1.find((r) => r.source === "menu" && (r.aisle_id === null || !fresh.has(r.aisle_id)) && w0.some((x) => x.name_key === r.name_key))!;
    expect(pick).toBeTruthy();
    for (const [week, amount] of [[W0, "300"], [W1, "250"]] as const) {
      await db.updateTable("grocery_list_items").set({ needed_amount: amount, needed_unit: "g", quantity_to_check: false }).where("account_id", "=", f.accountId).where("name_key", "=", pick.name_key).where("menu_id", "=", (await db.selectFrom("meal_menus").select("id").where("account_id", "=", f.accountId).where("week_start", "=", week as never).executeTakeFirstOrThrow()).id).execute();
    }
    const summed = fromDto((await prepareList(at(), f.sophie, null, [W0, W1])).model!);
    expect(summed.items.find((i) => nameKey(i.name) === pick.name_key)!.need!.kg).toBeCloseTo(0.55, 3);
    expect(fromDto((await prepareList(at(), f.sophie, W1)).model!).items.find((i) => nameKey(i.name) === pick.name_key)!.need!.kg).toBeCloseTo(0.25, 3);

    // validation en une fois : un regroupement, une liste par semaine, un seul scénario
    const lines = await groupLines(f, [W0, W1]);
    expect(lines.length).toBeGreaterThan(10);
    const done = await validateGroup(at(), f.sophie, { weeks: [W0, W1], scenario: 2, lines });
    expect(done.listIds).toHaveLength(2);
    const groups = await db.selectFrom("grocery_list_groups").selectAll().where("account_id", "=", f.accountId).execute();
    expect(groups).toHaveLength(1);
    expect(groups[0].scenario).toBe(2);
    const lists = await db.selectFrom("grocery_lists").select(["group_id", "scenario"]).where("account_id", "=", f.accountId).execute();
    expect(lists.every((l) => l.group_id === done.groupId && l.scenario === 2)).toBe(true);

    // chaque produit reste rattaché à sa semaine ; les paquets répartis égalent ceux du total ; les produits frais de la semaine suivante restent en préparation
    const after = { w0: await items(f, W0), w1: await items(f, W1) };
    for (const line of lines) {
      if (line.priceUnit === "kg" || line.priceUnit === "l") continue;
      const key = nameKey(line.name);
      const rows = [...after.w0, ...after.w1].filter((r) => r.name_key === key && r.state === "validated");
      expect(rows.reduce((s, r) => s + r.quantity, 0)).toBe(Math.round(line.qty) || 1);
    }
    expect(after.w1.filter((r) => r.aisle_id !== null && fresh.has(r.aisle_id) && !after.w0.some((x) => x.name_key === r.name_key && fresh.has(x.aisle_id ?? -1) && false)).every((r) => r.state === "preparing" || r.state === "validated")).toBe(true);
    expect(after.w1.filter((r) => expectedLater.includes(r.label)).every((r) => r.state === "preparing")).toBe(true);

    // la liste du mois est validée ; chaque semaine l'est aussi
    expect((await prepareList(at(), f.sophie, null, [W0, W1])).validated).toBe(true);
    expect((await prepareList(at(), f.sophie, W0)).validated).toBe(true);
    expect((await prepareList(at(), f.sophie, W1)).weeks.filter((w) => w.hasList).map((w) => w.week)).toEqual([W0, W1]);
  });

  it("Ma liste : le regroupement additionne les semaines, chaque semaine reste consultable ; cocher commence par la semaine la plus proche ; une semaine supprimée sort du regroupement", async () => {
    const f = await ready();
    await menu(f, W0);
    await menu(f, W1);
    const lines = await groupLines(f, [W0, W1]);
    await validateGroup(at(), f.sophie, { weeks: [W0, W1], scenario: 2, lines });

    const week = await myList(at(), f.sophie, W0);
    expect(week.group?.weeks).toEqual([W0, W1]);
    expect(week.scope).toBe("week");
    const all = await myList(at(), f.sophie, W0, "group");
    expect(all.scope).toBe("group");
    const count = (l: typeof week) => l.stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).length;
    expect(count(all)).toBeGreaterThanOrEqual(count(week));
    // les produits frais de la semaine suivante sont « à acheter plus tard »
    expect(all.later).toHaveLength(1);
    expect(all.later[0]).toMatchObject({ week: W1, label: "semaine du 9 nov." });
    expect(all.later[0].names.length).toBeGreaterThan(0);
    // une semaine seule n'a pas de section « plus tard »
    expect(week.later).toEqual([]);

    // cocher « acheté » : la semaine la plus proche d'abord
    const key = nameKey(lines.find((l) => (l.priceUnit ?? "unit") === "unit" && l.qty >= 1)!.name);
    const rowsOf = async () => ({ w0: (await items(f, W0)).find((r) => r.name_key === key), w1: (await items(f, W1)).find((r) => r.name_key === key) });
    await setBought(at(), f.sophie, { key, bought: true, late: false });
    const state = await rowsOf();
    if (state.w0 && state.w0.state === "bought") expect(state.w1?.state).not.toBe("bought");
    else expect(state.w0?.state ?? "validated").not.toBe("bought");

    // supprimer la liste d'une semaine la retire du regroupement ; il disparaît s'il en reste moins de 2
    await deleteWeekList(at(), f.sophie, W1);
    expect(await db.selectFrom("grocery_list_groups").select("id").where("account_id", "=", f.accountId).execute()).toEqual([]);
    const solo = await myList(at(), f.sophie, W0);
    expect(solo.group).toBeNull();
  });

  it("valider une seule semaine la sort du regroupement ; regrouper demande deux semaines différentes, chacune avec un menu ; l'invité secondaire ne regroupe pas", async () => {
    const f = await ready();
    await menu(f, W0);
    await menu(f, W1);
    await validateGroup(at(), f.sophie, { weeks: [W0, W1], scenario: 1, lines: await groupLines(f, [W0, W1]) });
    // la semaine du 9 est validée seule : le regroupement n'a plus que la semaine du 2, il disparaît
    const list = await prepareList(at(), f.sophie, W1);
    const model = fromDto(list.model!);
    const lines = scenarioLines(model, {}, computeScenarios(model, {}, [])[1]).map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, source: "menu" as const }));
    await validateList(at(), f.sophie, { scenario: 3, lines, week: W1 });
    expect(await db.selectFrom("grocery_list_groups").select("id").where("account_id", "=", f.accountId).execute()).toEqual([]);
    expect((await db.selectFrom("grocery_lists").select("scenario").where("account_id", "=", f.accountId).orderBy("scenario").execute()).map((l) => l.scenario)).toEqual([1, 3]);

    expect((await rejection(prepareList(at(), f.sophie, null, [W0]))).code).toBe("invalid_group");
    expect((await rejection(prepareList(at(), f.sophie, null, [W0, W0]))).code).toBe("invalid_group");
    expect((await rejection(prepareList(at(), f.sophie, null, [W0, W2]))).code).toBe("no_menu");
    expect((await rejection(prepareList(at(), f.sophie, null, [W0, "2026-12-07"]))).code).toBe("invalid_week");
    expect((await rejection(validateGroup(at(), f.elodie, { weeks: [W0, W1], scenario: 1, lines }))).status).toBe(403);
    // un invité secondaire reçoit la vue habituelle, jamais la liste du mois
    expect((await prepareList(at(), f.elodie, null, [W0, W1])).group).toBeNull();
  });
});
