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

/** Sessions de reconnaissance consécutives sans une parole avant d'arrêter la dictée (le navigateur coupe une session après quelques secondes de silence). */
export const MAX_QUIET_SESSIONS = 3;

export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
export type RecognitionConstructor = new () => Recognition;

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

export interface Heard {
  text: string;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const fold = (text: string) => squash(text).toLowerCase();

/**
 * Ce que la reconnaissance a entendu, reconstruit en entier à chaque événement à partir de tous les résultats de la session. Chrome sur Android, en mode continu, renvoie des résultats
 * cumulatifs (« rendez-vous », « rendez-vous robotique », « rendez-vous robotique demain »…), chacun contenant les précédents : les ajouter bout à bout répète les mots. Un résultat qui
 * commence par ce qui est déjà écrit le remplace donc ; un résultat plus court qui n'en est que le début est ignoré ; un résultat nouveau s'ajoute (comportement des autres navigateurs).
 * Limite connue : deux résultats identiques de suite (« oui », « oui ») n'en font qu'un.
 */
export function assembleTranscript(heard: Heard[]): string {
  let said = "";
  for (const { text } of heard) {
    const part = squash(text);
    if (!part) continue;
    const have = fold(said);
    const next = fold(part);
    if (!have || next.startsWith(have)) said = part;
    else if (have.startsWith(next)) continue;
    else said = `${said} ${part}`;
  }
  return said;
}

export type SpeechProblem = "denied" | "failed" | null;

export interface DictationHooks {
  /** Le texte du champ à cet instant : une session relancée repart de ce qui est déjà dicté. */
  getText: () => string;
  setText: (value: string) => void;
  onProblem: (problem: SpeechProblem) => void;
  /** La dictée est terminée (arrêt demandé, durée maximale, refus ou silence). */
  onEnd: () => void;
  /** La durée maximale est atteinte : on ne relance plus. */
  expired: () => boolean;
}

/**
 * Pilote une dictée jusqu'à « Stop » : le navigateur coupe une session de reconnaissance après quelques secondes de silence (sur Android, même en mode continu) ; tant que la personne n'a pas
 * appuyé sur « Stop », que la durée maximale n'est pas atteinte et que le micro n'est pas refusé, une nouvelle session repart aussitôt à la suite du texte déjà dicté. Après trois sessions
 * de suite sans un mot, la dictée s'arrête.
 */
export function createDictation(Ctor: RecognitionConstructor, hooks: DictationHooks): { start: () => boolean; stop: () => void } {
  let current: Recognition | null = null;
  let wanted = false;
  let quiet = 0;

  const begin = (): boolean => {
    const base = hooks.getText();
    let heardAny = false;
    const speech = new Ctor();
    speech.lang = "fr-FR";
    speech.continuous = true;
    speech.interimResults = true;
    speech.onresult = (event) => {
      heardAny = true;
      quiet = 0;
      hooks.setText(dictatedText(base, assembleTranscript(Array.from(event.results, (r) => ({ text: r[0].transcript }))), ""));
    };
    speech.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        hooks.onProblem("denied");
        wanted = false;
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        hooks.onProblem("failed");
        wanted = false;
      }
    };
    speech.onend = () => {
      if (current !== speech) return;
      current = null;
      if (wanted && !hooks.expired()) {
        if (!heardAny) quiet += 1;
        if (quiet < MAX_QUIET_SESSIONS) {
          try {
            if (begin()) return;
          } catch {
            /* la relance a échoué : la dictée se termine */
          }
        }
      }
      wanted = false;
      hooks.onEnd();
    };
    current = speech;
    try {
      speech.start();
    } catch {
      current = null;
      return false;
    }
    return true;
  };

  return {
    start() {
      if (current) return false;
      wanted = true;
      quiet = 0;
      hooks.onProblem(null);
      if (!begin()) {
        wanted = false;
        hooks.onProblem("failed");
        return false;
      }
      return true;
    },
    stop() {
      wanted = false;
      try {
        current?.stop();
      } catch {
        /* déjà arrêtée */
      }
    },
  };
}

export function useSpeechInput(options: { text: string; onText: (value: string) => void }) {
  const supported = useSyncExternalStore(noSubscription, () => Boolean(constructor()), () => false);
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<SpeechProblem>(null);
  const [elapsed, setElapsed] = useState(0);
  const dictation = useRef<ReturnType<typeof createDictation> | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const clearTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const finish = useCallback(() => {
    clearTimer();
    dictation.current?.stop();
  }, [clearTimer]);

  // Quitter l'écran coupe le micro.
  useEffect(
    () => () => {
      clearTimer();
      dictation.current?.stop();
      dictation.current = null;
    },
    [clearTimer],
  );

  /** À appeler directement depuis l'appui sur le micro : le navigateur demande l'accès au micro à ce moment-là. */
  const start = useCallback(() => {
    const Ctor = constructor();
    if (!Ctor || dictation.current) return;
    const controller = createDictation(Ctor, {
      getText: () => latest.current.text,
      setText: (value) => latest.current.onText(value),
      onProblem: setProblem,
      onEnd: () => {
        clearTimer();
        dictation.current = null;
        setListening(false);
      },
      expired: () => Date.now() - startedAt.current >= MAX_DICTATION_SECONDS * 1000,
    });
    dictation.current = controller;
    startedAt.current = Date.now();
    if (!controller.start()) {
      dictation.current = null;
      return;
    }
    setListening(true);
    setElapsed(0);
    timer.current = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt.current) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_DICTATION_SECONDS) finish();
    }, 500);
  }, [clearTimer, finish]);

  return { supported, listening, problem, elapsed, start, stop: finish };
}
