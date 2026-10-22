"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Saisie vocale par la reconnaissance du navigateur (Chrome, Android, Safari récent). Seul le texte reconnu est
 * transmis à l'appelant : aucun son n'est enregistré ni envoyé, le navigateur fait la transcription lui-même.
 */

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
}
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

const noSubscription = () => () => {};
const hasRecognition = () => recognitionConstructor() !== undefined;
const never = () => false;

export interface SpeechInput {
  /** Faux côté serveur et sur les navigateurs sans reconnaissance vocale : le bouton n'est alors pas affiché. */
  available: boolean;
  listening: boolean;
  /** L'accès au micro a été refusé. */
  denied: boolean;
  /** Démarre l'écoute ; onTranscript reçoit à chaque fois tout le texte reconnu depuis le début (final + en cours). */
  start: (onTranscript: (text: string) => void) => void;
  stop: () => void;
}

export function useSpeechInput({ lang = "fr-FR", maxSeconds = 120 }: { lang?: string; maxSeconds?: number } = {}): SpeechInput {
  const available = useSyncExternalStore(noSubscription, hasRecognition, never);
  const [listening, setListening] = useState(false);
  const [denied, setDenied] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const current = recognition.current;
    recognition.current = null;
    try {
      current?.stop(); // les derniers résultats arrivent encore via onresult avant onend
    } catch {
      // déjà arrêtée
    }
    setListening(false);
  }, []);

  const start = useCallback(
    (onTranscript: (text: string) => void) => {
      if (recognition.current) return;
      const Ctor = recognitionConstructor();
      if (!Ctor) return;
      setDenied(false);
      const speech = new Ctor();
      speech.lang = lang;
      speech.continuous = true;
      speech.interimResults = true;
      speech.onresult = (event) => {
        // On recompose tout le texte à chaque événement : certains navigateurs renvoient la liste complète, d'autres seulement la fin.
        let final = "";
        let interim = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) final += `${result[0].transcript.trim()} `;
          else interim += result[0].transcript;
        }
        onTranscript((final + interim).trim());
      };
      const finish = () => {
        if (recognition.current !== speech) return;
        recognition.current = null;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        setListening(false);
      };
      speech.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") setDenied(true);
        finish();
      };
      speech.onend = finish;
      recognition.current = speech;
      try {
        speech.start();
      } catch {
        recognition.current = null;
        return;
      }
      setListening(true);
      // Arrêt automatique : une dictée ne dépasse pas maxSeconds.
      timer.current = setTimeout(stop, maxSeconds * 1000);
    },
    [lang, maxSeconds, stop],
  );

  // Quitter l'écran libère le micro.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const current = recognition.current;
      recognition.current = null;
      try {
        (current?.abort ?? current?.stop)?.call(current);
      } catch {
        // déjà arrêtée
      }
    },
    [],
  );

  return { available, listening, denied, start, stop };
}
