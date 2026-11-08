import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { listCourseMessages, sendCourseMessage } from "@/server/courses/chat/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { createDish, dishForm } from "@/server/courses/menu/dishes";
import { menuInput, menuToolSchema } from "@/server/courses/menu-ia/contract";
import { courseHome } from "@/server/courses/home";
import { servingsNote, sessionText } from "@/components/courses/menu-text";
import { validateMenuCard } from "@/server/courses/menu-ia/validate";
import { minutesFromSteps, type ProposalStep } from "@/server/courses/menu-ia/proposal";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
process.env.MENU_IA = "live";

const db = testDb();
// lundi 9 novembre 2026 en semaine suivante (la semaine proposée par défaut est le lundi qui vient)
const NOW = new Date(2026, 10, 6, 10, 0, 0);
const WEEK = "2026-11-09";
const at = (): Ctx => ({ db, now: NOW });
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
const useTools = (...calls: { name: string; input: unknown }[]): ModelResponse => ({
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

async function household(options: { allergens?: string[]; diets?: string[]; allergyText?: string } = {}): Promise<Ctxt> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const opts = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: opts.cuisines.map((c) => c.id), ...options });
  const cuisines = (await dishForm(at(), f.sophie)).cuisines;
  const own = await createDish(at(), f.sophie, { name: "Gratin de la maison", cuisineId: cuisines[0].id, ingredients: ["Pommes de terre", "Crème", "Fromage râpé"], minutes: 50, recipe: "Enfourner." });
  const catalogDishes = (await db.selectFrom("meal_dishes").select("name").orderBy("id").limit(40).execute()).map((d) => d.name);
  return { f, cuisine: cuisines[0].name, catalogDishes, ownDish: { id: `H:${own.id}`, name: own.name } };
}

const free = (name: string, cuisine: string, ingredients: string[], extra: Record<string, unknown> = {}) => ({ nom: name, cuisine, duree_minutes: 40, recette: "Cuire doucement, saler, servir.", ingredients, ...extra });

/** Un menu complet : un plat de Mes plats, deux du catalogue, quatre plats libres, deux express libres. */
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

async function compose(c: Ctxt, input: unknown, text = "Compose mon menu") {
  const model = scripted(useTools({ name: "preparer_menu", input: {} }), useTools({ name: "proposer_menu", input }), reply("Voici votre menu."));
  const done = await sendCourseMessage(at(), c.f.sophie, { requestId: randomUUID(), text }, { model });
  return { done, model };
}

