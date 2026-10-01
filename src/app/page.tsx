"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MESSAGES } from "@/client/api";
import { detectPlatform, fetchAuthState, installGuide } from "@/client/auth";
import { useApiQuery, useOnline } from "@/client/hooks";
import { Button, Logo, Screen, uiStyles } from "@/components/ui";

const MINIMUM_SPLASH_MS = 700;

/**
 * Démarrage (US-2, maquette Démarrage) : écran aux couleurs de MAAQ, puis
 *  - guidage d'installation à la première visite sur un téléphone (US-1) ;
 *  - écran de connexion sans session mémorisée, ou écran du profil (déverrouillage par schéma) sinon (US-2 RF3).
 */
export default function StartupPage() {
  const router = useRouter();
  const online = useOnline();
  const health = useApiQuery<{ status: string }>(online ? "/api/health" : null);
  const [splashDone, setSplashDone] = useState(false);
  const [routingError, setRoutingError] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSplashDone(true), MINIMUM_SPLASH_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!health.data || !splashDone) return;
    const platform = detectPlatform();
    const onPhone = platform.os === "android" || platform.os === "iphone";
    if (onPhone && !platform.standalone && !installGuide.dismissed()) {
      router.replace("/installer");
      return;
    }
    fetchAuthState()
      .then((state) => router.replace(state.authenticated ? state.home : "/connexion"))
      .catch(() => setRoutingError(true));
  }, [health.data, splashDone, router]);

  if (!online) {
    return (
      <Screen centered>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ink-soft)" strokeWidth="1.6" style={{ marginBottom: 18 }} aria-hidden>
          <path d="M1 9a16 16 0 0 1 22 0M5 13a10 10 0 0 1 14 0M9 17a5 5 0 0 1 6 0" />
          <path d="M2 2l20 20" />
        </svg>
        <h1 className={uiStyles.statusTitle}>Pas de connexion internet</h1>
        <p className={uiStyles.statusText}>MAAQ nécessite une connexion pour fonctionner.</p>
        <Button onClick={() => window.location.reload()}>Réessayer</Button>
      </Screen>
    );
  }

  if (health.error || routingError) {
    const isTimeout = health.error?.kind === "timeout";
    return (
      <Screen centered>
        <div className={`${uiStyles.statusIcon} ${isTimeout ? uiStyles.statusIconNeutral : uiStyles.statusIconError}`} aria-hidden>
          {isTimeout ? "M" : "!"}
        </div>
        <p className={uiStyles.statusText}>{isTimeout ? MESSAGES.timeout : MESSAGES.server}</p>
        <Button onClick={() => window.location.reload()}>Réessayer</Button>
      </Screen>
    );
  }

  return (
    <Screen centered>
      <Logo size="large" pulse />
      {health.slow && (
        <p className={uiStyles.statusText} style={{ marginTop: 18 }}>
          Toujours en cours…
        </p>
      )}
    </Screen>
  );
}
