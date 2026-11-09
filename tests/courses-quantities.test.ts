import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { computeScenarios, emptyNeed, formatQuantity, ingredientText, lineAmount, scenarioLines, type Choice, type ListItem, type ListModel } from "@/server/courses/engine";
import { sendCourseMessage } from "@/server/courses/chat/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { fromDto } from "@/server/courses/list/dto";
import { myList } from "@/server/courses/list/mine";
import { prepareList, validateList } from "@/server/courses/list/service";
import { createDish, dishForm } from "@/server/courses/menu/dishes";
import { menuInput } from "@/server/courses/menu-ia/contract";
import { ingredientsOf } from "@/server/courses/menu-ia/proposal";
import { foldNeed } from "@/server/courses/menu-ia/needs";
import { validateMenuCard } from "@/server/courses/menu-ia/validate";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
process.env.MENU_IA = "live";

const db = testDb();
const NOW = new Date(2026, 10, 6, 10, 0, 0);
const at = (): Ctx => ({ db, now: NOW });

const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 };
const reply = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage, requestId: null });
const callTools = (...calls: { name: string; input: unknown }[]): ModelResponse => ({ content: calls.map((c, i) => ({ type: "tool_use" as const, id: `tu_${i}_${c.name}`, name: c.name, input: c.input })), stopReason: "tool_use", usage, requestId: null });
function scripted(...steps: ModelResponse[]): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  let i = 0;
  return { id: "faux", seen, send: async (request) => (seen.push(structuredClone(request)), steps[Math.min(i++, steps.length - 1)]) };
}

describe("CR-50 : lecture des quantités du menu (pur)", () => {
  it("une quantité hors bornes pour le foyer, sans unité ou sans nombre devient « à vérifier » ; les doublons disparaissent", () => {
    const lines = ingredientsOf(
      [
        { nom: "Blanc de poulet", quantite: 900, unite: "g" },
        { nom: "blanc de poulet", quantite: 100, unite: "g" },
        { nom: "Farine", quantite: 900, unite: "kg" },
        { nom: "Sel", quantite: 1, unite: "pincee" },
        { nom: "Crème", quantite: 20 },
        { nom: "Œufs", unite: "piece" },
        { nom: "Lait", quantite: 25, unite: "cl" },
      ],
      6,
    );
    expect(lines).toEqual([
      { label: "Blanc de poulet", quantity: 900, unit: "g" },
      { label: "Farine", quantity: null, unit: null },
      { label: "Sel", quantity: 1, unit: "pinch" },
      { label: "Crème", quantity: null, unit: null },
      { label: "Œufs", quantity: null, unit: null },
      { label: "Lait", quantity: 25, unit: "cl" },
    ]);
    expect(menuInput.safeParse({ diners: [{ nom: "A", ingredients: [{ nom: "x", quantite: 1, unite: "tasse" }] }] }).success).toBe(false);
    expect(menuInput.safeParse({ diners: [{ nom: "A", ingredients: [{ nom: "x", quantite: -1, unite: "g" }] }] }).success).toBe(false);
    expect(menuInput.safeParse({ diners: [{ nom: "A", ingredients: [{ nom: "x", quantite: 2, unite: "cuillere" }] }] }).success).toBe(true);
  });

  it("textes : « 900 g de blanc de poulet », « 2 œufs », « 1 pincée de sel », « 20 cl d'eau »", () => {
    expect(ingredientText({ label: "blanc de poulet", quantity: 900, unit: "g" })).toBe("900 g de blanc de poulet");
    expect(ingredientText({ label: "œufs", quantity: 2, unit: "piece" })).toBe("2 œufs");
    expect(ingredientText({ label: "sel", quantity: 1, unit: "pinch" })).toBe("1 pincée de sel");
    expect(ingredientText({ label: "eau", quantity: 20, unit: "cl" })).toBe("20 cl d'eau");
    expect(ingredientText({ label: "poivre", quantity: null, unit: null })).toBe("poivre");
    expect(formatQuantity(1.5, "kg")).toBe("1,5 kg");
    expect(formatQuantity(3, "spoon")).toBe("3 cuillères");
    expect(formatQuantity(null, "g")).toBe("");
  });

  it("besoins de la vue : une unité et aucune quantité manquante = besoin exact ; unités mélangées ou quantité manquante = à vérifier ; cuillères seules = placard", () => {
    const row = (base_unit: "g" | "ml" | "piece" | null, total: string | null, needs_check = false, is_pantry = false) => ({ base_unit, total_quantity: total, needs_check, is_pantry });
    expect(foldNeed([row("g", "900")])).toEqual({ amount: 900, unit: "g", toCheck: false, pantry: false });
    expect(foldNeed([row("g", "900"), row("piece", "2")])).toMatchObject({ amount: null, toCheck: true });
    expect(foldNeed([row("g", "900"), row(null, null, true)])).toMatchObject({ amount: null, toCheck: true });
    expect(foldNeed([row(null, null, false, true)])).toEqual({ amount: null, unit: null, toCheck: false, pantry: true });
    expect(foldNeed([row("g", "50", false, true)])).toMatchObject({ amount: 50, pantry: true });
  });
});

