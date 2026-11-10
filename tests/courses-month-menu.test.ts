import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { loadEngineData } from "@/server/courses/menu/data";
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
      expect(done.total).toBeLessThanOrEqual(card.total + 0.01);
      const menu = await db.selectFrom("meal_menus").select(["id", "session_minutes"]).where("account_id", "=", h.f.accountId).where("week_start", "=", w.week as never).executeTakeFirstOrThrow();
      expect(menu.session_minutes).toBe(205);
      expect(await db.selectFrom("meal_menu_session_steps").select("id").where("menu_id", "=", menu.id).execute()).toHaveLength(3);
    }
  });
});
