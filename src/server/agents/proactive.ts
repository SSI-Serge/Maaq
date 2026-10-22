import type { Kysely } from "kysely";
import { digitorn } from "@/server/adapters/digitorn";
import type { MockDigitorn } from "@/server/adapters/digitorn/mock";
import type { DB } from "@/server/db/schema.generated";
import { ensureDigitornRef } from "@/server/profile/digitorn-ref";

/**
 * Message proactif d'un agent local dans le tchat d'un profil (rappel, suggestion, mise en relation). En mode
 * « live », le client réel expose le simulateur qui porte les agents locaux ; sans simulateur, pas de dépôt possible.
 */
export async function postToAgentChat(db: Kysely<DB>, userId: string, agentRef: string, text: string): Promise<void> {
  const client = digitorn() as { simulator?: unknown };
  const simulator = (client.simulator ?? client) as Partial<MockDigitorn>;
  if (typeof simulator.postAgentMessage !== "function") throw new Error("Message proactif d'agent : pas encore disponible hors simulateur Digitorn.");
  simulator.postAgentMessage(await ensureDigitornRef(db, userId), agentRef, text);
}
