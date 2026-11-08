import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { sendCourseMessage } from "@/server/courses/chat/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { setBought } from "@/server/courses/list/mine";
import { addProduct, prepareList, saveLightChoices, validateList } from "@/server/courses/list/service";
import { createDish, dishForm } from "@/server/courses/menu/dishes";
import { addMenuDishesToMine } from "@/server/courses/menu-ia/mine";
import { validateMenuCard } from "@/server/courses/menu-ia/validate";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
process.env.MENU_IA = "live";

const db = testDb();
const NOW = new Date(2026, 10, 6, 10, 0, 0);
const WEEK = "2026-11-09";
const at = (now = NOW): Ctx => ({ db, now });
type Failure = { code: string; status: number; message: string };
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Failure;
  }
  throw new Error("aucun refus");
};

const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 };
const reply = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage, requestId: null });
const callTools = (...calls: { name: string; input: unknown }[]): ModelResponse => ({
  content: calls.map((c, i) => ({ type: "tool_use" as const, id: `tu_${i}_${c.name}`, name: c.name, input: c.input })),
  stopReason: "tool_use",
  usage,
  requestId: null,
});
function scripted(...steps: ModelResponse[]): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  let i = 0;
  return { id: "faux", seen, send: async (request) => (seen.push(structuredClone(request)), steps[Math.min(i++, steps.length - 1)]) };
}

interface Ctxt {
  f: CoupleFamily;
  cuisine: string;
  catalogDishes: string[];
  ownDish: { id: string; name: string };
}

async function household(): Promise<Ctxt> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const opts = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: opts.cuisines.map((c) => c.id) });
  const cuisines = (await dishForm(at(), f.sophie)).cuisines;
  const own = await createDish(at(), f.sophie, { name: "Gratin de la maison", cuisineId: cuisines[0].id, ingredients: ["Pommes de terre", "Crème", "Fromage râpé"], minutes: 50, recipe: "Enfourner." });
  const catalogDishes = (await db.selectFrom("meal_dishes").select("name").orderBy("id").limit(40).execute()).map((d) => d.name);
  return { f, cuisine: cuisines[0].name, catalogDishes, ownDish: { id: `H:${own.id}`, name: own.name } };
}

const free = (name: string, cuisine: string, ingredients: string[], extra: Record<string, unknown> = {}) => ({ nom: name, cuisine, duree_minutes: 40, recette: "1. Cuire doucement. 2. Saler. 3. Servir.", ingredients, ...extra });

function fullMenu(c: Ctxt, over: Record<string, unknown> = {}) {
  return {
    diners: [
      { plat_id: c.ownDish.id, nom: c.ownDish.name },
      { nom: c.catalogDishes[0] },
      { nom: c.catalogDishes[1] },
      free("Velouté de panais", c.cuisine, ["Panais", "Oignons", "Crème"], { version_allegee: { texte: "Sans crème, avec du lait.", retirer: ["Crème"], ajouter: ["Lait demi-écrémé"] } }),
      free("Curry de pois chiches", c.cuisine, ["Pois chiches", "Lait de coco", "Riz basmati"]),
      free("Tarte aux poireaux", c.cuisine, ["Poireaux", "Pâte brisée", "Œufs"]),
      free("Poulet rôti et haricots", c.cuisine, ["Poulet entier", "Haricots verts"]),
    ],
    express: [free("Salade de riz", c.cuisine, ["Riz basmati", "Thon", "Maïs"], { duree_minutes: 10 }), free("Omelette aux poireaux", c.cuisine, ["Œufs", "Poireaux"], { duree_minutes: 10 })],
    etapes: [
      { texte: "Préchauffer le four et éplucher les légumes.", duree_minutes: 15 },
      { texte: "Faire cuire le gratin au four.", plat: c.ownDish.name, duree_minutes: 50 },
      { texte: "Préparer le velouté pendant la cuisson du gratin.", plat: "Velouté de panais", duree_minutes: 30, en_meme_temps_que: 2 },
      { texte: "Ranger le velouté au frigo.", plat: "Velouté de panais", duree_minutes: 5, conservation: "frigo", jour_sortie: 2 },
    ],
    ...over,
  };
}

