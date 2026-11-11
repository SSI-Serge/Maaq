import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { weekStartLabel } from "@/server/courses/list/weeks";
import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx } from "@/server/auth/service";
import { sendCourseMessage } from "@/server/courses/chat/service";
import { executeCourseTool, toolContext } from "@/server/courses/chat/tools";
import { nameKey } from "@/server/courses/catalog/seed";
import { computeScenarios, scenarioLines } from "@/server/courses/engine";
import { getSettings, loadSettings, saveSettings } from "@/server/courses/household/settings";
import { deleteWeekList, deleteWeekMenu } from "@/server/courses/list/delete";
import { fromDto } from "@/server/courses/list/dto";
import { myList, setBought } from "@/server/courses/list/mine";
import { addProduct, prepareList, validateList } from "@/server/courses/list/service";
import { confirmTicket } from "@/server/courses/tickets/service";
import { loadEngineData } from "@/server/courses/menu/data";
import { menuInput } from "@/server/courses/menu-ia/contract";
import { buildProposal } from "@/server/courses/menu-ia/proposal";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";
import { validateTestMenu } from "./helpers/menu";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
process.env.MENU_IA = "live";

/**
 * Deux semaines à la fois (CR-54) et produits « pas encore acheté » de la liste d'avant (CR-55). Mercredi 4 novembre 2026 : la semaine en cours commence le lundi 2, la suivante le 9.
 */
const db = testDb();
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const W0 = "2026-11-02";
const W1 = "2026-11-09";
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

async function ready(): Promise<CoupleFamily> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }] });
  return f;
}

const menu = (f: CoupleFamily, week: string, now: Date = NOW, picks: string[] = ["F4"]) => validateTestMenu(db, f, { picks, week, now });
const menuId = async (f: CoupleFamily, week: string) => (await db.selectFrom("meal_menus").select("id").where("account_id", "=", f.accountId).where("week_start", "=", week as never).executeTakeFirstOrThrow()).id;
const items = (f: CoupleFamily, week: string) =>
  db.selectFrom("grocery_list_items as i").innerJoin("meal_menus as m", "m.id", "i.menu_id").select(["i.name_key", "i.label", "i.state", "i.source", "i.menu_id"]).where("i.account_id", "=", f.accountId).where("m.week_start", "=", week as never).execute();

/** Valide la liste d'une semaine (scénario 2) et rend les lignes envoyées. */
async function validate(f: CoupleFamily, week: string, ctx: Ctx = at(), extra: { name: string; source: "added" }[] = []) {
  const list = await prepareList(ctx, f.sophie, week);
  const model = fromDto(list.model!);
  const lines = scenarioLines(model, {}, computeScenarios(model, {}, [])[1]).map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, source: "menu" as const }));
  await validateList(ctx, f.sophie, { scenario: 2, lines: [...lines, ...extra.map((e) => ({ name: e.name, qty: 1, store: null, ref: null, price: null, source: e.source }))], week });
  return lines;
}

/** Rappels « Pas encore acheté » d'une liste : ils sont dans « Produits de mon historique » (CR-68), jamais dans « Produits ajoutés ». */
const reminders = (list: Awaited<ReturnType<typeof prepareList>>) =>
  (list.model?.items ?? []).filter((i) => i.leftoverWeek).map((i) => ({ key: nameKey(i.name), name: i.name, group: i.group, checked: i.checked, leftoverOf: `semaine du ${weekStartLabel(i.leftoverWeek as string)}` }));

