import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { eraseConversation, eraseExchange } from "@/server/courses/chat/erase";
import { exchangesOf } from "@/server/courses/chat/exchanges";
import { listCourseMessages, sendCourseMessage } from "@/server/courses/chat/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { MONTH_PREFIX } from "@/server/courses/menu-ia/cards";
import { env } from "@/server/env";
import { encrypt } from "@/server/security/crypto";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";
import { validateTestMenu } from "./helpers/menu";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";

/** US-179 (CR-70, CR-71) : chaque profil efface des échanges de son tchat Courses et repas, ou toute sa conversation. */
const db = testDb();
const T0 = new Date(2026, 10, 6, 10, 0, 0).getTime();
const at = (minutes: number): Ctx => ({ db, now: new Date(T0 + minutes * 60_000) });
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error("aucun refus");
};
const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 };
const reply = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage, requestId: null });
function talking(): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  return { id: "faux", seen, send: async (request) => (seen.push(structuredClone(request)), reply(`Réponse ${seen.length}`)) };
}

async function household(): Promise<CoupleFamily> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(0), f.sophie)).options;
  await saveSettings(at(0), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }] });
  return f;
}
const say = (f: CoupleFamily, who: "sophie" | "marc" | "elodie", minute: number, text: string, model: AssistantModel) => sendCourseMessage(at(minute), f[who], { requestId: randomUUID(), text }, { model });
const texts = async (f: CoupleFamily, who: "sophie" | "marc" | "elodie", minute = 60) => (await listCourseMessages(at(minute), f[who])).map((m) => m.text);

