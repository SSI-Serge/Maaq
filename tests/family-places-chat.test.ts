import { randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATUS_CODE, TYPE_CODE, type EventType } from "@/server/assistant/calendar";
import { addChild, loadPseudoMembers } from "@/server/assistant/family";
import { loadAgentDefinition } from "@/server/assistant/agent";
import { seal } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import type { AssistantModel, ContentBlock, ModelRequest } from "@/server/assistant/model";
import { FakePlaceProvider } from "@/server/assistant/place-provider";
import { answerPlaceSuggestion, requestPlaceSearch, runPlaceSearch, suggestPlaceSearch } from "@/server/assistant/places";
import { Pseudonymizer } from "@/server/assistant/pseudonymize";
import { listAssistantMessages, sendAssistantMessage } from "@/server/assistant/service";
import { executeTool, type ToolContext } from "@/server/assistant/tools";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createGuest, createProfile, sessionFor, testDb } from "./helpers/fixtures";

// La recherche « Sur place » est ouverte avec le faux service.
process.env.TRAVEL_MODE = "fake";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

const TZ = "Europe/Paris";
const NOW = new Date("2054-11-09T09:00:00Z");
const at = (): Ctx => ({ get db() { return db; }, now: NOW }) as Ctx;
const fake = () => new FakePlaceProvider();

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

async function family() {
  const primary = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: TZ }).where("id", "=", primary.accountId!).execute();
  const session = await sessionFor(db, primary.id);
  const elodie = await createGuest(db, primary.accountId!, "Élodie");
  const elodieSession = await sessionFor(db, elodie.id);
  await addChild(at(), session, { firstName: "Léo" });
  return { accountId: primary.accountId!, userId: primary.id, session, elodieSession, user: { id: primary.id, accountId: primary.accountId!, timeZone: TZ, parent: true } };
}
type Family = Awaited<ReturnType<typeof family>>;

async function seed(f: Family, s: { place?: string | null; type?: EventType; title?: string } = {}): Promise<string> {
  const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE[s.type ?? "family"]).executeTakeFirstOrThrow();
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal(s.title ?? "Visite du château"), starts_at: localToUtc("2054-11-10T15:00", TZ), ends_at: localToUtc("2054-11-10T17:00", TZ),
      status: STATUS_CODE.confirmed, location: s.place === null ? null : seal(s.place ?? "Château de Chambord"), source: "chat_text", whole_family: true, requested_by_user_id: f.userId,
      fingerprint: randomBytes(16), confirmed_at: NOW, confirmed_by_user_id: f.userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

const messages = (f: Family) => listAssistantMessages(at(), f.session);
const placeMessages = async (f: Family) => (await messages(f)).filter((m) => m.place);