describe("CR-54 : deux semaines, chacune avec son menu et sa liste", () => {
  it("chaque semaine a son menu et sa liste ; valider ou refaire l'une ne touche pas l'autre ; seules cette semaine et la suivante existent", async () => {
    const f = await ready();
    await menu(f, W0);
    await menu(f, W1);
    const first = await prepareList(at(), f.sophie);
    expect(first.week).toBe(W0);
    // la semaine en cours et les quatre suivantes (CR-56)
    expect(first.weeks.map((w) => [w.week, w.label, w.hasMenu, w.hasList])).toEqual([
      [W0, "Cette semaine (du 2 au 8 nov.)", true, false],
      [W1, "Semaine du 9 au 15 nov.", true, false],
      ["2026-11-16", "Semaine du 16 au 22 nov.", false, false],
      ["2026-11-23", "Semaine du 23 au 29 nov.", false, false],
      ["2026-11-30", "Semaine du 30 nov. au 6 déc.", false, false],
    ]);
    expect((await items(f, W0)).length).toBeGreaterThan(10);
    expect((await items(f, W1)).every((i) => i.state === "preparing")).toBe(true);

    await validate(f, W1);
    const next = await prepareList(at(), f.sophie, W1);
    expect(next.validated).toBe(true);
    expect((await prepareList(at(), f.sophie, W0)).validated).toBe(false);
    expect(next.weeks.map((w) => w.hasList)).toEqual([false, true, false, false, false]);
    expect((await items(f, W0)).every((i) => i.state === "preparing")).toBe(true);
    expect((await items(f, W1)).every((i) => i.state === "validated")).toBe(true);
    expect(await db.selectFrom("grocery_lists").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(1);

    // le menu de la semaine suivante est refait : sa liste se rouvre, celle de la semaine en cours ne bouge pas
    await validate(f, W0);
    await menu(f, W1, new Date(NOW.getTime() + 3_600_000));
    expect((await prepareList(at(), f.sophie, W1)).validated).toBe(false);
    expect((await items(f, W0)).every((i) => i.state === "validated")).toBe(true);
    expect((await items(f, W1)).every((i) => i.state === "preparing")).toBe(true);
    expect(await db.selectFrom("grocery_lists").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(2);

    // revalider une semaine met à jour sa liste, sans en créer une seconde
    await validate(f, W1);
    await validate(f, W1);
    expect(await db.selectFrom("grocery_lists").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(2);

    expect((await rejection(prepareList(at(), f.sophie, "2026-12-07"))).code).toBe("invalid_week");
    expect((await rejection(prepareList(at(), f.sophie, "2026-10-26"))).status).toBe(422);
  });

  it("CR-56 : on prépare la semaine en cours et les quatre suivantes, pas une de plus ; le sélecteur de Ma liste ne porte que sur les semaines qui ont une liste", async () => {
    const f = await ready();
    await menu(f, "2026-11-30");
    await menu(f, "2026-11-16");
    expect((await prepareList(at(), f.sophie, "2026-11-30")).menu?.week).toBe("2026-11-30");
    expect((await prepareList(at(), f.sophie)).week).toBe("2026-11-16");
    expect((await rejection(menu(f, "2026-12-07"))).message).toMatch(/quatre suivantes/);
    await validate(f, "2026-11-30");
    const mine = await myList(at(), f.sophie);
    expect(mine.week).toBe("2026-11-30");
    expect(mine.weeks.filter((w) => w.hasList).map((w) => w.week)).toEqual(["2026-11-30"]);
    // ticket ou coche : la semaine la plus proche d'abord, puis les suivantes
    await validate(f, "2026-11-16");
    const key = nameKey((await items(f, "2026-11-16")).find((i) => i.state === "validated")!.label);
    await setBought(at(), f.sophie, { key, bought: true, late: false });
    const near = (await items(f, "2026-11-16")).find((i) => i.name_key === key)!.state;
    const far = (await items(f, "2026-11-30")).find((i) => i.name_key === key)?.state;
    expect(near).toBe("bought");
    if (far) expect(far).toBe("validated");
  });

  it("Ma liste : la semaine en cours par défaut, la semaine suivante au choix ; un produit présent sur les deux listes est coché sur la semaine en cours d'abord", async () => {
    const f = await ready();
    await menu(f, W0);
    await menu(f, W1);
    const lines = await validate(f, W0);
    await validate(f, W1);
    const key = nameKey(lines[0].name);

    const mine = await myList(at(), f.sophie);
    expect(mine.week).toBe(W0);
    expect(mine.weeks.map((w) => w.hasList)).toEqual([true, true, false, false, false]);
    expect((await myList(at(), f.sophie, W1)).week).toBe(W1);

    await setBought(at(), f.sophie, { key, bought: true, late: false });
    const state = async (week: string) => (await items(f, week)).find((i) => i.name_key === key)!.state;
    expect([await state(W0), await state(W1)]).toEqual(["bought", "validated"]);
    await setBought(at(), f.sophie, { key, bought: true, late: false });
    expect([await state(W0), await state(W1)]).toEqual(["bought", "bought"]);
    expect((await rejection(setBought(at(), f.sophie, { key, bought: true, late: false }))).code).toBe("not_in_list");
    // la semaine affichée l'emporte : annuler sur la semaine suivante
    await setBought(at(), f.sophie, { key, bought: false, late: false, week: W1 });
    expect([await state(W0), await state(W1)]).toEqual(["bought", "validated"]);
  });

  it("un ticket coche le produit sur la liste de la semaine en cours d'abord, puis sur l'autre", async () => {
    const f = await ready();
    await menu(f, W0);
    await menu(f, W1);
    const lines = await validate(f, W0);
    await validate(f, W1);
    const key = nameKey(lines[0].name);
    const ticket = (date: string, time: string) => confirmTicket(at(), f.sophie, { store: "Lidl", city: "Nantes", date, time, lines: [{ product: lines[0].name, reference: null, total: 2, qty: 1, aisle: "Autres" }] } as never);
    const state = async (week: string) => (await items(f, week)).find((i) => i.name_key === key)!.state;
    await ticket("2026-11-03", "10:00:00");
    expect([await state(W0), await state(W1)]).toEqual(["bought", "validated"]);
    await ticket("2026-11-04", "09:00:00");
    expect([await state(W0), await state(W1)]).toEqual(["bought", "bought"]);
  });

  it("un produit ajouté à la main appartient à la semaine affichée ; sans menu, le premier menu validé le reprend", async () => {
    const f = await ready();
    await addProduct(at(), f.sophie, { name: "Lessive" });
    expect((await db.selectFrom("grocery_list_items").select("menu_id").where("account_id", "=", f.accountId).where("name_key", "=", "lessive").executeTakeFirstOrThrow()).menu_id).toBeNull();
    await menu(f, W1);
    expect((await db.selectFrom("grocery_list_items").select("menu_id").where("account_id", "=", f.accountId).where("name_key", "=", "lessive").executeTakeFirstOrThrow()).menu_id).toBe(await menuId(f, W1));

    await menu(f, W0);
    await addProduct(at(), f.sophie, { name: "Café", week: W0 });
    await addProduct(at(), f.sophie, { name: "Thé", week: W1 });
    const names = async (week: string) => (await prepareList(at(), f.sophie, week)).added.map((a) => a.name).sort();
    expect(await names(W0)).toEqual(["Café"]);
    expect(await names(W1)).toEqual(["Lessive", "Thé"]);
  });

  it("l'agent : l'état de la liste donne les deux semaines, la semaine choisie dans le tchat reçoit les ajouts, et le menu composé prend cette semaine", async () => {
    const f = await ready();
    await menu(f, W0);
    await menu(f, W1);
    const t = await toolContext(at(), f.sophie, W1);
    const state = JSON.parse((await executeCourseTool("etat_liste", {}, t)).content) as { semaines: { semaine: string; semaine_choisie_dans_ce_tchat: boolean; menu_valide: boolean; liste_validee: boolean }[] };
    expect(state.semaines.map((s) => [s.semaine, s.semaine_choisie_dans_ce_tchat, s.menu_valide, s.liste_validee]).slice(0, 3)).toEqual([
      ["Cette semaine (du 2 au 8 nov.)", false, true, false],
      ["Semaine du 9 au 15 nov.", true, true, false],
      ["Semaine du 16 au 22 nov.", false, false, false],
    ]);
    expect(state.semaines).toHaveLength(5);
    await executeCourseTool("ajouter_produit", { nom: "Piles" }, t);
    expect((await db.selectFrom("grocery_list_items").select("menu_id").where("account_id", "=", f.accountId).where("name_key", "=", "piles").executeTakeFirstOrThrow()).menu_id).toBe(await menuId(f, W1));

    // la semaine demandée par le tchat l'emporte sur celle que le modèle écrit
    const data = await loadEngineData(db, f.accountId, await loadSettings(db, f.accountId));
    const names = data.dishes.filter((d) => !d.mine).slice(0, 7).map((d) => ({ plat_id: d.id, nom: d.name }));
    const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 };
    const steps: ModelResponse[] = [
      { content: [{ type: "tool_use", id: "tu_1", name: "proposer_menu", input: { semaine: W0, diners: names } }], stopReason: "tool_use", usage, requestId: null },
      { content: [{ type: "text", text: "Voici le menu." }], stopReason: "end_turn", usage, requestId: null },
    ];
    let i = 0;
    const seen: ModelRequest[] = [];
    const model: AssistantModel = { id: "faux", send: async (request) => (seen.push(structuredClone(request)), steps[Math.min(i++, steps.length - 1)]) };
    const done = await sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "Un menu", week: W1 }, { model });
    expect(done.card?.proposal.week).toBe(W1);
    // le modèle sait pour quelle semaine il compose et qu'un menu y est déjà validé
    expect(JSON.stringify(seen[0].messages)).toContain("Semaine choisie pour le menu et la liste : Semaine du 9 au 15 nov.");
    expect(done.card?.replacesValidated).toBe(true);
    expect((await rejection(sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "Un menu", week: "2026-12-07" }, { model }))).code).toBe("invalid_week");
  });

  it("« déjà servi » compte l'autre semaine, avant comme après ; le menu de la même semaine (remplacé) est écarté", async () => {
    const f = await ready();
    await menu(f, W1);
    const settings = await loadSettings(db, f.accountId);
    const data = await loadEngineData(db, f.accountId, settings);
    const cuisines = await db.selectFrom("meal_cuisines").select(["id", "name"]).execute();
    const dish = data.dishes.find((d) => d.id === "F4")!;
    const propose = (week: string, now: Date = NOW) => {
      const built = buildProposal(menuInput.parse({ semaine: week, diners: [{ plat_id: dish.id, nom: dish.name }] }), { data, cuisines, householdSize: 4, now, newId: randomUUID });
      if (!built.ok) throw new Error(built.errors.join(" | "));
      return built.proposal.dinners[0].servedOn;
    };
    // semaine en cours : le plat de la semaine suivante est « déjà servi » (lundi 9)
    expect(propose(W0)).toBe("09/11");
    // même semaine : c'est le menu qu'on remplace, il ne compte pas
    expect(propose(W1)).toBeNull();
    // et dans l'autre sens : menu de la semaine suivante, plat servi la semaine en cours
    await menu(f, W0);
    const again = await loadEngineData(db, f.accountId, settings);
    const back = buildProposal(menuInput.parse({ semaine: W1, diners: [{ plat_id: dish.id, nom: dish.name }] }), { data: again, cuisines, householdSize: 4, now: NOW, newId: randomUUID });
    expect(back.ok && back.proposal.dinners[0].servedOn).toBe("02/11");
  });
});

