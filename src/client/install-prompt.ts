"use client";

/**
 * Proposition d'installation d'Android (événement « beforeinstallprompt »). Le navigateur l'émet
 * une seule fois, souvent avant l'arrivée sur le guidage : on la capte dès le chargement (US-1 RF4).
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

let capturing = false;

export function captureInstallPrompt(): void {
  if (capturing) return;
  capturing = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export const installPrompt = {
  available: () => deferred !== null,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async show(): Promise<void> {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    notify();
  },
};
