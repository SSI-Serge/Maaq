"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { detectPlatform } from "@/client/auth";
import { Button, ButtonLink, Loading, Notice } from "@/components/ui";
import type { PresentationView } from "@/server/presentation/service";
import styles from "./presentation.module.css";
import { clock, parseTranscript } from "./transcript";

type Phase = "idle" | "loading" | "playing" | "ended" | "failed";
type Origin = "onboarding" | "settings";

const TAGLINE = "MAAQ. Moins de charge mentale, plus de temps pour vous.";
const SECONDARY_NOTE = "Certaines fonctions sont réservées aux parents.";
const FAILURE = "La vidéo n’a pas pu être chargée. Vous la retrouverez dans Réglages › Aide.";

/**
 * Taille de la vidéo sur téléphone (RF6) : Android sait dire « cellulaire » ou « wifi » ; l'iPhone non, la taille s'affiche alors sans autre précision. Sur ordinateur, rien.
 */
function sizeNote(sizeLabel: string): string | null {
  const platform = detectPlatform();
  if (platform.os !== "android" && platform.os !== "iphone") return null;
  const type = (navigator as Navigator & { connection?: { type?: string } }).connection?.type;
  if (type === "wifi" || type === "ethernet") return null;
  return type === "cellular" ? `${sizeLabel} · vous êtes sur un réseau mobile` : sizeLabel;
}

const Play = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8 5v14l11-7z" />
  </svg>
);

/**
 * Écran « Découvrir MAAQ » et « Revoir la présentation » (US-140), d'après les maquettes : jamais de lecture automatique (RF2), lecture lancée par l'utilisateur et sans le son (il l'active
 * avec les commandes), sous-titres français affichés d'office (RF3), texte de la vidéo, taille sur téléphone (RF6), chargement, carte de fin et message d'échec avec « Continuer » (RF8).
 * Lecture native du navigateur, sans bibliothèque, sans cookie, sans suivi (RT1, RT2).
 */