describe("CR-42 : le menu composé par l'IA", () => {
  it("le schéma de l'outil est strict : une clé inconnue, trop de dîners ou une étape mal formée sont refusés", () => {
    const schema = menuToolSchema() as { type: string; properties: Record<string, unknown>; required?: string[] };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["diners", "express", "etapes", "semaine_type"]));
    const dish = { nom: "Plat" };
    expect(menuInput.safeParse({ diners: [dish], prix: 3 }).success).toBe(false);
    expect(menuInput.safeParse({ diners: Array(8).fill(dish) }).success).toBe(false);
    expect(menuInput.safeParse({ diners: [dish], express: Array(5).fill(dish) }).success).toBe(false);
    expect(menuInput.safeParse({ diners: [dish], etapes: [{ texte: "x", conservation: "cave" }] }).success).toBe(false);
    expect(menuInput.safeParse({ diners: [dish] }).success).toBe(true);
  });

  it("préparer le menu : le modèle reçoit régimes, allergies, Mes plats et produits, jamais un prénom ni la ville (CR-43)", async () => {
    const c = await household({ allergens: ["Arachide"], diets: ["Végétarien"], allergyText: "Léo ne supporte pas le kiwi" });
    const { model } = await compose(c, fullMenu(c));
    const seen = JSON.stringify(model.seen.flatMap((r) => r.messages));
    expect(seen).toContain("Arachide");
    expect(seen).toContain("Végétarien");
    expect(seen).toContain(c.ownDish.name);
    expect(seen).toContain(c.ownDish.id);
    expect(seen).toContain("Produits du catalogue");
    // les prénoms du foyer (Sophie, Marc, Élodie, Léo, Mia) et la ville ne partent jamais
    expect(seen).not.toMatch(/Sophie|Marc|Élodie|Léo|Mia|Nantes/);
    expect(seen).toMatch(/Enfant \d ne supporte pas le kiwi/);
  });

  it("hors composition du menu, rien n'est envoyé au modèle : ni outil de menu pour un invité secondaire, ni allergie", async () => {
    const c = await household({ allergens: ["Arachide"] });
    const model = scripted(reply("Bonjour !"));
    await sendCourseMessage(at(), c.f.elodie, { requestId: randomUUID(), text: "Bonjour" }, { model });
    const request = model.seen[0];
    expect(JSON.stringify(request.messages)).not.toMatch(/Arachide/);
    expect((request.tools as { name: string }[]).map((t) => t.name)).not.toContain("proposer_menu");
    const parents = scripted(reply("Bonjour !"));
    await sendCourseMessage(at(), c.f.sophie, { requestId: randomUUID(), text: "Bonjour" }, { model: parents });
    expect(JSON.stringify(parents.seen[0].messages)).not.toMatch(/Arachide/);
    expect((parents.seen[0].tools as { name: string }[]).map((t) => t.name)).toEqual(expect.arrayContaining(["preparer_menu", "proposer_menu"]));
  });

  it("un menu complet : carte rangée chiffrée après la réponse, plats rapprochés de Mes plats et du catalogue, plats libres signalés, durée estimée par MAAQ d'après le déroulé", async () => {
    const c = await household();
    const { done } = await compose(c, fullMenu(c));
    expect(done.failed).toBe(false);
    expect(done.card?.status).toBe("open");
    const p = done.card!.proposal;
    expect(p).toMatchObject({ week: WEEK, complete: true, freeDishes: true, blocked: false, planId: null });
    expect(p.dinners.map((d) => d.origin)).toEqual(["household", "catalog", "catalog", "ai", "ai", "ai", "ai"]);
    expect(p.express.map((d) => d.origin)).toEqual(["ai", "ai"]);
    // 15 + 50 + 5 (le velouté se fait pendant le gratin : il n'allonge pas la séance)
    expect(p.session).toMatchObject({ minutes: 70, estimated: true, overCap: false, source: "steps" });
    const messages = await listCourseMessages(at(), c.f.sophie);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[2].card?.messageId).toBe(done.card!.messageId);
    const stored = await db.selectFrom("agent_conversation_messages").select("content").where("id", "=", done.card!.messageId as never).executeTakeFirstOrThrow();
    expect(stored.content!.toString("utf8")).not.toContain("Velouté");
  });

  it("le déroulé manquant ou incohérent : retour à la formule « le plus long + 40 % des autres »", async () => {
    const c = await household();
    const { done } = await compose(c, fullMenu(c, { etapes: [] }));
    expect(done.card!.proposal.session.source).toBe("formula");
    const longest = Math.max(...done.card!.proposal.dinners.slice(0, 5).map((d) => d.minutes));
    expect(done.card!.proposal.session.minutes).toBeGreaterThan(longest);
    const steps: ProposalStep[] = [
      { position: 1, text: "a", dish: null, minutes: 20, overlaps: null, storage: null, takeOutDay: null },
      { position: 2, text: "b", dish: null, minutes: 20, overlaps: null, storage: null, takeOutDay: null },
    ];
    expect(minutesFromSteps(steps, 60)).toBeNull(); // plus courte que le plat le plus long
    expect(minutesFromSteps([{ ...steps[0], overlaps: 2 }, steps[1]], 10)).toBeNull(); // chevauchement vers une étape suivante
    expect(minutesFromSteps(steps, 10)).toBe(40);
  });

  it("au-delà de 2 h, la séance est signalée", async () => {
    const c = await household();
    const { done } = await compose(c, fullMenu(c, { etapes: [{ texte: "Tout cuire.", duree_minutes: 100 }, { texte: "Tout ranger.", duree_minutes: 40 }] }));
    expect(done.card!.proposal.session).toMatchObject({ minutes: 140, overCap: true, cap: 120 });
  });

  it("une répétition est signalée (« déjà servi le … ») sans bloquer", async () => {
    const c = await household();
    const first = await compose(c, fullMenu(c, { semaine: "2026-11-09" }));
    await validateMenuCard(at(), c.f.sophie, first.done.card!.messageId);
    const { done } = await compose(c, fullMenu(c, { semaine: "2026-11-16" }));
    const dish = done.card!.proposal.dinners.find((d) => d.name === "Velouté de panais")!;
    expect(dish.servedOn).toBe("12/11"); // 4e dîner de la semaine du 9 novembre
    expect(done.card!.proposal.complete).toBe(true);
    expect(done.card!.status).toBe("open");
  });

  it("un plat libre qui contient peut-être une allergie reçoit seulement « Contient peut-être … » et n'empêche pas la validation (CR-44)", async () => {
    const c = await household({ allergyText: "kiwi" });
    const menu = fullMenu(c);
    const { done } = await compose(c, fullMenu(c, { express: [free("Salade poulet et kiwi", c.cuisine, ["Poulet entier", "Kiwi"], { duree_minutes: 10 }), menu.express[1]] }));
    const p = done.card!.proposal;
    expect(p.freeDishes).toBe(true);
    expect(p.express[0].warnings).toEqual(["Contient peut-être kiwi"]);
    expect(p.express[0].blockers).toEqual([]);
    expect(p.blocked).toBe(false);
    expect(done.card!.status).toBe("open");
    await validateMenuCard(at(), c.f.sophie, done.card!.messageId);
  });

  it("un conflit d'allergie sur un plat connu bloque la validation", async () => {
    const c = await household({ allergens: ["Œufs"] });
    // le deuxième plat du catalogue contient des œufs
    expect(c.catalogDishes[1]).toBe("Pâtes à la sauce africaine express");
    const { done } = await compose(c, fullMenu(c));
    const p = done.card!.proposal;
    expect(p.dinners[2].blockers.join()).toMatch(/Conflit d'allergie ou de régime \(Œufs\)/);
    expect(p.blocked).toBe(true);
    expect(done.card!.status).toBe("incomplete");
    expect((await rejection(validateMenuCard(at(), c.f.sophie, done.card!.messageId))).code).toBe("allergy_conflict");
  });

  it("un menu de moins de sept dîners est incomplet : pas de bouton, validation refusée", async () => {
    const c = await household();
    const menu = fullMenu(c);
    const { done } = await compose(c, fullMenu(c, { diners: menu.diners.slice(0, 5), etapes: [] }));
    expect(done.card!.proposal.complete).toBe(false);
    expect(done.card!.status).toBe("incomplete");
    expect((await rejection(validateMenuCard(at(), c.f.sophie, done.card!.messageId))).code).toBe("menu_incomplete");
  });

  it("un menu invalide est renvoyé au modèle pour qu'il corrige ; après deux essais invalides, la demande échoue avec un message d'erreur", async () => {
    const c = await household();
    const menu = fullMenu(c);
    const broken = { ...menu, diners: [...menu.diners.slice(0, 6), { nom: "Plat sans rien" }] };
    const fixed = scripted(useTools({ name: "proposer_menu", input: broken }), useTools({ name: "proposer_menu", input: menu }), reply("Voici votre menu corrigé."));
    const ok = await sendCourseMessage(at(), c.f.sophie, { requestId: randomUUID(), text: "Un menu" }, { model: fixed });
    expect(ok.failed).toBe(false);
    expect(ok.card?.status).toBe("open");
    const feedback = JSON.stringify(fixed.seen[1].messages);
    expect(feedback).toMatch(/Menu refusé par MAAQ/);
    expect(feedback).toMatch(/plat libre incomplet/);

    const hopeless = scripted(useTools({ name: "proposer_menu", input: broken }));
    const failed = await sendCourseMessage(at(), c.f.sophie, { requestId: randomUUID(), text: "Un autre menu" }, { model: hopeless });
    expect(failed.failed).toBe(true);
    expect(failed.reply).toBe("Je n'ai pas réussi à composer le menu pour le moment. Vous pouvez réessayer.");
    expect(failed.card).toBeUndefined();
    expect(hopeless.seen).toHaveLength(2);
  });

  it("un déroulé incohérent est refusé : chevauchement vers une étape suivante, plat inconnu, deux conservations du même plat", async () => {
    const c = await household();
    const menu = fullMenu(c);
    const model = scripted(
      useTools({ name: "proposer_menu", input: { ...menu, etapes: [{ texte: "a", duree_minutes: 10, en_meme_temps_que: 2 }, { texte: "b", plat: "Plat absent", conservation: "frigo" }] } }),
      useTools({ name: "proposer_menu", input: { ...menu, etapes: [{ texte: "a", plat: "Curry de pois chiches", conservation: "frigo" }, { texte: "b", plat: "Curry de pois chiches", conservation: "congelateur" }] } }),
    );
    const failed = await sendCourseMessage(at(), c.f.sophie, { requestId: randomUUID(), text: "Menu" }, { model });
    expect(failed.failed).toBe(true);
    const feedback = JSON.stringify(model.seen[1].messages);
    expect(feedback).toMatch(/étape précédente/);
    expect(feedback).toMatch(/n'est pas dans le menu/);
  });

  it("un plat proposé deux fois est refusé", async () => {
    const c = await household();
    const menu = fullMenu(c);
    const model = scripted(useTools({ name: "proposer_menu", input: { ...menu, diners: [...menu.diners.slice(0, 6), menu.diners[3]] } }), reply("Dommage."));
    await sendCourseMessage(at(), c.f.sophie, { requestId: randomUUID(), text: "Menu" }, { model });
    expect(JSON.stringify(model.seen[1].messages)).toMatch(/proposé deux fois/);
  });

  it("un menu corrigé remplace le précédent : l'ancienne carte devient « Menu remplacé » et ne se valide plus", async () => {
    const c = await household();
    const first = await compose(c, fullMenu(c));
    expect(first.done.card!.status).toBe("open");
    const second = await compose(c, fullMenu(c), "Change le jeudi");
    expect(second.done.card!.status).toBe("open");
    const view = await listCourseMessages(at(), c.f.sophie);
    const cards = view.filter((m) => m.card).map((m) => m.card!.status);
    expect(cards).toEqual(["replaced", "open"]);
    expect((await rejection(validateMenuCard(at(), c.f.sophie, first.done.card!.messageId))).code).toBe("menu_replaced");
    // le menu en cours est donné au modèle pour la correction suivante, par noms de plats seulement
    const third = scripted(reply("D'accord."));
    await sendCourseMessage(at(), c.f.sophie, { requestId: randomUUID(), text: "Encore un changement" }, { model: third });
    expect(JSON.stringify(third.seen[0].messages)).toContain("Menu en cours (semaine du 2026-11-09)");
    expect(JSON.stringify(third.seen[0].messages)).not.toContain("Cuire doucement");
  });

  it("Valider le menu : le menu est enregistré avec ses plats libres, ingrédients, version allégée et déroulé ; les ingrédients entrent dans la liste ; rien dans le catalogue commun", async () => {
    const c = await household();
    const catalogBefore = (await db.selectFrom("meal_dishes").select("id").execute()).length;
    const { done } = await compose(c, fullMenu(c));
    const result = await validateMenuCard(at(), c.f.sophie, done.card!.messageId);
    expect(result).toMatchObject({ week: WEEK, sessionMinutes: 70, estimated: true, overCap: false });
    expect(result.listed).toBeGreaterThan(10);
    // « Ajouter ce plat à vos plats ? » : tout sauf les plats déjà dans Mes plats (y compris ceux du catalogue)
    expect(result.addable.map((a) => a.name)).toContain("Velouté de panais");
    expect(result.addable.map((a) => a.name)).toContain(c.catalogDishes[0]);
    expect(result.addable.map((a) => a.name)).not.toContain(c.ownDish.name);

    const menu = await db.selectFrom("meal_menus").selectAll().where("account_id", "=", c.f.accountId).executeTakeFirstOrThrow();
    expect(menu).toMatchObject({ session_minutes: 70, session_is_estimated: true, session_over_cap: false, batch_week_id: null });
    const entries = await db.selectFrom("meal_menu_entries").selectAll().where("menu_id", "=", menu.id).orderBy("kind").orderBy("slot").execute();
    expect(entries.filter((e) => e.kind === "dinner").map((e) => e.dish_origin)).toEqual(["household", "catalog", "catalog", "ai", "ai", "ai", "ai"]);
    const velouté = entries.find((e) => e.dish_name === "Velouté de panais")!;
    expect(velouté).toMatchObject({ dish_id: null, household_dish_id: null, light_by_ai: true, light_text: "Sans crème, avec du lait.", duration_minutes: 40 });
    expect(velouté.cuisine_id).not.toBeNull();
    const ingredients = await db.selectFrom("meal_menu_entry_ingredients").select(["label", "product_id"]).where("entry_id", "=", velouté.id).orderBy("position").execute();
    expect(ingredients.map((i) => i.label)).toEqual(["Panais", "Oignons", "Crème"]);
    expect(ingredients.find((i) => i.label === "Oignons")!.product_id).not.toBeNull();
    const light = await db.selectFrom("meal_menu_entry_light_items").select(["kind", "label"]).where("entry_id", "=", velouté.id).orderBy("kind").execute();
    expect(light).toEqual([{ kind: "add", label: "Lait demi-écrémé" }, { kind: "remove", label: "Crème" }]);
    const steps = await db.selectFrom("meal_menu_session_steps").select(["position", "entry_id", "overlaps_position", "storage_mode", "take_out_day"]).where("menu_id", "=", menu.id).orderBy("position").execute();
    expect(steps.map((s) => [s.position, s.overlaps_position, s.storage_mode, s.take_out_day])).toEqual([[1, null, null, null], [2, null, null, null], [3, 2, null, null], [4, null, "fridge", 2]]);
    expect(steps[3].entry_id).toBe(velouté.id);
    expect((await db.selectFrom("meal_dishes").select("id").execute()).length).toBe(catalogBefore);
    // les ingrédients des plats libres sont dans la liste, un ingrédient inconnu du catalogue est noté pour l'administration
    const list = await db.selectFrom("grocery_list_items").select("name_key").where("account_id", "=", c.f.accountId).execute();
    expect(list.map((l) => l.name_key).join(" ")).toMatch(/panais/);
    // la carte validée ne se valide pas deux fois
    expect((await rejection(validateMenuCard(at(), c.f.sophie, done.card!.messageId))).code).toBe("already_validated");
    const after = await listCourseMessages(at(), c.f.sophie);
    expect(after.find((m) => m.card)!.card!.status).toBe("validated");
  });

  it("une carte n'est validable que par son propriétaire et seulement par un parent du couple", async () => {
    const c = await household();
    const { done } = await compose(c, fullMenu(c));
    expect((await rejection(validateMenuCard(at(), c.f.marc, done.card!.messageId))).code).toBe("card_not_found");
    expect((await rejection(validateMenuCard(at(), c.f.elodie, done.card!.messageId))).status).toBe(403);
    expect((await rejection(validateMenuCard(at(), c.f.sophie, "9999999"))).code).toBe("card_not_found");
  });
});

