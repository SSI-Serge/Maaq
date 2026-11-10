import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { loadEngineData } from "@/server/courses/menu/data";
import { applyBundles, type Bundle } from "@/server/courses/month/reuse";
import type { PoolDish } from "@/server/courses/month/solver";
import { composeMonth, monthReplace, monthReplaceOptions, monthStatus, monthValidate, monthWriteSteps, MIN_MENUS } from "@/server/courses/month/service";
import { loadSettings } from "@/server/courses/household/settings";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";
import { validateTestMenu } from "./helpers/menu";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
process.env.MENU_IA = "live";

/** CR-59, CR-60, CR-62, CR-63 : le menu du mois dans le budget. Jeudi 12 novembre 2026 ; l'historique du foyer remonte à la fin septembre. */
const db = testDb();
const NOW = new Date(2026, 10, 12, 10, 0, 0);
const START = "2026-11-16";
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
function seasonModel(cuisine: string): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  const respond = (n: number): ModelResponse => ({
    content: [{ type: "tool_use", id: "tu", name: "proposer_plats_de_saison", input: { plats: Array.from({ length: 12 }, (_, i) => ({ nom: `Plat de saison ${n}-${i + 1}`, cuisine, mois: [11], etiquettes: [], duree_minutes: 15 + (i % 3) * 5, recette: "Cuire et servir.", ingredients: [{ nom: "Courgettes", quantite: 600, unite: "g" }, { nom: "Riz long / basmati", quantite: 300, unite: "g" }] })) } }],
    stopReason: "tool_use",
    usage,
    requestId: null,
  });
  return { id: "faux", seen, send: async (request) => (seen.push(structuredClone(request)), respond(seen.length)) };
}

async function household(menus: number, budget: number | null = 420): Promise<{ f: CoupleFamily; cuisine: string }> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }], monthlyBudget: budget });
  const data = await loadEngineData(db, f.accountId, await loadSettings(db, f.accountId));
  const ids = data.dishes.filter((d) => !d.mine).map((d) => d.id);
  // des menus validés à des dates passées, chacun avec d'autres plats
  const mondays = ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"];
  for (let i = 0; i < Math.min(menus, mondays.length); i++) {
    const tuesday = new Date(Number(mondays[i].slice(0, 4)), Number(mondays[i].slice(5, 7)) - 1, Number(mondays[i].slice(8)) + 1, 10, 0, 0);
    await validateTestMenu(db, f, { picks: ids.slice(i * 8, i * 8 + 7), week: mondays[i], express: true, now: tuesday });
  }
  return { f, cuisine: options.cuisines[0].name };
}

describe("Menu du mois : ouverture (CR-59, CR-63)", () => {
  it("il faut un budget et 6 menus validés ; l'état dit combien de menus et de tickets", async () => {
    const few = await household(4);
    expect(await monthStatus(at(), few.f.sophie)).toMatchObject({ menus: 4, tickets: 0, budget: 420, ready: false, card: null });
    expect((await rejection(composeMonth(at(), few.f.sophie, {}))).code).toBe("not_ready");
    expect((await rejection(composeMonth(at(), few.f.sophie, {}))).message).toContain("(vous en avez 4)");
    const none = await household(MIN_MENUS, null);
    expect((await rejection(composeMonth(at(), none.f.sophie, {}))).code).toBe("budget_missing");
    // un invité secondaire n'a pas ce parcours
    expect((await rejection(composeMonth(at(), none.f.elodie, {}))).status).toBe(403);
    expect((await rejection(monthStatus(at(), none.f.elodie))).status).toBe(403);
  });
});

