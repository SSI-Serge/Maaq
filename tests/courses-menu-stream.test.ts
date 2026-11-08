import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/client/api";
import { postStream, splitLines } from "@/client/stream";
import { readStream, type AssistantModel, type ModelDelta, type ModelRequest, type ModelResponse } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import { sendCourseMessage } from "@/server/courses/chat/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { menuProgress, type MenuProgress } from "@/server/courses/menu-ia/progress";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

process.env.ASSISTANT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test";
process.env.MENU_IA = "live";

const db = testDb();
const at = (): Ctx => ({ db, now: new Date(2026, 10, 6, 10, 0, 0) });
const usage = { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 };

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const bodyOf = (text: string, chunk = 17): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
};

describe("menu au fil de l'eau : lecture du flux du modèle", () => {
  it("rend la même réponse que sans flux : texte, appel d'outil aux arguments complets, jetons, raison d'arrêt ; les morceaux arrivent un à un, même coupés au milieu", async () => {
    const json = JSON.stringify({ diners: [{ nom: "Velouté de panais" }], express: [] });
    const text = sse([
      { type: "message_start", message: { usage: { input_tokens: 8, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Je compose " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "le menu é" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "proposer_menu", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(0, 20) } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(20) } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 321 } },
      { type: "message_stop" },
    ]);
    const deltas: ModelDelta[] = [];
    const response = await readStream(bodyOf(text), (d) => deltas.push(d), "req_1");
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([{ type: "text", text: "Je compose le menu é" }, { type: "tool_use", id: "tu_1", name: "proposer_menu", input: JSON.parse(json) }]);
    expect(response.usage).toMatchObject({ inputTokens: 8, outputTokens: 321, cacheRead: 200, cacheWrite: 100 });
    expect(response.requestId).toBe("req_1");
    expect(deltas.filter((d) => d.type === "tool_input").map((d) => (d as { json: string }).json)).toEqual([json.slice(0, 20), json]);
  });

  it("une erreur du modèle en cours de flux devient une erreur à réessayer", async () => {
    const text = sse([{ type: "message_start", message: {} }, { type: "error", error: { type: "overloaded_error", message: "x" } }]);
    await expect(readStream(bodyOf(text), () => {}, null)).rejects.toMatchObject({ name: "ModelError", retryable: true });
  });

  it("menuProgress lit ce qui est déjà complet d'un menu coupé : noms des plats terminés, plats express à part, nombre d'étapes", () => {
    const full = JSON.stringify({ diners: [{ nom: "Gratin \"maison\"", plat_id: "H:1" }, { nom: "Curry" }], express: [{ nom: "Salade" }], etapes: [{ texte: "Préchauffer." }, { texte: "Cuire." }] });
    expect(menuProgress(full)).toEqual({ dinners: ['Gratin "maison"', "Curry"], express: ["Salade"], steps: 2 });
    const cut = full.slice(0, full.indexOf("Curry") + 3);
    expect(menuProgress(cut)).toEqual({ dinners: ['Gratin "maison"'], express: [], steps: 0 });
    expect(menuProgress("")).toEqual({ dinners: [], express: [], steps: 0 });
    // un plat n'apparaît qu'une fois son nom fermé
    expect(menuProgress('{"diners":[{"nom":"Cur')).toEqual({ dinners: [], express: [], steps: 0 });
  });

  it("le tchat rappelle onProgress à chaque plat de plus écrit par le modèle, une seule fois par état", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const opts = (await getSettings(at(), f.sophie)).options;
    await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: opts.cuisines.map((c) => c.id) });
    const dishes = (await db.selectFrom("meal_dishes").select("name").orderBy("id").limit(7).execute()).map((d) => ({ nom: d.name }));
    const input = { diners: dishes };
    const json = JSON.stringify(input);
    let calls = 0;
    const model: AssistantModel = {
      id: "faux",
      send: async (_request: ModelRequest, options): Promise<ModelResponse> => {
        calls += 1;
        if (calls === 1) {
          // le modèle écrit le menu par morceaux de 40 caractères
          for (let end = 40; end < json.length + 40; end += 40) options?.onDelta?.({ type: "tool_input", name: "proposer_menu", json: json.slice(0, Math.min(end, json.length)) });
          return { content: [{ type: "tool_use", id: "tu_1", name: "proposer_menu", input }], stopReason: "tool_use", usage, requestId: null };
        }
        return { content: [{ type: "text", text: "Voici." }], stopReason: "end_turn", usage, requestId: null };
      },
    };
    const seen: MenuProgress[] = [];
    const done = await sendCourseMessage(at(), f.sophie, { requestId: randomUUID(), text: "Un menu" }, { model, onProgress: (p) => seen.push(structuredClone(p)) });
    expect(done.card).toBeDefined();
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.at(-1)!.dinners).toEqual(dishes.map((d) => d.nom));
    // des états successifs, sans doublon, du plus court au plus long
    const counts = seen.map((p) => p.dinners.length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts.map((c, i) => `${c}/${seen[i].express.length}/${seen[i].steps}`)).size).toBe(seen.length);
  });
});

