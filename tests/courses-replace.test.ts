import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { listCourseMessages, sendCourseMessage } from "@/server/courses/chat/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { prepareList } from "@/server/courses/list/service";
import { createDish, dishForm } from "@/server/courses/menu/dishes";
import { replaceDish, replaceOptions } from "@/server/courses/menu-ia/replace";
import { writeMenuSteps } from "@/server/courses/menu-ia/steps";
import { validateMenuCard } from "@/server/courses/menu-ia/validate";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
process.env.MENU_IA = "live";

/** CR-57 : consulter et remplacer un plat avant de valider, sans IA ; déroulé réécrit une fois à la validation ; « Rédiger le déroulé ». */
const db = testDb();
const NOW = new Date(2026, 10, 6, 10, 0, 0);
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

const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 };
const reply = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage, requestId: null });
const callTools = (...calls: { name: string; input: unknown }[]): ModelResponse => ({ content: calls.map((c, i) => ({ type: "tool_use" as const, id: `tu_${i}_${c.name}`, name: c.name, input: c.input })), stopReason: "tool_use", usage, requestId: null });
function scripted(...steps: ModelResponse[]): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  let i = 0;
  return { id: "faux", seen, send: async (request) => (seen.push(structuredClone(request)), steps[Math.min(i++, steps.length - 1)]) };
}

interface House {
  f: CoupleFamily;
  cuisine: string;
  catalog: string[];
  own: { id: string; name: string };
}

const settingsOf = (cuisineIds: number[], householdSize: number) => ({ city: "Nantes", householdSize, shoppingDays: [6], goals: { time: true }, cuisineIds });

async function household(): Promise<House> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const opts = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, settingsOf(opts.cuisines.map((c) => c.id), 4));
  const cuisines = (await dishForm(at(), f.sophie)).cuisines;
  const own = await createDish(at(), f.sophie, { name: "Gratin de la maison", cuisineId: cuisines[0].id, ingredients: ["Pommes de terre", "Crème", "Fromage râpé"], minutes: 50, recipe: "Enfourner le gratin." });
  const catalog = (await db.selectFrom("meal_dishes").select("name").orderBy("id").limit(40).execute()).map((d) => d.name);
  return { f, cuisine: cuisines[0].name, catalog, own: { id: `H:${own.id}`, name: own.name } };
}

const free = (name: string, cuisine: string, ingredients: string[], extra: Record<string, unknown> = {}) => ({ nom: name, cuisine, duree_minutes: 40, recette: "Cuire doucement, saler, servir.", ingredients: ingredients.map((nom) => ({ nom, quantite: 200, unite: "g" })), ...extra });

/** Sept dîners (Mes plats en premier si demandé) et quatre plats express libres. */
function menu(h: House, week: string, withOwn: boolean, ownIngredients?: unknown) {
  const first = withOwn ? { plat_id: h.own.id, nom: h.own.name, ...(ownIngredients ? { ingredients: ownIngredients } : {}) } : free("Velouté de courge", h.cuisine, ["Courge", "Oignons"]);
  return {
    semaine: week,
    diners: [
      first,
      { nom: h.catalog[0] },
      { nom: h.catalog[1] },
      free("Curry de pois chiches", h.cuisine, ["Pois chiches", "Lait de coco"]),
      free("Tarte aux poireaux", h.cuisine, ["Poireaux", "Pâte brisée"]),
      free("Poulet rôti et haricots", h.cuisine, ["Poulet entier", "Haricots verts"]),
      free("Soupe de lentilles", h.cuisine, ["Lentilles", "Carottes"]),
    ],
    express: [free("Salade de riz", h.cuisine, ["Riz basmati", "Thon"], { duree_minutes: 10 }), free("Omelette aux herbes", h.cuisine, ["Œufs", "Ciboulette"], { duree_minutes: 10 }), free("Wrap au thon", h.cuisine, ["Thon", "Galette"], { duree_minutes: 10 }), free("Salade de pâtes", h.cuisine, ["Pâtes", "Tomates"], { duree_minutes: 10 })],
    etapes: [
      { texte: "Préparer tous les légumes.", duree_minutes: 30 },
      { texte: "Cuire les plats au four.", duree_minutes: 90 },
    ],
  };
}

