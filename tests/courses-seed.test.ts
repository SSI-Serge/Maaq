import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { nameKey } from "@/server/courses/catalog/seed";
import { ensureCatalog, withFreshCatalog } from "./helpers/courses-catalog";
import { testDb } from "./helpers/fixtures";

const db = testDb();

describe("Chargement initial du catalogue Courses et repas", () => {
  it("charge les 60 plats, leurs ingrédients, les références, les semaines types et les versions allégées", async () => {
    await withFreshCatalog(db, async (trx, report) => {
      expect(report.skipped).toBe(false);
      expect(report).toMatchObject({ cuisines: 3, dishes: 60, batchWeeks: 12, tags: 12 });
      expect(report.aisles).toBe(19); // les 19 rayons de départ ; « Poissons » et « Boissons (cuisine) » du classeur sont rangés dans « Poissonnerie » et « Boissons »
      expect(report.lightVersions).toBeGreaterThanOrEqual(34);
      expect(report.references).toBeGreaterThan(50); // seules les références conformes avec un prix sont chargées (prix obligatoire en base)
      expect(report.referencesWithoutPrice + report.nonCompliantReferences + report.references).toBeGreaterThanOrEqual(600);
      expect(report.ingredientLinks).toBeGreaterThan(300);
      expect(report.seasonLinks).toBeGreaterThan(0);
      const count = async (table: "meal_dishes" | "grocery_products" | "meal_batch_week_days") => Number((await trx.selectFrom(table).select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow()).n);
      expect(await count("meal_dishes")).toBe(60);
      expect(await count("meal_batch_week_days")).toBe(60);
    });
  });

  it("les plats express sont ceux de 15 minutes au plus ; les 4 semaines bloquées le sont par la base", async () => {
    await withFreshCatalog(db, async (trx) => {
      const express = await trx.selectFrom("meal_dishes").select("code").where("is_express", "=", true).execute();
      expect(express.length).toBeGreaterThanOrEqual(4);
      const weeks = await sql<{ code: string; is_usable: boolean }>`select code, is_usable from v_meal_batch_weeks order by code`.execute(trx);
      expect(weeks.rows.filter((w) => !w.is_usable).map((w) => w.code)).toEqual(["AS2", "AS4", "FS1", "FS3"]);
    });
  });

  it("les statuts de correspondance vus par la base sont ceux du script : 11 à confirmer, 4 absents", async () => {
    await withFreshCatalog(db, async (trx) => {
      const rows = await sql<{ match_status: string }>`select match_status from v_meal_batch_week_days`.execute(trx);
      const by = (s: string) => rows.rows.filter((r) => r.match_status === s).length;
      expect(by("absent")).toBe(4);
      expect(by("to_confirm")).toBe(11);
      expect(by("sure")).toBe(45);
    });
  });

  it("un second chargement ne change rien", async () => {
    await ensureCatalog(db);
    expect((await ensureCatalog(db)).skipped).toBe(true);
  });

  it("les noms de produit sont rendus en clés normalisées", () => {
    expect(nameKey("Crème  fraîche épaisse")).toBe("creme fraiche epaisse");
    expect(nameKey("Œufs - frais")).toBe("oeufs frais");
  });
});