export function PresentationPage({
  origin,
  presentation,
  secondaryGuest = false,
  loading = false,
  error = false,
  onSeen,
  onContinue,
  busy = false,
}: {
  origin: Origin;
  /** null : aucune vidéo configurée ; undefined : pas encore connue. */
  presentation: PresentationView | null | undefined;
  secondaryGuest?: boolean;
  loading?: boolean;
  /** La description de la présentation n'a pas pu être lue. */
  error?: boolean;
  /** Appelé à la fin de la vidéo : le parcours l'enregistre comme vue. */
  onSeen?: () => void;
  /** « Continuer » et « Passer » (parcours d'accueil) ; dans Réglages, le bouton est un retour vers les réglages. */
  onContinue?: () => void;
  busy?: boolean;
}) {
  const settings = origin === "settings";
  const video = useRef<HTMLVideoElement>(null);
  const trackEl = useRef<HTMLTrackElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [cue, setCue] = useState("");
  const [time, setTime] = useState({ now: 0, total: 0 });
  const [ratio, setRatio] = useState(9 / 16);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Taille affichée : lue côté navigateur (type de connexion), donc après l'affichage.
  const sizeLabel = presentation?.sizeLabel;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (sizeLabel) setNote(sizeNote(sizeLabel));
  }, [sizeLabel]);

  // Sous-titres : la piste est chargée mais affichée par MAAQ (style de la charte, au-dessus des commandes).
  useEffect(() => {
    const track = trackEl.current?.track;
    if (!track) return;
    track.mode = "hidden";
    const read = () => setCue(Array.from(track.activeCues ?? []).map((c) => (c as VTTCue).text).join("\n"));
    track.addEventListener("cuechange", read);
    return () => track.removeEventListener("cuechange", read);
  }, [presentation?.captionsUrl]);

  async function play(fromStart = false) {
    const element = video.current;
    if (!element) return;
    setPhase("loading");
    element.muted = true; // jamais avec le son : l'utilisateur l'active lui-même
    setMuted(true);
    if (fromStart) element.currentTime = 0;
    try {
      await element.play();
    } catch {
      setPhase("failed");
    }
  }

  const header = (
    <div className={styles.head}>
      <div className={styles.headRow}>
        {settings && (
          <Link href="/reglages" className={styles.back} aria-label="Retour aux réglages">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Link>
        )}
        <div className={styles.headText}>
          <div className={styles.eyebrow}>{settings ? "Réglages › Aide" : "Bienvenue"}</div>
          <h1 className={styles.title}>Découvrir MAAQ en 1 minute</h1>
        </div>
      </div>
      <p className={styles.desc}>Ce que MAAQ peut faire pour votre famille, en images. Sous-titrée : elle se comprend sans le son.</p>
    </div>
  );

  const continueButton = settings ? <ButtonLink href="/reglages" block className={styles.cta}>
      Retour aux réglages
    </ButtonLink> : (
    <Button block className={styles.cta} onClick={onContinue} loading={busy}>
      Continuer
    </Button>
  );

  // États sans lecteur : chargement de la description, échec de lecture de la description, aucune vidéo.
  if (loading || presentation === undefined || presentation === null || error) {
    return (
      <main className={styles.page}>
        <div className={styles.inner}>
          {header}
          <div className={styles.body}>
            <div className={styles.actions}>
              {loading && !error && <Loading />}
              {error && (
                <>
                  <Notice tone="warning">{FAILURE}</Notice>
                  {continueButton}
                </>
              )}
              {!loading && !error && presentation === null && (
                <>
                  <Notice tone="info">La présentation n’est pas disponible pour le moment.</Notice>
                  {settings && continueButton}
                </>
              )}
            </div>
          </div>
        </div>
      </main>
    );
  }

  const shape = ratio < 1 ? "portrait" : "landscape";
  const lines = parseTranscript(presentation.transcript ?? "");
  const shownLines = secondaryGuest ? [...lines, { time: null, text: SECONDARY_NOTE }] : lines;
  const finished = phase === "ended" || phase === "failed";
  const progress = time.total > 0 ? Math.min(100, (time.now / time.total) * 100) : 0;

  return (
    <main className={`${styles.page} ${phase !== "idle" ? styles.immersive : ""}`}>
      <div className={styles.inner}>
        {header}
        <div className={styles.body}>
          <div className={styles.frame} data-phase={phase} data-shape={shape} style={{ ["--ratio" as string]: String(ratio) }} role="region" aria-label="Lecteur vidéo">
            <video
              ref={video}
              className={styles.video}
              src={presentation.videoUrl}
              poster={presentation.posterUrl ?? undefined}
              preload="metadata"
              playsInline
              muted
              onLoadedMetadata={(event) => {
                const { videoWidth, videoHeight, duration } = event.currentTarget;
                if (videoWidth && videoHeight) setRatio(videoWidth / videoHeight);
                setTime((t) => ({ ...t, total: duration }));
              }}
              onTimeUpdate={(event) => setTime({ now: event.currentTarget.currentTime, total: event.currentTarget.duration })}
              onPlaying={() => {
                setPhase("playing");
                setPaused(false);
              }}
              onPause={() => !video.current?.ended && setPaused(true)}
              onWaiting={() => setPhase((p) => (p === "playing" ? "loading" : p))}
              onEnded={() => {
                setPhase("ended");
                onSeen?.();
              }}
              onError={() => setPhase("failed")}
            >
              <track ref={trackEl} kind="subtitles" srcLang="fr" label="Français" src={presentation.captionsUrl} />
            </video>

            {phase === "idle" && (
              <>
                <span className={styles.badge} aria-hidden>
                  <span style={{ color: "var(--primary-ink)", display: "flex" }}>
                    <Play size={26} />
                  </span>
                </span>
                {presentation.durationLabel && <span className={styles.duration}>{presentation.durationLabel}</span>}
              </>
            )}

            {phase === "loading" && (
              <div className={`${styles.layer} ${styles.layerLoading}`} role="status">
                <div className={styles.spin} aria-hidden />
                <span className={styles.layerText}>Chargement de la vidéo…</span>
              </div>
            )}

            {phase === "playing" && captions && cue && (
              <div className={styles.subtitle}>
                <span>{cue}</span>
              </div>
            )}

            {phase === "playing" && (
              <div className={styles.controls}>
                <button
                  className={styles.iconBtn}
                  aria-label={paused ? "Lecture" : "Pause"}
                  onClick={() => (paused ? void video.current?.play() : video.current?.pause())}
                >
                  {paused ? (
                    <Play size={18} />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                    </svg>
                  )}
                </button>
                <div className={styles.track} aria-hidden>
                  <div className={styles.trackFill} style={{ width: `${progress}%` }} />
                </div>
                <span className={styles.time}>
                  {clock(time.now)} / {clock(time.total)}
                </span>
                <button className={styles.cc} aria-pressed={captions} aria-label="Sous-titres" onClick={() => setCaptions((c) => !c)}>
                  CC
                </button>
                <button
                  className={styles.iconBtn}
                  aria-label={muted ? "Activer le son" : "Couper le son"}
                  onClick={() => {
                    if (!video.current) return;
                    video.current.muted = !video.current.muted;
                    setMuted(video.current.muted);
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M4 9h4l5-4v14l-5-4H4z" />
                    {muted ? <path d="M17 9l4 6M21 9l-4 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
                  </svg>
                </button>
              </div>
            )}

            {phase === "ended" && (
              <div className={`${styles.layer} ${styles.layerEnd}`}>
                <div className={styles.endMark} aria-hidden>
                  M
                </div>
                <p className={styles.endText}>{TAGLINE}</p>
                {secondaryGuest && <p className={styles.endNote}>{SECONDARY_NOTE}</p>}
              </div>
            )}

            {phase === "failed" && (
              <div className={`${styles.layer} ${styles.layerError}`} role="alert">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#f7f1e6" strokeWidth="1.8" aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v6M12 16.5v.5" />
                </svg>
                <p className={styles.layerText}>{FAILURE}</p>
              </div>
            )}
          </div>

          <div className={styles.actions}>
            {phase === "idle" && (
              <>
                <Button block className={styles.cta} onClick={() => void play()}>
                  <Play size={16} />
                  Lancer la vidéo
                </Button>
                {note && <p className={styles.size}>{note}</p>}
              </>
            )}
            {finished && continueButton}
            {phase === "ended" && (
              <Button variant="secondary" block className={styles.cta} onClick={() => void play(true)}>
                Revoir la vidéo
              </Button>
            )}
            {shownLines.length > 0 && (
              <button className={styles.link} aria-expanded={transcriptOpen} onClick={() => setTranscriptOpen((o) => !o)}>
                {transcriptOpen ? "Masquer le texte de la vidéo" : "Lire le texte de la vidéo"}
              </button>
            )}
            {!settings && !finished && (
              <button className={styles.skip} onClick={onContinue} disabled={busy}>
                Passer
              </button>
            )}
          </div>

          {transcriptOpen && shownLines.length > 0 && (
            <div className={styles.transcript}>
              <div className={styles.transcriptTitle}>Texte de la vidéo</div>
              {shownLines.map((line, index) => (
                <div key={index} className={styles.line}>
                  {lines.some((l) => l.time) && <span className={styles.lineTime}>{line.time ?? ""}</span>}
                  <span>{line.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
