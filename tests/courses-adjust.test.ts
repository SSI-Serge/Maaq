import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { listCourseMessages } from "@/server/courses/chat/service";
import { computeScenarios, scenarioLines } from "@/server/courses/engine";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { fromDto } from "@/server/courses/list/dto";
import { prepareList, validateList } from "@/server/courses/list/service";
import { adjustLater, decideAdjustment, missingIngredients, proposeAdjustments } from "@/server/courses/menu-ia/adjust";
import { confirmTicket } from "@/server/courses/tickets/service";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";
import { validateTestMenu } from "./helpers/menu";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
process.env.MENU_IA = "live";

/** CR-58 (US-177) : ingrédients manquants après un ticket, « Ajuster le menu » par l'IA, plat remplacé dans le menu validé. */
const db = testDb();
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const W1 = "2026-11-09";
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
const callTool = (name: string, input: unknown): ModelResponse => ({ content: [{ type: "tool_use", id: "tu_1", name, input }], stopReason: "tool_use", usage, requestId: null });
function scripted(...steps: ModelResponse[]): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  let i = 0;
  return { id: "faux", seen, send: async (request) => (seen.push(structuredClone(request)), steps[Math.min(i++, steps.length - 1)]) };
}

async function validatedMenu(): Promise<{ f: CoupleFamily; bought: string }> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }] });
  await validateTestMenu(db, f, { picks: ["F4"], week: W1, now: NOW });
  const list = await prepareList(at(), f.sophie, W1);
  const model = fromDto(list.model!);
  const lines = scenarioLines(model, {}, computeScenarios(model, {}, [])[1]).map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, source: "menu" as const }));
  await validateList(at(), f.sophie, { scenario: 2, lines, week: W1 });
  return { f, bought: lines[0].name };
}

const ticketFor = (f: CoupleFamily, product: string, extra: string[] = []) =>
  confirmTicket(at(), f.sophie, { store: "Lidl", city: "Nantes", date: "2026-11-05", time: "10:00:00", lines: [{ product, reference: null, total: 3.2, qty: 1, aisle: "Autres" }, ...extra.map((e) => ({ product: e, reference: null, total: 1.5, qty: 1, aisle: "Autres" }))] } as never);

