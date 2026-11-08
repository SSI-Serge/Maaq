import { describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { nameKey } from "@/server/courses/catalog/seed";
import { comparatif, computeScenarios, currentItems, scenarioLines } from "@/server/courses/engine";
import { fromDto } from "@/server/courses/list/dto";
import { courseHome } from "@/server/courses/home";
import { myList, setBought } from "@/server/courses/list/mine";
import { addProduct, prepareList, removeProduct, saveLightChoices, validateList } from "@/server/courses/list/service";
import { getSettings, saveSettings, setSharing } from "@/server/courses/household/settings";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";
import { validateTestMenu } from "./helpers/menu";

const db = testDb();
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const at = (): Ctx => ({ db, now: NOW });
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error("aucun refus");
};

async function readyWithMenu(): Promise<{ f: CoupleFamily; dinners: string[] }> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, {
    city: "Nantes",
    householdSize: 4,
    shoppingDays: [6],
    goals: { time: true },
    cuisineIds: options.cuisines.map((c) => c.id),
    stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }],
  });
  const { dinners } = await validateTestMenu(db, f, { picks: ["F4"], express: true, now: at().now });
  return { f, dinners };
}

describe("US-156/157 : liste de courses issue du menu", () => {
  it("valider un menu met ses ingrédients dans la liste ; sans menu, la liste est vide", async () => {
    await ensureCatalog(db);
    const none = await coupleFamily(db);
    const empty = await prepareList(at(), none.sophie);
    expect(empty.menu).toBeNull();
    expect(empty.model).toBeNull();

    const { f } = await readyWithMenu();
    const items = await db.selectFrom("grocery_list_items").select(["label", "state", "source", "list_id"]).where("account_id", "=", f.accountId).execute();
    expect(items.length).toBeGreaterThan(15);
    expect(items.every((i) => i.state === "preparing" && i.source === "menu" && i.list_id === null)).toBe(true);
    const list = await prepareList(at(), f.sophie);
    expect(list.menu!.days).toHaveLength(7);
    expect(list.menu!.weekLabel).toBe("9 novembre");
    expect(list.validated).toBe(false);
    expect(list.model!.items.filter((i) => i.group === "menu").length).toBe(items.length);
  });

  it("le comparatif propose le moins cher, trois scénarios sont calculés, le prix inconnu reste « N/A »", async () => {
    const { f } = await readyWithMenu();
    const list = await prepareList(at(), f.sophie);
    const model = fromDto(list.model!);
    const sel = {};
    const current = currentItems(model, sel);
    expect(current.length).toBeGreaterThan(10);
    expect(comparatif(model, sel).every((i) => i.choices.length >= 2)).toBe(true);
    const scenarios = computeScenarios(model, sel, list.stores.map((s) => s.chain));
    expect(scenarios.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(scenarios[0].total).toBeGreaterThan(0);
    // aucun ticket : le scénario « produits habituels » n'a aucun prix
    expect(scenarios[2].withoutPrice).toBe(current.length);
    const lines = scenarioLines(model, sel, scenarios[0]);
    expect(lines.some((l) => l.price !== null)).toBe(true);
    expect(lines.some((l) => l.price === null)).toBe(true);
  });

  it("produits ajoutés : doublon = quantité augmentée ; l'invité secondaire retire les siens seulement", async () => {
    const { f } = await readyWithMenu();
    const first = await addProduct(at(), f.sophie, { name: "Lessive liquide 1,5 L" });
    expect(first.duplicate).toBeNull();
    const second = await addProduct(at(), f.sophie, { name: "lessive" });
    expect(second.duplicate).toEqual({ name: "Lessive liquide 1,5 L", quantity: 2 });
    await addProduct(at(), f.elodie, { name: "Lait demi-écrémé 1 L" });
    const seen = await prepareList(at(), f.elodie);
    expect(seen.access).toBe("list");
    expect(seen.model).toBeNull();
    expect(seen.added.map((a) => a.name)).toEqual(["Lessive liquide 1,5 L", "Lait demi-écrémé 1 L"]);
    expect(seen.added.map((a) => a.mine)).toEqual([false, true]);
    // elle ne retire pas ce que le couple a ajouté, mais retire son propre ajout
    await removeProduct(at(), f.elodie, "lessive liquide 1,5 l");
    expect((await prepareList(at(), f.elodie)).added).toHaveLength(2);
    expect(await removeProduct(at(), f.elodie, "lait demi ecreme 1 l")).toHaveLength(1);
    expect((await rejection(addProduct(at(), f.sophie, { name: "  " }))).code).toBe("invalid_name");
    // le couple voit les ajouts dans sa liste
    const couple = await prepareList(at(), f.sophie);
    expect(couple.model!.items.find((i) => i.name === "Lessive liquide 1,5 L")?.group).toBe("ajout");
  });

  it("valider un scénario met les produits en liste validée avec magasin et prix ; un produit ajouté ensuite arrive sans prix", async () => {
    const { f } = await readyWithMenu();
    const list = await prepareList(at(), f.sophie);
    const model = fromDto(list.model!);
    const scenario = computeScenarios(model, {}, list.stores.map((s) => s.chain))[0];
    const lines = scenarioLines(model, {}, scenario).map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, source: "menu" as const }));
    const done = await validateList(at(), f.sophie, { scenario: 1, lines });
    expect(done.count).toBe(lines.length);
    const rows = await db.selectFrom("grocery_list_items").select(["state", "store_chain", "unit_price", "list_id"]).where("account_id", "=", f.accountId).execute();
    expect(rows.every((r) => r.state === "validated" && r.list_id === done.listId)).toBe(true);
    expect(rows.some((r) => r.unit_price !== null && r.store_chain !== null)).toBe(true);
    expect(rows.filter((r) => r.unit_price === null).every((r) => r.store_chain === null)).toBe(true);
    expect(await db.selectFrom("grocery_lists").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(1);

    // validée de nouveau : une seule liste reste
    await validateList(at(), f.sophie, { scenario: 2, lines });
    expect(await db.selectFrom("grocery_lists").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(1);

    const late = await addProduct(at(), f.sophie, { name: "Œufs x6" });
    expect(late.added[0].late).toBe(true);
    const row = await db.selectFrom("grocery_list_items").select(["state", "unit_price", "store_chain"]).where("account_id", "=", f.accountId).where("name_key", "=", "oeufs x6").executeTakeFirstOrThrow();
    expect(row).toMatchObject({ state: "added_after_validation", unit_price: null, store_chain: null });
    expect((await prepareList(at(), f.sophie)).validated).toBe(true);
  });

  it("au menu suivant, les produits non achetés reviennent « pas acheté la dernière fois » ; le journal des produits à référencer ne garde aucun foyer", async () => {
    const { f, dinners } = await readyWithMenu();
    const list = await prepareList(at(), f.sophie);
    const model = fromDto(list.model!);
    const lines = scenarioLines(model, {}, computeScenarios(model, {}, [])[1]).map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, source: "menu" as const }));
    await validateList(at(), f.sophie, { scenario: 2, lines });
    await addProduct(at(), f.sophie, { name: "Essuie-tout" });
    // un menu pour la semaine suivante
    await validateTestMenu(db, f, { picks: [dinners[0]], week: "2026-11-16", now: at().now });
    const carried = await db.selectFrom("grocery_list_items").select(["name_key", "state", "not_bought_last_time"]).where("account_id", "=", f.accountId).where("state", "<>", "bought").execute();
    expect(carried.every((r) => r.state === "preparing")).toBe(true);
    expect(carried.find((r) => r.name_key === "essuie tout")?.not_bought_last_time).toBe(true);
    const after = await prepareList(at(), f.sophie);
    expect(after.menu!.week).toBe("2026-11-16");
    expect(after.added.find((a) => a.name === "Essuie-tout")?.notBoughtLastTime).toBe(true);
    const columns = await db.selectFrom("grocery_unreferenced_events").selectAll().limit(1).execute();
    expect(Object.keys(columns[0] ?? {}).some((c) => /account|user|household/.test(c))).toBe(false);
  });

  it("la version allégée choisie est reprise ; seul le couple la règle", async () => {
    const { f } = await readyWithMenu();
    const list = await prepareList(at(), f.sophie);
    const dish = list.model!.dishes.find((d) => d.hasAdaptation) ?? list.model!.dishes[0];
    await saveLightChoices(at(), f.sophie, { [dish.name]: "light" });
    expect((await prepareList(at(), f.marc)).modes).toEqual({ [dish.name]: "light" });
    await saveLightChoices(at(), f.sophie, { [dish.name]: "standard" });
    expect((await prepareList(at(), f.sophie)).modes).toEqual({});
    expect((await rejection(saveLightChoices(at(), f.elodie, { [dish.name]: "light" }))).status).toBe(403);
    expect((await rejection(validateList(at(), f.elodie, { scenario: 1, lines: [{ name: "x", qty: 1, store: null, ref: null, price: null, source: "menu" }] }))).status).toBe(403);
  });

  it("partage des prix : la base commune alimente le comparatif seulement pour un foyer qui partage les siens", async () => {
    const { f } = await readyWithMenu();
    expect((await prepareList(at(), f.sophie)).sharing).toBe(false);
    await setSharing(at(), f.sophie, true);
    const shared = await prepareList(at(), f.sophie);
    expect(shared.sharing).toBe(true);
    expect(shared.model!.items.every((i) => i.choices.every((c) => c.kind !== "common"))).toBe(true);
  });
});

