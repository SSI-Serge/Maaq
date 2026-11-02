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

const INSTALL_SHOWN = "maaq:install-shown";

/**
 * Guidage d'installation (US-1). « Plus tard » vaut pour la session : reproposé à la prochaine ouverture (RF7). Quand l'application elle-même amène au guidage (à l'arrivée
 * dans l'espace connecté, après une activation), on note qu'il a été montré pendant cette session : il n'est pas redemandé à chaque écran.
 */
export const installGuide = {
  dismissed: () => read(() => sessionStorage, INSTALL_DISMISSED) === "1",
  dismiss: () => write(() => sessionStorage, INSTALL_DISMISSED, "1"),
  shown: () => read(() => sessionStorage, INSTALL_SHOWN) === "1",
  markShown: () => write(() => sessionStorage, INSTALL_SHOWN, "1"),
};

/**
 * Faut-il proposer le guidage ? Sur un téléphone seulement, pas quand l'application est déjà lancée depuis l'écran d'accueil (mode installé), pas après « Plus tard »
 * dans la même session. `alreadyShown` : le guidage a déjà été amené par l'application dans cette session (garde de l'espace connecté, activation).
 */
export function installGuideDue(platform: Platform, session: { dismissed: boolean; alreadyShown?: boolean }): boolean {
  const onPhone = platform.os === "android" || platform.os === "iphone";
  return onPhone && !platform.standalone && !session.dismissed && !session.alreadyShown;
}

/** Adresse de retour du guidage (paramètre `next`) : un chemin de l'application seulement, jamais une adresse extérieure ni le guidage lui-même. */
export function safeNext(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /^\/installer(\/|\?|$)/.test(raw)) return null;
  return raw.length <= 300 ? raw : null;
}

/** Adresse du guidage qui reprend `next` ensuite. */
export const installGuideUrl = (next: string) => `/installer?next=${encodeURIComponent(next)}`;

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
  /** iPhone dans un autre navigateur que Safari, ou dans le navigateur intégré d'une application (RF5) : l'ajout à l'écran d'accueil n'y est pas possible. */
  iosNonSafari: boolean;
  /** Navigateur intégré à une autre application (messagerie, réseau social, WebView) : l'installation n'y est pas possible, sur iPhone comme sur Android. */
  inApp: boolean;
}

let platformCache: Platform | null = null;

/** Détection du système pour le guidage d'installation (US-1 RF2, RT1, RT2), calculée une fois. */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return { os: "unknown", standalone: false, iosNonSafari: false, inApp: false };
  platformCache ??= platformOf({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  });
  return platformCache;
}

// Applications qui ouvrent les liens dans leur propre navigateur (Facebook, Instagram, Messenger, LinkedIn, Snapchat, X, Line, WeChat, Teams, Outlook, application Google).
const IN_APP_TOKENS = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|LinkedInApp|Snapchat|Twitter|Line\/|MicroMessenger|Teams|Outlook|GSA\/|WhatsApp/i;

/** Ce que le navigateur dit de l'appareil (pur, pour les tests) : système, mode installé, navigateur autre que Safari ou intégré à une application. */
export function platformOf(facts: { userAgent: string; maxTouchPoints: number; standalone: boolean }): Platform {
  const ua = facts.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && facts.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const isMobile = isIos || isAndroid || /mobile/i.test(ua);
  // iPhone : une vue web d'application n'a pas le mot « Safari » (comme une application installée, d'où l'exception du mode installé) ; Android : « wv » ou l'ancien « Version/x Chrome ».
  const iosWebView = isIos && !facts.standalone && /AppleWebKit/i.test(ua) && /Mobile\//i.test(ua) && !/Safari\//i.test(ua);
  const androidWebView = isAndroid && (/; wv\)/i.test(ua) || /Version\/[\d.]+ Chrome/i.test(ua));
  const inApp = (isIos || isAndroid) && !facts.standalone && (IN_APP_TOKENS.test(ua) || iosWebView || androidWebView);
  return {
    os: isIos ? "iphone" : isAndroid ? "android" : isMobile ? "unknown" : "desktop",
    standalone: facts.standalone,
    iosNonSafari: isIos && (/crios|fxios|edgios|opios/i.test(ua) || inApp),
    inApp,
  };
}

/** Heure locale « 14 h 32 » pour les messages de blocage (US-3 RF4). */
export function formatLocalTime(iso: string): string {
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)).replace(":", " h ");
}
