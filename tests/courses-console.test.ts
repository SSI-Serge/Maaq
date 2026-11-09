import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { consoleSummary, downloadFile, loadObject, runAction, type ConsoleContext } from "@/server/courses/console";
import { ensureCatalog } from "./helpers/courses-catalog";
import { createProfile, testDb } from "./helpers/fixtures";

const db = testDb();
let c: ConsoleContext;
const q = (filters: Record<string, string> = {}, text = "") => ({ q: text, filters });
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error("aucun refus");
};
const uid = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  await ensureCatalog(db);
  const admin = await createProfile(db, { role: "admin" });
  c = { ctx: { db, now: new Date() }, adminId: admin.id };
});

describe("Console du catalogue : plats (US-164)", () => {
  it("liste les 60 plats avec cuisine, durée, semaine type ; filtre et recherche ; signale les express", async () => {
    const all = await loadObject(c, "plats", q());
    expect(all.rows).toHaveLength(60);
    expect(all.info).toMatch(/plats express .* plats sans semaine type/);
    expect(all.filters.map((f) => f.key)).toEqual(["cuisine", "categorie", "duree", "etat"]);
    const afro = all.filters[0].options.find((o) => o.label === "Afro")!.value;
    expect((await loadObject(c, "plats", q({ cuisine: afro }))).rows).toHaveLength(20);
    expect((await loadObject(c, "plats", q({}, "yassa"))).rows.map((r) => r.cells.code)).toEqual(["A14"]);
    for (const r of (await loadObject(c, "plats", q({ duree: "express" }))).rows) expect(String(r.cells.duration)).toMatch(/min/);
  });

  it("retirer un plat le sort de la liste des plats proposés ; le rétablir le remet ; chaque action est au journal", async () => {
    const f1 = (await loadObject(c, "plats", q({}, "F1"))).rows.find((r) => r.cells.code === "F1")!;
    await runAction(c, "plats", "retire", f1.id, {});
    expect((await loadObject(c, "plats", q())).rows).toHaveLength(59);
    expect((await loadObject(c, "plats", q({ etat: "retires" }))).rows.map((r) => r.cells.code)).toEqual(["F1"]);
    await runAction(c, "plats", "restore", f1.id, {});
    expect((await loadObject(c, "plats", q())).rows).toHaveLength(60);
    const log = await db.selectFrom("admin_audit_log").select("details").where("entity_id", "=", "F1").where("action_type", "=", "meal_catalog_changed").execute();
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect((await rejection(runAction(c, "plats", "retire", "999999", {}))).code).toBe("not_found");
    const file = await downloadFile(c, "plats", "hors-batch", q());
    expect(file.file).toBe("plats_hors_batch.csv");
  });
});

