import { placesDirectory } from "@/server/adapters/places";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { giftStore, prefsStore, userIdOfRef } from "@/server/gifts/service";
import { matchStore } from "@/server/marketplace/buyer-service";
import { storefrontStore } from "@/server/marketplace/service";
import { coupDeMainBrain } from "./coup-de-main";
import { kdoHelpBrain } from "./kdo-help";
import { anthropicLlm } from "./llm";
import type { AgentBrain } from "./types";
import { vitrineBrain } from "./vitrine";

export type * from "./types";

/**
 * Agents exécutés par MAAQ (LOCAL_AGENTS_MODE). Avec « off », le simulateur Digitorn répond
 * seul, comme avant ; avec « anthropic », chaque agent listé ici répond avec un modèle Claude.
 */
export function localBrains(): AgentBrain[] {
  const { LOCAL_AGENTS_MODE, LOCAL_AGENTS_MODEL } = env();
  if (LOCAL_AGENTS_MODE === "off") return [];
  const llm = anthropicLlm({ model: LOCAL_AGENTS_MODEL });
  const userIdOf = (ref: string) => userIdOfRef(db(), ref);
  const profileOf = async (ref: string) => {
    const row = await db().selectFrom("users").select(["id", "first_name", "postcode"]).where("digitorn_user_ref", "=", ref).executeTakeFirst();
    return row ? { id: row.id, firstName: row.first_name, postcode: row.postcode } : null;
  };
  // Import différé : le module des adaptateurs Digitorn importe lui-même localBrains().
  const notifySupplier = async (supplierUserId: string, text: string) => {
    const { postToAgentChat } = await import("./proactive");
    await postToAgentChat(db(), supplierUserId, "vitrine", text);
  };
  return [
    kdoHelpBrain(llm, { store: giftStore(), prefs: prefsStore(), userIdOf }),
    vitrineBrain(llm, { store: storefrontStore(), userIdOf }),
    coupDeMainBrain(llm, { store: matchStore(), profileOf, notifySupplier, directory: placesDirectory() }),
  ];
}
