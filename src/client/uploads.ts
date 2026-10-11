"use client";

import { useSyncExternalStore } from "react";
import { newIdempotencyKey } from "./api";

/**
 * Envois de documents de contrats. Ils vivent hors des écrans : quitter la page du contrat ne les
 * interrompt pas tant que l'application reste ouverte (US-34 RF10, CC-10).
 *  - barre de progression et « Annuler » (RF7) ;
 *  - sans progression pendant 30 s : message de connexion lente et « Réessayer », rien n'est ajouté (RF9) ;
 *  - coupure réseau : jusqu'à 3 reprises automatiques, puis « L'envoi du document a échoué » (RF8, RF11).
 */

export type UploadState = "uploading" | "stalled" | "failed" | "rejected" | "done";

export interface UploadJob {
  id: string;
  contractId: string;
  contractName: string;
  fileName: string;
  state: UploadState;
  /** Avancement entre 0 et 1. */
  progress: number;
  message?: string;
}

export const STALL_AFTER_MS = 30_000;
export const MAX_AUTOMATIC_RETRIES = 3;
export const RETRY_DELAYS_MS = [1_000, 2_000, 3_000];

export const UPLOAD_MESSAGES = {
  failed: "L'envoi du document a échoué",
  stalled: "La connexion semble lente. Veuillez réessayer.",
} as const;

let jobs: UploadJob[] = [];
const files = new Map<string, File>();
const requests = new Map<string, XMLHttpRequest>();
const listeners = new Set<() => void>();
const doneListeners = new Set<(job: UploadJob) => void>();

function publish(next: UploadJob[]) {
  jobs = next;
  for (const listener of listeners) listener();
}

function patch(id: string, changes: Partial<UploadJob>) {
  if (!jobs.some((j) => j.id === id)) return;
  publish(jobs.map((j) => (j.id === id ? { ...j, ...changes } : j)));
}

/** État courant des envois (lecture directe, hors composant). */
export function getUploads(): UploadJob[] {
  return jobs;
}

export function useUploads(): UploadJob[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getUploads,
    () => [],
  );
}

/** Appelé à la fin d'un envoi réussi, quel que soit l'écran affiché (US-34 RF10). */
export function onUploadDone(listener: (job: UploadJob) => void): () => void {
  doneListeners.add(listener);
  return () => doneListeners.delete(listener);
}

export function startUpload(input: { contractId: string; contractName: string; file: File }): string {
  const id = newIdempotencyKey();
  files.set(id, input.file);
  publish([...jobs, { id, contractId: input.contractId, contractName: input.contractName, fileName: input.file.name, state: "uploading", progress: 0 }]);
  void run(id, 0);
  return id;
}

export function retryUpload(id: string): void {
  if (!files.has(id)) return;
  patch(id, { state: "uploading", progress: 0, message: undefined });
  void run(id, 0);
}

/** « Annuler » : l'envoi s'arrête et le document n'est pas ajouté (US-34 CA 7.1). */
export function cancelUpload(id: string): void {
  requests.get(id)?.abort();
  requests.delete(id);
  files.delete(id);
  publish(jobs.filter((j) => j.id !== id));
}

/** Retire de la liste un envoi terminé ou en échec. */
export function dismissUpload(id: string): void {
  files.delete(id);
  publish(jobs.filter((j) => j.id !== id));
}

type Outcome = { kind: "done" } | { kind: "rejected"; message: string } | { kind: "network" } | { kind: "stalled" } | { kind: "aborted" };

function send(job: UploadJob, file: File, onProgress: (ratio: number) => void): { outcome: Promise<Outcome>; request: XMLHttpRequest } {
  const request = new XMLHttpRequest();
  const outcome = new Promise<Outcome>((resolve) => {
    let stall: ReturnType<typeof setTimeout>;
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        // Le blocage doit être noté avant l'abandon : abort() déclenche « onabort », qui conclurait sur une annulation.
        resolve({ kind: "stalled" });
        request.abort();
      }, STALL_AFTER_MS);
    };
    const finish = (result: Outcome) => {
      clearTimeout(stall);
      resolve(result);
    };
    request.open("POST", `/api/contracts/${job.contractId}/documents`);
    request.setRequestHeader("Idempotency-Key", job.id); // un renvoi n'ajoute jamais deux fois le même document
    request.upload.onprogress = (event) => {
      armStall();
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) return finish({ kind: "done" });
      if (request.status >= 400 && request.status < 500) {
        let message: string = UPLOAD_MESSAGES.failed;
        try {
          message = (JSON.parse(request.responseText) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          // réponse sans détail : message standard
        }
        return finish({ kind: "rejected", message });
      }
      finish({ kind: "network" });
    };
    request.onerror = () => finish({ kind: "network" });
    request.ontimeout = () => finish({ kind: "network" });
    request.onabort = () => finish({ kind: "aborted" });
    const form = new FormData();
    form.append("file", file);
    armStall();
    request.send(form);
  });
  return { outcome, request };
}

async function run(id: string, attempt: number): Promise<void> {
  const job = jobs.find((j) => j.id === id);
  const file = files.get(id);
  if (!job || !file) return;

  const sending = send(job, file, (ratio) => patch(id, { progress: ratio }));
  requests.set(id, sending.request);
  const outcome = await sending.outcome;
  requests.delete(id);
  if (!jobs.some((j) => j.id === id)) return; // annulé entre-temps

  switch (outcome.kind) {
    case "done": {
      files.delete(id);
      patch(id, { state: "done", progress: 1 });
      const finished = jobs.find((j) => j.id === id);
      if (finished) for (const listener of doneListeners) listener(finished);
      return;
    }
    case "rejected":
      return patch(id, { state: "rejected", message: outcome.message });
    case "stalled":
      return patch(id, { state: "stalled", message: UPLOAD_MESSAGES.stalled });
    case "network":
      if (attempt < MAX_AUTOMATIC_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt] ?? 3_000));
        if (!jobs.some((j) => j.id === id)) return;
        patch(id, { progress: 0 });
        return run(id, attempt + 1);
      }
      return patch(id, { state: "failed", message: UPLOAD_MESSAGES.failed });
    case "aborted":
      return;
  }
}

/** Réservé aux tests : remet le gestionnaire à zéro. */
export function resetUploadsForTests(): void {
  for (const request of requests.values()) request.abort();
  requests.clear();
  files.clear();
  doneListeners.clear();
  publish([]);
}
