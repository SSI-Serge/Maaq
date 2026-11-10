import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ListFlow } from "@/components/courses/ListScreen";
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
  it("ajouter (tous les rayons proposés), renommer, relier et délier, ranger avec ↑ et ↓, retirer et proposer de nouveau ; le seuil se règle sur la même page, dans ses bornes ; tout est au journal", async () => {
    const empty = await loadObject(c, "quotidien", q);
    expect(empty.title).toBe("Produits du quotidien");
    expect(empty.rows).toHaveLength(1);
    expect(empty.rows[0]).toMatchObject({ id: "seuil", cells: { name: "Compléter l'historique d'un foyer quand il compte moins de 10 produits" } });
    // l'ajout propose tous les rayons de la console
    const all = await db.selectFrom("grocery_aisles").select("id").execute();
    expect(empty.tools.add!.fields.find((x) => x.key === "aisle")!.options).toHaveLength(all.length);

    const product = await db.selectFrom("grocery_products").select(["name", "name_key"]).orderBy("id").executeTakeFirstOrThrow();
    await runAction(c, "quotidien", "add", "", { name: "Liquide vaisselle", aisle: String(aisles[0].id) });
    await runAction(c, "quotidien", "add", "", { name: "Essuie-tout", aisle: String(aisles[0].id) });
    await runAction(c, "quotidien", "add", "", { name: "Mon produit relié", aisle: String(aisles[1].id) });
    const row = async (name: string) => (await loadObject(c, "quotidien", q)).rows.find((r) => r.cells.name === name)!;
    const order = async () => (await loadObject(c, "quotidien", q)).rows.filter((r) => r.cells.aisle === aisles[0].name && r.cells.state === "Proposé").map((r) => r.cells.name);
    expect(await order()).toEqual(["Liquide vaisselle", "Essuie-tout"]);
    expect((await row("Liquide vaisselle")).cells).toMatchObject({ aisle: aisles[0].name, link: "Non relié : affiché N/A, hors total", state: "Proposé" });
    // la clé est celle de l'application (tiret réduit à un espace)
    expect((await db.selectFrom("grocery_daily_products").select("name_key").where("name", "=", "Essuie-tout").executeTakeFirstOrThrow()).name_key).toBe("essuie tout");

    // relier par le nom exact d'un produit du catalogue, puis délier
    const linked = await row("Mon produit relié");
    expect((await rejection(runAction(c, "quotidien", "link", linked.id, { product: "Produit qui n'existe pas" }))).code).toBe("unknown_product");
    await runAction(c, "quotidien", "link", linked.id, { product: product.name });
    expect((await row("Mon produit relié")).cells.link).toBe(`Relié : ${product.name}`);
    expect((await row("Mon produit relié")).actions!.map((a) => a.key)).toContain("unlink");
    await runAction(c, "quotidien", "unlink", linked.id, {});
    expect((await row("Mon produit relié")).cells.link).toBe("Non relié : affiché N/A, hors total");
    await runAction(c, "quotidien", "link", linked.id, { product: product.name });
    // un produit ajouté dont le nom est celui d'un produit du catalogue est relié d'office
    await runAction(c, "quotidien", "add", "", { name: product.name, aisle: String(aisles[1].id) });
    expect((await row(product.name)).cells.link).toBe(`Relié : ${product.name}`);
    await db.deleteFrom("grocery_daily_products").where("name", "=", product.name).execute();

    expect((await rejection(runAction(c, "quotidien", "add", "", { name: "liquide  vaisselle", aisle: String(aisles[0].id) }))).code).toBe("duplicate");
    expect((await rejection(runAction(c, "quotidien", "add", "", { name: "", aisle: String(aisles[0].id) }))).code).toBe("missing_field");

    // ↑ et ↓
    const essuie = await row("Essuie-tout");
    await runAction(c, "quotidien", "up", essuie.id, {});
    expect(await order()).toEqual(["Essuie-tout", "Liquide vaisselle"]);
    await runAction(c, "quotidien", "up", essuie.id, {});
    expect(await order()).toEqual(["Essuie-tout", "Liquide vaisselle"]);
    await runAction(c, "quotidien", "down", essuie.id, {});
    expect(await order()).toEqual(["Liquide vaisselle", "Essuie-tout"]);

    // renommer, retirer, proposer de nouveau
    await runAction(c, "quotidien", "rename", essuie.id, { name: "Essuie tout XL" });
    expect((await db.selectFrom("grocery_daily_products").select("name_key").where("id", "=", Number(essuie.id)).executeTakeFirstOrThrow()).name_key).toBe("essuie tout xl");
    await runAction(c, "quotidien", "rename", essuie.id, { name: "Essuie-tout" });
    await runAction(c, "quotidien", "retire", essuie.id, {});
    expect((await row("Essuie-tout")).cells.state).toBe("Retiré");
    expect((await row("Essuie-tout")).actions!.map((a) => a.key)).toEqual(["restore"]);
    // l'ajouter de nouveau le fait revenir, sans doublon
    await runAction(c, "quotidien", "add", "", { name: "Essuie-tout", aisle: String(aisles[0].id) });
    expect((await loadObject(c, "quotidien", q)).rows.filter((r) => r.cells.name === "Essuie-tout")).toHaveLength(1);
    expect((await row("Essuie-tout")).cells.state).toBe("Proposé");
    await runAction(c, "quotidien", "retire", essuie.id, {});
    await runAction(c, "quotidien", "restore", essuie.id, {});

    // seuil : de 1 à 50
    await runAction(c, "quotidien", "threshold", "seuil", { value: "4" });
    expect((await loadObject(c, "quotidien", q)).rows[0].cells.name).toContain("moins de 4 produits");
    await expect(runAction(c, "quotidien", "threshold", "seuil", { value: "0" })).rejects.toBeTruthy();
    await expect(runAction(c, "quotidien", "threshold", "seuil", { value: "51" })).rejects.toBeTruthy();
    expect((await loadObject(c, "quotidien", q)).rows[0].cells.name).toContain("moins de 4 produits");
    await runAction(c, "quotidien", "threshold", "seuil", { value: "10" });

    const log = await db.selectFrom("admin_audit_log").select("id").where("action_type", "=", "daily_product_changed").where("admin_user_id", "=", c.adminId).execute();
    expect(log.length).toBeGreaterThanOrEqual(10);
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

    // à l'écran (maquette v77) : l'introduction, le bloc sous l'historique, par rayon, « N/A · hors total » sans produit relié
    const markup = renderToStaticMarkup(createElement(ListFlow, { list, reload: () => {}, onWeek: () => {}, onGroup: () => {} }));
    const rubric = markup.slice(markup.indexOf("Produits de mon historique"), markup.indexOf("Ingrédients / additifs exclus"));
    expect(rubric).toContain("Achetés ces 3 derniers mois, en plus des repas.");
    expect(rubric).toContain("Votre historique est encore court. Pensez aussi à :");
    expect(rubric).toContain("Des produits courants, décochés : cochez ceux qu&#x27;il vous faut.");
    expect(rubric.indexOf(aisles[0].name)).toBeGreaterThan(rubric.indexOf("Pensez aussi à :"));
    expect(rubric).toContain("Liquide vaisselle");
    expect(rubric).toContain("N/A · hors total");
    expect(rubric).not.toContain('checked=""');

    // un produit ajouté à la main n'est pas proposé une deuxième fois
    await addProduct(at(), f.sophie, { name: "Liquide vaisselle", week: W0 });
    const afterAdd = await prepareList(at(), f.sophie, W0);
    expect(groupNames(afterAdd, "quotidien")).not.toContain("Liquide vaisselle");
    expect(groupNames(afterAdd, "ajout")).toContain("Liquide vaisselle");

    // un produit du quotidien qui est un ingrédient du menu affiché n'est pas proposé
    const ingredient = groupNames(afterAdd, "menu")[0];
    await runAction(c, "quotidien", "add", "", { name: ingredient, aisle: String(aisles[0].id) });
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
    expect(renderToStaticMarkup(createElement(ListFlow, { list: full, reload: () => {}, onWeek: () => {}, onGroup: () => {} }))).not.toContain("Pensez aussi à :");
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
