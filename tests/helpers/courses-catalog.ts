import { readFileSync } from "node:fs";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import { seedWithin, type SeedData, type SeedReport } from "@/server/courses/catalog/seed";
import type { DB } from "@/server/db/schema.generated";

export const SEED_PRICE_DATE = "2026-11-06";

export function readSeedData(): SeedData {
  return JSON.parse(readFileSync(path.join(process.cwd(), "db", "seed", "courses", "catalog.json"), "utf8")) as SeedData;
}

/**
 * Catalogue de départ chargé dans la base de test (une seule fois, sous verrou : les tables du catalogue sont communes à tous les foyers et à tous les fichiers de tests).
 * `fresh` vide d'abord le catalogue, pour le test du chargement lui-même.
 */
export async function ensureCatalog(db: Kysely<DB>, options: { fresh?: boolean } = {}): Promise<SeedReport> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(7014)`.execute(trx);
    if (options.fresh) {
      await sql`truncate meal_dishes, meal_batch_weeks, meal_cuisines, meal_dish_categories, meal_dish_tags, grocery_products, grocery_aisles restart identity cascade`.execute(trx);
    }
    return seedWithin(trx, readSeedData(), { priceDate: SEED_PRICE_DATE });
  });
}
