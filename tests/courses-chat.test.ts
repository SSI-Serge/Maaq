import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AssistantModel, ModelRequest, ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { cleanMarkers, contextBlock } from "@/server/courses/chat/agent";
import { listCourseMessages, sendCourseMessage } from "@/server/courses/chat/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { myList } from "@/server/courses/list/mine";
import { validateList } from "@/server/courses/list/service";
import { menuPropose, menuStart, menuValidate } from "@/server/courses/menu/service";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

const db = testDb();
const NOW = new Date(2026, 10, 6, 10, 0, 0);
const at = (): Ctx => ({ db, now: NOW });
type Failure = { code: string; status: number; message: string };
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Failure;
  }
  throw new Error("aucun refus");
};

const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 };
const reply = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage, requestId: null });
const useTools = (...calls: { name: string; input: unknown }[]): ModelResponse => ({
  content: calls.map((c, i) => ({ type: "tool_use" as const, id: `tu_${i}`, name: c.name, input: c.input })),
  stopReason: "tool_use",
  usage,
  requestId: null,
});

/** Faux modèle : joue des réponses prévues et garde ce qu'il a reçu. */
function scripted(...steps: ModelResponse[]): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  let i = 0;
  return { id: "faux", seen, send: async (request) => (seen.push(structuredClone(request)), steps[Math.min(i++, steps.length - 1)]) };
}

async function household(strict = false): Promise<CoupleFamily> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), ...(strict ? { allergens: ["Arachide"], diets: ["Végétarien"], allergyText: "kiwi" } : {}) });
  return f;
}
const say = (f: CoupleFamily, who: "sophie" | "marc" | "elodie", text: string, model: AssistantModel) => sendCourseMessage(at(), f[who], { requestId: randomUUID(), text }, { model });