describe("Ajuster le menu après un ticket (CR-58)", () => {
  it("un ticket qui coche un produit du menu signale les ingrédients manquants plat par plat, placards ignorés ; un ticket sans produit du menu ne déclenche rien", async () => {
    const { f, bought } = await validatedMenu();
    // un ticket sans aucun produit de la liste : rien n'est signalé
    const none = await ticketFor(f, "Voiture jouet");
    expect(none.adjust).toBeNull();

    const done = await ticketFor(f, bought, ["Courgettes fraîches du marché"]);
    expect(done.adjust).not.toBeNull();
    const card = done.adjust!;
    expect(card).toMatchObject({ status: "open", canAdjust: true, week: W1 });
    expect(card.dishes.length).toBeGreaterThan(0);
    // le produit acheté n'est plus signalé comme manquant
    expect(card.dishes.flatMap((d) => d.missing).map((m) => m.toLowerCase())).not.toContain(bought.toLowerCase());
    expect(card.dishes.every((d) => d.missing.length > 0 && /^(dinner|express):\d+$/.test(d.key))).toBe(true);
    expect(card.dishes[0].day).toMatch(/^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|express)$/);

    // la carte est dans le tchat, sans les noms du ticket
    const messages = await listCourseMessages(at(), f.sophie);
    const seen = messages.find((m) => m.adjust?.messageId === card.messageId)!.adjust!;
    expect(JSON.stringify(seen)).not.toContain("Courgettes fraîches du marché");

    // tout acheter : plus rien ne manque ; les ingrédients en cuillère ou en pincée (placards) ne comptent jamais
    const menu = await db.selectFrom("meal_menus").select("id").where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    const left = await missingIngredients(db, f.accountId, menu.id);
    expect(left.length).toBeGreaterThan(0);
    await db.updateTable("grocery_list_items").set({ state: "bought", bought_at: NOW }).where("account_id", "=", f.accountId).execute();
    expect(await missingIngredients(db, f.accountId, menu.id)).toEqual([]);
  });

  it("« Je l'achèterai plus tard » ne redemande rien ; réservé au couple", async () => {
    const { f, bought } = await validatedMenu();
    const card = (await ticketFor(f, bought)).adjust!;
    expect((await rejection(adjustLater(at(), f.elodie, card.messageId))).status).toBe(403);
    const later = await adjustLater(at(), f.sophie, card.messageId);
    expect(later).toMatchObject({ status: "later", canAdjust: false });
    expect((await rejection(adjustLater(at(), f.sophie, card.messageId))).code).toBe("not_open");
    expect((await rejection(proposeAdjustments(at(), f.sophie, card.messageId, { model: scripted(callTool("proposer_ajustement", {})) }))).code).toBe("not_open");
  });

  it("« Ajuster le menu » : un appel compté 1 dans la limite, sans prix ni magasin ; accepter remplace le plat du menu validé et rouvre la liste, achats gardés ; refuser garde le plat", async () => {
    const { f, bought } = await validatedMenu();
    const card = (await ticketFor(f, bought, ["Courgettes"])).adjust!;
    const target = card.dishes[0];
    const second = card.dishes[1];
    const cuisine = (await db.selectFrom("meal_cuisines").select("name").orderBy("id").executeTakeFirstOrThrow()).name;
    const before = (await db.selectFrom("meal_menu_daily_counters").select("menu_count").where("account_id", "=", f.accountId).execute()).reduce((s, r) => s + r.menu_count, 0);
    const proposal = (plat: string, nom: string) => ({ plat, explication: `Remplacer les ingrédients manquants par ceux achetés (${nom}).`, nom, cuisine, duree_minutes: 40, recette: "Cuire doucement, saler, servir.", ingredients: [{ nom: "Courgettes", quantite: 600, unite: "g" }, { nom: "Oignons", quantite: 200, unite: "g" }] });
    const model = scripted(callTool("proposer_ajustement", { propositions: [proposal(target.name, "Gratin de courgettes"), proposal(second.name, "Poêlée de courgettes"), proposal("Plat inconnu", "Inconnu")] }));
    const proposed = await proposeAdjustments(at(), f.sophie, card.messageId, { model });
    expect(model.seen).toHaveLength(1);
    const sent = JSON.stringify(model.seen[0].messages);
    expect(sent).toContain(target.name);
    expect(sent).toContain("Courgettes");
    expect(sent).not.toMatch(/€|Lidl|Nantes|2026-11-05|Sophie|Marc/);
    expect(proposed.status).toBe("proposed");
    expect(proposed.proposals.map((p) => p.key)).toEqual([target.key, second.key]);
    const after = (await db.selectFrom("meal_menu_daily_counters").select("menu_count").where("account_id", "=", f.accountId).execute()).reduce((s, r) => s + r.menu_count, 0);
    expect(after).toBe(before + 1);

    // accepter : le plat est remplacé dans le menu validé, la liste se rouvre, le produit acheté reste acheté
    const menuRow = await db.selectFrom("meal_menus").select("id").where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    await db.insertInto("meal_menu_session_steps").values({ menu_id: menuRow.id, account_id: f.accountId, position: 1, body: "Tout préparer.", duration_minutes: 90 } as never).execute();
    const [kind, slot] = target.key.split(":");
    const accepted = await decideAdjustment({ db, now: new Date(NOW.getTime() + 3_600_000) }, f.sophie, { messageId: card.messageId, key: target.key, accept: true });
    expect(accepted.decided[target.key]).toBe("accepted");
    expect(accepted.status).toBe("proposed");
    const entry = await db.selectFrom("meal_menu_entries").select(["dish_name", "dish_origin", "duration_minutes"]).where("kind", "=", kind as never).where("slot", "=", Number(slot)).where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ dish_name: "Gratin de courgettes", dish_origin: "ai", duration_minutes: 40 });
    const items = await db.selectFrom("grocery_list_items").select(["name_key", "state"]).where("account_id", "=", f.accountId).execute();
    expect(items.some((i) => i.state === "bought")).toBe(true);
    expect(items.filter((i) => i.state === "validated")).toEqual([]);
    expect((await prepareList(at(), f.sophie, W1)).validated).toBe(false);
    // un plat de la séance a changé : le déroulé est effacé, la durée est estimée, « Déroulé à mettre à jour » avec « Rédiger le déroulé » est proposé
    if (kind === "dinner" && Number(slot) <= 5) {
      expect(await db.selectFrom("meal_menu_session_steps").select("id").where("menu_id", "=", menuRow.id).execute()).toEqual([]);
      expect((await db.selectFrom("meal_menus").select("session_is_estimated").where("id", "=", menuRow.id).executeTakeFirstOrThrow()).session_is_estimated).toBe(true);
      expect((await prepareList(at(), f.sophie, W1)).menu!.canWriteSteps).toBe(true);
    }

    // refuser le second : le plat reste, la carte se ferme
    const closed = await decideAdjustment(at(), f.sophie, { messageId: card.messageId, key: second.key, accept: false });
    expect(closed).toMatchObject({ status: "closed" });
    expect((await db.selectFrom("meal_menu_entries").select("dish_name").where("account_id", "=", f.accountId).where("dish_name", "=", second.name).execute()).length).toBe(1);
    expect((await rejection(decideAdjustment(at(), f.sophie, { messageId: card.messageId, key: second.key, accept: true }))).code).toBe("not_open");
  });

  it("si l'IA ne répond pas correctement, la carte reste en attente (« Ajuster le menu » reste proposé)", async () => {
    const { f, bought } = await validatedMenu();
    const card = (await ticketFor(f, bought)).adjust!;
    const failed = await proposeAdjustments(at(), f.sophie, card.messageId, { model: scripted({ content: [{ type: "text", text: "Désolé." }], stopReason: "end_turn", usage, requestId: null }) });
    expect(failed).toMatchObject({ status: "open", failed: true, canAdjust: true, proposals: [] });
  });
});