describe("Menu du mois : proposition, autre proposition, remplacement, validation", () => {
  it("quatre semaines de sept dîners et quatre plats express, tous différents, chiffrées ; l'IA n'est appelée que pour les plats de saison manquants (comptée 1) ; « Autre proposition » change de plats", async () => {
    const h = await household(MIN_MENUS);
    const model = seasonModel(h.cuisine);
    const card = await composeMonth(at(), h.f.sophie, { startWeek: START }, { model });
    expect(card.weeks.map((w) => w.week)).toEqual(["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"]);
    const dinners = card.weeks.flatMap((w) => w.proposal.dinners);
    const express = card.weeks.flatMap((w) => w.proposal.express);
    const names = [...dinners, ...express].map((d) => d.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(dinners.length + card.notes.missingDinners).toBe(28);
    expect(express.length).toBeLessThanOrEqual(16);
    // les coûts des semaines s'additionnent au total ; le budget est comparé tel quel
    expect(card.weeks.reduce((s, w) => s + w.cost, 0)).toBeCloseTo(card.total, 1);
    expect(card.budget).toBe(420);
    expect(card.overBy === null ? card.total <= 420 : card.total > 420).toBe(true);
    // les plats de saison viennent de la base commune ou de l'IA ; l'appel est compté une fois
    const counter = (await db.selectFrom("meal_menu_daily_counters").select("menu_count").where("account_id", "=", h.f.accountId).execute()).reduce((s, r) => s + r.menu_count, 0);
    expect(counter).toBeLessThanOrEqual(2);
    if (model.seen.length) expect(JSON.stringify(model.seen[0].messages)).not.toMatch(/€|Lidl|Sophie|Marc|Nantes/);
    // la carte n'apparaît pas dans le tchat
    const { listCourseMessages } = await import("@/server/courses/chat/service");
    expect((await listCourseMessages(at(), h.f.sophie)).some((m) => m.text.includes('"card":"month"'))).toBe(false);

    // « Autre proposition » : d'autres plats (en partie), mêmes règles
    const next = await composeMonth(at(), h.f.sophie, { startWeek: START, variant: 1, previous: card.messageId }, { model });
    const nextNames = new Set([...next.weeks.flatMap((w) => [...w.proposal.dinners, ...w.proposal.express])].map((d) => d.name.toLowerCase()));
    const overlap = names.filter((n) => nextNames.has(n)).length;
    expect(overlap).toBeLessThan(names.length);
    expect(next.variant).toBe(1);
    // l'état rend la dernière proposition ouverte
    expect((await monthStatus(at(), h.f.sophie)).card?.messageId).toBe(next.messageId);
  });

  it("hors budget : le total le moins cher est proposé avec « Dépasse votre budget de … » et les 3 plats qui coûtent le plus", async () => {
    const h = await household(MIN_MENUS, 1);
    const card = await composeMonth(at(), h.f.sophie, { startWeek: START }, { model: seasonModel(h.cuisine) });
    expect(card.overBy).not.toBeNull();
    expect(card.overBy).toBeCloseTo(card.total - 1, 1);
    expect(card.expensive.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < card.expensive.length; i++) expect(card.expensive[i - 1].cost).toBeGreaterThanOrEqual(card.expensive[i].cost);
  });

  it("remplacer un plat se fait sans IA et recalcule les coûts ; un plat déjà proposé une autre semaine est refusé ; « Valider les 4 menus » enregistre menus et listes, garde une semaine au choix", async () => {
    const h = await household(MIN_MENUS);
    const model = seasonModel(h.cuisine);
    const card = await composeMonth(at(), h.f.sophie, { startWeek: START }, { model });
    const calls = model.seen.length;
    const w0 = card.weeks[0];
    const swapIndex = w0.proposal.express.length ? 0 : -1;
    if (swapIndex >= 0 && w0.proposal.dinners.length) {
      const options = await monthReplaceOptions(at(), h.f.sophie, { messageId: card.messageId, week: w0.week, kind: "dinner", index: 0 });
      expect(options.express.length).toBeGreaterThan(0);
      const swapped = await monthReplace(at(), h.f.sophie, { messageId: card.messageId, week: w0.week, kind: "dinner", index: 0, choice: { group: "express", index: 0 } });
      expect(swapped.weeks[0].proposal.dinners[0].name).toBe(w0.proposal.express[0].name);
      expect(swapped.weeks[0].proposal.express[0].name).toBe(w0.proposal.dinners[0].name);
      // le total reste cohérent avec les semaines
      expect(swapped.weeks.reduce((s, w) => s + w.cost, 0)).toBeCloseTo(swapped.total, 1);
    }
    expect(model.seen.length).toBe(calls);
    expect((await rejection(monthReplace(at(), h.f.sophie, { messageId: card.messageId, week: "2027-01-04", kind: "dinner", index: 0, choice: { group: "dinners", index: 1 } }))).code).toBe("invalid_week");

    // une semaine a déjà un menu : elle est gardée, les autres sont validées
    const complete = card.weeks.filter((w) => w.proposal.complete);
    expect(complete.length).toBeGreaterThanOrEqual(2);
    if (complete.length === card.weeks.length) {
      const kept = card.weeks[1].week;
      const done = await monthValidate(at(), h.f.sophie, { messageId: card.messageId, keep: [kept] });
      expect(done.validated).toEqual(card.weeks.filter((w) => w.week !== kept).map((w) => w.week));
      expect(done.kept).toEqual([kept]);
      expect(done.groupWeeks).toEqual(done.validated);
      const menus = await db.selectFrom("meal_menus").select("week_start").where("account_id", "=", h.f.accountId).execute();
      expect(menus.length).toBe(MIN_MENUS + 3);
      // les plats de saison choisis comptent pour le foyer, la carte est fermée
      expect((await monthStatus(at(), h.f.sophie)).card).toBeNull();
      expect((await rejection(monthValidate(at(), h.f.sophie, { messageId: card.messageId }))).code).toBe("already_validated");
    } else {
      // historique trop court pour une semaine complète : elle ne se valide pas
      expect((await rejection(monthValidate(at(), h.f.sophie, { messageId: card.messageId }))).code).toBe("menu_incomplete");
    }
  });
});

describe("Menu du mois : « Rédiger le déroulé » et total recalculé (US-178 RF9, RF10)", () => {
  it("le déroulé d'une semaine se rédige avant la validation (compté 1 dans la limite), il est enregistré avec le menu ; le total validé est recalculé quand une semaine est gardée", async () => {
    const h = await household(MIN_MENUS);
    const card = await composeMonth(at(), h.f.sophie, { startWeek: START }, { model: seasonModel(h.cuisine) });
    const w = card.weeks.find((x) => x.proposal.complete)!;
    expect(w).toBeTruthy();
    const names = w.proposal.dinners.slice(0, 5).map((d) => d.name);
    const counter = async () => (await db.selectFrom("meal_menu_daily_counters").select("menu_count").where("account_id", "=", h.f.accountId).execute()).reduce((sum, r) => sum + r.menu_count, 0);
    const before = await counter();
    const steps = [
      { texte: "Préparer les légumes.", duree_minutes: 40 },
      { texte: "Cuire le premier plat.", plat: names[0], duree_minutes: 160 },
      { texte: "Ranger le premier plat.", plat: names[0], duree_minutes: 5, conservation: "frigo", jour_sortie: 2 },
    ];
    const model: AssistantModel & { seen: ModelRequest[] } = { id: "faux", seen: [], send: async (request) => (model.seen.push(structuredClone(request)), { content: [{ type: "tool_use", id: "t", name: "proposer_deroule", input: { etapes: steps } }], stopReason: "tool_use", usage, requestId: null }) };
    const written = await monthWriteSteps(at(), h.f.sophie, { messageId: card.messageId, week: w.week }, { model });
    const after = written.weeks.find((x) => x.week === w.week)!.proposal;
    expect(after.steps).toHaveLength(3);
    expect(after.session).toMatchObject({ source: "steps", minutes: 205, estimated: true });
    expect(await counter()).toBe(before + 1);
    expect(JSON.stringify(model.seen[0].messages)).not.toMatch(/€|Lidl|Sophie|Nantes/);
    expect((await rejection(monthWriteSteps(at(), h.f.sophie, { messageId: card.messageId, week: "2027-01-04" }, { model }))).code).toBe("invalid_week");
    expect((await rejection(monthWriteSteps(at(), h.f.elodie, { messageId: card.messageId, week: w.week }, { model }))).status).toBe(403);
    // une réponse invalide ne change rien
    const bad: AssistantModel = { id: "faux", send: async () => ({ content: [{ type: "text", text: "Désolé." }], stopReason: "end_turn", usage, requestId: null }) };
    expect((await rejection(monthWriteSteps(at(), h.f.sophie, { messageId: card.messageId, week: card.weeks.find((x) => x.week !== w.week && x.proposal.complete)?.week ?? w.week }, { model: bad }))).code).toBe("steps_failed");

    if (card.weeks.every((x) => x.proposal.complete)) {
      const kept = card.weeks.find((x) => x.week !== w.week)!.week;
      const done = await monthValidate(at(), h.f.sophie, { messageId: card.messageId, keep: [kept] });
      expect(done.total).toBeGreaterThan(0);
      // les prix se calculent par paquet entier : retirer une semaine ne baisse pas toujours le total au centime près (la composition varie avec l'identifiant du foyer)
      expect(done.total).toBeLessThanOrEqual(card.total * 1.15);
      const menu = await db.selectFrom("meal_menus").select(["id", "session_minutes"]).where("account_id", "=", h.f.accountId).where("week_start", "=", w.week as never).executeTakeFirstOrThrow();
      expect(menu.session_minutes).toBe(205);
      expect(await db.selectFrom("meal_menu_session_steps").select("id").where("menu_id", "=", menu.id).execute()).toHaveLength(3);
    }
  });
});

describe("Menu du mois : reprise du déroulé (US-178 RF9, décision du PO)", () => {
  it("les cinq dîners d'une semaine correspondent à une séance que le foyer a déjà faite : son déroulé et sa durée sont repris, sans IA ; les autres semaines gardent la durée estimée et « Rédiger le déroulé »", async () => {
    const h = await household(MIN_MENUS, 99999);
    // le foyer a déjà fait une séance de cinq plats du catalogue (plus ancienne que les autres), avec un déroulé écrit
    const data = await loadEngineData(db, h.f.accountId, await loadSettings(db, h.f.accountId));
    await validateTestMenu(db, h.f, { picks: data.dishes.filter((d) => !d.mine).slice(50, 55).map((d) => d.id), week: "2026-09-14", express: true, now: new Date(2026, 8, 15, 10, 0, 0) });
    const menu = await db.selectFrom("meal_menus").select("id").where("account_id", "=", h.f.accountId).where("week_start", "=", "2026-09-14" as never).executeTakeFirstOrThrow();
    const dinners = await db.selectFrom("meal_menu_entries").select(["id", "slot", "dish_name"]).where("menu_id", "=", menu.id).where("kind", "=", "dinner").orderBy("slot").execute();
    await db.updateTable("meal_menus").set({ session_minutes: 95, session_is_estimated: true }).where("id", "=", menu.id).execute();
    await db
      .insertInto("meal_menu_session_steps")
      .values([
        { menu_id: menu.id, account_id: h.f.accountId, position: 1, body: "Préparer tous les légumes.", entry_id: null, duration_minutes: 35, overlaps_position: null, storage_mode: null, take_out_day: null },
        { menu_id: menu.id, account_id: h.f.accountId, position: 2, body: "Cuire le premier plat.", entry_id: dinners[0].id as never, duration_minutes: 55, overlaps_position: null, storage_mode: null, take_out_day: null },
        { menu_id: menu.id, account_id: h.f.accountId, position: 3, body: "Ranger le premier plat.", entry_id: dinners[0].id as never, duration_minutes: 5, overlaps_position: null, storage_mode: "fridge", take_out_day: 2 },
      ])
      .execute();
    const model = seasonModel(h.cuisine);
    const card = await composeMonth(at(), h.f.sophie, { startWeek: START }, { model });
    const reused = card.weeks.filter((w) => w.proposal.reused === "session");
    expect(reused).toHaveLength(1);
    const week = reused[0].proposal;
    expect(week.dinners.slice(0, 5).map((d) => d.name)).toEqual(dinners.slice(0, 5).map((d) => d.dish_name));
    expect(week.steps.map((s) => s.text)).toEqual(["Préparer tous les légumes.", "Cuire le premier plat.", "Ranger le premier plat."]);
    expect(week.steps[1].dish).toBe(dinners[0].dish_name);
    expect(week.steps[2]).toMatchObject({ storage: "fridge", takeOutDay: 2 });
    expect(week.session).toMatchObject({ source: "steps", minutes: 95, estimated: true });
    expect(week.planId).toBeNull();
    // les autres semaines : durée estimée par la formule, pas de déroulé, « Rédiger le déroulé » reste facultatif
    for (const w of card.weeks.filter((x) => x.proposal.reused === undefined)) {
      expect(w.proposal.steps).toEqual([]);
      expect(w.proposal.session).toMatchObject({ source: "formula", estimated: true });
    }
    // aucun appel à l'IA pour la reprise
    expect(JSON.stringify(model.seen).includes("Préparer tous les légumes")).toBe(false);

    // le déroulé est enregistré avec le menu à la validation
    if (card.weeks.every((w) => w.proposal.complete)) {
      await monthValidate(at(), h.f.sophie, { messageId: card.messageId, keep: card.weeks.filter((w) => w.week !== reused[0].week).map((w) => w.week) });
      const saved = await db.selectFrom("meal_menus").select(["id", "session_minutes", "batch_week_id"]).where("account_id", "=", h.f.accountId).where("week_start", "=", reused[0].week as never).executeTakeFirstOrThrow();
      expect(saved.session_minutes).toBe(95);
      expect(saved.batch_week_id).toBeNull();
      expect(await db.selectFrom("meal_menu_session_steps").select("id").where("menu_id", "=", saved.id).execute()).toHaveLength(3);
    }
  });

  it("les cinq dîners correspondent à une semaine type : son planning et sa durée sont repris, sans IA ; un plat remplacé efface la reprise (durée par la formule, « Rédiger le déroulé » proposé)", async () => {
    const h = await household(MIN_MENUS, 99999);
    const data = await loadEngineData(db, h.f.accountId, await loadSettings(db, h.f.accountId));
    // aucune semaine type du catalogue de test n'a ses cinq plats dans le catalogue : on en crée une, retirée à la fin
    const codes = data.dishes.filter((d) => !d.mine).slice(50, 55);
    const dishRows = await db.selectFrom("meal_dishes").select(["id", "code", "name", "cuisine_id"]).where("code", "in", codes.map((d) => d.id)).execute();
    const ordered = codes.map((c) => dishRows.find((r) => r.code === c.id)!);
    const [week] = await db
      .insertInto("meal_batch_weeks")
      .values({ code: "ZR1", cuisine_id: ordered[0].cuisine_id, theme: "Semaine de reprise", session_minutes: 100, session_text: "Hacher tous les légumes.\nCuire les cinq plats.\nRanger au frais.", shared_ingredients_pct: 50 })
      .returning(["id"])
      .execute();
    try {
      await db
        .insertInto("meal_batch_week_days")
        .values(ordered.map((r, i) => ({ week_id: week.id, weekday: i + 1, planning_dish_name: r.name, dish_id: r.id, match_pct: 100 })))
        .execute();
      // le foyer a déjà fait ces cinq plats (une semaine plus ancienne que les autres)
      await validateTestMenu(db, h.f, { picks: codes.map((d) => d.id), week: "2026-09-21", express: true, now: new Date(2026, 8, 22, 10, 0, 0) });
      const model = seasonModel(h.cuisine);
      const card = await composeMonth(at(), h.f.sophie, { startWeek: START }, { model });
      const reused = card.weeks.filter((w) => w.proposal.reused === "plan");
      expect(reused).toHaveLength(1);
      const proposal = reused[0].proposal;
      expect(proposal.planId).toBe("ZR1");
      expect(proposal.planTheme).toBe("Semaine de reprise");
      expect(proposal.planSteps).toEqual(["Hacher tous les légumes.", "Cuire les cinq plats.", "Ranger au frais."]);
      expect(proposal.steps).toEqual([]);
      expect(proposal.session).toMatchObject({ source: "plan", minutes: 100, estimated: false });
      expect(proposal.dinners.slice(0, 5).map((d) => d.name)).toEqual(ordered.map((r) => r.name));
      expect(JSON.stringify(model.seen).includes("Hacher tous les légumes")).toBe(false);
      // les autres semaines gardent la formule
      for (const w of card.weeks.filter((x) => x.proposal.reused === undefined)) expect(w.proposal.session.source).toBe("formula");

      // remplacer un des cinq plats : la reprise ne vaut plus
      const swapped = await monthReplace(at(), h.f.sophie, { messageId: card.messageId, week: reused[0].week, kind: "dinner", index: 0, choice: { group: "express", index: 0 } });
      const after = swapped.weeks.find((w) => w.week === reused[0].week)!.proposal;
      expect(after.planId).toBeNull();
      expect(after.planSteps).toEqual([]);
      expect(after.reused).toBeUndefined();
      expect(after.steps).toEqual([]);
      expect(after.session.source).toBe("formula");
    } finally {
      await db.deleteFrom("meal_batch_weeks").where("code", "=", "ZR1").execute();
    }
  });

  it("un modèle qui coûterait plus cher que la proposition et le budget n'est pas repris (la durée reste estimée) ; sous le budget il l'est ; un modèle plus long que le plafond de séance ne l'est pas", () => {
    const need = (kg: number) => new Map([["Produit", { kg, l: 0, piece: 0, spoon: 0, pinch: 0 }]]);
    const dish = (key: string, kg: number): PoolDish => ({ key, name: key, minutes: 20, cuisine: "x", express: false, needs: need(kg), unpriced: 0 });
    const cheap = ["a", "b", "c", "d", "e"].map((k) => dish(k, 0.1));
    const dear = ["v", "w", "x", "y", "z"].map((k) => dish(k, 2));
    const price = (_p: string, n: { kg: number }) => n.kg * 10;
    const bundle: Bundle = { kind: "session", keys: ["v", "w", "x", "y", "z"], minutes: 90, estimated: true, steps: [] };
    const solution = { weeks: [{ dinners: [...cheap], express: [] }], total: 0, unpricedProducts: 0, weekCosts: [0], missingDinners: 0, missingExpress: 0 };
    const refused = applyBundles(solution, [...cheap, ...dear], [bundle], price, { budget: 20, sessionCap: null });
    expect(refused.reuse).toEqual([null]);
    expect(refused.solution.weeks[0].dinners.map((d) => d?.key)).toEqual(["a", "b", "c", "d", "e"]);
    const taken = applyBundles(solution, [...cheap, ...dear], [bundle], price, { budget: 200, sessionCap: null });
    expect(taken.reuse[0]).toBe(bundle);
    expect(taken.solution.weeks[0].dinners.map((d) => d?.key)).toEqual(["v", "w", "x", "y", "z"]);
    expect(applyBundles(solution, [...cheap, ...dear], [bundle], price, { budget: 200, sessionCap: 60 }).reuse).toEqual([null]);
  });

  it("un plat du modèle placé dans une autre semaine change de place avec un plat de la séance qui s'en va ; un plat express ne peut être remplacé que par un plat qui peut l'être ; le plafond de séance des autres semaines est respecté", () => {
    const dish = (key: string, minutes: number, express = false): PoolDish => ({ key, name: key, minutes, cuisine: "x", express, needs: new Map([["Produit", { kg: 0.1, l: 0, piece: 0, spoon: 0, pinch: 0 }]]), unpriced: 0 });
    const price = () => 1;
    const week0 = ["a", "b", "c", "d", "e"].map((k) => dish(k, 20));
    const week1 = ["v", "w", "x", "y", "z"].map((k) => dish(k, 20));
    const pool = [...week0, ...week1];
    const solution = { weeks: [{ dinners: [...week0], express: [] }, { dinners: [...week1], express: [] }], total: 0, unpricedProducts: 0, weekCosts: [0, 0], missingDinners: 0, missingExpress: 0 };
    // le modèle prend deux plats de la semaine 1 : « d » et « e » prennent leur place
    const bundle: Bundle = { kind: "plan", keys: ["a", "b", "c", "v", "w"], minutes: 100, estimated: false, planId: "P1", planSteps: ["Tout cuire."] };
    const moved = applyBundles(solution, pool, [bundle], price, { budget: null, sessionCap: 120 });
    expect(moved.reuse[0]).toBe(bundle);
    expect(moved.reuse[1]).toBeNull();
    expect(moved.solution.weeks[0].dinners.map((d) => d?.key)).toEqual(["a", "b", "c", "v", "w"]);
    const all = moved.solution.weeks.flatMap((w) => w.dinners.map((d) => d?.key));
    expect(new Set(all).size).toBe(10);
    expect(moved.solution.weeks[1].dinners.slice(0, 5).map((d) => d?.key).sort()).toEqual(["d", "e", "x", "y", "z"]);
    // plafond de la semaine 1 : « d » et « e » sont longs, la semaine 1 dépasserait 120 minutes
    const long = [dish("a", 20), dish("b", 20), dish("c", 20), dish("d", 90), dish("e", 90)];
    const tight = { ...solution, weeks: [{ dinners: [...long], express: [] }, { dinners: [...week1], express: [] }] };
    expect(applyBundles(tight, [...long, ...week1], [bundle], price, { budget: null, sessionCap: 120 }).reuse).toEqual([null, null]);
    // un plat du modèle qui tient une place express ne peut être remplacé que par un plat express
    const quick = dish("v", 15, true);
    const withExpress = { ...solution, weeks: [{ dinners: [...week0], express: [] }, { dinners: week1.slice(1).concat(dish("q", 20)), express: [quick] }] };
    expect(applyBundles(withExpress, [...week0, ...week1.slice(1), dish("q", 20), quick], [bundle], price, { budget: null, sessionCap: null }).reuse[0]).toBeNull();
  });
});