describe("CR-42 : le menu dans le tchat (M3)", () => {
  it("la carte sait si elle remplace un menu déjà validé pour la même semaine (CR-45) ; la nouvelle carte de la semaine validée reste ouverte", async () => {
    const c = await household();
    const first = await compose(c, fullMenu(c));
    expect(first.done.card!.replacesValidated).toBe(false);
    await validateMenuCard(at(), c.f.sophie, first.done.card!.messageId);
    const second = await compose(c, fullMenu(c), "Un autre menu");
    expect(second.done.card).toMatchObject({ status: "open", replacesValidated: true });
    const view = (await listCourseMessages(at(), c.f.sophie)).filter((m) => m.card).map((m) => [m.card!.status, m.card!.replacesValidated]);
    expect(view).toEqual([["validated", true], ["open", true]]);
  });

  it("textes de la carte : séance estimée ou semaine type, facteur pour plus de 4 personnes", () => {
    const base = { planTheme: null, session: { minutes: 105, estimated: true, overCap: false, cap: 120, source: "formula" as const } };
    expect(sessionText(base)).toBe("Dimanche · environ 1 h 45 (durée estimée), pour les dîners du lundi au vendredi. Samedi et dimanche : hors séance.");
    expect(sessionText({ planTheme: "Sauce tomate & volaille", session: { ...base.session, minutes: 110, estimated: false, source: "plan" } })).toBe("Dimanche · 1 h 50 · semaine type « Sauce tomate & volaille », pour les dîners du lundi au vendredi. Samedi et dimanche : hors séance.");
    expect(servingsNote(4)).toBeNull();
    expect(servingsNote(null)).toBeNull();
    expect(servingsNote(6)).toBe("Recettes pour 4 : multipliez par 1,5.");
    expect(servingsNote(5)).toBe("Recettes pour 4 : multipliez par 1,25.");
  });

  it("l'accueil dit si le menu se compose en conversation : parents du couple seulement, quand MENU_IA est ouvert", async () => {
    const c = await household();
    expect((await courseHome(at(), c.f.sophie)).menuIa).toBe(true);
    expect((await courseHome(at(), c.f.elodie)).menuIa).toBe(false);
  });
});
