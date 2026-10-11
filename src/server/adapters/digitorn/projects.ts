import type { Kysely } from "kysely";
import { db } from "@/server/db/client";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { decrypt } from "@/server/security/crypto";
import type { LiveOptions } from "./live";

const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

/**
 * Projets Digitorn des agents publiés : la clé secrète de chaque agent est rangée chiffrée dans la base (saisie dans la
 * console d'administration), jamais dans l'environnement ni dans les journaux.
 */
export function projectsFrom(database: () => Kysely<DB>): Pick<LiveOptions, "projectOf" | "allProjects"> {
  return {
    async projectOf(agentRef) {
      const row = await database()
        .selectFrom("agents")
        .select(["digitorn_api_key_encrypted", "digitorn_app_url"])
        .where("digitorn_agent_ref", "=", agentRef)
        .executeTakeFirst();
      if (!row?.digitorn_api_key_encrypted) return null;
      return { apiKey: decrypt(Buffer.from(row.digitorn_api_key_encrypted), key()), appUrl: row.digitorn_app_url };
    },

    async allProjects() {
      const rows = await database()
        .selectFrom("agents")
        .select(["digitorn_agent_ref", "digitorn_api_key_encrypted"])
        .where("digitorn_api_key_encrypted", "is not", null)
        .execute();
      return rows.map((row) => ({ agentRef: row.digitorn_agent_ref, apiKey: decrypt(Buffer.from(row.digitorn_api_key_encrypted!), key()) }));
    },
  };
}

export const projectsFromDatabase = projectsFrom(db);