describe("CR-50 : quantités dans les scénarios (moteur)", () => {
  const choice = (price: number | null, pkg: Choice["package"], priceUnit: Choice["priceUnit"] = "unit"): Choice => ({ kind: "reference", ref: "r", price, store: "Lidl", city: null, age: "lt6", priceUnit, package: pkg });
  const item = (id: number, over: Partial<ListItem>): ListItem => ({ id, name: `p${id}`, rayon: "Féculents", group: "menu", pour: [], by: "", qty: 1, checked: true, choices: [], storePrices: new Map(), approx: false, notBoughtLastTime: false, need: null, toCheck: false, pantry: false, ...over });
  const need = (over: Partial<ReturnType<typeof emptyNeed>>) => ({ ...emptyNeed(), ...over });

  it("le nombre de paquets suit la référence choisie : 900 g en paquets de 500 g = 2, en paquets de 1 kg = 1 ; une quantité saisie par le foyer l'emporte", () => {
    const pasta = item(1, { need: need({ kg: 0.9 }) });
    expect(lineAmount(pasta, {}, choice(1.2, { amount: 0.5, unit: "kg" }))).toMatchObject({ qty: 2, total: 2.4, toCheck: false });
    expect(lineAmount(pasta, {}, choice(2, { amount: 1, unit: "kg" }))).toMatchObject({ qty: 1, total: 2 });
    expect(lineAmount(pasta, { qty: new Map([[1, 4]]) }, choice(1.2, { amount: 0.5, unit: "kg" }))).toMatchObject({ qty: 4, total: 4.8 });
    expect(lineAmount(pasta, {}, choice(1.2, null))).toMatchObject({ qty: 1, toCheck: true });
    expect(lineAmount(item(2, {}), {}, choice(3, { amount: 1, unit: "kg" }))).toMatchObject({ qty: 1, toCheck: false, total: 3 });
    expect(lineAmount(item(3, { toCheck: true }), {}, choice(3, { amount: 1, unit: "kg" }))).toMatchObject({ qty: 1, toCheck: true });
  });

  it("produit au poids : poids connu × prix au kilo compté dans le total ; poids inconnu : prix au kilo, non totalisé ; le foyer ajuste le poids", () => {
    const leeks = item(1, { need: need({ kg: 1.2 }) });
    const kg = choice(1.89, null, "kg");
    expect(lineAmount(leeks, {}, kg)).toEqual({ qty: 1, weight: 1.2, total: 2.27, toCheck: false });
    expect(lineAmount(leeks, { qty: new Map([[1, 1.4]]) }, kg)).toMatchObject({ weight: 1.4, total: 2.65 });
    const unknown = item(2, {});
    expect(lineAmount(unknown, {}, kg)).toEqual({ qty: 1, weight: null, total: null, toCheck: false });
    // un besoin en pièces ne se convertit pas en poids
    expect(lineAmount(item(3, { need: need({ piece: 4 }) }), {}, kg)).toMatchObject({ weight: null, total: null });
  });

  it("totaux des scénarios : le placard décoché n'entre ni dans les cartes ni dans le total, il y entre une fois coché ; les produits au poids connus comptent", () => {
    const model: ListModel = {
      dishes: [],
      items: [
        item(0, { name: "Pâtes", need: need({ kg: 0.9 }), choices: [choice(1.2, { amount: 0.5, unit: "kg" })], storePrices: new Map([["Lidl", { ref: "r", price: 1.2, package: { amount: 0.5, unit: "kg" } }]]) }),
        item(1, { name: "Poireaux", need: need({ kg: 1.2 }), choices: [choice(1.89, null, "kg")], storePrices: new Map([["Lidl", { ref: "r", price: 1.89, priceUnit: "kg" }]]) }),
        item(2, { name: "Huile d'olive", pantry: true, checked: false, need: null, choices: [choice(4.5, { amount: 1, unit: "l" })], storePrices: new Map([["Lidl", { ref: "r", price: 4.5 }]]) }),
        item(3, { name: "Courge", choices: [choice(1.89, null, "kg")], storePrices: new Map([["Lidl", { ref: "r", price: 1.89, priceUnit: "kg" }]]) }),
      ],
    };
    const before = computeScenarios(model, {}, ["Lidl"]);
    expect(before[0]).toMatchObject({ total: 4.67, notTotaled: 1 });
    expect(before[1]).toMatchObject({ total: 4.67, notTotaled: 1 });
    const lines = scenarioLines(model, {}, before[1]);
    expect(lines.map((l) => [l.name, l.qty, l.lineTotal, l.checked, l.pantry])).toEqual([
      ["Pâtes", 2, 2.4, true, false],
      ["Poireaux", 1, 2.27, true, false],
      ["Courge", 1, null, true, false],
      ["Huile d'olive", 1, 4.5, false, true],
    ]);
    // cochée, l'huile entre dans le total : 4,67 + 4,50
    const after = computeScenarios(model, { checked: new Map([[2, true]]) }, ["Lidl"]);
    expect(after[1].total).toBe(9.17);
    expect(scenarioLines(model, { checked: new Map([[2, true]]) }, after[1]).find((l) => l.name === "Huile d'olive")).toMatchObject({ checked: true, lineTotal: 4.5 });
  });
});

