import type { Kysely } from "kysely";
import { whatsapp } from "@/server/adapters/whatsapp";
import type { DB } from "@/server/db/schema.generated";
import { matchStore } from "./buyer-service";
import type { HandoffDeps } from "./handoff";
import { storefrontStore } from "./service";

/**
 * Dépendances du transfert de mise en relation dans l'application : magasins partagés, tchats via le simulateur
 * Digitorn, coordonnées de l'acheteur lues dans users, WhatsApp du fournisseur via channel_identities.
 */
export function appHandoffDeps(db: Kysely<DB>, now: () => Date = () => new Date()): HandoffDeps {
  return {
    store: matchStore(db),
    storefronts: storefrontStore(db),
    now,
    // Import différé : le module des adaptateurs Digitorn importe lui-même les agents locaux.
    postInApp: async (userId, agentRef, text) => {
      const { postToAgentChat } = await import("@/server/agents/proactive");
      await postToAgentChat(db, userId, agentRef, text);
    },
    buyerContactOf: async (userId) => {
      const row = await db.selectFrom("users").select(["first_name", "email", "phone"]).where("id", "=", userId).executeTakeFirst();
      return row ? { firstName: row.first_name, email: row.email, phone: row.phone } : null;
    },
    supplierFirstNameOf: async (userId) => (await db.selectFrom("users").select("first_name").where("id", "=", userId).executeTakeFirst())?.first_name ?? null,
    whatsapp: {
      transport: whatsapp(),
      identityOf: async (userId) => {
        const row = await db.selectFrom("channel_identities").select(["external_id", "opt_in", "last_inbound_at"]).where("user_id", "=", userId).where("channel", "=", "whatsapp").executeTakeFirst();
        return row ? { waId: row.external_id, optIn: row.opt_in, lastInboundAt: row.last_inbound_at ? new Date(row.last_inbound_at).toISOString() : null } : null;
      },
      record: async (userId, messageId) => {
        await db
          .insertInto("channel_messages")
          .values({ user_id: userId, channel: "whatsapp", external_id: messageId, direction: "outbound", status: "sent", created_at: now(), updated_at: now() })
          .onConflict((oc) => oc.columns(["channel", "external_id"]).doNothing())
          .execute();
      },
    },
  };
}
