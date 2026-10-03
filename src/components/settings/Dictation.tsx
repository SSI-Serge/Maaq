"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Notice } from "@/components/ui";
import styles from "./settings.module.css";

/** Un enregistrement dure 2 minutes au plus (US-63 RF4). */
export const MAX_RECORDING_SECONDS = 120;

export const DICTATION_MESSAGES = {
  unavailable: "La dictée n'est pas disponible sur cet appareil",
  denied: "MAAQ n'a pas accès à votre micro. Autorisez-le dans les réglages de votre téléphone, ou utilisez l'onglet Écrit.",
  noTranscription: "La transcription automatique n'est pas disponible sur cet appareil : saisissez ou corrigez le texte ci-dessous.",
} as const;

/** Reconnaissance vocale du navigateur, quand il en propose une (Chrome, Android, Safari récent). */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

function canRecord(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder !== "undefined";
}

const noSubscription = () => () => {};

type Phase = "idle" | "recording" | "review";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * Message dicté (US-63) : enregistrement de 2 minutes au plus avec compteur, transcription en texte relisible
 * et corrigeable, « Recommencer », « Réécouter ». Seul le texte part au support, jamais le son (RF6).
 */
export function Dictation({
  text,
  onText,
  onSwitchToWritten,
  children,
}: {
  text: string;
  onText: (value: string) => void;
  onSwitchToWritten: () => void;
  /** Bouton d'envoi et ses messages, affichés sous le texte transcrit. */
  children: React.ReactNode;
}) {
  const available = useSyncExternalStore(noSubscription, canRecord, () => true);
  const [phase, setPhase] = useState<Phase>(text ? "review" : "idle");
  const [elapsed, setElapsed] = useState(0);
  const [denied, setDenied] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [transcriptionAvailable, setTranscriptionAvailable] = useState(true);

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalText = useRef("");
  const startedAt = useRef(0);
  const url = useRef<string | null>(null);

  function releaseDevices() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    try {
      recognition.current?.stop();
    } catch {
      // déjà arrêtée
    }
    recognition.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }

  // Quitter l'écran libère le micro et le fichier audio temporaire.
  useEffect(
    () => () => {
      releaseDevices();
      if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  async function start() {
    setDenied(false);
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setDenied(true); // refus de l'autorisation (RF3)
      return;
    }
    stream.current = media;
    finalText.current = "";
    onText("");

    const chunks: Blob[] = [];
    const rec = new MediaRecorder(media);
    rec.ondataavailable = (event) => chunks.push(event.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(blob);
      setAudioUrl(url.current);
      setPhase("review");
    };
    recorder.current = rec;

    const Ctor = recognitionConstructor();
    setTranscriptionAvailable(Boolean(Ctor));
    if (Ctor) {
      const speech = new Ctor();
      speech.lang = "fr-FR";
      speech.continuous = true;
      speech.interimResults = true;
      speech.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) finalText.current += `${result[0].transcript.trim()} `;
          else interim += result[0].transcript;
        }
        onText((finalText.current + interim).trim());
      };
      speech.onerror = () => setTranscriptionAvailable(false);
      recognition.current = speech;
      try {
        speech.start();
      } catch {
        setTranscriptionAvailable(false);
      }
    }

    rec.start();
    startedAt.current = Date.now();
    setElapsed(0);
    setPhase("recording");
    timer.current = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt.current) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_RECORDING_SECONDS) stop(); // arrêt automatique à 2 minutes (RF4)
    }, 250);
  }

  function stop() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    try {
      recognition.current?.stop();
    } catch {
      // déjà arrêtée
    }
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }

  function restart() {
    releaseDevices();
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setAudioUrl(null);
    onText(""); // l'enregistrement précédent est supprimé (CA 5.1)
    setPhase("idle");
  }

  if (!available) {
    return (
      <div className={styles.micZone}>
        <Notice tone="warning">{DICTATION_MESSAGES.unavailable}</Notice>
        <Button variant="secondary" onClick={onSwitchToWritten}>
          Utiliser l&apos;onglet Écrit
        </Button>
      </div>
    );
  }

  if (phase === "idle") {
    return (
      <div className={styles.micZone}>
        <button type="button" className={styles.mic} aria-label="Dicter mon message" onClick={start}>
          <MicIcon />
        </button>
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-soft)" }}>
          Démarrer l&apos;enregistrement
        </p>
        {denied && (
          <Notice tone="error">
            {DICTATION_MESSAGES.denied}
          </Notice>
        )}
      </div>
    );
  }

  if (phase === "recording") {
    return (
      <div className={styles.micZone}>
        <button type="button" className={`${styles.mic} ${styles.micRecording}`} aria-label="Arrêter" onClick={stop}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
        <div className={styles.timer} role="timer" aria-live="off">
          {clock(elapsed)} / {clock(MAX_RECORDING_SECONDS)}
        </div>
        <p style={{ margin: 0, fontSize: 13 }}>Arrêter</p>
        {text && <p style={{ margin: 0, fontSize: 12, textAlign: "center", opacity: 0.7 }}>{text}</p>}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {audioUrl && <audio className={styles.audio} controls src={audioUrl} aria-label="Réécouter l'enregistrement" />}
      {!transcriptionAvailable && <Notice tone="info">{DICTATION_MESSAGES.noTranscription}</Notice>}
      <label style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-soft)" }} htmlFor="dictated-text">
        Texte transcrit — modifiable avant l&apos;envoi
      </label>
      <textarea id="dictated-text" className={styles.textarea} maxLength={2000} value={text} onChange={(event) => onText(event.target.value)} />
      <div className={styles.counter}>{2000 - text.length} caractères restants</div>
      <Button variant="secondary" onClick={restart}>
        Recommencer
      </Button>
      {children}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