describe("CR-55 : produits « pas encore acheté » de la liste d'avant", () => {
  it("la liste de la semaine suivante les montre décochés, hors total ; achetés sur leur semaine d'origine, ils disparaissent ; cochés, ils deviennent des produits de la nouvelle semaine", async () => {
    const f = await ready();
    // aucune liste avant la première : rien
    await menu(f, W0);
    expect(reminders(await prepareList(at(), f.sophie, W0))).toEqual([]);

    await validate(f, W0);
    await addProduct(at(), f.sophie, { name: "Essuie-tout", week: W0 });
    await menu(f, W1, NOW, []);
    const w1keys = new Set((await items(f, W1)).map((i) => i.name_key));
    const origin = (await items(f, W0)).filter((i) => ["validated", "added_after_validation"].includes(i.state));
    // CR-68 : seuls les ajouts à la main sont rappelés, plus les ingrédients du menu précédent
    const expected = ["essuie tout"];
    expect(origin.filter((i) => !w1keys.has(i.name_key)).length).toBeGreaterThan(1);

    const next = await prepareList(at(), f.sophie, W1);
    const left = reminders(next);
    expect(left.map((a) => a.key).sort()).toEqual(expected);
    expect(left.every((a) => a.leftoverOf === "semaine du 2 nov.")).toBe(true);
    // ils sont dans « Produits de mon historique », décochés ; « Produits ajoutés » n'en contient aucun
    expect(left.every((a) => a.group === "habituel" && !a.checked)).toBe(true);
    expect(next.added.some((a) => a.key === "essuie tout")).toBe(false);
    // décochés et hors des scénarios tant qu'ils ne sont pas cochés
    const model = fromDto(next.model!);
    const leftoverItem = model.items.find((i) => nameKey(i.name) === "essuie tout")!;
    expect(leftoverItem.checked).toBe(false);
    expect(leftoverItem.leftoverWeek).toBe(W0);
    const plain = scenarioLines(model, {}, computeScenarios(model, {}, [])[1]).map((l) => l.name);
    expect(plain).not.toContain("Essuie-tout");
    // ils restent sur la liste d'origine
    expect((await items(f, W0)).find((i) => i.name_key === "essuie tout")!.state).toBe("added_after_validation");

    // acheté sur la semaine d'origine : le pense-bête disparaît ; annulé, il revient
    await setBought(at(), f.sophie, { key: "essuie tout", bought: true, late: true, week: W0 });
    expect(reminders(await prepareList(at(), f.sophie, W1)).some((a) => a.key === "essuie tout")).toBe(false);
    await setBought(at(), f.sophie, { key: "essuie tout", bought: false, late: true, week: W0 });
    expect(reminders(await prepareList(at(), f.sophie, W1)).some((a) => a.key === "essuie tout")).toBe(true);

    // coché : il devient un produit de la nouvelle semaine ; l'origine ne bouge pas
    await validate(f, W1, at(), [{ name: "Essuie-tout", source: "added" }]);
    const copied = (await items(f, W1)).find((i) => i.name_key === "essuie tout")!;
    expect(copied).toMatchObject({ state: "validated", source: "added" });
    expect((await items(f, W0)).find((i) => i.name_key === "essuie tout")!.state).toBe("added_after_validation");
    expect(reminders(await prepareList(at(), f.sophie, W1)).some((a) => a.key === "essuie tout")).toBe(false);

    // la liste de la semaine suivante est supprimée : le produit copié part avec elle et revient, décoché, depuis la liste d'origine ; les ajouts à la main de la semaine partent aussi
    await addProduct(at(), f.sophie, { name: "Piles", week: W1 });
    const removed = await deleteWeekList(at(), f.sophie, W1);
    expect(removed.deleted).toBe(true);
    expect((await items(f, W1)).some((i) => i.name_key === "essuie tout" || i.name_key === "piles")).toBe(false);
    const rebuilt = await prepareList(at(), f.sophie, W1);
    expect(rebuilt.validated).toBe(false);
    expect(rebuilt.menu).not.toBeNull();
    expect(reminders(rebuilt).map((a) => a.key).sort()).toEqual(expected);
    expect((await items(f, W1)).filter((i) => i.state === "preparing").length).toBeGreaterThan(5);
    expect(rebuilt.weeks.slice(0, 2).map((w) => [w.hasMenu, w.hasList])).toEqual([[true, true], [true, false]]);
  });

  it("semaine sautée : les pense-bêtes viennent de la dernière liste encore existante d'une semaine antérieure ; liste supprimée : plus rien", async () => {
    const f = await ready();
    // liste de la semaine du 19 octobre (validée ce jour-là), rien la semaine du 26, menu de la semaine en cours
    const old = new Date(2026, 9, 20, 10, 0, 0);
    const oldCtx: Ctx = { db, now: old };
    await menu(f, "2026-10-19", old);
    await validate(f, "2026-10-19", oldCtx);
    await addProduct(oldCtx, f.sophie, { name: "Sacs poubelle", week: "2026-10-19" });
    await menu(f, W0);
    const shown = reminders(await prepareList(at(), f.sophie, W0));
    expect(shown.map((a) => a.key)).toEqual(["sacs poubelle"]);
    expect(shown.every((a) => a.leftoverOf === "semaine du 19 oct.")).toBe(true);
    expect(shown.some((a) => a.key === "sacs poubelle")).toBe(true);

    // une liste plus récente d'une semaine intermédiaire prend la place de la plus ancienne
    const mid = new Date(2026, 9, 27, 10, 0, 0);
    await menu(f, "2026-10-26", mid);
    await validate(f, "2026-10-26", { db, now: mid });
    await addProduct({ db, now: mid }, f.sophie, { name: "Éponges", week: "2026-10-26" });
    const recent = reminders(await prepareList(at(), f.sophie, W0));
    expect(recent.every((a) => a.leftoverOf === "semaine du 26 oct.")).toBe(true);
    expect(recent.some((a) => a.key === "eponges")).toBe(true);
    expect(recent.some((a) => a.key === "sacs poubelle")).toBe(false);

    // la liste de la semaine du 26 est supprimée : retour à celle du 19
    await asProfile(db, f.userIds.sophie, async (trx) => {
      await sql`select delete_grocery_list(${await menuId(f, "2026-10-26")}::uuid)`.execute(trx);
    });
    expect(reminders(await prepareList(at(), f.sophie, W0)).every((a) => a.leftoverOf === "semaine du 19 oct.")).toBe(true);
    // les deux listes supprimées : rien
    await asProfile(db, f.userIds.sophie, async (trx) => {
      await sql`select delete_grocery_list(${await menuId(f, "2026-10-19")}::uuid)`.execute(trx);
    });
    expect(reminders(await prepareList(at(), f.sophie, W0))).toEqual([]);
  });
});

