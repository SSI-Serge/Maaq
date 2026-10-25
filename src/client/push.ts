"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "./api";
import { useApiQuery } from "./hooks";

/**
 * Notifications web de cet appareil (US-94). Sur iPhone, l'autorisation ne peut être demandée qu'à partir d'iOS 16.4 et une fois l'application
 * installée sur l'écran d'accueil, et toujours après un geste de l'utilisateur (RT1) : rien ne se demande tout seul.
 */

export type PushState =
  /** Lecture de l'appareil en cours. */
  | "checking"
  /** Ce navigateur ne sait pas recevoir de notifications. */
  | "unsupported"
  /** iPhone sous iOS 16.3 ou moins (US-94 RT4). */
  | "ios_too_old"
  /** iPhone : MAAQ doit d'abord être installée sur l'écran d'accueil (US-94 RF7). */
  | "ios_install"
  /** Le serveur n'a pas de clés : les rappels partent par email seulement. */
  | "unavailable"
  /** On peut demander l'autorisation. */
  | "ready"
  /** L'utilisateur a refusé : seuls les réglages du téléphone peuvent changer cela (US-94 RF5). */
  | "denied"
  /** Autorisé et inscrit. */
  | "enabled";

export interface DeviceFacts {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** Application lancée depuis l'écran d'accueil. */
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPush: boolean;
  hasNotification: boolean;
  permission: "default" | "granted" | "denied";
  serverConfigured: boolean;
  /** Cet appareil est inscrit côté serveur. */
  subscribed: boolean;
}

const isIos = (f: Pick<DeviceFacts, "userAgent" | "platform" | "maxTouchPoints">) =>
  /iPhone|iPad|iPod/.test(f.userAgent) || (f.platform === "MacIntel" && f.maxTouchPoints > 1); // un iPad récent se présente comme un Mac

/** Ce que l'écran d'activation doit proposer, d'après ce que sait l'appareil (US-94 RF1 à RF7, RT4). */
export function pushStateOf(f: DeviceFacts): Exclude<PushState, "checking"> {
  if (isIos(f)) {
    const version = /OS (\d+)[_.](\d+)/.exec(f.userAgent);
    if (version && (Number(version[1]) < 16 || (Number(version[1]) === 16 && Number(version[2]) < 4))) return "ios_too_old";
    if (!f.standalone) return "ios_install";
  }
  if (!f.hasServiceWorker || !f.hasPush || !f.hasNotification) return "unsupported";
  if (!f.serverConfigured) return "unavailable";
  if (f.permission === "denied") return "denied";
  return f.permission === "granted" && f.subscribed ? "enabled" : "ready";
}

function standalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function toKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function localSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

async function readLocal(): Promise<{ permission: DeviceFacts["permission"]; subscription: PushSubscription | null }> {
  return { permission: "Notification" in window ? Notification.permission : "default", subscription: await localSubscription() };
}

interface ServerStatus {
  configured: boolean;
  publicKey: string | null;
  subscribed: boolean;
}

const register = (subscription: PushSubscription) => apiRequest("/api/push/subscription", { method: "POST", body: subscription.toJSON() });

export function usePush() {
  const status = useApiQuery<ServerStatus>("/api/push/subscription");
  const [local, setLocal] = useState<{ permission: DeviceFacts["permission"]; subscription: PushSubscription | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"failed" | "slow" | null>(null);
  const reloadStatus = status.reload;

  const read = useCallback(async () => setLocal(await readLocal()), []);

  useEffect(() => {
    let alive = true;
    void readLocal().then((next) => {
      if (alive) setLocal(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Autorisé sur ce téléphone mais inconnu du serveur (après une déconnexion, par exemple) : on réinscrit l'appareil sans rien demander.
  const mismatch = Boolean(status.data?.configured && !status.data.subscribed && local?.permission === "granted" && local.subscription);
  useEffect(() => {
    if (!mismatch || !local?.subscription) return;
    void register(local.subscription).then(reloadStatus, () => {});
  }, [mismatch, local, reloadStatus]);

  const facts: DeviceFacts | null =
    local && status.data
      ? {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          maxTouchPoints: navigator.maxTouchPoints,
          standalone: standalone(),
          hasServiceWorker: "serviceWorker" in navigator,
          hasPush: "PushManager" in window,
          hasNotification: "Notification" in window,
          permission: local.permission,
          serverConfigured: status.data.configured,
          subscribed: status.data.subscribed && Boolean(local.subscription),
        }
      : null;
  const state: PushState = facts ? pushStateOf(facts) : "checking";

  /** À appeler directement depuis l'appui sur « Activer mes rappels » : la demande d'autorisation suit un geste de l'utilisateur. */
  const enable = useCallback(async () => {
    const publicKey = status.data?.publicKey;
    if (!publicKey) return;
    setPending(true);
    setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const permission = Notification.requestPermission();
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("slow")), 15_000);
      });
      const run = async () => {
        if ((await permission) !== "granted") return;
        const registration = await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
        const subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }));
        await register(subscription);
      };
      await Promise.race([run(), deadline]);
    } catch (err) {
      setError(err instanceof Error && err.message === "slow" ? "slow" : "failed");
    } finally {
      clearTimeout(timer);
      setPending(false);
      await read();
      reloadStatus();
    }
  }, [status.data, read, reloadStatus]);

  return { state, enable, pending, error, loadError: status.error, reload: reloadStatus };
}

/** Drapeau « écran d'activation déjà vu » : sert à n'ouvrir l'écran qu'à la première visite (US-94 RF1, RF6). */
const SEEN = "maaq.rappels.vus";
export function remindersSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
}
export function markRemindersSeen(): void {
  try {
    window.localStorage.setItem(SEEN, "1");
  } catch {
    /* sans stockage, l'écran se représentera : rien de grave */
  }
}
