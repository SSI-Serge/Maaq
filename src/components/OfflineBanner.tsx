"use client";

import { MESSAGES } from "@/client/api";
import { useOnline } from "@/client/hooks";
import { uiStyles } from "./ui";

/** Bandeau affiché en haut de l'écran tant que l'appareil n'a pas de connexion (CC-4). */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className={uiStyles.offlineBanner} role="alert">
      {MESSAGES.offline}
    </div>
  );
}
