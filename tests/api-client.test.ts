import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, MESSAGES, RETRY_DELAYS_MS, apiRequest } from "@/client/api";
import { bodySignature } from "@/client/hooks";

const noSleep = vi.fn(async () => {});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.useRealTimers();
  noSleep.mockClear();
});

describe("client réseau commun", () => {
  it("renvoie les données d'une lecture réussie", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    await expect(apiRequest("/x", { fetchImpl, sleep: noSleep })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("CC-5 : refait deux tentatives silencieuses (1 s puis 3 s) avant d'afficher l'erreur serveur", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    const error = await apiRequest<never>("/x", { fetchImpl, sleep: noSleep }).catch((e: ApiError) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe("server");
    expect(error.message).toBe(MESSAGES.server);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(noSleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([...RETRY_DELAYS_MS]);
  });

  it("CC-5 : réussit si une nouvelle tentative aboutit", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("réseau"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    await expect(apiRequest("/x", { fetchImpl, sleep: noSleep })).resolves.toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("CC-7 : un enregistrement sans clé d'idempotence n'est jamais renvoyé automatiquement", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {}));
    await expect(apiRequest("/x", { method: "POST", body: {}, fetchImpl, sleep: noSleep })).rejects.toMatchObject({ kind: "server" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("CC-7 : un enregistrement protégé est renvoyé avec la même clé", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(502, {}))
      .mockResolvedValueOnce(jsonResponse(201, { id: 7 }));
    await expect(
      apiRequest("/x", { method: "POST", body: { a: 1 }, idempotencyKey: "cle-1", fetchImpl, sleep: noSleep }),
    ).resolves.toEqual({ id: 7 });
    const keys = fetchImpl.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys).toEqual(["cle-1", "cle-1"]);
  });

  it("un refus métier (4xx) est rendu tel quel, sans nouvelle tentative", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { error: { code: "quota", message: "Plus aucun invité disponible." } }));
    const error = await apiRequest<never>("/x", { fetchImpl, sleep: noSleep }).catch((e: ApiError) => e);
    expect(error).toMatchObject({ kind: "rejected", status: 422, message: "Plus aucun invité disponible." });
    expect(error.retryable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("CC-4 : échoue tout de suite sans connexion", async () => {
    const fetchImpl = vi.fn();
    await expect(apiRequest("/x", { fetchImpl, isOnline: () => false })).rejects.toMatchObject({
      kind: "offline",
      message: MESSAGES.offline,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CC-3 et CC-6 : signale l'attente après 5 s puis la connexion lente après 15 s", async () => {
    vi.useFakeTimers();
    const onSlow = vi.fn();
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = apiRequest<never>("/x", { fetchImpl, onSlow }).catch((e: ApiError) => e);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(onSlow).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;
    expect(error).toMatchObject({ kind: "timeout", message: MESSAGES.timeout });
  });
});

describe("envoi de fichiers (photos de ticket)", () => {
  it("envoie un FormData tel quel : multipart, sans type JSON forcé, le fichier arrive entier au serveur", async () => {
    const body = new FormData();
    body.append("files", new File([new Uint8Array([1, 2, 3, 4, 5])], "ticket.jpg", { type: "image/jpeg" }));
    let seen: { headers: Record<string, string>; sent: unknown } | undefined;
    const fetchImpl = (async (_path: string, init: RequestInit) => {
      seen = { headers: init.headers as Record<string, string>, sent: init.body };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await apiRequest("/x", { method: "POST", body, fetchImpl });
    expect(seen!.headers["Content-Type"]).toBeUndefined();
    expect(seen!.sent).toBe(body);
    // ce que le serveur de l'application reçoit : le fichier, avec son type et son contenu
    const received = await new Request("http://test/api/courses/tickets/read", { method: "POST", body: seen!.sent as FormData }).formData();
    const file = received.getAll("files")[0] as File;
    expect(file.name).toBe("ticket.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(5);
  });

  it("l'empreinte d'un envoi de fichiers distingue deux photos différentes (un FormData n'est jamais « {} »)", () => {
    const one = new FormData();
    one.append("files", new File(["a"], "a.jpg", { type: "image/jpeg", lastModified: 1 }));
    const two = new FormData();
    two.append("files", new File(["abc"], "b.jpg", { type: "image/jpeg", lastModified: 2 }));
    expect(bodySignature(one)).not.toBe(bodySignature(two));
    expect(bodySignature(one)).not.toBe("{}");
    expect(bodySignature({ a: 1 })).toBe('{"a":1}');
  });
});
