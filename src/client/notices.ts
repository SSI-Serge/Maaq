"use client";

import { useSyncExternalStore } from "react";

/**
 * Messages de fin de traitement en arrière-plan, affichés sur n'importe quel écran (CC-10) :
 * « Message transmis au support », échec d'un envoi quand on a quitté l'écran…
 */
export interface Notice {
  id: string;
  tone: "success" | "error";
  text: string;
}

let notices: Notice[] = [];
const listeners = new Set<() => void>();

function publish(next: Notice[]) {
  notices = next;
  for (const listener of listeners) listener();
}

export function pushNotice(tone: Notice["tone"], text: string, durationMs = 6_000): void {
  const id = crypto.randomUUID();
  publish([...notices, { id, tone, text }]);
  setTimeout(() => dismissNotice(id), durationMs);
}

export function dismissNotice(id: string): void {
  publish(notices.filter((n) => n.id !== id));
}

export function useNotices(): Notice[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notices,
    () => [],
  );
}
