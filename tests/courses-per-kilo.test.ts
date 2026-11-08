import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { importFile, loadObject, type ConsoleContext } from "@/server/courses/console";
import { computeScenarios, scenarioLines } from "@/server/courses/engine";
import { getSettings, saveSettings, setSharing } from "@/server/courses/household/settings";
import { fromDto } from "@/server/courses/list/dto";
import { myList } from "@/server/courses/list/mine";
import { prepareList, validateList } from "@/server/courses/list/service";
import { confirmTicket } from "@/server/courses/tickets/service";
import { normalizeDraft } from "@/server/courses/tickets/structure";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { createProfile, testDb } from "./helpers/fixtures";
import { validateTestMenu } from "./helpers/menu";

const db = testDb();
const NOW = new Date(2026, 10, 6, 10, 0, 0);
const at = (): Ctx => ({ db, now: NOW });
const csv = (text: string) => ({ name: "r.csv", content: Buffer.from(`﻿${text}`, "utf8") });
const opts = { replaceAll: false, dryRun: false };
let admin: ConsoleContext;

beforeAll(async () => {
  await ensureCatalog(db);
  admin = { ctx: { db, now: new Date() }, adminId: (await createProfile(db, { role: "admin" })).id };
});

async function household(): Promise<CoupleFamily> {
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }] });
  return f;
}

describe("Prix au kilo : références (CR-39, CR-40)", () => {
  it("la base déduit la quantité du format ; l'import accepte la quantité, son unité et l'unité du prix, qui priment ; un format non compris ne donne rien", async () => {
    const tag = randomUUID().slice(0, 8);
    const header = "produit;rayon;enseigne;reference;format;prix;date_prix;statut;additifs;composition;package_amount;package_unit;unite_prix";
    await importFile(
      admin,
      "references",
      csv(`${header}\nRiz ${tag};Féculents;Lidl;Riz long;500 g;1,20;2026-10-20;Conforme;;;;;\nBananes ${tag};Fruits et légumes;Lidl;Vrac;au kilo;1,89;2026-10-20;Sans objet;;;;;kg\nSucre ${tag};Épicerie sucrée;Lidl;Sucre;la boîte;1,50;2026-10-20;Conforme;;;;;\nFarine ${tag};Féculents;Lidl;Farine;sac;1,10;2026-10-20;Conforme;;;1,5;kg;\n`),
      opts,
    );
    const rows = (await loadObject(admin, "references", { q: tag, filters: {} })).rows;
    const by = (p: string) => rows.find((r) => String(r.cells.product).startsWith(p))!;
    expect(by("Riz").cells).toMatchObject({ price: "1,20 €", perMeasure: "2,40 €/kg" });
    expect(by("Bananes").cells).toMatchObject({ price: "1,89 €/kg", perMeasure: "1,89 €/kg" });
    expect(by("Sucre").cells.perMeasure).toBe("—");
    expect(by("Farine").cells.perMeasure).toBe("0,73 €/kg");
    const stored = await db.selectFrom("grocery_product_references").select(["reference_name", "package_amount", "package_unit", "price_unit"]).where("reference_name", "in", ["Riz long", "Vrac", "Sucre", "Farine"]).execute();
    expect(stored.find((s) => s.reference_name === "Riz long")).toMatchObject({ package_unit: "kg", price_unit: "unit" });
    expect(Number(stored.find((s) => s.reference_name === "Riz long")!.package_amount)).toBeCloseTo(0.5);
    // fichier invalide : quantité sans unité, unité du prix inconnue
    for (const bad of ["Z;Féculents;Lidl;R;250 g;1;2026-10-20;Conforme;;;2;;", "Z;Féculents;Lidl;R;250 g;1;2026-10-20;Conforme;;;;;au_poids"]) {
      await expect(importFile(admin, "references", csv(`${header}\n${bad}\n`), opts)).rejects.toMatchObject({ code: "invalid_import" });
    }
  });
});

