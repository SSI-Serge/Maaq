import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { DB } from "@/server/db/schema.generated";

type Db = Kysely<DB> | Transaction<DB>;

/**
 * Identifiant du profil chez Digitorn, créé à la première transmission (US-10 RT2). Le format
 * définitif reste à valider avec Digitorn (hypothèse H11).
 */
export async function ensureDigitornRef(db: Db, userId: string): Promise<string> {
  const row = await db.selectFrom("users").select("digitorn_user_ref").where("id", "=", userId).executeTakeFirstOrThrow();
  if (row.digitorn_user_ref) return row.digitorn_user_ref;
  const ref = `maaq-${randomUUID()}`;
  // Deux créations simultanées : la première gagne, l'autre relit.
  await db.updateTable("users").set({ digitorn_user_ref: ref }).where("id", "=", userId).where("digitorn_user_ref", "is", null).execute();
  const final = await db.selectFrom("users").select("digitorn_user_ref").where("id", "=", userId).executeTakeFirstOrThrow();
  return final.digitorn_user_ref!;
}
