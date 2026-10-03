"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { detectPlatform, installGuide } from "@/client/auth";
import { installPrompt } from "@/client/install-prompt";
import { Button, Notice, Screen } from "@/components/ui";
import styles from "@/components/auth/auth.module.css";

type Os = "android" | "iphone";

const noSubscription = () => () => {};

/** Guidage pas à pas pour ajouter MAAQ à l'écran d'accueil (US-1), maquette Installation. */
export default function InstallGuidePage() {
  const router = useRouter();
  const platform = useSyncExternalStore(noSubscription, detectPlatform, () => null);
  const canPrompt = useSyncExternalStore(installPrompt.subscribe, installPrompt.available, () => false);
  const [chosen, setChosen] = useState<Os | null>(null);
  // Système détecté ; à défaut, l'onglet iPhone, le parcours le plus détaillé (RT1).
  const os: Os = chosen ?? (platform?.os === "android" ? "android" : "iphone");

  function later() {
    installGuide.dismiss();
    router.replace("/");
  }

  return (
    <Screen>
      <div className={styles.eyebrow}>Première visite</div>
      <h1 className={styles.title}>Installer MAAQ</h1>
      <p className={styles.lead}>Ajoutez MAAQ à votre écran d&apos;accueil pour l&apos;ouvrir aussi vite qu&apos;une app native.</p>

      <div className={styles.tabs} role="tablist">
        {(["android", "iphone"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={os === value}
            className={`${styles.tab} ${os === value ? styles.tabActive : ""}`}
            onClick={() => setChosen(value)}
          >
            {value === "android" ? "Android" : "iPhone"}
          </button>
        ))}
      </div>

      {os === "android" ? (
        canPrompt ? (
          <div className={styles.form}>
            <p className={styles.lead} style={{ margin: 0 }}>
              Votre navigateur peut installer MAAQ directement.
            </p>
            <Button block onClick={() => installPrompt.show()}>
              Installer MAAQ
            </Button>
          </div>
        ) : (
          <ol className={styles.steps}>
            <Step n={1}>
              Ouvrez MAAQ dans <b>Chrome</b>.
            </Step>
            <Step n={2}>
              Ouvrez le menu <b>⋮</b> en haut à droite.
            </Step>
            <Step n={3}>
              Choisissez <b>« Ajouter à l&apos;écran d&apos;accueil »</b> ou <b>« Installer l&apos;application »</b>.
            </Step>
            <Step n={4}>Confirmez — l&apos;icône MAAQ apparaît sur votre écran d&apos;accueil.</Step>
          </ol>
        )
      ) : (
        <>
          {platform?.iosNonSafari && (
            <div style={{ marginBottom: 14 }}>
              <Notice tone="warning">Ce navigateur ne permet pas l&apos;ajout à l&apos;écran d&apos;accueil. Ouvrez MAAQ dans Safari.</Notice>
            </div>
          )}
          <ol className={styles.steps}>
            <Step n={1}>
              Ouvrez MAAQ dans <b>Safari</b>.
            </Step>
            <Step n={2}>
              Touchez le bouton de partage{" "}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="Partager" style={{ verticalAlign: "-3px" }}>
                <path d="M12 3v12M8 7l4-4 4 4" />
                <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
              </svg>{" "}
              en bas de l&apos;écran.
            </Step>
            <Step n={3}>
              Choisissez <b>« Sur l&apos;écran d&apos;accueil »</b> (faites défiler si besoin).
            </Step>
            <Step n={4}>
              Touchez <b>« Ajouter »</b> — l&apos;icône MAAQ apparaît sur votre écran d&apos;accueil.
            </Step>
          </ol>
        </>
      )}

      <div className={styles.footer}>
        <Button variant="secondary" block onClick={later}>
          Plus tard
        </Button>
      </div>
    </Screen>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className={styles.step}>
      <span className={styles.stepNumber}>{n}</span>
      <span>{children}</span>
    </li>
  );
}