async function compose(h: House, input: unknown) {
  const model = scripted(callTools({ name: "preparer_menu", input: {} }), callTools({ name: "proposer_menu", input }), reply("Voici votre menu."));
  const done = await sendCourseMessage(at(), h.f.sophie, { requestId: randomUUID(), text: "Compose mon menu" }, { model });
  return done.card!;
}

const counter = async (h: House) => (await db.selectFrom("meal_menu_daily_counters").select("menu_count").where("account_id", "=", h.f.accountId).execute()).reduce((s, r) => s + r.menu_count, 0);
const cardOf = async (h: House, id: string) => (await listCourseMessages(at(), h.f.sophie)).find((m) => m.card?.messageId === id)!.card!;

describe("CR-57 : remplacer un plat sans IA", () => {
  it("un express prend la place d'un dîner et le dîner devient express ; deux dîners échangent leur jour ; ni appel du modèle ni menu compté en plus", async () => {
    const h = await household();
    const card = await compose(h, menu(h, W1, false));
    const before = await counter(h);
    const p0 = card.proposal;

    // express → dîner (samedi) : le dîner prend la place de l'express
    const options = await replaceOptions(at(), h.f.sophie, { messageId: card.messageId, kind: "dinner", index: 5 });
    expect(options.express.map((e) => e.name)).toEqual(p0.express.map((e) => e.name));
    expect(options.dinners.map((d) => d.index)).not.toContain(5);
    expect(options.own.map((o) => o.name)).toEqual([h.own.name]);
    const swapped = await replaceDish(at(), h.f.sophie, { messageId: card.messageId, kind: "dinner", index: 5, choice: { group: "express", index: 0 } });
    expect(swapped.proposal.dinners[5].name).toBe(p0.express[0].name);
    expect(swapped.proposal.express[0].name).toBe(p0.dinners[5].name);
    // le samedi n'est pas dans la séance : durée et déroulé ne bougent pas
    expect(swapped.proposal.session).toEqual(p0.session);
    expect(swapped.proposal.stepsStale).toBe(false);

    // échange de jour dans la séance (lundi et mardi) : durée recalculée avec la formule, déroulé à mettre à jour
    const days = await replaceDish(at(), h.f.sophie, { messageId: card.messageId, kind: "dinner", index: 0, choice: { group: "dinners", index: 1 } });
    expect(days.proposal.dinners[0].name).toBe(p0.dinners[1].name);
    expect(days.proposal.dinners[1].name).toBe(p0.dinners[0].name);
    expect(days.proposal.stepsStale).toBe(true);
    expect(days.proposal.session).toMatchObject({ estimated: true, source: "formula" });
    expect(days.proposal.steps.length).toBe(p0.steps.length);
    // la carte est la même, rechargée du fil
    expect((await cardOf(h, card.messageId)).proposal.dinners[0].name).toBe(p0.dinners[1].name);
    expect(await counter(h)).toBe(before);
    // un invité secondaire ne remplace rien ; une carte inconnue est refusée
    expect((await rejection(replaceDish(at(), h.f.elodie, { messageId: card.messageId, kind: "dinner", index: 0, choice: { group: "dinners", index: 1 } }))).status).toBe(403);
    expect((await rejection(replaceDish(at(), h.f.sophie, { messageId: "999999999", kind: "dinner", index: 0, choice: { group: "dinners", index: 1 } }))).code).toBe("card_not_found");
    expect((await rejection(replaceDish(at(), h.f.sophie, { messageId: card.messageId, kind: "dinner", index: 0, choice: { group: "dinners", index: 0 } }))).code).toBe("invalid_dish");
  });

  it("un plat de Mes plats reprend les quantités de son dernier menu validé, ramenées au foyer ; sans quantités connues : « Quantité à vérifier »", async () => {
    const h = await household();
    // premier menu : Mes plats avec des quantités, validé pour 4 personnes
    const first = await compose(h, menu(h, W1, true, [{ nom: "Pommes de terre", quantite: 800, unite: "g" }, { nom: "Crème", quantite: 20, unite: "cl" }, { nom: "Fromage râpé", quantite: 100, unite: "g" }]));
    await validateMenuCard(at(), h.f.sophie, first.messageId, { model: scripted(reply("rien")) });
    // le foyer passe à 6 personnes ; le menu suivant n'a pas Mes plats
    await saveSettings(at(), h.f.sophie, settingsOf((await getSettings(at(), h.f.sophie)).options.cuisines.map((c) => c.id), 6));
    const second = await compose(h, menu(h, W2, false));
    const replaced = await replaceDish(at(), h.f.sophie, { messageId: second.messageId, kind: "dinner", index: 0, choice: { group: "own", dishId: h.own.id } });
    const dish = replaced.proposal.dinners[0];
    expect(dish).toMatchObject({ name: h.own.name, origin: "household", recipe: "Enfourner le gratin." });
    const byName = new Map(dish.ingredients.map((i) => [i.label, i]));
    expect(byName.get("Pommes de terre")).toMatchObject({ quantity: 1200, unit: "g" });
    expect(byName.get("Crème")).toMatchObject({ quantity: 30, unit: "cl" });
    expect(replaced.proposal.dinners.map((d) => d.name)).not.toContain("Velouté de courge");
    // le plat est maintenant dans le menu : il n'est plus proposé, et ne peut pas l'être deux fois
    expect((await replaceOptions(at(), h.f.sophie, { messageId: second.messageId, kind: "dinner", index: 1 })).own).toEqual([]);
    expect((await rejection(replaceDish(at(), h.f.sophie, { messageId: second.messageId, kind: "dinner", index: 1, choice: { group: "own", dishId: h.own.id } }))).code).toBe("duplicate_dish");

    // un plat de Mes plats jamais servi : ingrédients sans quantité
    const never = await createDish(at(), h.f.sophie, { name: "Cake aux olives", cuisineId: (await dishForm(at(), h.f.sophie)).cuisines[0].id, ingredients: ["Olives", "Farine"], minutes: 60, recipe: "" });
    const again = await replaceDish(at(), h.f.sophie, { messageId: second.messageId, kind: "express", index: 0, choice: { group: "own", dishId: `H:${never.id}` } });
    expect(again.proposal.express[0]).toMatchObject({ name: "Cake aux olives", recipe: "" });
    expect(again.proposal.express[0].ingredients.every((i) => i.quantity === null)).toBe(true);
  });
});

