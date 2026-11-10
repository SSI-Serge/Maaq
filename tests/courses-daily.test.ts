import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { nameKey } from "@/server/courses/catalog/seed";
import { loadObject, runAction, type ConsoleContext } from "@/server/courses/console";
import { computeScenarios, scenarioLines } from "@/server/courses/engine";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { deleteWeekMenu } from "@/server/courses/list/delete";
import { fromDto } from "@/server/courses/list/dto";
import { myList, setBought } from "@/server/courses/list/mine";
import { addProduct, prepareList, validateList } from "@/server/courses/list/service";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { createProfile, testDb } from "./helpers/fixtures";
import { validateTestMenu } from "./helpers/menu";

/** CR-66, CR-67 (US-157 RF3 et RF3ter, US-169 RF3) : « Produits de mon historique » sans les ingrédients des repas, complétée par « Pensez aussi à : » ; console « Produits du quotidien » et son seuil. */
const db = testDb();
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const W0 = "2026-11-02";
const at = (): Ctx => ({ db, now: NOW });
const q = { q: "", filters: {} };
let c: ConsoleContext;
let aisles: { id: number; name: string }[];
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error("aucun refus");
};

const groupNames = (list: Awaited<ReturnType<typeof prepareList>>, group: string) => list.model!.items.filter((i) => i.group === group).map((i) => i.name);
const setThreshold = (value: number) => db.updateTable("platform_settings").set({ value_text: String(value) }).where("setting_key", "=", "grocery_history_min_products").execute();

async function household(): Promise<CoupleFamily> {
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((x) => x.id), stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }] });
  await validateTestMenu(db, f, { picks: ["F4"], week: W0, now: NOW });
  return f;
}

async function validateAll(f: CoupleFamily, added: string[]) {
  const list = await prepareList(at(), f.sophie, W0);
  const model = fromDto(list.model!);
  // les produits cochés entrent dans les scénarios
  const checked = Object.fromEntries(added.map((n) => [model.items.find((i) => i.name === n)!.id, true]));
  const sel = { checked: new Map(Object.entries(checked).map(([k, v]) => [Number(k), v])) };
  const scenario = computeScenarios(model, sel, list.stores.map((s) => s.chain))[0];
  const lines = scenarioLines(model, sel, scenario).map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, source: (added.includes(l.name) ? "added" : "menu") as "added" | "menu" }));
  await validateList(at(), f.sophie, { scenario: 1, lines, week: W0 });
  return lines;
}

beforeAll(async () => {
  await ensureCatalog(db);
  const admin = await createProfile(db, { role: "admin" });
  c = { ctx: { db, now: new Date() }, adminId: admin.id };
  aisles = await db.selectFrom("grocery_aisles").select(["id", "name"]).orderBy("sort_order").orderBy("id").limit(2).execute();
  await db.deleteFrom("grocery_daily_products").execute();
  await setThreshold(10);
});

afterAll(async () => {
  await db.deleteFrom("grocery_daily_products").execute();
  await setThreshold(10);
});