describe("Tchat de l'agent Courses et repas", () => {
  it("« Ajoute du lait » appelle l'outil, le produit est dans la liste, la réponse est rangée chiffrée puis relue", async () => {
    const f = await household();
    const model = scripted(useTools({ name: "ajouter_produit", input: { nom: "Lait demi-écrémé" } }), reply("C'est noté : le lait est dans vos produits ajoutés. [[ecran:liste]]"));
    // le marqueur n'est gardé que si l'écran a été demandé par l'outil ouvrir_ecran : sinon il devient le nom de l'écran
    const done = await say(f, "sophie", "Ajoute du lait", model);
    expect(done.failed).toBe(false);
    expect(done.reply).toBe("C'est noté : le lait est dans vos produits ajoutés. Liste de courses");
    const item = await db.selectFrom("grocery_list_items").select(["label", "added_by_user_id", "state"]).where("account_id", "=", f.accountId).where("source", "=", "added").executeTakeFirstOrThrow();
    expect(item).toMatchObject({ label: "Lait demi-écrémé", added_by_user_id: f.userIds.sophie, state: "preparing" });
    const stored = await db.selectFrom("agent_conversation_messages").select("content").execute();
    expect(stored.every((m) => !m.content || !m.content.toString("utf8").includes("lait"))).toBe(true);
    expect((await listCourseMessages(at(), f.sophie)).map((m) => [m.role, m.text])).toEqual([["user", "Ajoute du lait"], ["assistant", done.reply]]);
    // l'autre parent a sa propre conversation
    expect(await listCourseMessages(at(), f.marc)).toEqual([]);
  });

  it("le modèle ne reçoit ni allergie, ni régime, ni prénom, ni ville ; seulement la date, le jour du budget, les réglages manquants et le droit", async () => {
    const f = await household(true);
    const model = scripted(reply("Bonjour !"));
    await say(f, "sophie", "Bonjour", model);
    const sent = JSON.stringify(model.seen.map((r) => r.messages));
    expect(sent).not.toMatch(/Arachide|kiwi|Végétarien|Sophie|Marc|Nantes/i);
    expect(sent).toContain("Droit de la personne qui écrit : parent du couple");
    expect(sent).toContain("Jour du budget : non");
    expect(model.seen[0].system).toContain("Courses et repas");
    expect(model.seen[0].tools.length).toBe(5);
    const first = contextBlock({ now: NOW, timeZone: "Europe/Paris", budgetDay: true, missingSettings: ["city", "goals"], access: "list" });
    expect(first).toContain("oui, c'est aujourd'hui");
    expect(first).toContain("la ville, les objectifs");
    expect(first).toContain("invité secondaire");
  });

  it("« J'ai pris le lait et les œufs » coche les produits de la liste validée ; un produit absent est signalé ; l'historique du fil est repris", async () => {
    const f = await household();
    const pick = (await menuStart(at(), f.sophie)).groups.flatMap((g) => g.dishes)[0];
    const menu = await menuPropose(at(), f.sophie, { picks: [pick.id] });
    await menuValidate(at(), f.sophie, { picks: [pick.id], dinners: menu.days.map((d) => d.dish.id), express: [] });
    await validateList(at(), f.sophie, {
      scenario: 1,
      lines: [
        { name: "Lait demi-écrémé", qty: 1, store: null, ref: null, price: null, source: "added" as const },
        { name: "Œufs", qty: 1, store: null, ref: null, price: null, source: "added" as const },
        { name: "Piles AA", qty: 1, store: null, ref: null, price: null, source: "added" as const },
      ],
    });
    const model = scripted(useTools({ name: "marquer_achete", input: { produits: ["lait", "oeufs", "farine"] } }), reply("C'est noté : le lait et les œufs sortent de la liste."));
    const done = await say(f, "marc", "J'ai pris le lait et les œufs", model);
    expect(done.failed).toBe(false);
    const result = JSON.stringify(model.seen[1].messages.at(-1));
    expect(result).toContain("Lait demi-écrémé");
    expect(result).toContain("Introuvables dans la liste validée : farine");
    const left = (await myList(at(), f.sophie)).stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).map((l) => l.name);
    expect(left).toEqual(["Piles AA"]);
    const next = scripted(reply("Avec plaisir."));
    await say(f, "marc", "Merci", next);
    const history = JSON.stringify(next.seen[0].messages);
    expect(history).toContain("J'ai pris le lait et les œufs");
    expect(history).toContain("sortent de la liste");
  });

  it("l'invité secondaire ajoute un produit mais l'outil refuse le budget et les écrans réservés au couple", async () => {
    const f = await household();
    const model = scripted(
      useTools({ name: "ajouter_produit", input: { nom: "Essuie-tout" } }, { name: "chiffres_budget", input: {} }, { name: "ouvrir_ecran", input: { ecran: "menu" } }, { name: "ouvrir_ecran", input: { ecran: "ma_liste" } }),
      reply("Voici : [[ecran:menu]] [[ecran:ma_liste]]"),
    );
    const done = await say(f, "elodie", "Ajoute des essuie-tout, montre-moi le budget", model);
    expect(done.reply).toBe("Voici : Menu de la semaine [[ecran:ma_liste]]");
    const results = JSON.stringify(model.seen[1].messages.at(-1));
    expect(results).toContain("réservé aux deux parents du couple");
    const item = await db.selectFrom("grocery_list_items").select("added_by_user_id").where("account_id", "=", f.accountId).where("name_key", "=", "essuie tout").executeTakeFirstOrThrow();
    expect(item.added_by_user_id).toBe(f.userIds.elodie);
  });

  it("le budget donne des chiffres calculés par MAAQ ; marqueurs d'écran inconnus effacés", async () => {
    const f = await household();
    const model = scripted(useTools({ name: "chiffres_budget", input: {} }), reply("Le budget est vide. [[ecran:inconnu]]"));
    const done = await say(f, "sophie", "Mon budget ?", model);
    expect(JSON.stringify(model.seen[1].messages.at(-1))).toContain("Aucun ticket enregistré");
    expect(done.reply).toBe("Le budget est vide. ");
    expect(cleanMarkers("[[ecran:budget]] [[ecran:ticket]]", new Set(["budget"]))).toBe("[[ecran:budget]] Enregistrer un ticket");
  });

  it("une demande renvoyée n'est pas refaite ni recomptée ; modèle en panne : échec propre ; texte vide ou trop long refusé ; agent fermé sans modèle", async () => {
    const f = await household();
    const requestId = randomUUID();
    const model = scripted(reply("Bonjour !"));
    await sendCourseMessage(at(), f.sophie, { requestId, text: "Bonjour" }, { model });
    const again = await sendCourseMessage(at(), f.sophie, { requestId, text: "Bonjour" }, { model });
    expect(again).toMatchObject({ alreadyAnswered: true, reply: "Bonjour !" });
    expect(model.seen).toHaveLength(1);
    const broken: AssistantModel = { send: async () => { throw new Error("panne"); } };
    const failed = await sendCourseMessage(at(), f.marc, { requestId: randomUUID(), text: "Bonjour" }, { model: broken });
    expect(failed.failed).toBe(true);
    expect(failed.reply).toMatch(/Je n'ai pas pu traiter/);
    expect((await rejection(sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "  " }, { model }))).code).toBe("empty_request");
    expect((await rejection(sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "x".repeat(2001) }, { model }))).code).toBe("request_too_long");
    expect((await rejection(sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "Bonjour" }))).code).toBe("assistant_unavailable");
  });
});