describe("CR-54 : suppression d'un menu ou d'une liste", () => {
  it("réservée au couple ; supprimer le menu emporte sa liste (achetés et ajoutés à la main compris) sans toucher aux tickets, aux prix ni au plafond de menus", async () => {
    const f = await ready();
    await menu(f, W0);
    await menu(f, W1);
    const lines = await validate(f, W1);
    await addProduct(at(), f.sophie, { name: "Piles", week: W1 });
    await setBought(at(), f.sophie, { key: nameKey(lines[0].name), bought: true, late: false, week: W1 });
    await db.insertInto("grocery_receipts").values({ account_id: f.accountId, store_chain: "lidl", purchased_on: "2026-11-03" as never, total_amount: "12.50", recorded_by_user_id: f.userIds.sophie }).execute();
    await db.insertInto("meal_menu_daily_counters").values({ account_id: f.accountId, menu_date: "2026-11-04" as never, menu_count: 2 }).execute();

    expect((await rejection(deleteWeekMenu(at(), f.elodie, W1))).status).toBe(403);
    expect((await rejection(deleteWeekList(at(), f.elodie, W1))).status).toBe(403);
    expect((await items(f, W1)).length).toBeGreaterThan(0);
    expect((await rejection(deleteWeekMenu(at(), f.sophie, "2026-12-07"))).code).toBe("invalid_week");

    await deleteWeekMenu(at(), f.marc, W1);
    expect(await db.selectFrom("meal_menus").select("id").where("account_id", "=", f.accountId).where("week_start", "=", W1 as never).execute()).toEqual([]);
    expect((await db.selectFrom("grocery_list_items").select("menu_id").where("account_id", "=", f.accountId).execute()).every((i) => i.menu_id !== null)).toBe(true);
    expect((await db.selectFrom("grocery_list_items").select("id").where("account_id", "=", f.accountId).where("name_key", "=", "piles").execute())).toEqual([]);
    expect(await db.selectFrom("grocery_lists").select("id").where("account_id", "=", f.accountId).execute()).toEqual([]);
    expect((await items(f, W0)).length).toBeGreaterThan(0);
    expect(await db.selectFrom("grocery_receipts").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(1);
    expect((await db.selectFrom("meal_menu_daily_counters").select("menu_count").where("account_id", "=", f.accountId).executeTakeFirstOrThrow()).menu_count).toBe(2);
    expect((await rejection(deleteWeekMenu(at(), f.sophie, W1))).code).toBe("no_menu");
    expect((await prepareList(at(), f.sophie)).weeks.map((w) => w.hasMenu)).toEqual([true, false, false, false, false]);
  });

  it("supprimer la liste garde le menu : la liste est recalculée à partir de lui, à valider de nouveau", async () => {
    const f = await ready();
    await menu(f, W1);
    const lines = await validate(f, W1);
    const before = (await items(f, W1)).length;
    await addProduct(at(), f.sophie, { name: "Piles", week: W1 });
    await setBought(at(), f.sophie, { key: nameKey(lines[0].name), bought: true, late: false, week: W1 });

    expect((await rejection(deleteWeekList(at(), f.elodie, W1))).status).toBe(403);
    await deleteWeekList(at(), f.sophie, W1);
    expect(await db.selectFrom("grocery_lists").select("id").where("account_id", "=", f.accountId).execute()).toEqual([]);
    const after = await items(f, W1);
    expect(after.every((i) => i.state === "preparing" && i.source === "menu")).toBe(true);
    expect(after.some((i) => i.name_key === "piles")).toBe(false);
    expect(after.length).toBeGreaterThan(before - 5);
    const page = await prepareList(at(), f.sophie, W1);
    expect(page.menu).not.toBeNull();
    expect(page.validated).toBe(false);
  });
});
