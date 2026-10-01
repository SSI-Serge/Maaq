import { DevOutbox } from "./dev-outbox";
import type { Messenger } from "./types";

let instance: DevOutbox | undefined;

/** Messagerie de l'application. Seul le mode « dev » (boîte de test) existe pour l'instant. */
export function messenger(): Messenger {
  return devOutbox();
}

export function devOutbox(): DevOutbox {
  instance ??= new DevOutbox();
  return instance;
}

export type { Messenger, OutboxEntry, OutgoingEmail, OutgoingSms } from "./types";