async function compose(c: Ctxt, input: unknown, ctx: Ctx = at()) {
  const model = scripted(callTools({ name: "preparer_menu", input: {} }), callTools({ name: "proposer_menu", input }), reply("Voici votre menu."));
  return sendCourseMessage(ctx, c.f.sophie, { requestId: randomUUID(), text: "Compose mon menu" }, { model });
}

describe("CR-42 : revalidation, liste, Mes plats (M4)", () => {
  it("revalider une semaine déjà validée met à jour le même menu et refait la liste : achats cochés gardés, ajouts à la main repris, page rouverte (CR-45)", async () => {
    const c = await household();
    const first = await compose(c, fullMenu(c));
    await validateMenuCard(at(), c.f.sophie, first.card!.messageId);
    const menu1 = await db.selectFrom("meal_menus").select(["id", "validated_at"]).where("account_id", "=", c.f.accountId).executeTakeFirstOrThrow();
    await addProduct(at(), c.f.sophie, { name: "Piles AA" });
    const prepared = await prepareList(at(), c.f.sophie);
    expect(prepared.validated).toBe(false);
    const lines = prepared.model!.items.slice(0, 6).map((i) => ({ name: i.name, qty: 1, store: null, ref: null, price: null, source: "menu" as const }));
    await validateList(at(), c.f.sophie, { scenario: 1, lines: [...lines, { name: "Piles AA", qty: 1, store: null, ref: null, price: null, source: "added" as const }] });
    expect((await prepareList(at(), c.f.sophie)).validated).toBe(true);
    // un produit de la liste validée est acheté en magasin
    const boughtRow = await db.selectFrom("grocery_list_items").select(["label", "name_key"]).where("account_id", "=", c.f.accountId).where("state", "=", "validated").where("source", "=", "menu").limit(1).executeTakeFirstOrThrow();
    await setBought(at(), c.f.sophie, { key: boughtRow.name_key, bought: true, late: false });

    const later = at(new Date(NOW.getTime() + 3_600_000));
    const second = await compose(c, fullMenu(c, { diners: [{ plat_id: c.ownDish.id, nom: c.ownDish.name }, ...fullMenu(c).diners.slice(3), free("Soupe de lentilles", c.cuisine, ["Lentilles", "Carottes"]), free("Riz au lait", c.cuisine, ["Riz", "Lait demi-écrémé"])], etapes: [] }), later);
    expect(second.card!.replacesValidated).toBe(true);
    const result = await validateMenuCard(later, c.f.sophie, second.card!.messageId);
    expect(result.week).toBe(WEEK);
    const menus = await db.selectFrom("meal_menus").select(["id", "validated_at"]).where("account_id", "=", c.f.accountId).execute();
    expect(menus).toHaveLength(1);
    expect(menus[0].id).toBe(menu1.id);
    expect(menus[0].validated_at.getTime()).toBeGreaterThan(menu1.validated_at.getTime());
    const entries = await db.selectFrom("meal_menu_entries").select("dish_name").where("menu_id", "=", menu1.id).execute();
    expect(entries.map((e) => e.dish_name)).not.toContain(c.catalogDishes[0]);
    expect((await db.selectFrom("meal_menu_session_steps").select("id").where("menu_id", "=", menu1.id).execute()).length).toBe(0);
    const items = await db.selectFrom("grocery_list_items").select(["label", "state", "source"]).where("account_id", "=", c.f.accountId).execute();
    expect(items.find((i) => i.label === boughtRow.label)?.state).toBe("bought");
    expect(items.find((i) => i.label === "Piles AA")).toMatchObject({ state: "preparing", source: "added" });
    expect((await prepareList(later, c.f.sophie)).validated).toBe(false);
  });

  it("la page Liste de courses lit les plats libres : durées, recettes, ingrédients, déroulé, conservation, version allégée proposée par l'IA et son choix", async () => {
    const c = await household();
    const done = await compose(c, fullMenu(c));
    await validateMenuCard(at(), c.f.sophie, done.card!.messageId);
    const prepared = await prepareList(at(), c.f.sophie);
    const menu = prepared.menu!;
    expect(menu.days.map((d) => d.name)).toContain("Velouté de panais");
    expect(menu.days.find((d) => d.name === "Velouté de panais")!.time).toBe("40 min");
    const recipe = menu.recipes.find((r) => r.name === "Velouté de panais")!;
    expect(recipe).toMatchObject({ kind: "dinner", ingredients: ["Panais", "Oignons", "Crème"], steps: ["Cuire doucement.", "Saler.", "Servir."] });
    expect(menu.recipes.filter((r) => r.kind === "express")).toHaveLength(2);
    expect(menu.session).toMatchObject({ estimated: true, overCap: false });
    expect(menu.batch.steps.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(menu.batch.steps[2].overlap).toMatch(/En même temps que l'étape 2/);
    expect(menu.batch.overlapping).toBe(true);
    expect(menu.batch.storage).toEqual([{ dish: "Velouté de panais", how: "Réfrigérateur, à sortir pour mardi" }]);
    // version allégée proposée par l'IA : dans la liste des versions, avec son adaptation ; le choix est gardé dans la ligne de menu
    const light = prepared.model!.dishes.find((d) => d.name === "Velouté de panais")!;
    expect(light).toMatchObject({ text: "Sans crème, avec du lait.", hasAdaptation: true });
    expect(prepared.modes["Velouté de panais"]).toBeUndefined();
    await saveLightChoices(at(), c.f.sophie, { "Velouté de panais": "light" });
    expect((await prepareList(at(), c.f.sophie)).modes["Velouté de panais"]).toBe("light");
    await saveLightChoices(at(), c.f.sophie, { "Velouté de panais": "standard" });
    expect((await prepareList(at(), c.f.sophie)).modes["Velouté de panais"]).toBeUndefined();
  });

  it("Ajouter ce plat à vos plats : plats libres et du catalogue copiés dans Mes plats, lien gardé dans le menu, rien dans le catalogue commun ; un plat déjà présent n'est pas dupliqué", async () => {
    const c = await household();
    const catalogBefore = (await db.selectFrom("meal_dishes").select("id").execute()).length;
    const done = await compose(c, fullMenu(c));
    await validateMenuCard(at(), c.f.sophie, done.card!.messageId);
    const slotOf = (name: string) => `dinner:${done.card!.proposal.dinners.findIndex((d) => d.name === name) + 1}`;
    const result = await addMenuDishesToMine(at(), c.f.sophie, { week: WEEK, slots: [slotOf("Velouté de panais"), slotOf(c.catalogDishes[0]), slotOf(c.ownDish.name)] });
    expect([...result.added].sort()).toEqual(["Velouté de panais", c.catalogDishes[0]].sort());
    expect(result.skipped.map((s) => s.name)).toEqual([c.ownDish.name]);
    const mine = (await dishForm(at(), c.f.sophie)).dishes;
    const copy = mine.find((d) => d.name === "Velouté de panais")!;
    expect(copy).toMatchObject({ minutes: 40, ingredients: ["Panais", "Oignons", "Crème"] });
    expect(mine.find((d) => d.name === c.catalogDishes[0])!.ingredients.length).toBeGreaterThan(0);
    const entry = await db.selectFrom("meal_menu_entries").select(["household_dish_id", "dish_origin"]).where("account_id", "=", c.f.accountId).where("dish_name", "=", "Velouté de panais").executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ household_dish_id: copy.id, dish_origin: "ai" });
    expect((await db.selectFrom("meal_dishes").select("id").execute()).length).toBe(catalogBefore);
    const again = await addMenuDishesToMine(at(), c.f.sophie, { week: WEEK, slots: [slotOf("Velouté de panais")] });
    expect(again.added).toEqual([]);
    expect((await dishForm(at(), c.f.sophie)).dishes.filter((d) => d.name === "Velouté de panais")).toHaveLength(1);
    expect((await rejection(addMenuDishesToMine(at(), c.f.elodie, { week: WEEK, slots: ["dinner:1"] }))).status).toBe(403);
  });
});
