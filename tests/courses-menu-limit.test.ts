import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { MENU_LIMIT_REPLY } from "@/server/courses/chat/agent";
import { sendCourseMessage } from "@/server/courses/chat/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { purgeExpired } from "@/server/jobs";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
process.env.MENU_IA = "live";

const db = testDb();
const NOW = new Date(2026, 10, 6, 10, 0, 0);
const at = (): Ctx => ({ db, now: NOW });

const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 };
const reply = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage, requestId: null });
const callTools = (...calls: { name: string; input: unknown }[]): ModelResponse => ({
  content: calls.map((c, i) => ({ type: "tool_use" as const, id: `tu_${i}_${c.name}`, name: c.name, input: c.input })),
  stopReason: "tool_use",
  usage,
  requestId: null,
});
function scripted(...steps: ModelResponse[]): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  let i = 0;
  return { id: "faux", seen, send: async (request) => (seen.push(structuredClone(request)), steps[Math.min(i++, steps.length - 1)]) };
}

async function household() {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const opts = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: opts.cuisines.map((c) => c.id) });
  const dishes = (await db.selectFrom("meal_dishes").select("name").orderBy("id").limit(7).execute()).map((d) => ({ nom: d.name }));
  return { f, menu: { diners: dishes } };
}

const setCap = (value: number) => db.updateTable("platform_settings").set({ value_text: String(value) }).where("setting_key", "=", "meal_menu_daily_cap").execute();
afterAll(() => setCap(10));

describe("CR-44 : plafond de menus complets par foyer et par jour", () => {
  it("chaque menu accepté, correction comprise, est compté ; au-delà du plafond : « vous pourrez reprendre demain », sans carte ni erreur", async () => {
    await setCap(2);
    const { f, menu } = await household();
    const compose = (input: unknown) => sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "Un menu" }, { model: scripted(callTools({ name: "proposer_menu", input }), reply("Voici.")) });
    expect((await compose(menu)).card).toBeDefined();
    expect((await compose(menu)).card).toBeDefined();
    const third = await compose(menu);
    expect(third).toMatchObject({ failed: false, reply: MENU_LIMIT_REPLY });
    expect(third.card).toBeUndefined();
    expect(MENU_LIMIT_REPLY).toBe("Vous avez atteint la limite de menus pour aujourd'hui : vous pourrez reprendre demain.");
    const counter = await db.selectFrom("meal_menu_daily_counters").select("menu_count").where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    expect(counter.menu_count).toBe(2);
    // l'autre foyer a son propre compteur
    const other = await household();
    const ok = await sendCourseMessage(at(), other.f.sophie, { requestId: randomUUID(), text: "Un menu" }, { model: scripted(callTools({ name: "proposer_menu", input: other.menu }), reply("Voici.")) });
    expect(ok.card).toBeDefined();
  });

  it("un menu refusé par MAAQ (invalide) n'est pas compté ; le plafond se règle en console", async () => {
    await setCap(1);
    const { f, menu } = await household();
    const broken = { diners: [{ nom: "Plat libre sans rien" }] };
    const model = scripted(callTools({ name: "proposer_menu", input: broken }), callTools({ name: "proposer_menu", input: menu }), reply("Voici."));
    const done = await sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "Un menu" }, { model });
    expect(done.card).toBeDefined();
    expect((await db.selectFrom("meal_menu_daily_counters").select("menu_count").where("account_id", "=", f.accountId).executeTakeFirstOrThrow()).menu_count).toBe(1);
    const again = await sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "Un autre" }, { model: scripted(callTools({ name: "proposer_menu", input: menu }), reply("Voici.")) });
    expect(again.reply).toBe(MENU_LIMIT_REPLY);
  });

  it("la purge quotidienne efface les compteurs de plus de 7 jours et garde les récents", async () => {
    const { f } = await household();
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const recent = new Date().toISOString().slice(0, 10);
    await db.insertInto("meal_menu_daily_counters").values([{ account_id: f.accountId, menu_date: old as never, menu_count: 3 }, { account_id: f.accountId, menu_date: recent as never, menu_count: 1 }]).execute();
    await purgeExpired({ db, now: new Date() });
    const left = await db.selectFrom("meal_menu_daily_counters").select("menu_count").where("account_id", "=", f.accountId).execute();
    expect(left.map((r) => r.menu_count)).toEqual([1]);
  });
});
