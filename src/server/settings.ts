import type { Kysely, Transaction } from "kysely";
import type { DB } from "@/server/db/schema.generated";

type Db = Kysely<DB> | Transaction<DB>;

/**
 * Lit un réglage entier de la plateforme (US-65). Lu à chaque usage : une nouvelle valeur
 * s'applique au traitement suivant sans redémarrage (US-65 RF3, RT1).
 */
export async function integerSetting(db: Db, key: string, fallback: number): Promise<number> {
  const row = await db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", key).executeTakeFirst();
  const value = Number(row?.value_text);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
