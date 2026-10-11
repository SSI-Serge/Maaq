"use client";

import { useEffect } from "react";
import { captureInstallPrompt } from "@/client/install-prompt";

/**
 * Initialisations faites une fois au chargement : capture de la proposition d'installation
 * Android (US-1 RF4) et service worker, qui affiche l'écran hors connexion au lancement
 * (US-2 RF8) et applique les nouvelles versions au lancement suivant (US-2 RF9).
 */
export function AppBoot() {
  useEffect(() => {
    captureInstallPrompt();
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