describe("US-179 : effacer des échanges du tchat", () => {
  it("un échange est une demande et les réponses qui la suivent ; une carte « ingrédients manquants » et un message de l'agent sans demande forment chacun le leur", () => {
    const rows = [
      { id: "1", sender: "agent", text: "Bonjour" },
      { id: "2", sender: "profile", text: "Un menu" },
      { id: "3", sender: "agent", text: "Voici" },
      { id: "4", sender: "agent", text: '{"card":"menu","proposal":{}}' },
      { id: "5", sender: "agent", text: '{"card":"adjust","x":1}' },
      { id: "6", sender: "agent", text: "Proposition d'ajustement" },
      { id: "7", sender: "profile", text: "Merci" },
    ];
    expect([...exchangesOf(rows)]).toEqual([["1", "1"], ["2", "2"], ["3", "2"], ["4", "2"], ["5", "5"], ["6", "5"], ["7", "7"]]);
  });

  it("effacer un échange retire la demande et ses réponses, pour de bon ; l'agent n'en tient plus compte ; menus, listes et compteur restent (CA 2.1, 8.1)", async () => {
    const f = await household();
    await validateTestMenu(db, f, { picks: ["F4"], week: "2026-11-09", now: at(0).now });
    const model = talking();
    await say(f, "sophie", 1, "Première demande secrète", model);
    await say(f, "sophie", 3, "Deuxième demande", model);
    const before = await listCourseMessages(at(10), f.sophie);
    expect(before.map((m) => m.text)).toEqual(["Première demande secrète", "Réponse 1", "Deuxième demande", "Réponse 2"]);
    // les deux messages d'un échange portent le même identifiant d'échange
    expect(before[0].exchange).toBe(before[0].id);
    expect(before[1].exchange).toBe(before[0].id);
    expect(before[3].exchange).toBe(before[2].id);
    const counter = async () => (await db.selectFrom("daily_request_counters").select("request_count").where("user_id", "=", f.userIds.sophie).execute()).reduce((s, r) => s + r.request_count, 0);
    const requests = await counter();

    // on efface par n'importe quel message de l'échange : ici la réponse
    expect(await eraseExchange(at(10), f.sophie, before[1].id)).toEqual({ deleted: 2 });
    expect(await texts(f, "sophie")).toEqual(["Deuxième demande", "Réponse 2"]);
    expect(await db.selectFrom("agent_conversation_messages").select("id").where("id", "in", [before[0].id, before[1].id] as never[]).execute()).toEqual([]);
    expect((await rejection(eraseExchange(at(10), f.sophie, before[1].id))).code).toBe("message_not_found");

    // RF8 : l'échange effacé n'est plus envoyé à l'IA
    await say(f, "sophie", 12, "Troisième demande", model);
    const sent = JSON.stringify(model.seen[model.seen.length - 1].messages);
    expect(sent).toContain("Deuxième demande");
    expect(sent).not.toContain("Première demande secrète");
    expect(sent).not.toContain("Réponse 1");

    // RF4 : le menu validé, sa liste et le compteur de demandes ne bougent pas
    expect(await db.selectFrom("meal_menus").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(1);
    expect((await db.selectFrom("grocery_list_items").select("id").where("account_id", "=", f.accountId).execute()).length).toBeGreaterThan(5);
    expect(await counter()).toBe(requests + 1);
  });

  it("chaque profil n'efface que son propre tchat, invité secondaire compris ; un autre profil est refusé (CA 7.1)", async () => {
    const f = await household();
    const model = talking();
    await say(f, "sophie", 1, "Demande de Sophie", model);
    await say(f, "elodie", 2, "Demande d'Élodie", model);
    const sophie = await listCourseMessages(at(10), f.sophie);
    const elodie = await listCourseMessages(at(10), f.elodie);
    expect((await rejection(eraseExchange(at(10), f.marc, sophie[0].id))).status).toBe(404);
    expect((await rejection(eraseExchange(at(10), f.elodie, sophie[0].id))).status).toBe(404);
    expect((await rejection(eraseExchange(at(10), f.sophie, "abc"))).status).toBe(404);
    expect(await texts(f, "sophie")).toHaveLength(2);
    // l'invité secondaire efface le sien
    expect(await eraseExchange(at(10), f.elodie, elodie[0].id)).toEqual({ deleted: 2 });
    expect(await texts(f, "elodie")).toEqual([]);
    expect(await texts(f, "sophie")).toHaveLength(2);
    // effacer toute sa conversation ne touche pas celle des autres
    await say(f, "marc", 11, "Demande de Marc", model);
    expect(await eraseConversation(at(20), f.sophie)).toEqual({ deleted: 2 });
    expect(await texts(f, "sophie")).toEqual([]);
    expect(await texts(f, "marc")).toHaveLength(2);
    expect(await eraseConversation(at(20), f.sophie)).toEqual({ deleted: 0 });
  });

  it("une réponse en cours ne s'efface pas tant qu'elle n'est pas finie ; une demande restée sans réponse s'efface ensuite (RF6)", async () => {
    const f = await household();
    const silent: AssistantModel = { id: "faux", send: async () => ({ content: [{ type: "text", text: "" }], stopReason: "end_turn", usage, requestId: null }) };
    await say(f, "sophie", 1, "Demande sans réponse", silent).catch(() => undefined);
    const rows = await db.selectFrom("agent_conversation_messages as m").innerJoin("agent_conversations as c", "c.id", "m.conversation_id").select(["m.id", "m.sender"]).where("c.user_id", "=", f.userIds.sophie).orderBy("m.id").execute();
    const pending = rows.filter((r) => r.sender !== "agent");
    expect(pending.length).toBeGreaterThan(0);
    if (rows.length === pending.length) {
      // juste après l'envoi : la réponse est tenue pour en cours
      expect((await rejection(eraseExchange(at(1.5), f.sophie, String(pending[0].id)))).code).toBe("reply_in_progress");
      expect((await rejection(eraseConversation(at(1.5), f.sophie))).code).toBe("reply_in_progress");
    }
    // plus tard : l'échange s'efface
    expect((await eraseExchange(at(10), f.sophie, String(pending[0].id))).deleted).toBeGreaterThan(0);
  });

  it("« Effacer la conversation » garde la proposition cachée du menu du mois ; effacer la carte d'un menu non validé retire son bouton, un menu validé reste (RF3, RF4, RF5)", async () => {
    const f = await household();
    const model = talking();
    await say(f, "sophie", 1, "Bonjour", model);
    const conversation = await db.selectFrom("agent_conversations").select("id").where("user_id", "=", f.userIds.sophie).executeTakeFirstOrThrow();
    const key = Buffer.from(env().ENCRYPTION_KEY, "base64");
    const hidden = await db
      .insertInto("agent_conversation_messages")
      .values({ conversation_id: conversation.id, sender: "agent", kind: "text", content: encrypt(`${MONTH_PREFIX},"id":"x","weeks":[]}`, key), created_at: at(2).now })
      .returning("id")
      .executeTakeFirstOrThrow();
    // la proposition cachée n'est pas un échange : elle ne s'efface ni seule ni avec la conversation
    expect((await rejection(eraseExchange(at(10), f.sophie, String(hidden.id)))).code).toBe("message_not_found");
    await validateTestMenu(db, f, { picks: ["F4"], week: "2026-11-09", now: at(0).now });
    expect((await eraseConversation(at(10), f.sophie)).deleted).toBe(2);
    expect(await texts(f, "sophie")).toEqual([]);
    expect(await db.selectFrom("agent_conversation_messages").select("id").where("id", "=", hidden.id).execute()).toHaveLength(1);
    expect(await db.selectFrom("meal_menus").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(1);
  });
});