describe("US-158 : Ma liste de courses", () => {
  async function validated() {
    const { f } = await readyWithMenu();
    expect(await myList(at(), f.sophie)).toMatchObject({ empty: true, hasMenu: true });
    const list = await prepareList(at(), f.sophie);
    const model = fromDto(list.model!);
    const scenario = computeScenarios(model, {}, list.stores.map((s) => s.chain))[0];
    const lines = scenarioLines(model, {}, scenario).map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, source: "menu" as const }));
    await validateList(at(), f.sophie, { scenario: 1, lines });
    return { f, lines };
  }

  it("avant la validation, la liste est vide ; après, elle est rangée par magasin puis par rayon avec un reste à acheter", async () => {
    const { f, lines } = await validated();
    const mine = await myList(at(), f.sophie);
    expect(mine.empty).toBe(false);
    expect(mine.hasMenu).toBe(true);
    const count = mine.stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).length;
    expect(count).toBe(lines.length);
    expect(mine.stores.at(-1)!.name).toBe("À trouver sur place");
    expect(mine.stores.at(-1)!.subtotal).toBeNull();
    const priced = mine.stores.filter((s) => s.subtotal !== null);
    expect(priced.length).toBeGreaterThan(0);
    expect(mine.remaining).toBeCloseTo(priced.reduce((n, s) => n + s.subtotal!, 0), 2);
  });

  it("cocher « acheté » fait sortir le produit et le fait rejoindre l'historique ; annuler le remet ; tout acheté = message", async () => {
    const { f, lines } = await validated();
    const first = lines[0];
    const key = nameKey(first.name);
    await setBought(at(), f.sophie, { key, bought: true, late: false });
    const after = await myList(at(), f.sophie);
    expect(after.stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).some((l) => l.key === key)).toBe(false);
    const row = await db.selectFrom("grocery_list_items").select(["state", "bought_by_user_id"]).where("account_id", "=", f.accountId).where("name_key", "=", key).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ state: "bought", bought_by_user_id: f.userIds.sophie });
    // il apparaît dans le pense-bête « produits de mon historique » de la préparation suivante
    const prep = await prepareList(at(), f.sophie);
    expect(prep.model!.items.some((i) => i.group === "habituel" && i.name === first.name)).toBe(true);
    await setBought(at(), f.sophie, { key, bought: false, late: false });
    expect((await myList(at(), f.sophie)).stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).some((l) => l.key === key)).toBe(true);
    expect((await rejection(setBought(at(), f.sophie, { key, bought: false, late: false }))).code).toBe("not_bought");
    for (const l of lines) {
      const k = nameKey(l.name);
      await setBought(at(), f.sophie, { key: k, bought: true, late: false });
    }
    expect((await myList(at(), f.sophie)).allBought).toBe(true);
  });

  it("les produits ajoutés depuis la validation sont en tête, sans prix ; l'invité secondaire voit la liste sans prix ni total et ne coche rien", async () => {
    const { f } = await validated();
    await addProduct(at(), f.elodie, { name: "Œufs x6" });
    const couple = await myList(at(), f.sophie);
    expect(couple.late.map((l) => l.name)).toEqual(["Œufs x6"]);
    const guest = await myList(at(), f.elodie);
    expect(guest.access).toBe("list");
    expect(guest.remaining).toBeNull();
    expect(guest.stores.every((s) => s.subtotal === null && s.aisles.every((a) => a.lines.every((l) => l.price === null)))).toBe(true);
    expect(guest.late.map((l) => l.mine)).toEqual([true]);
    // CR-38 : l'invité secondaire coche « acheté » n'importe quel article, mais ne décoche que ses propres coches
    await setBought(at(), f.sophie, { key: "oeufs x6", bought: true, late: true });
    expect((await myList(at(), f.sophie)).late).toEqual([]);
    expect((await rejection(setBought(at(), f.elodie, { key: "oeufs x6", bought: false, late: true }))).code).toBe("not_yours");
    await setBought(at(), f.sophie, { key: "oeufs x6", bought: false, late: true });
    expect((await myList(at(), f.sophie)).late.map((l) => l.name)).toEqual(["Œufs x6"]);
    const guestTick = (await myList(at(), f.elodie)).stores.flatMap((s) => s.aisles.flatMap((a) => a.lines))[0];
    await setBought(at(), f.elodie, { key: guestTick.key, bought: true, late: false });
    await setBought(at(), f.elodie, { key: guestTick.key, bought: false, late: false });
    expect((await myList(at(), f.elodie)).stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).some((l) => l.key === guestTick.key)).toBe(true);
    // ce que le couple a coché, elle ne peut pas le décocher
    await setBought(at(), f.sophie, { key: guestTick.key, bought: true, late: false });
    expect((await rejection(setBought(at(), f.elodie, { key: guestTick.key, bought: false, late: false }))).code).toBe("not_yours");
  });
});

