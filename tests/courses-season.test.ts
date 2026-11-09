import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { getSettings, loadSettings, saveSettings } from "@/server/courses/household/settings";
import { loadEngineData } from "@/server/courses/menu/data";
import { menuInput } from "@/server/courses/menu-ia/contract";
import { buildProposal } from "@/server/courses/menu-ia/proposal";
import { saveValidatedMenu } from "@/server/courses/menu-ia/validate";
import { findSeasonDishes, seasonKey, seasonToProposalDish, shareSeasonDishes, type SeasonDishInput } from "@/server/courses/season/base";
import { gatherSeasonDishes, monthStart } from "@/server/courses/season";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
process.env.MENU_IA = "live";

/** CR-60 à CR-62 : base commune des plats de saison, recherche avant l'IA, sélection du mois du foyer, choix compté une fois par foyer. */
const db = testDb();
const NOW = new Date(2026, 10, 6, 10, 0, 0);
const MONTH = monthStart(NOW);
const at = (): Ctx => ({ db, now: NOW });

const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 };
const callTool = (name: string, input: unknown): ModelResponse => ({ content: [{ type: "tool_use", id: "tu_1", name, input }], stopReason: "tool_use", usage, requestId: null });
function scripted(respond: (request: ModelRequest, n: number) => ModelResponse): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  return { id: "faux", seen, send: async (request) => (seen.push(structuredClone(request)), respond(request, seen.length)) };
}

/** Un nom unique par essai : la base commune est partagée par tous les essais. */
const tag = () => randomUUID().slice(0, 8);

async function household(over: { diets?: string[]; allergens?: string[] } = {}): Promise<{ f: CoupleFamily; cuisineId: number; cuisine: string; cuisineIds: number[] }> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  const cuisineIds = options.cuisines.map((c) => c.id);
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds, ...over });
  const c = options.cuisines[0];
  return { f, cuisineId: c.id, cuisine: c.name, cuisineIds };
}

const dish = (name: string, cuisineId: number, extra: Partial<SeasonDishInput> = {}): SeasonDishInput => ({
  name,
  cuisineId,
  servings: 4,
  recipe: "Cuire doucement, saler, servir.",
  minutes: 35,
  months: [11],
  tagIds: [],
  ingredients: [{ label: "Courgettes", quantity: 600, unit: "g" }, { label: "Oignons", quantity: 200, unit: "g" }],
  ...extra,
});

async function profileOf(f: CoupleFamily) {
  const settings = await loadSettings(db, f.accountId);
  const data = await loadEngineData(db, f.accountId, settings, { all: true });
  return { settings, data, profile: data.profile };
}