describe("Console du catalogue : cuisines, rayons, additifs", () => {
  it("une cuisine ajoutée est choisissable puis masquée ; un doublon est refusé", async () => {
    const name = `Test ${uid()}`;
    await runAction(c, "cuisines", "add", "", { kind: "cuisine", name, order: "900" });
    const row = (await loadObject(c, "cuisines", q())).rows.find((r) => r.cells.name === name)!;
    expect(row.cells).toMatchObject({ type: "Cuisine", count: 0, state: "Nouvelle" });
    expect((await rejection(runAction(c, "cuisines", "add", "", { kind: "cuisine", name, order: "900" }))).code).toBe("duplicate");
    await runAction(c, "cuisines", "hide", row.id, {});
    expect((await loadObject(c, "cuisines", q())).rows.find((r) => r.id === row.id)!.cells.state).toBe("Masquée");
  });

  it("un rayon se marque « Rayon frais » ou non, depuis la console (US-169 RF2bis)", async () => {
    const name = `Rayon ${uid()}`;
    await runAction(c, "rayons", "add", "", { name });
    const row = (await loadObject(c, "rayons", q())).rows.find((r) => r.cells.name === name)!;
    expect(row.cells.fresh).toBe("Non");
    expect(row.actions.map((x) => x.label)).toContain("Marquer rayon frais");
    await runAction(c, "rayons", "fresh", row.id, {});
    expect((await db.selectFrom("grocery_aisles").select("is_fresh").where("id", "=", Number(row.id)).executeTakeFirstOrThrow()).is_fresh).toBe(true);
    const again = (await loadObject(c, "rayons", q())).rows.find((r) => r.cells.name === name)!;
    expect(again.cells.fresh).toBe("Oui");
    expect(again.actions.map((x) => x.label)).toContain("Retirer des rayons frais");
    await runAction(c, "rayons", "fresh", row.id, {});
    expect((await db.selectFrom("grocery_aisles").select("is_fresh").where("id", "=", Number(row.id)).executeTakeFirstOrThrow()).is_fresh).toBe(false);
  });

  it("un rayon se renomme et se fusionne : les produits suivent", async () => {
    const a = `Rayon A ${uid()}`;
    const b = `Rayon B ${uid()}`;
    await runAction(c, "rayons", "add", "", { name: a });
    await runAction(c, "rayons", "add", "", { name: b });
    const list = (await loadObject(c, "rayons", q())).rows;
    const ra = list.find((r) => r.cells.name === a)!;
    const rb = list.find((r) => r.cells.name === b)!;
    await db.insertInto("grocery_products").values({ name: `Produit ${uid()}`, name_key: `produit ${uid()}`, aisle_id: Number(ra.id) }).execute();
    await runAction(c, "rayons", "rename", ra.id, { name: `${a} bis` });
    await runAction(c, "rayons", "merge", ra.id, { into: rb.id });
    const after = (await loadObject(c, "rayons", q())).rows;
    expect(after.find((r) => r.id === ra.id)).toBeUndefined();
    expect(after.find((r) => r.id === rb.id)!.cells.products).toBe(1);
    expect((await rejection(runAction(c, "rayons", "merge", rb.id, { into: rb.id }))).status).toBe(422);
  });

  it("un additif se compte dans les références exclues, se retire et se réactive", async () => {
    const label = `E${900 + Math.floor(Math.random() * 99)}x${uid()}`;
    await runAction(c, "additifs", "add", "", { label, reason: "Test" });
    const row = (await loadObject(c, "additifs", q())).rows.find((r) => r.cells.label === label)!;
    expect(row.cells.excluded).toBe(0);
    await runAction(c, "additifs", "remove", row.id, {});
    expect((await loadObject(c, "additifs", q())).rows.some((r) => r.id === row.id)).toBe(false);
    await runAction(c, "additifs", "add", "", { label: label.toLowerCase(), reason: "De nouveau" });
    expect((await loadObject(c, "additifs", q())).rows.some((r) => r.id === row.id)).toBe(true);
    await runAction(c, "additifs", "remove", row.id, {});
    expect((await rejection(runAction(c, "additifs", "add", "", { label: "", reason: "x" }))).code).toBe("missing_field");
  });
});