describe("Accueil de l'agent", () => {
  it("résume la liste validée, signale ce que l'autre parent a ajouté, et ne montre au secondaire que sa part", async () => {
    await ensureCatalog(db);
    const fresh = await coupleFamily(db);
    const first = await courseHome(at(), fresh.sophie);
    expect(first.list).toBeNull();
    expect(first.missing.length).toBeGreaterThan(0);

    const { f } = await readyWithMenu();
    const list = await prepareList(at(), f.sophie);
    const model = fromDto(list.model!);
    const lines = scenarioLines(model, {}, computeScenarios(model, {}, list.stores.map((s) => s.chain))[0]).map((l) => ({ name: l.name, qty: l.qty, store: l.store, ref: l.ref, price: l.price, source: "menu" as const }));
    await validateList(at(), f.sophie, { scenario: 1, lines });
    await addProduct(at(), f.marc, { name: "Liquide vaisselle" });
    const home = await courseHome(at(), f.sophie);
    expect(home.access).toBe("couple");
    expect(home.missing).toEqual([]);
    expect(home.list).toMatchObject({ products: lines.length });
    expect(home.addedByOthers).toEqual({ by: "Marc", names: ["Liquide vaisselle"] });
    expect((await courseHome(at(), f.marc)).addedByOthers).toBeNull();
    const guest = await courseHome(at(), f.elodie);
    expect(guest.access).toBe("list");
    expect(guest.missing).toEqual([]);
    expect(guest.budgetDay).toBe(false);
    // le jour du budget (1 par défaut) : la bulle s'affiche pour le couple seulement
    const budget = await courseHome({ db, now: new Date(2026, 10, 1) }, f.sophie);
    expect(budget.budgetDay).toBe(true);
    expect((await courseHome({ db, now: new Date(2026, 10, 1) }, f.elodie)).budgetDay).toBe(false);
  });
});
