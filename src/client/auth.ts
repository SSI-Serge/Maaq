"use client";

import { useState, useSyncExternalStore } from "react";
import { apiRequest, newIdempotencyKey } from "./api";
import { clearAllDrafts } from "./hooks";

/** Ce que le serveur dit de la connexion sur cet appareil (GET /api/auth/state). */
export type AuthState =
  | { authenticated: false; pendingVerification: boolean; accessRemoved?: boolean }
  | {
      authenticated: true;
      unlocked: boolean;
      user: { firstName: string; maskedEmail: string; role: "admin" | "primary_user" | "guest"; guestRank: "core" | "secondary" | null };
      device: { hasPattern: boolean; patternLocked: boolean };
      home: string;
    };

export function fetchAuthState(): Promise<AuthState> {
  return apiRequest<AuthState>("/api/auth/state");
}

/** Fuseau horaire de l'appareil, transmis à chaque connexion (D21). */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris";
  } catch {
    return "Europe/Paris";
  }
}

const REMEMBERED_EMAIL = "maaq:email";
const PENDING_LOGOUT = "maaq:pending-logout";
const INSTALL_DISMISSED = "maaq:install-later";

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // stockage indisponible : la fonction de confort est simplement perdue
  }
}

/** Email de connexion mémorisé sur l'appareil et pré-rempli (US-3 RF8). */
export const rememberedEmail = {
  get: () => read(() => localStorage, REMEMBERED_EMAIL) ?? "",
  set: (email: string) => write(() => localStorage, REMEMBERED_EMAIL, email.trim()),
};

const noSubscription = () => () => {};

/**
 * Champ email pré-rempli avec l'email mémorisé (US-3 RF8, US-8 RF2, US-66 RF2), sans écart
 * entre le rendu serveur (vide) et le rendu sur l'appareil.
 */
export function useRememberedEmail(): [string, (value: string) => void] {
  const saved = useSyncExternalStore(noSubscription, rememberedEmail.get, () => "");
  const [typed, setTyped] = useState<string | null>(null);
  return [typed ?? saved, setTyped];
}

/** « Plus tard » sur le guidage d'installation : reproposé à la prochaine ouverture (US-1 RF7). */
export const installGuide = {
  dismissed: () => read(() => sessionStorage, INSTALL_DISMISSED) === "1",
  dismiss: () => write(() => sessionStorage, INSTALL_DISMISSED, "1"),
};

/**
 * Déconnexion (US-9). En cas d'échec réseau, l'appareil se considère déconnecté quand même et
 * la fermeture côté serveur sera renvoyée au prochain passage sur l'écran de connexion (RF8, RF9).
 */
export async function signOut(): Promise<void> {
  clearAllDrafts();
  try {
    await apiRequest("/api/auth/logout", { method: "POST", idempotencyKey: newIdempotencyKey() });
    write(() => localStorage, PENDING_LOGOUT, null);
  } catch {
    write(() => localStorage, PENDING_LOGOUT, "1");
  }
}

export function hasPendingLogout(): boolean {
  return read(() => localStorage, PENDING_LOGOUT) === "1";
}

/** Renvoie une déconnexion restée en attente ; true si elle est maintenant faite côté serveur. */
export async function flushPendingLogout(): Promise<boolean> {
  if (!hasPendingLogout()) return true;
  try {
    await apiRequest("/api/auth/logout", { method: "POST", idempotencyKey: newIdempotencyKey() });
    write(() => localStorage, PENDING_LOGOUT, null);
    return true;
  } catch {
    return false;
  }
}

export interface Platform {
  os: "android" | "iphone" | "desktop" | "unknown";
  standalone: boolean;
  iosNonSafari: boolean;
}

let platformCache: Platform | null = null;

/** Détection du système pour le guidage d'installation (US-1 RF2, RT1, RT2), calculée une fois. */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return { os: "unknown", standalone: false, iosNonSafari: false };
  platformCache ??= computePlatform();
  return platformCache;
}

function computePlatform(): Platform {
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const isMobile = isIos || isAndroid || /mobile/i.test(ua);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    os: isIos ? "iphone" : isAndroid ? "android" : isMobile ? "unknown" : "desktop",
    standalone,
    iosNonSafari: isIos && /crios|fxios|edgios|opios|gsa\//i.test(ua),
  };
}

/** Heure locale « 14 h 32 » pour les messages de blocage (US-3 RF4). */
export function formatLocalTime(iso: string): string {
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)).replace(":", " h ");
}
