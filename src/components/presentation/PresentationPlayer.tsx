"use client";

import { useRef, useState } from "react";
import { detectPlatform } from "@/client/auth";
import { Button, Loading, Notice } from "@/components/ui";
import type { PresentationView } from "@/server/presentation/service";
import styles from "./presentation.module.css";

type Phase = "idle" | "loading" | "playing" | "failed";

/** Sur un réseau mobile, la taille de la vidéo est indiquée (RF6) : Android sait dire « cellulaire » ou « wifi » ; l'iPhone non, la taille s'affiche alors sur tout téléphone. */
function showSize(): boolean {
  const platform = detectPlatform();
  if (platform.os !== "android" && platform.os !== "iphone") return false;
  const type = (navigator as Navigator & { connection?: { type?: string } }).connection?.type;
  return !(type === "wifi" || type === "ethernet");
}

/**
 * Lecteur de la vidéo de présentation (US-140) : jamais de lecture automatique (RF2), lecture lancée par l'utilisateur et sans le son (il l'active avec les commandes), sous-titres
 * français affichés d'office (RF3), transcription en texte, taille sur réseau mobile (RF6), indicateur de chargement et message en cas d'échec (RF8). Lecture native du navigateur,
 * sans bibliothèque, sans cookie, sans suivi (RT1, RT2).
 */
export function PresentationPlayer({
  presentation,
  secondaryGuest,
  onEnded,
  onFailed,
  children,
}: {
  presentation: PresentationView;
  secondaryGuest?: boolean;
  onEnded?: () => void;
  /** Appelé une fois quand la vidéo ne se charge pas (le parcours propose alors « Continuer »). */
  onFailed?: () => void;
  /** Boutons du parcours (« Passer », « Continuer »), placés sous le bouton de lancement. */
  children?: React.ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  async function launch() {
    const element = video.current;
    if (!element) return;
    setPhase("loading");
    element.muted = true; // jamais avec le son : l'utilisateur l'active lui-même
    for (const track of Array.from(element.textTracks)) track.mode = "showing";
    try {
      await element.play();
    } catch {
      fail();
    }
  }

  function fail() {
    setPhase("failed");
    onFailed?.();
  }

  return (
    <div className={styles.player}>
      <div className={styles.frame}>
        <video
          ref={video}
          className={styles.video}
          src={presentation.videoUrl}
          poster={presentation.posterUrl ?? undefined}
          controls={phase === "playing"}
          preload="none"
          playsInline
          muted
          onPlaying={() => setPhase("playing")}
          onWaiting={() => setPhase((p) => (p === "playing" ? "loading" : p))}
          onEnded={() => onEnded?.()}
          onError={fail}
          onLoadedMetadata={(event) => {
            for (const track of Array.from(event.currentTarget.textTracks)) track.mode = "showing";
          }}
        >
          <track kind="subtitles" srcLang="fr" label="Français" src={presentation.captionsUrl} default />
        </video>
        {phase === "loading" && (
          <div className={styles.overlay}>
            <Loading label="Chargement de la vidéo…" />
          </div>
        )}
      </div>

      {phase === "failed" ? (
        <Notice tone="warning">La vidéo n&apos;a pas pu être chargée. Vous la retrouverez dans Réglages › Aide.</Notice>
      ) : (
        <>
          {phase === "idle" && (
            <div className={styles.launch}>
              <Button block onClick={() => void launch()}>
                Lancer la vidéo
              </Button>
              {showSize() && <p className={styles.size}>{presentation.sizeLabel}</p>}
            </div>
          )}
          {phase !== "idle" && <p className={styles.size}>Les sous-titres sont affichés ; la vidéo démarre sans le son, activez-le avec les commandes.</p>}
        </>
      )}

      {presentation.durationLabel && <p className={styles.size}>Durée : {presentation.durationLabel}</p>}
      {presentation.transcript && (
        <details className={styles.transcript}>
          <summary>Lire le texte de la vidéo</summary>
          {presentation.transcript.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </details>
      )}
      {secondaryGuest && <p className={styles.note}>Certaines fonctions sont réservées aux parents.</p>}
      {children}
    </div>
  );
}
