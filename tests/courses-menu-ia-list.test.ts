import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ValidatedBanner, WeekMenuCard } from "@/components/courses/HomeScreen";
import { MenuDishRows, WeekNav } from "@/components/courses/MenuWeekScreen";
import { listCourseMessages } from "@/server/courses/chat/service";
import { courseHome } from "@/server/courses/home";
import { validateWeekMenu } from "@/server/courses/menu-ia/after-validation";
import { MONTH_PREFIX } from "@/server/courses/menu-ia/cards";
import { weekMenuView } from "@/server/courses/menu-week";
import { env } from "@/server/env";
import { encrypt } from "@/server/security/crypto";
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

const free = (name: string, cuisine: string, ingredients: string[], extra: Record<string, unknown> = {}) => ({ nom: name, cuisine, duree_minutes: 40, recette: "1. Cuire doucement. 2. Saler. 3. Servir.", ingredients: ingredients.map((nom) => ({ nom, quantite: 200, unite: "g" })), ...extra });

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
    expect(recipe).toMatchObject({ kind: "dinner", steps: ["Cuire doucement.", "Saler.", "Servir."] });
    expect(recipe.ingredients.map((i) => i.label)).toEqual(["Panais", "Oignons", "Crème"]);
    expect(recipe.ingredients[0]).toMatchObject({ quantity: 200, unit: "g" });
    expect(menu.servings).toBe(4);
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

