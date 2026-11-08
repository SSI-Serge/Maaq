import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { sendCourseMessage } from "@/server/courses/chat/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

// MENU_IA reste à sa valeur par défaut (« off ») : le menu composé par l'IA est fermé, comme en production tant que le DPO n'a pas répondu (CR-43)
process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
delete process.env.MENU_IA;

const db = testDb();
const at = (): Ctx => ({ db, now: new Date(2026, 10, 6, 10, 0, 0) });
const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 };
const reply = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage, requestId: null });
function scripted(...steps: ModelResponse[]): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  let i = 0;
  return { id: "faux", seen, send: async (request) => (seen.push(structuredClone(request)), steps[Math.min(i++, steps.length - 1)]) };
}

describe("MENU_IA fermé", () => {
  it("les outils de menu ne sont pas donnés au modèle et aucune donnée de santé ne part", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const options = (await getSettings(at(), f.sophie)).options;
    await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), allergens: ["Arachide"] });
    const model = scripted(reply("Bonjour !"));
    await sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "Fais mon menu" }, { model });
    expect((model.seen[0].tools as { name: string }[]).map((t) => t.name)).not.toContain("proposer_menu");
    expect((model.seen[0].tools as { name: string }[]).map((t) => t.name)).not.toContain("preparer_menu");
    expect(JSON.stringify(model.seen)).not.toMatch(/Arachide/);
  });
});
