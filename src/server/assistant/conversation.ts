import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";

/** Ligne de l'Assistant Famille dans la table des agents (créée avec la base) : les conversations du tchat de MAAQ s'y rattachent. */
export async function familyAgentId(db: Kysely<DB>): Promise<string> {
  return (await db.selectFrom("agents").select("id").where("platform", "=", "anthropic").where("platform_agent_ref", "=", "assistant-famille").executeTakeFirstOrThrow()).id;
}

/** Une conversation par parent (agent_conversations : un profil, un agent). */
export async function conversationOf(db: Kysely<DB>, accountId: string, userId: string, now: Date): Promise<{ id: string }> {
  return db
    .insertInto("agent_conversations")
    .values({ account_id: accountId, user_id: userId, agent_id: await familyAgentId(db), last_message_at: now })
    .onConflict((oc) => oc.columns(["user_id", "agent_id"]).doUpdateSet({ last_message_at: now }))
    .returning("id")
    .executeTakeFirstOrThrow();
}
