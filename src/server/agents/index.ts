import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { giftStore, prefsStore, userIdOfRef } from "@/server/gifts/service";
import { kdoHelpBrain } from "./kdo-help";
import { anthropicLlm } from "./llm";
import type { AgentBrain } from "./types";

export type * from "./types";

/**
 * Agents exécutés par MAAQ (LOCAL_AGENTS_MODE). Avec « off », le simulateur Digitorn répond
 * seul, comme avant ; avec « anthropic », chaque agent listé ici répond avec un modèle Claude.
 */
export function localBrains(): AgentBrain[] {
  const { LOCAL_AGENTS_MODE, LOCAL_AGENTS_MODEL } = env();
  if (LOCAL_AGENTS_MODE === "off") return [];
  const llm = anthropicLlm({ model: LOCAL_AGENTS_MODEL });
  return [kdoHelpBrain(llm, { store: giftStore(), prefs: prefsStore(), userIdOf: (ref) => userIdOfRef(db(), ref) })];
}