describe("CR-57 : le déroulé à la validation", () => {
  const stepsFor = (names: string[]) => [
    { texte: "Préparer tous les légumes.", duree_minutes: 40 },
    { texte: "Cuire les plats.", plat: names[0], duree_minutes: 60 },
    { texte: "Ranger le premier plat.", plat: names[0], duree_minutes: 5, conservation: "frigo", jour_sortie: 2 },
  ];

  it("après un remplacement dans la séance, l'IA réécrit le déroulé une seule fois, sans compter dans la limite de menus ; la durée suit les étapes", async () => {
    const h = await household();
    const card = await compose(h, menu(h, W1, false));
    await replaceDish(at(), h.f.sophie, { messageId: card.messageId, kind: "dinner", index: 0, choice: { group: "dinners", index: 1 } });
    const stale = await cardOf(h, card.messageId);
    const names = stale.proposal.dinners.slice(0, 5).map((d) => d.name);
    const before = await counter(h);
    const model = scripted(callTools({ name: "proposer_deroule", input: { etapes: stepsFor(names) } }));
    const result = await validateMenuCard(at(), h.f.sophie, card.messageId, { model });
    expect(model.seen).toHaveLength(1);
    // l'IA ne reçoit que les cinq plats de la séance : ni prénom ni prix
    expect(JSON.stringify(model.seen[0].messages)).toContain(names[0]);
    expect(JSON.stringify(model.seen[0].messages)).not.toMatch(/Sophie|Marc|Nantes|€/);
    const menuRow = await db.selectFrom("meal_menus").select(["id", "session_minutes", "session_is_estimated"]).where("account_id", "=", h.f.accountId).executeTakeFirstOrThrow();
    expect(menuRow.session_minutes).toBe(result.sessionMinutes);
    expect(result.sessionMinutes).toBe(105);
    const rows = await db.selectFrom("meal_menu_session_steps").select(["position", "body"]).where("menu_id", "=", menuRow.id).orderBy("position").execute();
    expect(rows).toHaveLength(3);
    expect(await counter(h)).toBe(before);
    // le déroulé est là : « Rédiger le déroulé » n'est pas proposé
    expect((await prepareList(at(), h.f.sophie, W1)).menu!.canWriteSteps).toBe(false);
  });

  it("si l'IA échoue, le menu est validé avec la durée estimée et sans déroulé ; « Rédiger le déroulé » écrit ensuite le déroulé, une seule fois", async () => {
    const h = await household();
    const card = await compose(h, menu(h, W1, false));
    await replaceDish(at(), h.f.sophie, { messageId: card.messageId, kind: "dinner", index: 0, choice: { group: "dinners", index: 1 } });
    const result = await validateMenuCard(at(), h.f.sophie, card.messageId, { model: scripted(reply("Désolé, je ne peux pas.")) });
    expect(result.estimated).toBe(true);
    const menuRow = await db.selectFrom("meal_menus").select("id").where("account_id", "=", h.f.accountId).executeTakeFirstOrThrow();
    expect(await db.selectFrom("meal_menu_session_steps").select("id").where("menu_id", "=", menuRow.id).execute()).toEqual([]);
    const page = await prepareList(at(), h.f.sophie, W1);
    expect(page.menu!.canWriteSteps).toBe(true);
    expect((await prepareList(at(), h.f.elodie, W1)).menu).toBeNull();

    const names = (await db.selectFrom("meal_menu_entries").select(["dish_name", "slot"]).where("menu_id", "=", menuRow.id).where("kind", "=", "dinner").orderBy("slot").execute()).slice(0, 5).map((e) => e.dish_name);
    // un déroulé incohérent est refusé, rien n'est écrit
    const bad = scripted(callTools({ name: "proposer_deroule", input: { etapes: [{ texte: "x", duree_minutes: 5, en_meme_temps_que: 3 }, { texte: "y", duree_minutes: 5 }] } }));
    expect((await rejection(writeMenuSteps(at(), h.f.sophie, W1, { model: bad }))).code).toBe("steps_failed");
    expect((await rejection(writeMenuSteps(at(), h.f.elodie, W1, { model: bad }))).status).toBe(403);
    const good = scripted(callTools({ name: "proposer_deroule", input: { etapes: stepsFor(names) } }));
    const written = await writeMenuSteps(at(), h.f.sophie, W1, { model: good });
    expect(written).toEqual({ steps: 3, minutes: 105 });
    expect((await db.selectFrom("meal_menus").select("session_minutes").where("id", "=", menuRow.id).executeTakeFirstOrThrow()).session_minutes).toBe(105);
    expect((await prepareList(at(), h.f.sophie, W1)).menu!.canWriteSteps).toBe(false);
    expect((await rejection(writeMenuSteps(at(), h.f.sophie, W1, { model: good }))).code).toBe("has_steps");
  });
});
