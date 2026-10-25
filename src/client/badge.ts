"use client";

import { useEffect } from "react";
import { apiRequest } from "./api";

/**
 * Badge de l'icône (US-84) : nombre de confirmations en attente. Uniquement sur une application installée dont le profil a autorisé les
 * notifications ; ailleurs, rien ne se passe et le compteur de l'application reste la référence (RF4, RF5). Un échec ne change rien : le badge
 * garde sa dernière valeur, sans message (RF8).
 */

type BadgeNavigator = Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

/** Les écrans qui changent le nombre de confirmations en attente (confirmer, écarter, modifier) le signalent par cet événement. */
export const PENDING_CHANGED = "maaq:pending-changed";
export const pendingChanged = () => window.dispatchEvent(new Event(PENDING_CHANGED));

export function setBadge(count: number): void {
  const nav = navigator as BadgeNavigator;
  if (!nav.setAppBadge) return;
  void (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.())?.catch(() => {});
}

async function refresh(): Promise<void> {
  if (!("setAppBadge" in navigator) || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const { events } = await apiRequest<{ events: unknown[] }>("/api/family/events/pending");
    setBadge(events.length);
  } catch {
    /* garde la dernière valeur */
  }
}

/** Met le badge à jour à l'ouverture de l'application, quand elle revient au premier plan, et après chaque changement signalé. */
export function useBadgeSync(): void {
  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(PENDING_CHANGED, onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(PENDING_CHANGED, onVisible);
    };
  }, []);
}