describe("Console « Produits du quotidien » (US-169 RF3, CA 3.1)", () => {
  it("ajouter, relier à un produit du catalogue, modifier, retirer et proposer de nouveau ; le seuil se règle sur la même page, dans ses bornes ; tout est au journal", async () => {
    const empty = await loadObject(c, "quotidien", q);
    expect(empty.title).toBe("Produits du quotidien");
    expect(empty.rows[0]).toMatchObject({ id: "seuil", cells: { position: 10 } });
    expect(empty.rows).toHaveLength(1);

    await runAction(c, "quotidien", "add", "", { name: "Liquide vaisselle", aisle: String(aisles[0].id), product: "", position: "1" });
    await runAction(c, "quotidien", "add", "", { name: "Essuie-tout", aisle: String(aisles[0].id), product: "", position: "2" });
    const product = await db.selectFrom("grocery_products").select(["name", "name_key"]).orderBy("id").executeTakeFirstOrThrow();
    await runAction(c, "quotidien", "add", "", { name: "Mon produit relié", aisle: String(aisles[1].id), product: product.name, position: "1" });
    const rows = (await loadObject(c, "quotidien", q)).rows.slice(1);
    expect(rows.map((r) => r.cells.name)).toEqual(expect.arrayContaining(["Liquide vaisselle", "Essuie-tout", "Mon produit relié"]));
    expect(rows.find((r) => r.cells.name === "Mon produit relié")!.cells.product).toBe(product.name);
    expect(rows.find((r) => r.cells.name === "Liquide vaisselle")!.cells).toMatchObject({ aisle: aisles[0].name, product: "—", state: "Proposé" });
    // la clé est celle de l'application (tiret réduit à un espace)
    expect((await db.selectFrom("grocery_daily_products").select("name_key").where("name", "=", "Essuie-tout").executeTakeFirstOrThrow()).name_key).toBe("essuie tout");

    expect((await rejection(runAction(c, "quotidien", "add", "", { name: "liquide  vaisselle", aisle: String(aisles[0].id), product: "", position: "3" }))).code).toBe("duplicate");
    expect((await rejection(runAction(c, "quotidien", "add", "", { name: "Autre", aisle: String(aisles[0].id), product: "Produit qui n'existe pas", position: "3" }))).code).toBe("unknown_product");
    expect((await rejection(runAction(c, "quotidien", "add", "", { name: "", aisle: String(aisles[0].id), product: "", position: "3" }))).code).toBe("missing_field");

    const row = rows.find((r) => r.cells.name === "Essuie-tout")!;
    await runAction(c, "quotidien", "edit", row.id, { name: "Essuie-tout", aisle: String(aisles[1].id), product: "", position: "5" });
    expect((await loadObject(c, "quotidien", q)).rows.find((r) => r.id === row.id)!.cells).toMatchObject({ aisle: aisles[1].name, position: 5 });
    await runAction(c, "quotidien", "retire", row.id, {});
    expect((await loadObject(c, "quotidien", q)).rows.find((r) => r.id === row.id)!.cells.state).toBe("Retiré");
    // l'ajouter de nouveau le fait revenir, sans doublon
    await runAction(c, "quotidien", "add", "", { name: "Essuie-tout", aisle: String(aisles[0].id), product: "", position: "2" });
    const back = (await loadObject(c, "quotidien", q)).rows.filter((r) => r.cells.name === "Essuie-tout");
    expect(back).toHaveLength(1);
    expect(back[0].cells.state).toBe("Proposé");
    await runAction(c, "quotidien", "retire", row.id, {});
    await runAction(c, "quotidien", "restore", row.id, {});

    // seuil : de 1 à 50
    await runAction(c, "quotidien", "threshold", "seuil", { value: "4" });
    expect((await loadObject(c, "quotidien", q)).rows[0].cells.position).toBe(4);
    await expect(runAction(c, "quotidien", "threshold", "seuil", { value: "0" })).rejects.toBeTruthy();
    await expect(runAction(c, "quotidien", "threshold", "seuil", { value: "51" })).rejects.toBeTruthy();
    expect((await loadObject(c, "quotidien", q)).rows[0].cells.position).toBe(4);
    await runAction(c, "quotidien", "threshold", "seuil", { value: "10" });

    const log = await db.selectFrom("admin_audit_log").select("id").where("action_type", "=", "daily_product_changed").where("admin_user_id", "=", c.adminId).execute();
    expect(log.length).toBeGreaterThanOrEqual(6);
    expect((await rejection(runAction(c, "quotidien", "retire", "999999", {}))).code).toBe("not_found");
  });
});