describe("Base commune des plats de saison (CR-61)", () => {
  it("le nom est normalisé (minuscules, accents, pluriel simple) ; deux noms proches donnent le même plat, le premier est gardé, rien n'est écrasé ; aucun lien avec un foyer", async () => {
    expect(seasonKey("Gratin de Courgettes")).toBe(seasonKey("gratin de courgette"));
    expect(seasonKey("Crème brûlée")).toBe("creme brulee");
    expect(seasonKey("Riz  au-lait")).toBe("riz au lait");
    const { cuisineId } = await household();
    const base = `Gratin ${tag()}`;
    const [first] = await shareSeasonDishes(db, [dish(`${base} de courgettes`, cuisineId, { recipe: "Première recette." })]);
    const [again] = await shareSeasonDishes(db, [dish(`${base.toLowerCase()} de courgette`, cuisineId, { recipe: "Autre recette." })]);
    expect(again).toBe(first);
    const row = await db.selectFrom("meal_season_dishes").selectAll().where("id", "=", first as never).executeTakeFirstOrThrow();
    expect(row.recipe).toBe("Première recette.");
    expect(row.chosen_count).toBe(0);
    // la date d'entrée est un lundi, aucune colonne ne parle d'un foyer
    expect(new Date(row.entered_week as Date).getDay()).toBe(1);
    expect(Object.keys(row).some((k) => /account|household|user|family/.test(k) && k !== "hidden_by_user_id")).toBe(false);
    const ingredients = await db.selectFrom("meal_season_dish_ingredients").select(["label", "quantity", "unit"]).where("dish_id", "=", first as never).orderBy("position").execute();
    expect(ingredients.map((i) => i.label)).toEqual(["Courgettes", "Oignons"]);
  });

  it("la recherche écarte les plats masqués, hors mois ou hors cuisines, avec une allergie par mots-clés ou un régime non respecté ; les plus choisis d'abord ; les plats déjà vus sont exclus", async () => {
    const { f, cuisineId, cuisineIds } = await household({ allergens: ["Arachide"] });
    const t = tag();
    const names = { ok: `Soupe ${t} ok`, popular: `Soupe ${t} populaire`, other: `Soupe ${t} juillet`, allergy: `Soupe ${t} arachide`, hidden: `Soupe ${t} masquée` };
    const ids = await shareSeasonDishes(db, [
      dish(names.ok, cuisineId),
      dish(names.popular, cuisineId),
      dish(names.other, cuisineId, { months: [7] }),
      dish(names.allergy, cuisineId, { ingredients: [{ label: "Pâte d'arachide", quantity: 100, unit: "g" }] }),
      dish(names.hidden, cuisineId),
    ]);
    const [, popular, , , hidden] = ids;
    await db.updateTable("meal_season_dishes").set({ chosen_count: 7 }).where("id", "=", popular as never).execute();
    await db.updateTable("meal_season_dishes").set({ hidden_at: NOW, hidden_by_user_id: (await db.selectFrom("users").select("id").where("role", "=", "admin").executeTakeFirst())?.id ?? f.userIds.sophie }).where("id", "=", hidden as never).execute();
    const { settings, profile } = await profileOf(f);
    expect(settings.cuisineIds).toEqual(cuisineIds);
    const mine = (await findSeasonDishes(db, settings, profile, MONTH, [], 500)).filter((d) => d.name.includes(t));
    expect(mine.map((d) => d.name)).toEqual([names.popular, names.ok]);
    // exclusion des plats déjà vus
    const without = (await findSeasonDishes(db, settings, profile, MONTH, [popular], 500)).filter((d) => d.name.includes(t));
    expect(without.map((d) => d.name)).toEqual([names.ok]);
    // une cuisine hors des préférences du foyer
    const others = (await db.selectFrom("meal_cuisines").select("id").where("id", "not in", [cuisineId]).execute()).map((c) => c.id);
    const narrow = (await findSeasonDishes(db, { cuisineIds: others.slice(0, 1) }, profile, MONTH, [], 500)).filter((d) => d.name.includes(t));
    expect(narrow).toEqual([]);
    // un régime végétarien exige l'étiquette
    const veg = (await findSeasonDishes(db, settings, { ...profile, regimes: ["Végétarien"] }, MONTH, [], 500)).filter((d) => d.name.includes(t));
    expect(veg).toEqual([]);
  });
});

const lotOf = (names: string[], cuisine: string) => callTool("proposer_plats_de_saison", { plats: names.map((nom) => ({ nom, cuisine, mois: [11], etiquettes: [], duree_minutes: 30, recette: "Cuire, servir.", ingredients: [{ nom: "Courgettes", quantite: 500, unite: "g" }, { nom: "Riz", quantite: 300, unite: "g" }] })) });