describe("menu au fil de l'eau : client du flux", () => {
  const ndjson = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const streamResponse = (text: string, status = 200) => new Response(bodyOf(text, 9), { status, headers: { "content-type": "application/x-ndjson" } });

  it("sépare les lignes complètes et garde la ligne coupée", () => {
    expect(splitLines('{"a":1}\n{"b":')).toEqual({ lines: ['{"a":1}'], rest: '{"b":' });
    expect(splitLines("")).toEqual({ lines: [], rest: "" });
  });

  it("rend les états intermédiaires puis le résultat", async () => {
    const progress: unknown[] = [];
    const fetchImpl = (async (_path: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Accept).toBe("application/x-ndjson");
      return streamResponse(ndjson([{ type: "progress", progress: { dinners: ["A"] } }, { type: "progress", progress: { dinners: ["A", "B"] } }, { type: "done", result: { reply: "ok" } }]));
    }) as unknown as typeof fetch;
    const result = await postStream<{ reply: string }>("/x", { a: 1 }, { fetchImpl, onProgress: (p) => progress.push(p) });
    expect(result).toEqual({ reply: "ok" });
    expect(progress).toEqual([{ dinners: ["A"] }, { dinners: ["A", "B"] }]);
  });

  it("une erreur du serveur dans le flux, un refus HTTP, un flux coupé sans résultat : erreurs claires, « Réessayer » seulement pour le réseau et le serveur", async () => {
    const run = (res: Response) => postStream("/x", {}, { fetchImpl: (async () => res) as unknown as typeof fetch }).catch((e: ApiError) => e);
    const refused = await run(streamResponse(ndjson([{ type: "error", error: { code: "daily_cap_reached", message: "Trop de demandes", status: 429 } }])));
    expect(refused).toMatchObject({ kind: "rejected", message: "Trop de demandes", retryable: false });
    const broken = await run(streamResponse(ndjson([{ type: "error", error: { code: "server_error", message: "Erreur interne", status: 500 } }])));
    expect(broken).toMatchObject({ kind: "server", retryable: true });
    const http = await run(new Response(JSON.stringify({ error: { code: "forbidden", message: "Réservé aux parents" } }), { status: 403 }));
    expect(http).toMatchObject({ kind: "rejected", status: 403, message: "Réservé aux parents" });
    const cut = await run(streamResponse(ndjson([{ type: "progress", progress: {} }])));
    expect(cut).toMatchObject({ kind: "server", retryable: true });
    const unavailable = await run(new Response("", { status: 503 }));
    expect(unavailable).toMatchObject({ kind: "server", retryable: true });
  });

  it("délai dépassé : message de connexion lente avec « Réessayer »", async () => {
    const fetchImpl = ((_path: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("annulé", "AbortError"))))) as unknown as typeof fetch;
    const error = await postStream("/x", {}, { fetchImpl, timeoutMs: 20 }).catch((e: ApiError) => e);
    expect(error).toMatchObject({ kind: "timeout", retryable: true });
  });
});