describe("« Pensez aussi à : » dans « Produits de mon historique » (US-157 RF3ter, CA 3.2 à 3.4)", () => {
  it("sous le seuil, les produits du quotidien sont proposés par rayon, décochés, sans doublon avec le menu, les produits ajoutés et l'historique ; un produit retiré n'est pas proposé ; au-dessus du seuil, rien", async () => {
    const f = await household();
    const list = await prepareList(at(), f.sophie, W0);
    const daily = list.model!.items.filter((i) => i.group === "quotidien");
    expect(daily.map((i) => i.name)).toEqual(expect.arrayContaining(["Liquide vaisselle", "Essuie-tout"]));
    // le produit relié au catalogue : écarté si ce produit du catalogue est déjà dans le menu, sinon proposé avec le prix du produit relié
    const linked = await db.selectFrom("grocery_daily_products as d").innerJoin("grocery_products as p", "p.id", "d.product_id").select("p.name").where("d.name", "=", "Mon produit relié").executeTakeFirstOrThrow();
    const inMenu = list.model!.items.some((i) => i.group !== "quotidien" && i.name === linked.name);
    expect(daily.some((i) => i.name === "Mon produit relié")).toBe(!inMenu);
    expect(daily.every((i) => !i.checked)).toBe(true);
    expect(daily.find((i) => i.name === "Liquide vaisselle")!.rayon).toBe(aisles[0].name);
    // sans produit du catalogue relié : aucun prix
    expect(daily.find((i) => i.name === "Liquide vaisselle")!.choices).toEqual([]);

    // un produit ajouté à la main n'est pas proposé une deuxième fois
    await addProduct(at(), f.sophie, { name: "Liquide vaisselle", week: W0 });
    const afterAdd = await prepareList(at(), f.sophie, W0);
    expect(groupNames(afterAdd, "quotidien")).not.toContain("Liquide vaisselle");
    expect(groupNames(afterAdd, "ajout")).toContain("Liquide vaisselle");

    // un produit du quotidien qui est un ingrédient du menu affiché n'est pas proposé
    const ingredient = groupNames(afterAdd, "menu")[0];
    await runAction(c, "quotidien", "add", "", { name: ingredient, aisle: String(aisles[0].id), product: "", position: "9" });
    expect(groupNames(await prepareList(at(), f.sophie, W0), "quotidien")).not.toContain(ingredient);

    // retiré en console : plus proposé
    const row = (await loadObject(c, "quotidien", q)).rows.find((r) => r.cells.name === "Essuie-tout")!;
    await runAction(c, "quotidien", "retire", row.id, {});
    expect(groupNames(await prepareList(at(), f.sophie, W0), "quotidien")).not.toContain("Essuie-tout");
    await runAction(c, "quotidien", "restore", row.id, {});

    // seuil à 1 : le foyer n'a aucun produit dans l'historique, la rubrique est encore complétée ; avec un produit acheté en plus des repas, elle ne l'est plus
    await setThreshold(1);
    expect(groupNames(await prepareList(at(), f.sophie, W0), "quotidien").length).toBeGreaterThan(0);
    await validateAll(f, []);
    await setBought(at(), f.sophie, { key: nameKey("Liquide vaisselle"), bought: true, late: false, week: W0 });
    const full = await prepareList(at(), f.sophie, W0);
    expect(groupNames(full, "habituel")).toEqual(["Liquide vaisselle"]);
    expect(groupNames(full, "quotidien")).toEqual([]);
    await setThreshold(10);
    // de nouveau sous le seuil : la rubrique est complétée, sans le produit déjà dans l'historique
    const again = await prepareList(at(), f.sophie, W0);
    expect(groupNames(again, "quotidien")).toContain("Essuie-tout");
    expect(groupNames(again, "quotidien")).not.toContain("Liquide vaisselle");
  });

  it("un produit du quotidien coché entre dans les scénarios et dans Ma liste comme un produit ajouté, dans son rayon ; une fois acheté, il rejoint l'historique", async () => {
    const f = await household();
    const lines = await validateAll(f, ["Essuie-tout"]);
    expect(lines.find((l) => l.name === "Essuie-tout")).toMatchObject({ source: "added", price: null });
    const item = await db.selectFrom("grocery_list_items").select(["source", "state", "aisle_id"]).where("account_id", "=", f.accountId).where("name_key", "=", "essuie tout").executeTakeFirstOrThrow();
    const expected = await db.selectFrom("grocery_daily_products").select("aisle_id").where("name_key", "=", "essuie tout").executeTakeFirstOrThrow();
    expect(item).toMatchObject({ source: "added", state: "validated", aisle_id: expected.aisle_id });
    const mine = await myList(at(), f.sophie, W0);
    expect(mine.stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).some((l) => l.key === "essuie tout")).toBe(true);

    await setBought(at(), f.sophie, { key: "essuie tout", bought: true, late: false, week: W0 });
    const after = await prepareList(at(), f.sophie, W0);
    expect(groupNames(after, "habituel")).toContain("Essuie-tout");
    expect(groupNames(after, "quotidien")).not.toContain("Essuie-tout");
  });
});

describe("Historique sans les ingrédients des repas (US-157 RF3, CR-66)", () => {
  it("un produit acheté (ticket) écarté parce qu'il est ingrédient d'un menu revient dans l'historique quand on supprime le menu qui l'utilisait", async () => {
    const f = await household();
    const menuNames = groupNames(await prepareList(at(), f.sophie, W0), "menu");
    // une autre semaine a un menu : on choisit un ingrédient qui n'est que dans le menu de la première semaine
    const other = "2026-11-09";
    await validateTestMenu(db, f, { picks: ["A14"], week: other, now: NOW });
    const otherNames = new Set(groupNames(await prepareList(at(), f.sophie, other), "menu"));
    const ingredient = menuNames.find((n) => !otherNames.has(n))!;
    expect(ingredient).toBeDefined();
    // il figure sur un ticket du foyer
    const product = await db.selectFrom("grocery_products").select(["id", "aisle_id"]).where("name_key", "=", nameKey(ingredient)).executeTakeFirst();
    const aisle = product?.aisle_id ?? aisles[0].id;
    const receipt = await db.insertInto("grocery_receipts").values({ account_id: f.accountId, store_chain: "lidl", purchased_on: "2026-11-03" as never, total_amount: "5.20", recorded_by_user_id: f.userIds.sophie }).returning("id").executeTakeFirstOrThrow();
    await db
      .insertInto("grocery_receipt_lines")
      .values([
        { receipt_id: receipt.id, account_id: f.accountId, position: 1, label: ingredient, name_key: nameKey(ingredient), line_total: "3.20", aisle_id: aisle, product_id: (product?.id ?? null) as never },
        { receipt_id: receipt.id, account_id: f.accountId, position: 2, label: "Café moulu", name_key: "cafe moulu", line_total: "2.00", aisle_id: aisle },
      ])
      .execute();

    // tant que le menu existe : l'achat en plus des repas est proposé, l'ingrédient non (même vu depuis l'autre semaine)
    const before = await prepareList(at(), f.sophie, other);
    expect(groupNames(before, "habituel")).toContain("Café moulu");
    expect(groupNames(before, "habituel")).not.toContain(ingredient);

    // le menu qui l'utilisait est supprimé : le produit revient dans l'historique
    await deleteWeekMenu(at(), f.sophie, W0);
    const after = await prepareList(at(), f.sophie, other);
    expect(groupNames(after, "habituel")).toContain(ingredient);
    expect(groupNames(after, "habituel")).toContain("Café moulu");
  });
});