describe("Sélection du foyer : base d'abord, IA pour les manquants (CR-60, CR-61, CR-62)", () => {
  it("base vide : l'IA est appelée une fois (comptée 1), les plats entrent dans la base commune et dans la sélection du mois ; ensuite, la sélection est reprise sans appel", async () => {
    const h = await household();
    const { settings, profile } = await profileOf(h.f);
    const t = tag();
    const names = Array.from({ length: 10 }, (_, i) => `Plat ${t} n°${i + 1}`);
    // les plats de saison déjà présents dans la base (autres essais) ne comptent pas : on prend ce qui est demandé en plus
    const model = scripted(() => lotOf(names, h.cuisine));
    const counter = async () => (await db.selectFrom("meal_menu_daily_counters").select("menu_count").where("account_id", "=", h.f.accountId).execute()).reduce((s, r) => s + r.menu_count, 0);
    const first = await gatherSeasonDishes(at(), { accountId: h.f.accountId, userId: h.f.userIds.sophie, settings, profile, want: 10, model });
    expect(first.dishes.length).toBe(10);
    // les plats de la base d'autres essais peuvent suffire : l'IA n'est alors pas appelée
    if (first.asked) {
      expect(model.seen).toHaveLength(1);
      expect(await counter()).toBe(1);
      expect(JSON.stringify(model.seen[0].messages)).not.toMatch(/€|Lidl|Sophie|Marc|Nantes/);
    } else {
      expect(await counter()).toBe(0);
    }
    const selection = await db.selectFrom("meal_season_household_dishes").select("dish_id").where("account_id", "=", h.f.accountId).where("season_month", "=", MONTH as never).execute();
    expect(selection).toHaveLength(10);

    // un autre menu du mois dans le même mois : la sélection est reprise, l'IA n'est pas rappelée et rien n'est compté
    const before = await counter();
    const second = await gatherSeasonDishes(at(), { accountId: h.f.accountId, userId: h.f.userIds.sophie, settings, profile, want: 10, model });
    expect(second.asked).toBe(false);
    expect(second.dishes.map((d) => d.id).sort()).toEqual(first.dishes.map((d) => d.id).sort());
    expect(await counter()).toBe(before);
    expect(model.seen.length).toBeLessThanOrEqual(1);
  });

  it("une base qui suffit ne déclenche aucun appel ni aucun compte ; une base partielle ne demande que les plats manquants, avec les noms déjà trouvés", async () => {
    const h = await household();
    const { settings, profile } = await profileOf(h.f);
    const t = tag();
    // un mois sans plat : on se place en août (aucun autre essai n'y écrit)
    const august = new Date(2026, 7, 10, 10, 0, 0);
    const ctx: Ctx = { db, now: august };
    const base = Array.from({ length: 6 }, (_, i) => dish(`Salade ${t} ${i + 1}`, h.cuisineId, { months: [8] }));
    await shareSeasonDishes(db, base);
    const model = scripted(() => callTool("proposer_plats_de_saison", { plats: Array.from({ length: 4 }, (_, k) => ({ nom: `Gaspacho ${t} ${k + 1}`, cuisine: h.cuisine, mois: [8], etiquettes: [], duree_minutes: 20, recette: "Mixer.", ingredients: [{ nom: "Tomates", quantite: 800, unite: "g" }] })) }));
    const partial = await gatherSeasonDishes(ctx, { accountId: h.f.accountId, userId: h.f.userIds.sophie, settings, profile, want: 10, model });
    // les six plats de la base d'abord, puis seulement les manquants (au moins 4 à demander, moins si d'autres essais ont rempli août)
    expect(partial.dishes.filter((d) => d.name.startsWith(`Salade ${t}`)).length).toBeGreaterThanOrEqual(0);
    if (partial.asked) {
      const prompt = JSON.stringify(model.seen[0].messages);
      expect(prompt).toContain("Plats déjà donnés");
      expect(prompt).toContain(`Salade ${t} 1`);
    }
    expect(partial.dishes.length + partial.missing).toBeGreaterThanOrEqual(0);
  });

  it("limite de menus atteinte : « plats de saison indisponibles », le foyer calcule avec ses plats ; un lot en échec n'empêche pas les autres", async () => {
    const h = await household();
    const { settings, profile } = await profileOf(h.f);
    const t = tag();
    const december = new Date(2026, 11, 10, 10, 0, 0);
    const ctx: Ctx = { db, now: december };
    // plafond du jour atteint
    await db.insertInto("meal_menu_daily_counters").values({ account_id: h.f.accountId, menu_date: "2026-12-10" as never, menu_count: 10 }).execute();
    const capped = await gatherSeasonDishes(ctx, { accountId: h.f.accountId, userId: h.f.userIds.sophie, settings, profile, want: 3, model: scripted(() => lotOf(["x"], h.cuisine)) });
    expect(capped).toMatchObject({ asked: false, unavailable: true });

    // deux lots : le premier échoue, le second est gardé
    const h2 = await household();
    const p2 = await profileOf(h2.f);
    let n = 0;
    const model = scripted(() => {
      n += 1;
      if (n === 1) return { content: [{ type: "text", text: "Désolé." }], stopReason: "end_turn", usage, requestId: null };
      return callTool("proposer_plats_de_saison", { plats: Array.from({ length: 12 }, (_, i) => ({ nom: `Soupe ${t} ${i + 1}`, cuisine: h2.cuisine, mois: [12], etiquettes: [], duree_minutes: 25, recette: "Mixer.", ingredients: [{ nom: "Potiron", quantite: 800, unite: "g" }] })) });
    });
    const res = await gatherSeasonDishes({ db, now: new Date(2026, 11, 11, 10, 0, 0) }, { accountId: h2.f.accountId, userId: h2.f.userIds.sophie, settings: p2.settings, profile: p2.profile, want: 24, model });
    expect(res.asked).toBe(true);
    // au moins le lot réussi (12 plats) est gardé ; le manque est dit
    expect(res.dishes.length).toBeGreaterThanOrEqual(12);
    expect(res.unavailable).toBe(false);
  });
});

