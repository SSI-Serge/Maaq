import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { downloadFile, importFile, loadObject, lookupValue, runAction, type ConsoleContext } from "@/server/courses/console";
import { ensureCatalog } from "./helpers/courses-catalog";
import { createProfile, testDb } from "./helpers/fixtures";

const db = testDb();
let c: ConsoleContext;
const q = (filters: Record<string, string> = {}, text = "") => ({ q: text, filters });
const uid = () => randomUUID().slice(0, 8);
type Failure = { code: string; status: number; message: string; details?: { issues: string[] } };
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Failure;
  }
  throw new Error("aucun refus");
};
const file = (text: string) => ({ name: "fichier.csv", content: Buffer.from(`﻿${text}`, "utf8") });
const opts = { replaceAll: false, dryRun: false };

beforeAll(async () => {
  await ensureCatalog(db);
  const admin = await createProfile(db, { role: "admin" });
  c = { ctx: { db, now: new Date() }, adminId: admin.id };
});

describe("Console du catalogue : imports et correspondances", () => {
  it("références : un fichier invalide refuse tout ; un fichier correct ajoute puis met à jour ; sans prix = N/A", async () => {
    const tag = uid();
    const bad = await rejection(importFile(c, "references", file(`produit;rayon;enseigne;reference;prix;date_prix;statut\nRiz ${tag};Féculents;Lidl;Riz long 1 kg;2,10;2026-10-12;Conforme\nRiz ${tag};Rayon inconnu;Lidl;Riz rond 1 kg;abc;;Conforme\n`), opts));
    expect(bad.code).toBe("invalid_import");
    expect(bad.details?.issues.join(" ")).toMatch(/ligne 3/);
    expect((await loadObject(c, "references", q({}, `Riz ${tag}`))).rows).toHaveLength(0);

    const ok = await importFile(c, "references", file(`produit;rayon;enseigne;reference;format;prix;date_prix;statut;additifs\nRiz ${tag};Féculents;Lidl;Riz long 1 kg;sachet de 1 kg;2,10;2026-10-12;Conforme;\nRiz ${tag};Féculents;Carrefour;Riz bio;;;;À vérifier;E250|E171\n`), opts);
    expect(ok.count).toBe(2);
    const rows = (await loadObject(c, "references", q({}, `Riz ${tag}`))).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.cells.store === "Lidl")!.cells).toMatchObject({ price: "2,10 €", date: "12/10/2026", format: "sachet de 1 kg" });
    expect(rows.find((r) => r.cells.store === "Carrefour")!.cells.format).toBe("—");
    expect(rows.find((r) => r.cells.store === "Carrefour")!.cells.price).toBe("N/A");

    await importFile(c, "references", file(`produit;rayon;enseigne;reference;prix;date_prix;statut\nRiz ${tag};Féculents;Lidl;Riz long 1 kg;2,25;2026-11-01;Conforme\n`), opts);
    const again = (await loadObject(c, "references", q({}, `Riz ${tag}`))).rows;
    expect(again).toHaveLength(2);
    expect(again.find((r) => r.cells.store === "Lidl")!.cells.price).toBe("2,25 €");

    const dry = await importFile(c, "references", file(`produit;rayon;enseigne;reference;prix;date_prix\nZzz ${tag};Féculents;Lidl;Zzz;1;2026-01-01\n`), { replaceAll: false, dryRun: true });
    expect(dry.lines[0]).toMatch(/Rien n'a été importé/);
    expect((await loadObject(c, "references", q({}, `Zzz ${tag}`))).rows).toHaveLength(0);

    const lidl = rows.find((r) => r.cells.store === "Lidl")!;
    await runAction(c, "references", "edit", lidl.id, { ref: "Riz long 1 kg", price: "2,30", date: "2026-11-02", status: "compliant" });
    expect((await rejection(runAction(c, "references", "edit", lidl.id, { ref: "x", price: "-1", date: "2026-11-02", status: "compliant" }))).code).toBe("invalid_price");
    expect((await downloadFile(c, "references", "template", q())).content).toContain("produit;rayon;enseigne;reference;format;prix");
    const longFormat = "x".repeat(81);
    expect((await rejection(importFile(c, "references", file(`produit;rayon;enseigne;reference;format;prix;date_prix\nRiz ${tag};Féculents;Lidl;Riz long 1 kg;${longFormat};1;2026-01-01\n`), opts))).code).toBe("invalid_import");
  });

  it("une référence importée fait passer le produit à « référencé »", async () => {
    const name = `quinoa ${uid()}`;
    await db.insertInto("grocery_unreferenced_events").values({ name_key: name, kind: "unknown", source: "list" }).execute();
    await importFile(c, "references", file(`produit;rayon;enseigne;reference;prix;date_prix\n${name};Féculents;Lidl;Quinoa 500 g;3,50;2026-11-01\n`), opts);
    expect((await loadObject(c, "a-referencer", q({ statut: "referenced" }, name))).rows).toHaveLength(1);
    expect((await loadObject(c, "a-referencer", q({}, name))).rows).toHaveLength(0);
  });

  it("plannings : import contrôlé puis écrit ; les correspondances se choisissent, se gardent à la réimportation et se calculent", async () => {
    const code = `T${uid()}`.slice(0, 8);
    const header = "id_semaine;cuisine;theme;lundi;mardi;mercredi;jeudi;vendredi;ids;etapes;temps_total_min;mutualisation_pct";
    const bad = await rejection(importFile(c, "plannings", file(`${header}\n${code};Afro;Test;a;b;c;d;e;;étape;;80\n`), opts));
    expect(bad.details?.issues.join(" ")).toMatch(/ligne 2.*temps_total_min/);
    expect((await rejection(importFile(c, "plannings", file(`${header}\n${code};Martienne;Test;a;b;c;d;e;;étape;80;80\n`), opts))).code).toBe("invalid_import");

    const row = `${code};Afro;Semaine test;Velouté de courge;Haricots rouges sauce tomate & peau de bœuf;Zzz inconnu;Pâtes express;Gratin;A1| | | |;Tailler | Cuire;95;70`;
    const control = await importFile(c, "plannings", file(`${header}\n${row}\n`), { replaceAll: false, dryRun: true });
    expect(control.lines.length).toBeGreaterThan(5);
    expect(control.lines.join(" ")).toContain("A1 (confirmé)");
    expect((await loadObject(c, "plannings", q())).rows.some((r) => r.cells.code === code)).toBe(false);

    await importFile(c, "plannings", file(`${header}\n${row}\n`), opts);
    const week = (await loadObject(c, "plannings", q())).rows.find((r) => r.cells.code === code)!;
    expect(week.cells).toMatchObject({ cuisine: "Afro", theme: "Semaine test", duration: "1 h 35" });
    const open = (await loadObject(c, "correspondances", q())).rows.filter((r) => r.cells.week === code);
    expect(open.length).toBeGreaterThanOrEqual(3);
    const absent = open.find((r) => String(r.cells.status).startsWith("Absent"))!;
    expect(absent).toBeDefined();
    expect(week.tone).not.toBe("ok");

    const dishId = (await loadObject(c, "plats", q({}, "A1"))).rows[0].id;
    await runAction(c, "correspondances", "choose", absent.id, { dish: dishId });
    expect((await loadObject(c, "correspondances", q())).rows.some((r) => r.id === absent.id)).toBe(false);
    await importFile(c, "plannings", file(`${header}\n${row}\n`), opts);
    expect((await loadObject(c, "correspondances", q())).rows.some((r) => r.id === absent.id)).toBe(false);

    const nearby = await lookupValue(c, "correspondances", "Lasagnes aux légumes");
    expect(nearby).toHaveLength(3);
    expect(nearby[0]).toMatch(/^[AFI]\d+ .+ : \d+ %$/);
    expect((await rejection(lookupValue(c, "correspondances", ""))).code).toBe("missing_field");
    expect((await downloadFile(c, "correspondances", "export", q())).file).toBe("plats_planning_sans_catalogue.csv");
    await db.deleteFrom("meal_batch_weeks").where("code", "=", code).execute();
  });

  it("versions allégées : identifiant inconnu et produit à retirer inconnu refusent tout ; un produit à ajouter absent est noté", async () => {
    const unknown = await rejection(importFile(c, "versions", file("id_plat;plat;retirer;ajouter;texte_source\nZ99;x;;;texte\n"), opts));
    expect(unknown.details?.issues.join(" ")).toMatch(/Z99/);
    const noProduct = await rejection(importFile(c, "versions", file("id_plat;plat;retirer;ajouter;texte_source\nF1;x;Produit qui nexiste pas;;texte\n"), opts));
    expect(noProduct.details?.issues.join(" ")).toMatch(/inconnu du catalogue/);

    const tag = `riz complet ${uid()}`;
    const before = (await loadObject(c, "versions", q({}, "F1"))).rows.find((r) => String(r.cells.dish).startsWith("F1 "))!;
    const done = await importFile(c, "versions", file(`id_plat;plat;retirer;ajouter;texte_source\nF1;x;;${tag};Texte test\n`), opts);
    expect(done.lines.join(" ")).toContain("produits à référencer");
    const after = (await loadObject(c, "versions", q({}, "F1"))).rows.find((r) => String(r.cells.dish).startsWith("F1 "))!;
    expect(after.cells).toMatchObject({ add: tag, text: "Texte test" });
    const clean = (v: unknown) => String(v).replace("—", "");
    await runAction(c, "versions", "edit", before.id, { remove: clean(before.cells.remove), add: clean(before.cells.add), text: clean(before.cells.text) });
    expect((await downloadFile(c, "versions", "sans", q())).file).toBe("plats_sans_version_allegee.csv");
  });

  it("saisons : un produit reçoit ses mois, lus d'un seul tenant même à cheval sur deux années", async () => {
    const product = await db.selectFrom("grocery_products").select(["id", "name"]).orderBy("id").limit(1).executeTakeFirstOrThrow();
    const had = await db.selectFrom("grocery_product_seasons").select("season_month").where("product_id", "=", product.id).execute();
    await runAction(c, "saisons", "add", "", { product: product.name, from: "9", to: "2" });
    const row = (await loadObject(c, "saisons", q({}, product.name))).rows.find((r) => r.id === String(product.id))!;
    expect(row.cells.months).toBe("septembre → février");
    await runAction(c, "saisons", "edit", row.id, { from: "1", to: "12" });
    expect((await loadObject(c, "saisons", q({}, product.name))).rows.find((r) => r.id === row.id)!.cells.months).toBe("toute l'année");
    expect((await rejection(runAction(c, "saisons", "add", "", { product: "produit introuvable", from: "1", to: "2" }))).code).toBe("unknown_product");
    await db.deleteFrom("grocery_product_seasons").where("product_id", "=", product.id).execute();
    if (had.length) await db.insertInto("grocery_product_seasons").values(had.map((h) => ({ product_id: product.id, season_month: h.season_month }))).execute();
  });
});
