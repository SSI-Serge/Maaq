"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Dictée d'une demande à l'Assistant Famille (US-71, voie rapide) : la reconnaissance vocale du navigateur transcrit la voix, le texte
 * apparaît dans le champ de saisie pour être relu et corrigé, et seul ce texte part au serveur, jamais le son.
 * Chrome sur Android transmet l'audio aux serveurs de Google pour le transcrire : à ne pas utiliser avec de vraies données avant la
 * transcription européenne prévue pour le pilote.
 */

/** Une dictée dure 2 minutes au plus, comme celle du support (US-63 RF4). */
export const MAX_DICTATION_SECONDS = 120;

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type RecognitionConstructor = new () => Recognition;

function constructor(): RecognitionConstructor | undefined {
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

const noSubscription = () => () => {};

/** Texte du champ pendant une dictée : ce qui était déjà écrit, puis ce qui est dit (définitif, puis en cours de reconnaissance). */
export function dictatedText(base: string, spoken: string, interim: string): string {
  const said = `${spoken}${interim}`.trim();
  if (!said) return base;
  const head = base.trimEnd();
  return head ? `${head} ${said}` : said;
}

export type SpeechProblem = "denied" | "failed" | null;

export function useSpeechInput(options: { text: string; onText: (value: string) => void }) {
  const supported = useSyncExternalStore(noSubscription, () => Boolean(constructor()), () => false);
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<SpeechProblem>(null);
  const [elapsed, setElapsed] = useState(0);
  const recognition = useRef<Recognition | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const finish = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    try {
      recognition.current?.stop();
    } catch {
      /* déjà arrêtée */
    }
  }, []);

  // Quitter l'écran coupe le micro.
  useEffect(
    () => () => {
      finish();
      recognition.current = null;
    },
    [finish],
  );

  /** À appeler directement depuis l'appui sur le micro : le navigateur demande l'accès au micro à ce moment-là. */
  const start = useCallback(() => {
    const Ctor = constructor();
    if (!Ctor || recognition.current) return;
    const base = latest.current.text;
    let spoken = "";
    const speech = new Ctor();
    speech.lang = "fr-FR";
    speech.continuous = true;
    speech.interimResults = true;
    speech.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) spoken += `${result[0].transcript.trim()} `;
        else interim += result[0].transcript;
      }
      latest.current.onText(dictatedText(base, spoken, interim));
    };
    speech.onerror = (event) => {
      setProblem(event.error === "not-allowed" || event.error === "service-not-allowed" ? "denied" : event.error === "no-speech" || event.error === "aborted" ? null : "failed");
    };
    speech.onend = () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      recognition.current = null;
      setListening(false);
    };
    recognition.current = speech;
    setProblem(null);
    try {
      speech.start();
    } catch {
      recognition.current = null;
      setProblem("failed");
      return;
    }
    setListening(true);
    setElapsed(0);
    const startedAt = Date.now();
    timer.current = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_DICTATION_SECONDS) finish();
    }, 500);
  }, [finish]);

  return { supported, listening, problem, elapsed, start, stop: finish };
}
