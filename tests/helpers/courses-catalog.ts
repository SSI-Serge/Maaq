import { readFileSync } from "node:fs";
import path from "node:path";
import { sql, type Kysely, type Transaction } from "kysely";
import { seedWithin, type SeedData, type SeedReport } from "@/server/courses/catalog/seed";
import type { DB } from "@/server/db/schema.generated";

export const SEED_PRICE_DATE = "2026-11-06";

export function readSeedData(): SeedData {
  return JSON.parse(readFileSync(path.join(process.cwd(), "db", "seed", "courses", "catalog.json"), "utf8")) as SeedData;
}

/** Catalogue de départ chargé dans la base de test (une seule fois, sous verrou : les tables du catalogue sont communes à tous les foyers et à tous les fichiers de tests). */
export async function ensureCatalog(db: Kysely<DB>): Promise<SeedReport> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(7014)`.execute(trx);
    return seedWithin(trx, readSeedData(), { priceDate: SEED_PRICE_DATE });
  });
}

class Rollback extends Error {}

/**
 * Charge le catalogue sur une base vidée DANS une transaction, laisse `check` l'examiner, puis annule tout : le vrai catalogue de la base de test n'est pas touché
 * (le vidage et le chargement disparaissent avec l'annulation).
 */
export async function withFreshCatalog(db: Kysely<DB>, check: (trx: Transaction<DB>, report: SeedReport) => Promise<void>): Promise<void> {
  try {
    await db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(7014)`.execute(trx);
      await sql`truncate meal_dishes, meal_batch_weeks, meal_cuisines, meal_dish_categories, meal_dish_tags, grocery_products, grocery_aisles restart identity cascade`.execute(trx);
      const report = await seedWithin(trx, readSeedData(), { priceDate: SEED_PRICE_DATE });
      await check(trx, report);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}