describe("Console du catalogue : produits à référencer, base commune, réglages", () => {
  it("les produits à référencer se rejettent et se rouvrent ; l'export ne contient aucun foyer", async () => {
    const name = `riz test ${uid()}`;
    for (let i = 0; i < 3; i += 1) await sql`select note_grocery_unreferenced(${randomUUID()}::uuid, ${name}, 'unknown'::grocery_unreferenced_kind, 'list'::grocery_unreferenced_source)`.execute(db).catch(() => null);
    // la fonction exige un foyer existant pour lire ses réglages ; sans foyer on insère directement
    await db.insertInto("grocery_unreferenced_events").values({ name_key: name, kind: "unknown", source: "list" }).execute();
    const row = (await loadObject(c, "a-referencer", q({}, name))).rows.find((r) => r.id === name)!;
    expect(row.cells).toMatchObject({ kind: "Inconnu", state: "À référencer", city: "—" });
    await runAction(c, "a-referencer", "reject", name, {});
    expect((await loadObject(c, "a-referencer", q({}, name))).rows).toHaveLength(0);
    expect((await loadObject(c, "a-referencer", q({ statut: "rejected" }, name))).rows).toHaveLength(1);
    await runAction(c, "a-referencer", "reopen", name, {});
    const file = await downloadFile(c, "a-referencer", "export", q({ statut: "tous" }, name));
    expect(file.content).toContain(name);
    expect(file.content.toLowerCase()).not.toMatch(/account|foyer|user/);
  });

  it("la base commune signale un prix absurde « à vérifier » et permet de le retirer puis de le rétablir", async () => {
    const product = await db.selectFrom("grocery_products").select("id").limit(1).executeTakeFirstOrThrow();
    const ref = `lait test ${uid()}`;
    const inserted = await db
      .insertInto("grocery_shared_prices")
      .values({ product_id: product.id, reference_name: ref, unit_price: "0.02", store_chain: "lidl", city: "nantes", week_start: "2026-11-02" as never })
      .returning("id")
      .executeTakeFirstOrThrow();
    const row = (await loadObject(c, "base-commune", q({ controle: "verifier" }))).rows.find((r) => r.id === String(inserted.id))!;
    expect(row.cells).toMatchObject({ ref: ref.replace(/(^|\s)(\p{L})/gu, (_, a: string, b: string) => `${a}${b.toUpperCase()}`), store: "Lidl", city: "Nantes", week: "2026-S45", check: "À vérifier" });
    await runAction(c, "base-commune", "remove", String(inserted.id), {});
    expect((await loadObject(c, "base-commune", q({ controle: "verifier" }))).rows.some((r) => r.id === String(inserted.id))).toBe(false);
    expect((await loadObject(c, "base-commune", q({ controle: "retirees" }))).rows.some((r) => r.id === String(inserted.id))).toBe(true);
    await runAction(c, "base-commune", "restore", String(inserted.id), {});
    await runAction(c, "base-commune", "remove", String(inserted.id), {});
    const log = await db.selectFrom("admin_audit_log").select("action_type").where("entity_id", "=", String(inserted.id)).where("entity_type", "=", "grocery_shared_price").execute();
    expect(log.every((l) => l.action_type === "grocery_price_moderated")).toBe(true);
    expect((await consoleSummary(c)).available).toContain("base-commune");
  });

  it("les réglages du module sont bornés et le seuil « sûre » reste au-dessus du seuil « à confirmer »", async () => {
    const before = (await loadObject(c, "reglages", q())).rows.find((r) => r.id === "meal_session_cap_minutes")!.cells.value;
    await runAction(c, "reglages", "edit", "meal_session_cap_minutes", { value: "130" });
    expect((await loadObject(c, "reglages", q())).rows.find((r) => r.id === "meal_session_cap_minutes")!.cells.value).toBe("130");
    await runAction(c, "reglages", "edit", "meal_session_cap_minutes", { value: String(before) });
    expect((await rejection(runAction(c, "reglages", "edit", "meal_session_cap_minutes", { value: "5000" }))).code).toBe("invalid_settings");
    expect((await rejection(runAction(c, "reglages", "edit", "meal_match_sure_pct", { value: "30" }))).code).toBe("invalid_thresholds");
    expect((await rejection(runAction(c, "reglages", "edit", "inconnu", { value: "3" }))).code).toBe("unknown_action");
  });

  it("un objet pas encore livré répond « non disponible »", async () => {

    expect((await rejection(loadObject(c, "nimporte", q()))).code).toBe("not_found");
  });
});

