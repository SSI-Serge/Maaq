import { describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { createDish, dishForm, dishTemplate, importDishes } from "@/server/courses/menu/dishes";
import { menuPropose, menuStart } from "@/server/courses/menu/service";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

const db = testDb();
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const at = (): Ctx => ({ db, now: NOW });
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string; details?: { issues?: string[]; missing?: string[] } };
  }
  throw new Error("aucun refus");
};
const csv = (text: string) => ({ name: "plats.csv", content: Buffer.from(`\uFEFF${text}`, "utf8") });

describe("US-159 : plats du foyer", () => {
  it("un plat du foyer a ses ingrédients reliés au catalogue, des étiquettes déduites, et n'est vu que de son foyer", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const g = await coupleFamily(db);
    const form = await dishForm(at(), f.sophie);
    const afro = form.cuisines.find((c) => c.name === "Afro")!;
    const made = await createDish(at(), f.sophie, { name: "  Poulet   yassa ", cuisineId: afro.id, ingredients: ["Poulet entier", "Oignons", "oignons", "Gombo séché du marché"], minutes: 45, recipe: "Faire mariner." });
    expect(made.name).toBe("Poulet yassa");
    const mine = (await dishForm(at(), f.marc)).dishes;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "Poulet yassa", cuisine: "Afro", minutes: 45, ingredients: ["Poulet entier", "Oignons", "Gombo séché du marché"] });
    expect((await dishForm(at(), g.sophie)).dishes).toEqual([]);
    const rows = await db.selectFrom("meal_household_dish_ingredients").select(["label", "product_id"]).where("household_dish_id", "=", made.id).orderBy("position").execute();
    expect(rows.find((r) => r.label === "Oignons")?.product_id).not.toBeNull();
    expect(rows.find((r) => r.label === "Gombo séché du marché")?.product_id).toBeNull();
    const tags = await db.selectFrom("meal_household_dish_tags as l").innerJoin("meal_dish_tags as t", "t.id", "l.tag_id").select("t.name").where("l.household_dish_id", "=", made.id).execute();
    expect(tags.map((t) => t.name)).toContain("Poulet");
    // l'ingrédient inconnu est noté sans foyer
    const noted = await db.selectFrom("grocery_unreferenced_events").select("name_key").where("name_key", "=", "gombo séché du marché").execute();
    expect(noted.length).toBeGreaterThan(0);
  });

  it("refuse un plat incomplet avec la liste de ce qui manque, un doublon, une durée absurde, et l'invité secondaire", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const cuisine = (await dishForm(at(), f.sophie)).cuisines[0].id;
    const e = await rejection(createDish(at(), f.sophie, { name: " ", cuisineId: 0, ingredients: [] }));
    expect(e.code).toBe("missing_fields");
    expect(e.message).toBe("Il manque le nom, la cuisine, au moins un ingrédient.");
    await createDish(at(), f.sophie, { name: "Ragoût", cuisineId: cuisine, ingredients: ["Carottes"] });
    expect((await rejection(createDish(at(), f.sophie, { name: "ragoût", cuisineId: cuisine, ingredients: ["Carottes"] }))).code).toBe("dish_exists");
    expect((await rejection(createDish(at(), f.sophie, { name: "Autre", cuisineId: cuisine, ingredients: ["Carottes"], minutes: 9000 }))).code).toBe("invalid_minutes");
    expect((await rejection(createDish(at(), f.elodie, { name: "Autre", cuisineId: cuisine, ingredients: ["Carottes"] }))).status).toBe(403);
    expect((await rejection(dishForm(at(), f.elodie))).status).toBe(403);
  });

  it("un plat du foyer entre dans les choix du menu", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const options = (await getSettings(at(), f.sophie)).options;
    await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { ownDishes: true }, cuisineIds: options.cuisines.map((c) => c.id) });
    const afro = options.cuisines.find((c) => c.name === "Afro")!;
    await createDish(at(), f.sophie, { name: "Gratin de la maison", cuisineId: afro.id, ingredients: ["Pommes de terre", "Crème fraîche"] });
    const start = await menuStart(at(), f.sophie);
    const own = start.groups.find((g) => g.name === "Mes plats")!;
    expect(own.dishes.map((d) => d.name)).toEqual(["Gratin de la maison"]);
    const menu = await menuPropose(at(), f.sophie, { picks: [own.dishes[0].id] });
    expect(menu.days.map((d) => d.dish.name)).toContain("Gratin de la maison");
  });

  it("import : tout le fichier est vérifié, une ligne invalide refuse tout ; un fichier correct ajoute tous les plats", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const bad = await rejection(importDishes(at(), f.sophie, csv("plat;cuisine;ingredients\nSoupe;Afro;Poireaux | Pommes de terre\nPaella;Espagnole;Riz\n;Afro;Riz\n")));
    expect(bad.code).toBe("invalid_import");
    expect(bad.details?.issues?.length).toBeGreaterThanOrEqual(2);
    expect((await dishForm(at(), f.sophie)).dishes).toEqual([]);
    const ok = await importDishes(at(), f.sophie, csv("plat;cuisine;ingredients\nSoupe;Afro;Poireaux | Pommes de terre\nOmelette;Français;Oeufs, Oignons\n"));
    expect(ok.count).toBe(2);
    expect((await dishForm(at(), f.marc)).dishes.map((d) => d.name).sort()).toEqual(["Omelette", "Soupe"]);
    expect((await rejection(importDishes(at(), f.sophie, csv("plat;cuisine;ingredients\nSoupe;Afro;Riz\n")))).code).toBe("dish_exists");
    expect((await dishForm(at(), f.marc)).dishes).toHaveLength(2);
    expect(dishTemplate().content).toContain("plat;cuisine;ingredients");
  });
});