describe("Prix au kilo : tickets (CR-39)", () => {
  it("un produit pesé garde son poids hors de la quantité ; g et cl sont convertis ; le prix au kilo est lu ou calculé ; seul le prix au kilo est partagé", async () => {
    const f = await household();
    await setSharing(at(), f.sophie, true);
    const done = await confirmTicket(at(), f.sophie, {
      store: "Lidl",
      city: "Nantes",
      date: "2026-11-05",
      lines: [
        { product: "Oignons", reference: "Vrac", total: 1.84, qty: 1, aisle: "Fruits et légumes", measured: 1234, measureUnit: "g" },
        { product: "Vin cuisine", reference: "Bouteille", total: 2.4, qty: 1, aisle: "Boissons", measured: 75, measureUnit: "cl", pricePerMeasure: 3.2 },
        { product: "Lait demi-écrémé", reference: "Lidl 1 L", total: 1.9, qty: 2, aisle: "Crémerie" },
      ],
    });
    expect(done.recorded).toBe(3);
    const lines = await db.selectFrom("grocery_receipt_lines").select(["label", "quantity", "measured_quantity", "measure_unit", "price_per_measure"]).where("account_id", "=", f.accountId).orderBy("position").execute();
    expect(lines.map((l) => [l.label, Number(l.quantity), l.measured_quantity === null ? null : Number(l.measured_quantity), l.measure_unit, l.price_per_measure === null ? null : Number(l.price_per_measure)])).toEqual([
      ["Oignons", 1, 1.234, "kg", 1.49],
      ["Vin cuisine", 1, 0.75, "l", 3.2],
      ["Lait demi-écrémé", 2, null, null, null],
    ]);
    // base commune : une ligne pesée est partagée avec son prix au kilo, jamais avec son poids
    const shared = await db.selectFrom("grocery_shared_prices").selectAll().where("reference_name", "in", ["vrac", "bouteille"]).where("store_chain", "=", "lidl").execute();
    for (const s of shared) expect(Object.keys(s).some((k) => /weight|poids|measured|quantity/.test(k))).toBe(false);
    expect(shared.some((s) => s.price_unit === "kg" && Number(s.unit_price) === 1.49)).toBe(true);
    // un poids invalide est refusé
    await expect(confirmTicket(at(), f.sophie, { store: "Lidl", city: null, date: "2026-11-04", lines: [{ product: "X", reference: null, total: 1, qty: 1, aisle: "Autres", measured: 5, measureUnit: "pièce" as never }] })).rejects.toMatchObject({ code: "invalid_line" });
  });

  it("la mise en forme du modèle convertit le poids lu et garde le prix au kilo imprimé", () => {
    const draft = normalizeDraft(
      JSON.stringify({ readable: true, store: "Lidl", date: "2026-11-05", lines: [{ product: "Pommes", total: 1.84, qty: 3, aisle: "Autres", weight: "1234", weight_unit: "g", price_per_unit: "1,49 €" }, { product: "Lait", total: 1.9, qty: 2, aisle: "Autres" }, { product: "Inconnu", total: 2, aisle: "Autres", weight: 2, weight_unit: "pièces" }] }),
      ["Autres"],
      "2026-11-06",
    );
    expect(draft.lines[0]).toMatchObject({ measured: 1.234, measureUnit: "kg", pricePerMeasure: 1.49, qty: 1 });
    expect(draft.lines[1]).toMatchObject({ measured: null, measureUnit: null, pricePerMeasure: null, qty: 2 });
    expect(draft.lines[2]).toMatchObject({ measured: null });
  });

  it("l'historique d'un produit pesé propose un « dernier acheté » au kilo, non totalisé", async () => {
    const f = await household();
    await confirmTicket(at(), f.sophie, { store: "Lidl", city: "Nantes", date: "2026-11-05", lines: [{ product: "Oignons", reference: "Vrac", total: 1.84, qty: 1, aisle: "Fruits et légumes", measured: 1.234, measureUnit: "kg" }] });
    await validateTestMenu(db, f);
    const model = fromDto((await prepareList(at(), f.sophie)).model!);
    const onions = model.items.find((i) => /oignon/i.test(i.name) && i.choices.some((c) => c.kind === "history"));
    expect(onions?.choices.find((c) => c.kind === "history")).toMatchObject({ priceUnit: "kg", price: 1.49, perUnit: { value: 1.49, unit: "kg" } });
  });
});

describe("Prix au kilo : liste validée et Ma liste (CR-40)", () => {
  it("un article au kilo garde son unité, n'entre pas dans le total et s'affiche au kilo ; l'invité secondaire ne voit aucun prix", async () => {
    const f = await household();
    await validateTestMenu(db, f);
    await validateList(at(), f.sophie, {
      scenario: 1,
      lines: [
        { name: "Riz long", qty: 2, store: "Lidl", ref: "Riz long", price: 1.2, priceUnit: "unit", source: "added" },
        { name: "Bananes plantains", qty: 1, store: "Lidl", ref: "Vrac", price: 3.29, priceUnit: "kg", source: "added" },
      ],
    });
    const stored = await db.selectFrom("grocery_list_items").select(["label", "price_unit", "unit_price"]).where("account_id", "=", f.accountId).where("state", "=", "validated").orderBy("label").execute();
    expect(stored.map((s) => [s.label, s.price_unit, Number(s.unit_price)])).toEqual([["Bananes plantains", "kg", 3.29], ["Riz long", "unit", 1.2]]);
    const mine = await myList(at(), f.sophie);
    const all = mine.stores.flatMap((s) => s.aisles.flatMap((a) => a.lines));
    expect(all.find((l) => l.name === "Riz long")).toMatchObject({ price: 2.4, perMeasure: null });
    expect(all.find((l) => l.name === "Bananes plantains")).toMatchObject({ price: null, perMeasure: { value: 3.29, unit: "kg" } });
    expect(mine.remaining).toBe(2.4);
    expect(mine.stores.find((s) => s.name === "Lidl")!.subtotal).toBe(2.4);
    const guest = (await myList(at(), f.elodie)).stores.flatMap((s) => s.aisles.flatMap((a) => a.lines));
    expect(guest.every((l) => l.price === null && l.perMeasure === null)).toBe(true);
    expect(guest.find((l) => l.name === "Bananes plantains")).toBeDefined();
  });

  it("les scénarios de la préparation comptent à part les articles au kilo", async () => {
    const f = await household();
    await validateTestMenu(db, f);
    const model = fromDto((await prepareList(at(), f.sophie)).model!);
    const scenarios = computeScenarios(model, {}, ["Lidl"]);
    for (const s of scenarios) expect(s.notTotaled).toBeGreaterThanOrEqual(0);
    expect(scenarioLines(model, {}, scenarios[0]).every((l) => ["unit", "kg", "l"].includes(l.priceUnit))).toBe(true);
  });
});