// ---------------------------------------------------------------------------------------------------------------------------
describe("suggestion automatique dans le tchat (US-112 RF3)", () => {
  it("CA 3.1 : un RDV familial dans un lieu public reçoit « Voulez-vous que je cherche… ? », une seule fois", async () => {
    const f = await family();
    const event = await seed(f);
    expect(await suggestPlaceSearch(db, NOW, f.user, event, fake())).toBe(true);
    expect(await suggestPlaceSearch(db, NOW, f.user, event, fake())).toBe(false);
    const [message] = await placeMessages(f);
    expect(message).toMatchObject({ role: "assistant", text: "", place: { kind: "place_suggestion", eventId: event, place: "Château de Chambord", suggestion: "pending" } });
    expect(await placeMessages(f)).toHaveLength(1);
  });

  it("un RDV personnel est concerné ; un RDV scolaire, médical ou sans lieu ne l'est pas", async () => {
    const f = await family();
    expect(await suggestPlaceSearch(db, NOW, f.user, await seed(f, { type: "personal" }), fake())).toBe(true);
    expect(await suggestPlaceSearch(db, NOW, f.user, await seed(f, { type: "school" }), fake())).toBe(false);
    expect(await suggestPlaceSearch(db, NOW, f.user, await seed(f, { type: "medical" }), fake())).toBe(false);
    expect(await suggestPlaceSearch(db, NOW, f.user, await seed(f, { place: null }), fake())).toBe(false);
    expect(await placeMessages(f)).toHaveLength(1);
  });

  it("rien quand « Sur place » est fermé, ni pour un profil qui n'a pas de tchat", async () => {
    const f = await family();
    const event = await seed(f);
    expect(await suggestPlaceSearch(db, NOW, f.user, event, null)).toBe(false);
    expect(await suggestPlaceSearch(db, NOW, { ...f.user, parent: false }, event, fake())).toBe(false);
    expect(await placeMessages(f)).toHaveLength(0);
  });

  it("CA 3.2 : « Non, merci » est mémorisé, l'assistant répond, et la suggestion n'est pas répétée", async () => {
    const f = await family();
    const event = await seed(f);
    await suggestPlaceSearch(db, NOW, f.user, event, fake());
    expect(await answerPlaceSuggestion(at(), f.session, event, "declined", fake())).toEqual({ searchId: null });
    const thread = await messages(f);
    expect(thread.at(-1)).toMatchObject({ role: "assistant", text: "D'accord. Vous pourrez lancer la recherche depuis le détail du RDV." });
    expect(thread.find((m) => m.place)?.place?.suggestion).toBe("declined");
    expect(await suggestPlaceSearch(db, NOW, f.user, event, fake())).toBe(false);
    expect((await failure(answerPlaceSuggestion(at(), f.session, event, "accepted", fake()))).code).toBe("already_answered");
  });

  it("« Oui » lance la recherche (origine « suggestion ») : le résultat arrive dans le tchat, d'abord « en cours » puis les adresses", async () => {
    const f = await family();
    const event = await seed(f);
    await suggestPlaceSearch(db, NOW, f.user, event, fake());
    const { searchId } = await answerPlaceSuggestion(at(), f.session, event, "accepted", fake());
    expect(searchId).toBeTruthy();
    expect((await db.selectFrom("event_place_searches").select("origin").where("id", "=", searchId!).executeTakeFirstOrThrow()).origin).toBe("suggestion");
    const waiting = (await placeMessages(f)).find((m) => m.place?.kind === "place_results");
    expect(waiting?.place?.search).toMatchObject({ id: searchId, status: "queued", blocks: [] });
    await runPlaceSearch(at(), searchId!, fake());
    const done = (await placeMessages(f)).find((m) => m.place?.kind === "place_results")!.place!;
    expect(done.search?.status).toBe("done");
    expect(done.search?.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(done.search?.blocks.map((b) => b.items.length)).toEqual([2, 2, 2]);
    expect((await placeMessages(f)).find((m) => m.place?.kind === "place_suggestion")?.place?.suggestion).toBe("accepted");
  });

  it("une suggestion ne se répond que par le parent à qui elle a été faite", async () => {
    const f = await family();
    const other = await family();
    const event = await seed(f);
    await suggestPlaceSearch(db, NOW, f.user, event, fake());
    expect((await failure(answerPlaceSuggestion(at(), other.session, event, "accepted", fake()))).code).toBe("not_found");
    expect((await failure(answerPlaceSuggestion(at(), f.elodieSession, event, "accepted", fake()))).code).toBe("not_found");
  });
});

describe("recherche demandée : message dans le tchat", () => {
  it("le bouton du détail pose un message « Sur place » pour un parent, pas pour un invité secondaire", async () => {
    const f = await family();
    const event = await seed(f);
    await requestPlaceSearch(at(), f.session, event, "button", fake());
    expect(await placeMessages(f)).toHaveLength(1);
    const before = await db.selectFrom("agent_conversation_messages").select("id").execute();
    await requestPlaceSearch(at(), f.elodieSession, event, "button", fake());
    expect((await db.selectFrom("agent_conversation_messages").select("id").execute()).length).toBe(before.length);
  });

  it("CA 10.1 / 11.1 : aucun résultat et échec s'affichent dans la carte", async () => {
    const f = await family();
    const event = await seed(f);
    const empty = new FakePlaceProvider();
    empty.empty = true;
    const a = await requestPlaceSearch(at(), f.session, event, "chat", empty);
    await runPlaceSearch(at(), a, empty);
    const down = new FakePlaceProvider();
    down.failing = true;
    const b = await requestPlaceSearch(at(), f.session, event, "chat", down);
    await runPlaceSearch(at(), b, down);
    const statuses = (await placeMessages(f)).map((m) => m.place?.search?.status);
    expect(statuses).toEqual(["no_result", "failed"]);
  });
});

describe("agent : jugement du lieu et demande de recherche", () => {
  const toolCtx = (f: Family): ToolContext => ({ db, accountId: f.accountId, userId: f.userId, timeZone: TZ, now: NOW, requestId: randomUUID(), source: "typed", pseudo: new Pseudonymizer([]), created: { ids: [] }, proposals: [] });
  const create = (over: Record<string, unknown>) => ({ titre: "Visite du château", type: "familial", debut: "2054-11-12T15:00", fin: "2054-11-12T17:00", journee_entiere: false, membres: ["Enfant 1"], source: "saisie", ...over });

  async function ctxWithMembers(f: Family): Promise<ToolContext> {
    return { ...toolCtx(f), pseudo: new Pseudonymizer(await loadPseudoMembers(db, f.accountId)) };
  }

  it("CA 3.1 / 3.3 : « oui » et « doute » sont retenus pour la suggestion, « non » (chez Mamie) ne l'est pas", async () => {
    const f = await family();
    const ctx = await ctxWithMembers(f);
    await executeTool("creer_evenement_provisoire", create({ lieu: "Château de Chambord", lieu_public: "oui" }), ctx);
    await executeTool("creer_evenement_provisoire", create({ titre: "Goûter", debut: "2054-11-13T15:00", fin: "2054-11-13T16:00", lieu: "12 rue des Lilas, Tours", lieu_public: "doute" }), ctx);
    await executeTool("creer_evenement_provisoire", create({ titre: "Anniversaire", debut: "2054-11-14T15:00", fin: "2054-11-14T16:00", lieu: "Chez Mamie", lieu_public: "non" }), ctx);
    await executeTool("creer_evenement_provisoire", create({ titre: "Sortie", debut: "2054-11-15T15:00", fin: "2054-11-15T16:00", lieu_public: "oui" }), ctx); // pas de lieu : rien
    expect([...(ctx.placeHints ?? new Map()).values()].sort()).toEqual(["doute", "oui"]);
  });

  it("CA 2.1 : « chercher_sur_place » lance la recherche d'un RDV existant et n'en dit pas le lieu au modèle", async () => {
    const f = await family();
    const event = await seed(f);
    const ctx = await ctxWithMembers(f);
    const result = await executeTool("chercher_sur_place", { id: `evt-${event.slice(0, 8)}` }, ctx);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ statut: "recherche_lancee" });
    expect(result.content).not.toContain("Chambord");
    expect(ctx.placeSearchIds).toHaveLength(1);
    const medical = await seed(f, { type: "medical" });
    expect((await executeTool("chercher_sur_place", { id: `evt-${medical.slice(0, 8)}` }, ctx)).content).toContain("médical");
  });

  it("l'outil rend au modèle le motif d'un refus (limite de 3 recherches)", async () => {
    const f = await family();
    const event = await seed(f);
    const ctx = await ctxWithMembers(f);
    for (let i = 0; i < 3; i++) await executeTool("chercher_sur_place", { id: `evt-${event.slice(0, 8)}` }, ctx);
    const refused = await executeTool("chercher_sur_place", { id: `evt-${event.slice(0, 8)}` }, ctx);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain("Nombre maximal de recherches pour ce RDV atteint (3).");
  });

  it("la définition de l'agent connaît l'outil et le paramètre, et les consignes les expliquent", () => {
    const definition = loadAgentDefinition();
    const tools = definition.tools as { name: string; input_schema: { properties: Record<string, unknown> } }[];
    expect(tools.map((t) => t.name)).toContain("chercher_sur_place");
    expect(Object.keys(tools.find((t) => t.name === "creer_evenement_provisoire")!.input_schema.properties)).toContain("lieu_public");
    expect(definition.instructions).toContain("chercher_sur_place");
    expect(definition.instructions).toContain("lieu_public");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("de bout en bout par l'assistant", () => {
  const scripted = (steps: (n: number) => ContentBlock[]): AssistantModel & { requests: ModelRequest[] } => {
    const requests: ModelRequest[] = [];
    return {
      requests,
      async send(request) {
        requests.push(structuredClone(request));
        const content = steps(requests.length - 1);
        return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { inputTokens: 100, outputTokens: 10, cacheRead: 0, cacheWrite: 0 }, requestId: `req_${requests.length}` };
      },
    };
  };
  const use = (id: string, name: string, input: unknown): ContentBlock => ({ type: "tool_use", id, name, input });
  const say = (text: string): ContentBlock[] => [{ type: "text", text }];
  const session = (f: Family): SessionContext => ({ ...f.session, device: { ...f.session.device, timezone: TZ } });

  it("un RDV dans un lieu public créé par l'assistant : sa réponse, puis la suggestion juste après", async () => {
    const f = await family();
    const model = scripted((n) =>
      n === 0
        ? [use("t", "creer_evenement_provisoire", { titre: "Visite du château", type: "familial", debut: "2054-11-12T15:00", fin: "2054-11-12T17:00", journee_entiere: false, membres: ["Enfant 1"], source: "saisie", lieu: "Château de Chambord", lieu_public: "oui" })]
        : say("C'est noté. Vous pouvez le confirmer dans l'application."),
    );
    const reply = await sendAssistantMessage(at(), session(f), { requestId: randomUUID(), text: "Visite du château de Chambord le 12 novembre à 15h pour Léo" }, { model });
    expect(reply).toMatchObject({ failed: false, placeSearchIds: [], placeMessages: 1 });
    const thread = await messages(f);
    expect(thread.map((m) => (m.place ? m.place.kind : m.role))).toEqual(["user", "assistant", "place_suggestion"]);
    expect(thread.at(-1)?.place).toMatchObject({ place: "Château de Chambord", suggestion: "pending" });
  });

  it("CA 2.1 : « Où peut-on se garer et manger près du château ? » lance la recherche ; le résultat arrive dans le fil après la réponse", async () => {
    const f = await family();
    const event = await seed(f);
    const model = scripted((n) => (n === 0 ? [use("t", "chercher_sur_place", { id: `evt-${event.slice(0, 8)}` })] : say("C'est lancé : le résultat arrivera dans le tchat et dans le détail du rendez-vous.")));
    const reply = await sendAssistantMessage(at(), session(f), { requestId: randomUUID(), text: "Où peut-on se garer et manger près du château ?" }, { model });
    expect(reply.placeSearchIds).toHaveLength(1);
    expect(reply.placeMessages).toBe(1);
    await runPlaceSearch(at(), reply.placeSearchIds[0], fake());
    const thread = await messages(f);
    expect(thread.map((m) => (m.place ? m.place.kind : m.role))).toEqual(["user", "assistant", "place_results"]);
    expect(thread.at(-1)?.place?.search?.status).toBe("done");
    // Le modèle ne reçoit jamais le lieu du RDV qu'il cherche.
    expect(JSON.stringify(model.requests.map((r) => r.messages))).not.toContain("Chambord");
  });
});