describe("CR-72, US-180bis : la conversation est vidée à la validation, le menu se retrouve sur l'accueil", () => {
  const TUESDAY = new Date(2026, 10, 10, 10, 0, 0);
  const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");
  const threadOf = async (userId: string) => db.selectFrom("agent_conversations").select("id").where("user_id", "=", userId).executeTakeFirstOrThrow();

  it("« Valider le menu » vide la conversation du profil qui valide, pour de bon ; la proposition cachée du mois et le fil de l'autre parent restent ; le menu est gardé", async () => {
    const c = await household();
    const card = await compose(c, fullMenu(c));
    // l'autre parent a son propre fil, et une proposition du menu du mois est rangée, cachée, dans celui de Sophie
    await sendCourseMessage(at(), c.f.marc, { requestId: randomUUID(), text: "Bonjour" }, { model: scripted(reply("Bonjour Marc")) });
    const sophieThread = await threadOf(c.f.userIds.sophie);
    const hidden = await db.insertInto("agent_conversation_messages").values({ conversation_id: sophieThread.id, sender: "agent", kind: "text", content: encrypt(`${MONTH_PREFIX},"id":"x","weeks":[]}`, key()), created_at: NOW }).returning("id").executeTakeFirstOrThrow();
    expect((await listCourseMessages(at(), c.f.sophie)).length).toBeGreaterThanOrEqual(3);

    const result = await validateWeekMenu(at(), c.f.sophie, card.card!.messageId);
    expect(result).toMatchObject({ week: WEEK, cleared: true });
    // vraie suppression : il ne reste dans le fil de Sophie que la proposition cachée
    expect(await listCourseMessages(at(), c.f.sophie)).toEqual([]);
    expect((await db.selectFrom("agent_conversation_messages").select("id").where("conversation_id", "=", sophieThread.id).execute()).map((r) => r.id)).toEqual([hidden.id]);
    expect((await listCourseMessages(at(), c.f.marc)).map((m) => m.text)).toEqual(["Bonjour", "Bonjour Marc"]);
    // le menu, ses recettes et la liste préparée sont là
    expect((await prepareList(at(), c.f.sophie, WEEK)).menu?.recipes).toHaveLength(9);

    // l'agent sait qu'un menu est validé par les données du menu, pas par la conversation (règle 4)
    const model = scripted(reply("D'accord."));
    await sendCourseMessage(at(TUESDAY), c.f.sophie, { requestId: randomUUID(), text: "Un menu pour cette semaine", week: WEEK }, { model });
    expect(JSON.stringify(model.seen[0])).not.toContain("Compose mon menu");
    const context = JSON.stringify(model.seen[0].messages);
    expect(context).toContain("un menu est déjà validé pour cette semaine");
    expect(context).not.toContain("Voici votre menu");
  });

  it("une réponse en cours ne bloque pas la validation : le menu est validé, la conversation reste telle quelle", async () => {
    const c = await household();
    const card = await compose(c, fullMenu(c));
    const thread = await threadOf(c.f.userIds.sophie);
    // une demande toute récente, sans réponse
    await db.insertInto("agent_conversation_messages").values({ conversation_id: thread.id, sender: "profile", kind: "text", content: encrypt("Et pour dimanche ?", key()), created_at: new Date(NOW.getTime() + 30_000) }).execute();
    const before = (await listCourseMessages(at(new Date(NOW.getTime() + 60_000)), c.f.sophie)).length;
    const result = await validateWeekMenu(at(new Date(NOW.getTime() + 60_000)), c.f.sophie, card.card!.messageId);
    expect(result.cleared).toBe(false);
    expect((await listCourseMessages(at(new Date(NOW.getTime() + 60_000)), c.f.sophie)).length).toBe(before);
    expect(await db.selectFrom("meal_menus").select("id").where("account_id", "=", c.f.accountId).execute()).toHaveLength(1);
  });

  it("accueil : la carte « Menu de la semaine » montre la semaine en cours, le nombre de repas et les 3 prochains dîners ; « Semaine suivante » quand elle a un menu", async () => {
    const c = await household();
    const card = await compose(c, fullMenu(c));
    await validateWeekMenu(at(), c.f.sophie, card.card!.messageId);
    // le vendredi 6, le seul menu est celui de la semaine prochaine : la carte le montre (« Menu de la semaine prochaine »), avec ses 3 premiers dîners, pour les deux parents
    for (const parent of [c.f.sophie, c.f.marc]) {
      const friday = await courseHome(at(), parent);
      expect(friday.weekMenu).toMatchObject({ week: WEEK, upcoming: true, range: "du 9 au 15 nov.", dinners: 7, express: 2 });
      expect(friday.weekMenu!.next.map((m) => m.day)).toEqual(["Lun. 9", "Mar. 10", "Mer. 11"]);
      expect(friday.nextWeekMenu).toBeNull();
    }
    // le mardi 10, c'est la semaine en cours : le dîner du jour d'abord (« Ce soir »), puis mercredi et jeudi
    const tuesday = await courseHome(at(TUESDAY), c.f.marc);
    expect(tuesday.weekMenu).toMatchObject({ week: WEEK, upcoming: false, range: "du 9 au 15 nov.", dinners: 7, express: 2 });
    expect(tuesday.weekMenu!.next.map((m) => [m.day, m.express])).toEqual([["Ce soir", false], ["Mer. 11", false], ["Jeu. 12", false]]);
    expect(tuesday.weekMenu!.next[0].name).toBe(c.catalogDishes[0]);
    expect(tuesday.nextWeekMenu).toBeNull();
    // le dimanche 15, il reste un dîner : les plats express complètent, sans jour
    const sunday = await courseHome(at(new Date(2026, 10, 15, 10, 0, 0)), c.f.sophie);
    expect(sunday.weekMenu!.next.map((m) => [m.day, m.express])).toEqual([["Ce soir", false], ["", true], ["", true]]);
    // un invité secondaire n'a ni carte ni lien
    const guest = await courseHome(at(TUESDAY), c.f.elodie);
    expect([guest.weekMenu, guest.nextWeekMenu]).toEqual([null, null]);
  });

  it("écran « Menu de la semaine » : le menu complet de la semaine demandée, les plats à ajouter à « Mes plats », réservé au couple", async () => {
    const c = await household();
    const card = await compose(c, fullMenu(c));
    await validateWeekMenu(at(), c.f.sophie, card.card!.messageId);
    const view = await weekMenuView(at(TUESDAY), c.f.marc);
    // la semaine en cours, seule semaine qui a un menu : rien d'autre à parcourir
    expect(view.weeks.map((t) => [t.week, t.offset, t.title, t.hasMenu])).toEqual([[WEEK, 0, "9 – 15 novembre", true]]);
    expect(view).toMatchObject({ week: WEEK, today: 2, listValidated: false });
    expect(view.menu!.recipes.filter((r) => r.kind === "dinner").map((r) => r.day)).toEqual(["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]);
    // le plat de « Mes plats » n'est pas à ajouter ; les plats libres et ceux du catalogue le sont
    expect(view.addable.map((a) => a.slot)).not.toContain("dinner:1");
    expect(view.addable.map((a) => a.slot)).toEqual(expect.arrayContaining(["dinner:4", "express:1"]));
    // « Ajouter à mes plats » depuis l'écran : le plat n'est plus proposé ensuite
    await addMenuDishesToMine(at(TUESDAY), c.f.marc, { week: WEEK, slots: ["dinner:4"] });
    expect((await weekMenuView(at(TUESDAY), c.f.marc)).addable.map((a) => a.slot)).not.toContain("dinner:4");
    // une semaine sans menu n'est pas proposée : la demander ramène au menu validé
    expect((await weekMenuView(at(TUESDAY), c.f.marc, "2026-11-16")).week).toBe(WEEK);
    // vue depuis le vendredi 6 : la semaine en cours (sans menu) puis la prochaine, qui s'ouvre d'abord
    const early = await weekMenuView(at(), c.f.sophie);
    expect(early).toMatchObject({ week: WEEK, today: null });
    expect(early.weeks.map((w) => [w.week, w.offset, w.hasMenu])).toEqual([["2026-11-02", 0, false], [WEEK, 1, true]]);
    expect((await weekMenuView(at(), c.f.sophie, "2026-11-02")).menu).toBeNull();
    expect((await rejection(weekMenuView(at(TUESDAY), c.f.elodie))).status).toBe(403);
  });

  it("rendu : la carte de l'accueil et les lignes du menu (jour, « Ce soir », « Passé », « Ajouter à mes plats »)", () => {
    const home = renderToStaticMarkup(createElement(WeekMenuCard, { menu: { week: WEEK, upcoming: false, range: "du 9 au 15 nov.", dinners: 7, express: 4, next: [{ day: "Ce soir", name: "Poulet yassa", express: false }, { day: "", name: "Salade de lentilles", express: true }] }, nextWeek: "2026-11-16", canPrepare: true, onPrepare: () => undefined }));
    expect(home).toContain("Menu de la semaine");
    expect(home).toContain("7 dîners · 4 express");
    expect(home).toContain("Du 9 au 15 nov.");
    expect(home).toContain("Ce soir");
    expect(home).toContain(`href="/courses/menu?week=${WEEK}"`);
    expect(home).toContain("Voir le menu complet ›");
    expect(home).toContain('href="/courses/menu?week=2026-11-16"');
    expect(home).not.toContain("Préparer le menu de cette semaine");
    // menu de la semaine prochaine seulement : son titre le dit, et « Préparer le menu de cette semaine » reste proposé en dessous
    const upcoming = renderToStaticMarkup(createElement(WeekMenuCard, { menu: { week: "2026-11-16", upcoming: true, range: "du 16 au 22 nov.", dinners: 7, express: 4, next: [{ day: "Lun. 16", name: "Lasagnes", express: false }] }, nextWeek: null, canPrepare: true, onPrepare: () => undefined }));
    expect(upcoming).toContain("Menu de la semaine prochaine");
    expect(upcoming).toContain("Du 16 au 22 nov.");
    expect(upcoming).toContain("Lun. 16");
    expect(upcoming).toContain('href="/courses/menu?week=2026-11-16"');
    expect(upcoming).toContain("Préparer le menu de cette semaine");
    expect(upcoming).not.toContain("Semaine suivante");
    const none = renderToStaticMarkup(createElement(WeekMenuCard, { menu: null, nextWeek: null, canPrepare: true, onPrepare: () => undefined }));
    expect(none).toContain("Préparer le menu de la semaine");
    expect(none).not.toContain("Semaine suivante");
    expect(renderToStaticMarkup(createElement(WeekMenuCard, { menu: null, nextWeek: null, canPrepare: false, onPrepare: () => undefined }))).toBe("");

    const recipe = (day: string, name: string) => ({ name, kind: "dinner" as const, day, time: "30 min", ingredients: [], steps: [] });
    const rows = renderToStaticMarkup(createElement(MenuDishRows, { week: WEEK, today: 2, recipes: [recipe("Lundi", "Couscous"), recipe("Mardi", "Poulet yassa"), recipe("Mercredi", "Velouté de panais")], servings: 4, addable: ["dinner:3"], added: [], busy: false, onAdd: () => undefined }));
    expect(rows).toMatch(/Lun\. 9.*Couscous.*Passé.*Mar\. 10.*Poulet yassa.*Ce soir.*Mer\. 11.*Velouté de panais/s);
    expect(rows.match(/Ajouter à mes plats/g)).toHaveLength(1);
    expect(rows.match(/Passé/g)).toHaveLength(1);
    const added = renderToStaticMarkup(createElement(MenuDishRows, { week: WEEK, today: null, recipes: [recipe("Mercredi", "Velouté de panais")], servings: 4, addable: ["dinner:3"], added: ["dinner:3"], busy: false, onAdd: () => undefined }));
    expect(added).toContain("✓ Ajouté à « Mes plats »");
    expect(added).not.toContain("Ce soir");
  });
});

describe("CR-73 : passer d'une semaine à l'autre dans « Menu de la semaine »", () => {
  const TUESDAY = new Date(2026, 10, 10, 10, 0, 0);
  it("toutes les semaines à venir qui ont un menu, plus la semaine en cours ; une semaine sans menu entre deux est sautée ; jamais de semaine passée", async () => {
    const c = await household();
    // menus validés pour les semaines du 16 et du 30 novembre ; pas pour celle du 23
    for (const week of ["2026-11-16", "2026-11-30"]) {
      const card = await compose(c, fullMenu(c, { semaine: week }), at(TUESDAY));
      await validateWeekMenu(at(TUESDAY), c.f.sophie, card.card!.messageId);
    }
    const view = await weekMenuView(at(TUESDAY), c.f.marc);
    expect(view.weeks.map((w) => [w.week, w.offset, w.title, w.hasMenu])).toEqual([
      [WEEK, 0, "9 – 15 novembre", false],
      ["2026-11-16", 1, "16 – 22 novembre", true],
      ["2026-11-30", 3, "30 nov. – 6 décembre", true],
    ]);
    // sans semaine demandée : la première semaine qui a un menu
    expect(view.week).toBe("2026-11-16");
    expect((await weekMenuView(at(TUESDAY), c.f.marc, "2026-11-30")).menu?.week).toBe("2026-11-30");
    // deux semaines plus tard, la semaine du 16 est passée : elle n'est plus proposée
    const later = await weekMenuView(at(new Date(2026, 10, 24, 10, 0, 0)), c.f.marc);
    expect(later.weeks.map((w) => w.week)).toEqual(["2026-11-23", "2026-11-30"]);
  });

  it("rendu : flèches inactives aux deux bouts, « Dans 3 semaines », position dans la liste ; bandeau du menu du mois vers la première semaine validée", () => {
    const weeks = [
      { week: WEEK, offset: 0, range: "du 9 au 15 nov.", title: "9 – 15 novembre", hasMenu: false },
      { week: "2026-11-16", offset: 1, range: "du 16 au 22 nov.", title: "16 – 22 novembre", hasMenu: true },
      { week: "2026-11-30", offset: 3, range: "du 30 nov. au 6 déc.", title: "30 nov. – 6 décembre", hasMenu: true },
    ];
    const nav = (week: string) => renderToStaticMarkup(createElement(WeekNav, { weeks, week, onWeek: () => undefined }));
    expect(nav(WEEK)).toContain("Cette semaine · 1 sur 3");
    expect(nav(WEEK)).toMatch(/aria-label="Semaine précédente" aria-disabled="true"/);
    expect(nav(WEEK)).toMatch(/aria-label="Semaine suivante" aria-disabled="false"/);
    expect(nav("2026-11-16")).toContain("Semaine prochaine · 2 sur 3");
    expect(nav("2026-11-30")).toContain("Dans 3 semaines · 3 sur 3");
    expect(nav("2026-11-30")).toContain("30 nov. – 6 décembre");
    expect(nav("2026-11-30")).toMatch(/aria-label="Semaine suivante" aria-disabled="true"/);
    const week = renderToStaticMarkup(createElement(ValidatedBanner, { note: { kind: "week" } }));
    expect(week).toContain("Menu validé. Retrouvez-le en haut de l&#x27;accueil.");
    expect(week).not.toContain("href");
    const month = renderToStaticMarkup(createElement(ValidatedBanner, { note: { kind: "month", firstWeek: "2026-11-16" } }));
    expect(month).toContain("Menus validés. Retrouvez-les dans le menu de la semaine.");
    expect(month).toContain('href="/courses/menu?week=2026-11-16"');
  });
});