describe("CR-49, CR-50 : du menu à la liste (base)", () => {
  it("recettes et quantités pour le foyer : enregistrées pour tout plat, besoins additionnés par produit, placard décoché, « Quantité à vérifier », paquets selon la référence, Ma liste au poids", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const opts = (await getSettings(at(), f.sophie)).options;
    await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 6, shoppingDays: [6], goals: { time: true }, cuisineIds: opts.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }] });
    const cuisines = (await dishForm(at(), f.sophie)).cuisines;
    const withRecipe = await createDish(at(), f.sophie, { name: "Gratin de la maison", cuisineId: cuisines[0].id, ingredients: ["Pommes de terre", "Crème"], minutes: 50, recipe: "Enfourner." });
    const noRecipe = await createDish(at(), f.sophie, { name: "Soupe du dimanche", cuisineId: cuisines[0].id, ingredients: ["Poireaux", "Oignons"], minutes: 30 });

    // un produit du catalogue vendu en paquets au kilo, et un produit « placard »
    const refs = await db
      .selectFrom("v_grocery_product_references as r")
      .innerJoin("grocery_products as p", "p.id", "r.product_id")
      .select(["p.name", "r.package_amount", "r.package_unit", "r.price_unit"])
      .where("r.unit_price", "is not", null)
      .where("r.is_compliant", "=", true)
      .where("p.is_pantry", "=", false)
      .where("r.store_chain", "in", ["lidl", "e.leclerc"])
      .orderBy("p.name")
      .execute();
    // un produit dont TOUTES les références ont un format en kilos : le nombre de paquets se calcule quelle que soit la référence retenue
    const byProduct = new Map<string, typeof refs>();
    for (const r of refs) byProduct.set(r.name, [...(byProduct.get(r.name) ?? []), r]);
    const product = [...byProduct.values()].find((rows) => rows.every((r) => r.package_unit === "kg" && r.package_amount !== null && r.price_unit === "unit"))![0];
    const packageOf = (name: string) => byProduct.get(name)!.map((r) => Number(r.package_amount));
    const pantry = await db.selectFrom("grocery_products").select("name").where("is_pantry", "=", true).orderBy("name").limit(1).executeTakeFirstOrThrow();
    expect(pantry.name).toBeTruthy();

    const catalogDish = (await db.selectFrom("meal_dishes").select("name").orderBy("id").limit(1).executeTakeFirstOrThrow()).name;
    const free = (name: string, ingredients: object[]) => ({ nom: name, cuisine: cuisines[0].name, duree_minutes: 30, recette: "1. Cuire. 2. Servir.", ingredients });
    const q = (nom: string, quantite: number, unite: string) => ({ nom, quantite, unite });
    const menu = {
      diners: [
        { plat_id: `H:${withRecipe.id}`, nom: withRecipe.name, recette: "1. Éplucher pour six. 2. Enfourner 45 min.", ingredients: [q("Pommes de terre", 1.5, "kg"), q("Crème", 40, "cl")] },
        { plat_id: `H:${noRecipe.id}`, nom: noRecipe.name, recette: "Recette inventée à ne pas garder.", ingredients: [q("Poireaux", 1.2, "kg"), q("Oignons", 3, "piece")] },
        { nom: catalogDish, recette: "1. Version pour six personnes.", ingredients: [q("Riz long", 600, "g")] },
        free("Plat A", [q(product.name, 400, "g"), q(pantry.name, 1, "pincee"), { nom: "Truc rare xyz" }]),
        free("Plat B", [q(product.name, 600, "g"), q("Œufs", 6, "piece")]),
        free("Plat C", [q("Lentilles", 500, "g")]),
        free("Plat D", [q("Carottes", 800, "g")]),
      ],
      express: [free("Salade E", [q(product.name, 100, "g")])],
    };
    const done = await sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "Un menu" }, { model: scripted(callTools({ name: "proposer_menu", input: menu }), reply("Voici.")) });
    expect(done.card).toBeDefined();
    await validateMenuCard(at(), f.sophie, done.card!.messageId);

    const saved = await db.selectFrom("meal_menus").select(["id", "servings"]).where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    expect(saved.servings).toBe(6);
    const entries = await db.selectFrom("meal_menu_entries").select(["id", "dish_name", "dish_origin", "recipe"]).where("menu_id", "=", saved.id).execute();
    const byName = new Map(entries.map((e) => [e.dish_name, e]));
    // CR-49 : la recette du menu est celle écrite pour le foyer, pour toute origine ; sauf un plat de Mes plats sans recette
    expect(byName.get(withRecipe.name)).toMatchObject({ dish_origin: "household", recipe: "1. Éplucher pour six. 2. Enfourner 45 min." });
    expect(byName.get(noRecipe.name)!.recipe).toBeNull();
    expect(byName.get(catalogDish)).toMatchObject({ dish_origin: "catalog", recipe: "1. Version pour six personnes." });
    // le plat d'origine n'est pas modifié
    expect((await db.selectFrom("meal_household_dishes").select("recipe").where("id", "=", withRecipe.id).executeTakeFirstOrThrow()).recipe).toBe("Enfourner.");
    const rows = await db.selectFrom("meal_menu_entry_ingredients").select(["label", "quantity", "unit", "base_quantity", "base_unit"]).where("entry_id", "=", byName.get(withRecipe.name)!.id).orderBy("position").execute();
    expect(rows.map((r) => [r.label, Number(r.quantity), r.unit, Number(r.base_quantity), r.base_unit])).toEqual([["Pommes de terre", 1.5, "kg", 1500, "g"], ["Crème", 40, "cl", 400, "ml"]]);

    // besoins : le produit de plusieurs plats est additionné (400 + 600 + 100 g = 1,1 kg), le placard est décoché, l'inconnu est à vérifier
    const items = await db.selectFrom("grocery_list_items").select(["label", "needed_amount", "needed_unit", "quantity_to_check", "is_pantry", "is_selected", "product_id"]).where("account_id", "=", f.accountId).execute();
    const find = (name: string) => items.find((i) => i.label.toLowerCase() === name.toLowerCase());
    expect(find(product.name)).toMatchObject({ needed_unit: "g", quantity_to_check: false, is_pantry: false, is_selected: true });
    expect(Number(find(product.name)!.needed_amount)).toBe(1100);
    expect(find(pantry.name)).toMatchObject({ is_pantry: true, is_selected: false });
    expect(items.find((i) => i.label.toLowerCase().includes("truc rare"))).toMatchObject({ quantity_to_check: true });

    // la préparation de la liste : paquets selon la référence de chaque scénario
    const prepared = await prepareList(at(), f.sophie);
    expect(prepared.menu!.servings).toBe(6);
    const model = fromDto(prepared.model!);
    const line = scenarioLines(model, {}, computeScenarios(model, {}, ["Lidl", "E.Leclerc"])[1]).find((l) => l.name.toLowerCase() === product.name.toLowerCase())!;
    const packageSizes = packageOf(product.name);
    const chosenSize = packageSizes.find((size) => Math.ceil(1.1 / size - 1e-9) === line.qty);
    const expectedPackages = Math.ceil(1.1 / (chosenSize ?? packageSizes[0]) - 1e-9);
    expect(line).toMatchObject({ need: { amount: 1.1, unit: "kg" }, toCheck: false });
    expect(line.qty).toBe(expectedPackages);
    const panty = scenarioLines(model, {}, computeScenarios(model, {}, ["Lidl"])[1]).find((l) => l.name.toLowerCase() === pantry.name.toLowerCase());
    expect(panty).toMatchObject({ pantry: true, checked: false });

    // validation de la liste : le besoin est gardé, Ma liste le montre
    const lines = scenarioLines(model, {}, computeScenarios(model, {}, ["Lidl", "E.Leclerc"])[1])
      .filter((l) => l.checked)
      .map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, priceUnit: l.priceUnit, need: l.need, weight: l.weight, toCheck: l.toCheck, pantry: l.pantry, source: "menu" as const }));
    await validateList(at(), f.sophie, { scenario: 2, lines });
    const stored = await db.selectFrom("grocery_list_items").select(["needed_amount", "needed_unit", "quantity", "is_selected"]).where("account_id", "=", f.accountId).where("state", "=", "validated").where("label", "ilike", product.name).executeTakeFirstOrThrow();
    expect(Number(stored.needed_amount)).toBe(1100);
    expect(stored).toMatchObject({ needed_unit: "g", quantity: expectedPackages, is_selected: true });
    const mine = await myList(at(), f.sophie);
    const mineLine = mine.stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).find((l) => l.name.toLowerCase() === product.name.toLowerCase())!;
    expect(mineLine.need).toEqual({ amount: 1100, unit: "g" });
    // l'invité secondaire voit le besoin, sans prix
    const guest = (await myList(at(), f.elodie)).stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).find((l) => l.name.toLowerCase() === product.name.toLowerCase())!;
    expect(guest).toMatchObject({ price: null, need: { amount: 1100, unit: "g" } });
  });
});