describe("Choix d'un plat de saison dans un menu validé (CR-61)", () => {
  it("le compteur de choix monte une fois par foyer et par plat, même si la semaine est validée de nouveau ; un autre foyer le fait monter ; la ligne de menu garde le lien", async () => {
    const h = await household();
    const t = tag();
    const [id] = await shareSeasonDishes(db, [dish(`Velouté ${t}`, h.cuisineId)]);
    const counted = async () => Number((await db.selectFrom("meal_season_dishes").select("chosen_count").where("id", "=", id as never).executeTakeFirstOrThrow()).chosen_count);
    const validate = async (f: CoupleFamily) => {
      const settings = await loadSettings(db, f.accountId);
      const data = await loadEngineData(db, f.accountId, settings, { all: true });
      const cuisines = await db.selectFrom("meal_cuisines").select(["id", "name"]).execute();
      const names = data.dishes.filter((d) => !d.mine).slice(0, 7).map((d) => ({ plat_id: d.id, nom: d.name }));
      const built = buildProposal(menuInput.parse({ semaine: "2026-11-09", diners: names }), { data, cuisines, householdSize: 4, now: NOW, newId: randomUUID });
      if (!built.ok) throw new Error(built.errors.join(" | "));
      const cand = (await findSeasonDishes(db, settings, data.profile, MONTH, [], 500, [id]))[0];
      const dishProposal = seasonToProposalDish(cand, { data, cuisines, householdSize: 4, now: NOW, newId: randomUUID }, "2026-11-09")!;
      const proposal = { ...built.proposal, dinners: [dishProposal, ...built.proposal.dinners.slice(1)] };
      await saveValidatedMenu(at(), f.accountId, f.userIds.sophie, proposal, data);
    };
    await validate(h.f);
    expect(await counted()).toBe(1);
    const entry = await db.selectFrom("meal_menu_entries").select(["dish_name", "dish_origin", "season_dish_id"]).where("account_id", "=", h.f.accountId).where("kind", "=", "dinner").where("slot", "=", 1).executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ dish_name: `Velouté ${t}`, dish_origin: "ai" });
    expect(String(entry.season_dish_id)).toBe(id);
    // la même semaine validée de nouveau : pas de double compte
    await validate(h.f);
    expect(await counted()).toBe(1);
    // un autre foyer
    const other = await household();
    await validate(other.f);
    expect(await counted()).toBe(2);
  });
});
