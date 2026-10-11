import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_AUTOMATIC_RETRIES,
  STALL_AFTER_MS,
  UPLOAD_MESSAGES,
  cancelUpload,
  getUploads,
  onUploadDone,
  resetUploadsForTests,
  retryUpload,
  startUpload,
  type UploadJob,
} from "@/client/uploads";

/** Faux XMLHttpRequest : le test décide quand et comment le serveur répond. */
class FakeXhr {
  static all: FakeXhr[] = [];
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  headers: Record<string, string> = {};
  aborted = false;
  constructor() {
    FakeXhr.all.push(this);
  }
  open() {}
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {}
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown = {}) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  networkError() {
    this.onerror?.();
  }
}

const file = () => new File(["%PDF-1.4"], "attestation.pdf", { type: "application/pdf" });
const latest = () => FakeXhr.all[FakeXhr.all.length - 1];

/** Laisse les promesses se résoudre, puis écoule les délais de reprise en attente. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(10_000);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeXhr.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  resetUploadsForTests();
});
afterEach(() => {
  resetUploadsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const stateOf = (id: string) => getUploads().find((j) => j.id === id);

describe("US-34 — envoi de documents en arrière-plan", () => {
  it("RF7 : la progression avance, puis l'envoi réussi prévient tous les écrans", async () => {
    const done: UploadJob[] = [];
    onUploadDone((job) => done.push(job));
    const id = startUpload({ contractId: "1", contractName: "Assurance Auto", file: file() });
    expect(latest().headers["Idempotency-Key"]).toBe(id);

    latest().progress(50, 100);
    expect(stateOf(id)).toMatchObject({ state: "uploading", progress: 0.5 });
    latest().respond(201);
    await settle();
    expect(stateOf(id)?.state).toBe("done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ contractName: "Assurance Auto", fileName: "attestation.pdf", state: "done" });
  });

  it("RF7, CA 7.1 : « Annuler » arrête l'envoi, rien n'est ajouté", async () => {
    const done: UploadJob[] = [];
    onUploadDone((job) => done.push(job));
    const id = startUpload({ contractId: "1", contractName: "Assurance Auto", file: file() });
    const request = latest();
    cancelUpload(id);
    expect(request.aborted).toBe(true);
    expect(stateOf(id)).toBeUndefined();
    request.respond(201); // une réponse tardive est ignorée
    await settle();
    expect(done).toHaveLength(0);
  });

  it("RF9, CA 9.1 : sans progression pendant 30 s, l'envoi est interrompu et « Réessayer » est proposé", async () => {
    const id = startUpload({ contractId: "1", contractName: "Assurance Auto", file: file() });
    const request = latest();
    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS - 1);
    expect(request.aborted).toBe(false);
    request.progress(10, 100); // une progression relance le délai
    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS - 1);
    expect(request.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await settle();
    expect(request.aborted).toBe(true);
    expect(stateOf(id)).toMatchObject({ state: "stalled", message: UPLOAD_MESSAGES.stalled });
    retryUpload(id);
    expect(stateOf(id)).toMatchObject({ state: "uploading", progress: 0 });
  });

  it("RF8, RF11 : une coupure est reprise jusqu'à 3 fois en silence, puis « L'envoi du document a échoué »", async () => {
    const id = startUpload({ contractId: "1", contractName: "Assurance Auto", file: file() });
    for (let attempt = 0; attempt < MAX_AUTOMATIC_RETRIES; attempt++) {
      expect(FakeXhr.all).toHaveLength(attempt + 1);
      latest().networkError();
      await settle();
    }
    expect(FakeXhr.all).toHaveLength(MAX_AUTOMATIC_RETRIES + 1);
    latest().networkError();
    await settle();
    expect(FakeXhr.all).toHaveLength(MAX_AUTOMATIC_RETRIES + 1); // plus de reprise automatique
    expect(stateOf(id)).toMatchObject({ state: "failed", message: "L'envoi du document a échoué" });
  });

  it("RF11, CA 11.1 : après une micro-coupure, la reprise aboutit sans message d'erreur", async () => {
    const done: UploadJob[] = [];
    onUploadDone((job) => done.push(job));
    startUpload({ contractId: "1", contractName: "Assurance Auto", file: file() });
    latest().networkError();
    await settle();
    expect(FakeXhr.all).toHaveLength(2);
    latest().respond(201);
    await settle();
    expect(done).toHaveLength(1);
  });

  it("un refus du serveur (format, taille) n'est pas rejoué automatiquement", async () => {
    const id = startUpload({ contractId: "1", contractName: "Assurance Auto", file: file() });
    latest().respond(422, { error: { code: "too_large", message: "Ce document dépasse 15 Mo." } });
    await settle();
    expect(FakeXhr.all).toHaveLength(1);
    expect(stateOf(id)).toMatchObject({ state: "rejected", message: "Ce document dépasse 15 Mo." });
  });

  it("« Réessayer » après un échec relance l'envoi avec la même clé d'idempotence", async () => {
    const id = startUpload({ contractId: "1", contractName: "Assurance Auto", file: file() });
    for (let attempt = 0; attempt <= MAX_AUTOMATIC_RETRIES; attempt++) {
      latest().networkError();
      await settle();
    }
    expect(stateOf(id)?.state).toBe("failed");
    const before = FakeXhr.all.length;
    retryUpload(id);
    expect(FakeXhr.all).toHaveLength(before + 1);
    expect(latest().headers["Idempotency-Key"]).toBe(id);
    latest().respond(201);
    await settle();
    expect(stateOf(id)?.state).toBe("done");
  });
});
