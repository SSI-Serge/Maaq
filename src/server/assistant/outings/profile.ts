import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";

/**
 * Accès aux données privées d'un profil (critères, propositions, idées et mémoire des offres de sorties, US-117 RT1). Toute lecture ou écriture de ces cinq tables passe ici :
 * la transaction indique le profil à la base (`SET LOCAL app.user_id`), ce qui fait agir la sécurité par ligne dès que l'application se connectera avec un rôle limité
 * (condition d'ouverture du pilote, lot 9). En attendant, la protection repose sur le code : chaque requête filtre aussi sur le profil, et les tests vérifient qu'un parent
 * ne voit rien de ce qui concerne l'autre.
 */
export async function asProfile<T>(db: Kysely<DB>, userId: string, work: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.user_id', ${userId}, true)`.execute(trx);
    return work(trx);
  });
}
