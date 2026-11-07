import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { addFormats } from "@/server/courses/catalog/formats";
import { downloadFile, importFile, loadObject, type ConsoleContext } from "@/server/courses/console";
import { readSeedData, ensureCatalog } from "./helpers/courses-catalog";
import { createProfile, testDb } from "./helpers/fixtures";

const db = testDb();
let c: ConsoleContext;

beforeAll(async () => {
  await ensureCatalog(db);
  const admin = await createProfile(db, { role: "admin" });
  c = { ctx: { db, now: new Date() }, adminId: admin.id };
});

describe("Reprise du format du classeur (US-166 RF2)", () => {
  it("le catalogue de départ donne un format à 303 références chargées sur 322, jamais vide ni de plus de 80 caractères", () => {
    const data = readSeedData();
    const formats = data.refs.filter((r) => r.status !== "Non trouvé").map((r) => (r as { format?: string }).format);
    expect(formats.filter(Boolean)).toHaveLength(303);
    expect(formats.every((f) => f === undefined || (f.trim() !== "" && f.length <= 80))).toBe(true);
    expect(formats.some((f) => f && /^non indiqu/i.test(f))).toBe(false);
  });

  it("l'export de la base, complété du format du classeur puis réimporté, ne change que le format et ne supprime ni n'ajoute rien", async () => {
    const tag = randomUUID().slice(0, 8);
    const header = "produit;rayon;enseigne;reference;format;prix;date_prix;statut;additifs;composition";
    await importFile(c, "references", { name: "a.csv", content: Buffer.from(`${header}\nPâtes test ${tag};Féculents;Lidl;Penne ${tag};;1,20;2026-10-01;Conforme;E250;Blé dur\nPâtes test ${tag};Féculents;Carrefour;Fusilli ${tag};;;;À vérifier;;\n`) }, { replaceAll: false, dryRun: false });
    const before = await downloadFile(c, "references", "export", { q: "", filters: {} });
    const catalog = [{ product: `Pâtes test ${tag}`, store: "Lidl", ref: `Penne ${tag}`, format: "paquet de 500 g" }];
    const merged = addFormats(before.content, catalog);
    expect(merged.withFormat).toBe(1);
    const count = (await db.selectFrom("grocery_product_references").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n;
    await importFile(c, "references", { name: "b.csv", content: Buffer.from(merged.csv, "utf8") }, { replaceAll: false, dryRun: false });
    const after = await downloadFile(c, "references", "export", { q: "", filters: {} });
    expect((await db.selectFrom("grocery_product_references").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n).toBe(count);
    const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);
    const diff = lines(after.content).filter((l, i) => l !== lines(before.content)[i]);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toContain("paquet de 500 g");
    const row = (await loadObject(c, "references", { q: `Pâtes test ${tag}`, filters: {} })).rows.find((r) => r.cells.store === "Lidl")!;
    expect(row.cells).toMatchObject({ format: "paquet de 500 g", price: "1,20 €" });
    const stored = await db.selectFrom("grocery_product_references").select(["additives", "composition_text"]).where("reference_name", "=", `Penne ${tag}`).executeTakeFirstOrThrow();
    expect(stored.additives).toEqual(["e250"]);
    expect(stored.composition_text).toBe("Blé dur");
  });
});