describe("Console du catalogue : produit « placard » (CR-50, CR-51)", () => {
  it("la liste montre le placard ; la modification d'une référence change la marque de son produit, pour toutes ses références", async () => {
    const all = await loadObject(c, "references", q());
    const pantryRow = all.rows.find((r) => r.cells.pantry === "oui")!;
    expect(pantryRow).toBeDefined();
    const sel = await loadObject(c, "references", q({}, String(all.rows.find((r) => r.cells.pantry === "non")!.cells.product)));
    const row = sel.rows.find((r) => r.cells.pantry === "non")!;
    const form = row.actions![0].fields!.find((f) => f.key === "pantry")!;
    expect(form.value).toBe("non");
    const fields = Object.fromEntries(row.actions![0].fields!.map((f) => [f.key, String(f.value ?? "")]));
    await runAction(c, "references", "edit", row.id, { ...fields, pantry: "oui" });
    const after = await loadObject(c, "references", q({}, String(row.cells.product)));
    expect(after.rows.filter((r) => r.cells.product === row.cells.product).every((r) => r.cells.pantry === "oui")).toBe(true);
    // retour à l'état de départ pour ne pas gêner les autres essais
    await runAction(c, "references", "edit", row.id, { ...fields, pantry: "non" });
    expect((await loadObject(c, "references", q({}, String(row.cells.product)))).rows.find((r) => r.id === row.id)!.cells.pantry).toBe("non");
  });
});

describe("Console : plats de saison de la base commune (CR-61)", () => {
  it("la liste montre le plat, ses mois, ses étiquettes et ses choix ; masquer le retire de la recherche, le réafficher le remet ; corriger les mois et les étiquettes est inscrit au journal", async () => {
    const { shareSeasonDishes } = await import("@/server/courses/season/base");
    const cuisine = (await db.selectFrom("meal_cuisines").select("id").orderBy("id").executeTakeFirstOrThrow()).id;
    const name = `Plat console ${uid()}`;
    const [id] = await shareSeasonDishes(db, [{ name, cuisineId: cuisine, servings: 4, recipe: "Cuire.", minutes: 30, months: [11, 12], tagIds: [], ingredients: [{ label: "Courgettes", quantity: 500, unit: "g" }] }]);
    const row = () => loadObject(c, "plats-de-saison", q({}, name)).then((t) => t.rows.find((r) => r.id === id));
    expect((await row())!.cells).toMatchObject({ name, months: "novembre → décembre", chosen: 0, state: "Visible" });
    expect((await row())!.actions.map((a) => a.key)).toEqual(["edit", "hide"]);

    await runAction(c, "plats-de-saison", "hide", id, {});
    expect((await row())!.cells.state).toBe("Masqué");
    expect((await loadObject(c, "plats-de-saison", q({ state: "hidden" }, name))).rows.map((r) => r.id)).toContain(id);
    expect((await loadObject(c, "plats-de-saison", q({ state: "visible" }, name))).rows).toEqual([]);
    await runAction(c, "plats-de-saison", "show", id, {});
    expect((await row())!.cells.state).toBe("Visible");

    // corriger les mois (mars à mai) et une étiquette de régime existante
    const tag = await db.selectFrom("meal_dish_tags").select("name").where("kind", "=", "diet").orderBy("id").executeTakeFirst();
    await runAction(c, "plats-de-saison", "edit", id, { from: "3", to: "5", tags: tag?.name ?? "" });
    const after = await row();
    expect(after!.cells.months).toBe("mars → mai");
    if (tag) expect(after!.cells.tags).toBe(tag.name);
    expect((await rejection(runAction(c, "plats-de-saison", "edit", id, { from: "3", to: "5", tags: "Étiquette inventée" }))).code).toBe("unknown_tag");
    expect((await rejection(runAction(c, "plats-de-saison", "hide", "999999999", {}))).code).toBe("not_found");
    const log = await db.selectFrom("admin_audit_log").select("action_type").where("entity_id", "=", id).where("entity_type", "=", "meal_season_dish").execute();
    expect(log.length).toBe(3);
    expect(log.every((l) => l.action_type === "seasonal_dish_changed")).toBe(true);
    // les réglages de console du module
    const settings = await loadObject(c, "reglages", q());
    expect(settings.rows.map((r) => r.id)).toEqual(expect.arrayContaining(["meal_season_dishes_count", "meal_season_dishes_max"]));
  });
});
