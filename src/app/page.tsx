"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MESSAGES } from "@/client/api";
import { useApiQuery, useOnline } from "@/client/hooks";
import { Button, Card, Eyebrow, Logo, Screen, uiStyles } from "@/components/ui";

/** Écran de démarrage (maquette Démarrage) : splash, connexion lente, erreur ou hors connexion. */
export default function StartupPage() {
  const online = useOnline();
  const health = useApiQuery<{ status: string }>(online ? "/api/health" : null);
  const [minimumSplashDone, setMinimumSplashDone] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMinimumSplashDone(true), 900);
    return () => clearTimeout(timer);
  }, []);

  if (!online) {
    return (
      <Screen centered>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ink-soft)" strokeWidth="1.6" style={{ marginBottom: 18 }} aria-hidden>
          <path d="M1 9a16 16 0 0 1 22 0M5 13a10 10 0 0 1 14 0M9 17a5 5 0 0 1 6 0" />
          <path d="M2 2l20 20" />
        </svg>
        <h1 className={uiStyles.statusTitle}>Pas de connexion internet</h1>
        <p className={uiStyles.statusText}>MAAQ nécessite une connexion pour fonctionner.</p>
        <Button onClick={health.reload}>Réessayer</Button>
      </Screen>
    );
  }

  if (health.error) {
    const isTimeout = health.error.kind === "timeout";
    return (
      <Screen centered>
        <div className={`${uiStyles.statusIcon} ${isTimeout ? uiStyles.statusIconNeutral : uiStyles.statusIconError}`} aria-hidden>
          {isTimeout ? "M" : "!"}
        </div>
        <p className={uiStyles.statusText}>{isTimeout ? MESSAGES.timeout : MESSAGES.server}</p>
        <Button onClick={health.reload}>Réessayer</Button>
      </Screen>
    );
  }

  if (health.loading || !minimumSplashDone) {
    return (
      <Screen centered>
        <Logo size="large" pulse />
        {health.slow && <p className={uiStyles.statusText} style={{ marginTop: 18 }}>Toujours en cours…</p>}
      </Screen>
    );
  }

  return (
    <Screen>
      <Logo />
      <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 16 }}>
        <h1 style={{ fontSize: 26, lineHeight: 1.25 }}>Les fondations sont en place</h1>
        <p style={{ fontSize: 14, color: "var(--ink-soft)", lineHeight: 1.5, margin: 0 }}>
          Le service répond et la base de données est à jour. Les écrans de connexion arrivent avec le lot 1.
        </p>
        <Card>
          <Eyebrow>Outils de développement</Eyebrow>
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 14, lineHeight: 1.9 }}>
            <li><Link href="/dev/charte" style={{ color: "var(--secondary-strong)", fontWeight: 600 }}>Charte et composants</Link></li>
            <li><Link href="/dev/digitorn" style={{ color: "var(--secondary-strong)", fontWeight: 600 }}>Digitorn simulé</Link></li>
            <li><Link href="/dev/boite" style={{ color: "var(--secondary-strong)", fontWeight: 600 }}>Boîte de test (emails et SMS)</Link></li>
          </ul>
        </Card>
      </div>
    </Screen>
  );
}
