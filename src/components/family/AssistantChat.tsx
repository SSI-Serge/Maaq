"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { useApiQuery } from "@/client/hooks";
import { MAX_DICTATION_SECONDS, useSpeechInput } from "@/client/speech";
import { AppShell, appStyles } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { AssistantMessageView, TaskDraftView } from "@/server/assistant/service";
import type { TaskLists } from "@/server/assistant/tasks";
import { OptionalSection } from "./OptionalSection";
import { PlaceResultsCard, PlaceSuggestionCard } from "./PlaceCards";
import { EventProposalCard, TaskDraftCard } from "./ProposalCards";
import styles from "./family.module.css";

const MAX_LENGTH = 4000;
const REPLY_TIMEOUT_MS = 70_000; // un tour de l'assistant peut enchaîner plusieurs appels du modèle

const EXAMPLES = ["Réunion parents-profs jeudi à 18h à l'école", "Contrôle technique de la voiture samedi à 9h, une heure", "Coller ici le texte d'un mail ou d'un SMS reçu"];

interface Entry {
  key: string;
  role: "user" | "assistant";
  text: string;
  events: AssistantMessageView["events"];
  /** Message « Sur place » du fil : suggestion ou résultat de la recherche (US-112). */
  place?: AssistantMessageView["place"];
  /** Tâches proposées par l'assistant : cartes à ajouter, perdues au rechargement (rien n'est enregistré, US-110 RF1). */
  drafts?: TaskDraftView[];
  /** Demande envoyée sans réponse : on peut la renvoyer avec le même identifiant, sans doublon. */
  failedRequest?: string;
  /** Texte tapé ou dicté : la nouvelle tentative garde l'origine du message. */
  source?: Source;
}

type Source = "typed" | "dictation";
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

interface Reply {
  reply: string;
  failed: boolean;
  events: { id: string; title: string; start: string; status: string }[];
  taskDrafts?: TaskDraftView[];
  /** Messages « Sur place » posés dans le fil par cette demande : l'écran recharge le fil pour les montrer. */
  placeMessages?: number;
}

/**
 * Saisie d'une demande à l'Assistant Famille : le tchat de MAAQ (D29). Le texte est envoyé tel quel ; l'assistant crée un rendez-vous
 * provisoire que le parent confirme depuis l'écran de confirmation (lien « Voir la proposition de RDV »). L'identifiant de la demande,
 * choisi ici, rend « Réessayer » sans danger : aucun rendez-vous n'est créé deux fois.
 */
export function AssistantChat() {
  const history = useApiQuery<{ messages: AssistantMessageView[] }>("/api/assistant/messages");
  const [added, setAdded] = useState<Entry[]>([]);
  // Personnes à qui assigner une tâche proposée, pour le bouton « Modifier » de sa carte.
  const taskLists = useApiQuery<{ lists: TaskLists }>("/api/family/tasks");
  const [text, setText] = useState("");
  // Le texte vient d'une dictée que le parent a relue : l'assistant le sait, la voix n'est jamais envoyée.
  const [dictated, setDictated] = useState(false);
  const speech = useSpeechInput({
    text,
    onText: (value) => {
      setText(value);
      setDictated(true);
    },
  });
  const [pending, setPending] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<ApiError>();
  const bottom = useRef<HTMLDivElement>(null);

  const past: Entry[] = (history.data?.messages ?? []).map((m) => ({ key: m.id, role: m.role, text: m.text, events: m.events, place: m.place }));
  // Les messages envoyés pendant cette visite ne sont repris de l'historique qu'au prochain chargement.
  const knownRequests = new Set((history.data?.messages ?? []).map((m) => m.requestId));
  const thread = [...past, ...added.filter((e) => !knownRequests.has(e.key.split(":")[0]))];

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [thread.length, pending]);

  async function send(requestId: string, message: string, source: Source) {
    setPending(requestId);
    setError(undefined);
    setSlow(false);
    try {
      const reply = await apiRequest<Reply>("/api/assistant/messages", {
        method: "POST",
        body: { requestId, text: message, source },
        timeoutMs: REPLY_TIMEOUT_MS,
        onSlow: () => setSlow(true),
      });
      setAdded((current) => [...current.filter((e) => e.failedRequest !== requestId), { key: `${requestId}:reply`, role: "assistant", text: reply.reply, events: reply.events, drafts: reply.taskDrafts }]);
      // Une recherche ou une suggestion « Sur place » a été posée dans le fil : on le recharge pour la montrer, juste après la réponse.
      if (reply.placeMessages) history.reload();
    } catch (err) {
      const apiError = err instanceof ApiError ? err : new ApiError("server", String(err));
      setError(apiError);
      // La demande reste affichée avec la possibilité de la renvoyer telle quelle.
      setAdded((current) => current.map((e) => (e.key === `${requestId}:user` ? { ...e, failedRequest: requestId } : e)));
    } finally {
      setPending(null);
      setSlow(false);
    }
  }

  function submit() {
    const message = text.trim();
    if (!message || pending) return;
    const requestId = crypto.randomUUID();
    const source: Source = dictated ? "dictation" : "typed";
    speech.stop();
    setAdded((current) => [...current, { key: `${requestId}:user`, role: "user", text: message, events: [], source }]);
    setText("");
    setDictated(false);
    void send(requestId, message, source);
  }

  const failed = added.find((e) => e.failedRequest);
  const unavailable = error?.body?.code === "assistant_unavailable" || error?.body?.code === "forbidden";

  return (
    <AppShell title="Nouvelle demande" back={{ href: "/assistant", label: "Assistant Famille" }}>
      {history.loading && !history.data && <Loading slow={history.slow} />}
      {history.error && history.error.body?.code !== "forbidden" && <RetryNotice message={history.error.message} onRetry={history.reload} />}
      {history.error?.body?.code === "forbidden" && <Notice tone="info">L&apos;Assistant Famille est réservé aux deux parents du foyer.</Notice>}

      {history.data && thread.length === 0 && (
        <div className={styles.suggestions}>
          <p className={appStyles.text}>Écrivez ou collez ce que vous auriez transmis à une assistante : un rendez-vous, un message de l&apos;école, un SMS du cabinet.</p>
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className={styles.suggestion} onClick={() => setText(example)}>
              {example}
            </button>
          ))}
        </div>
      )}

      <div className={styles.thread} aria-live="polite">
        {thread.map((entry) => (
          <div key={entry.key} className={`${styles.bubble} ${entry.role === "user" ? styles.bubbleUser : styles.bubbleAgent}`}>
            {entry.text}
            {entry.place && (
              <OptionalSection label="Sur place">
                {entry.place.kind === "place_suggestion" ? <PlaceSuggestionCard place={entry.place} onAnswered={history.reload} /> : <PlaceResultsCard place={entry.place} onRetried={history.reload} />}
              </OptionalSection>
            )}
            {entry.events.map((e) =>
              e.status === "provisional" ? (
                <EventProposalCard key={e.id} eventId={e.id} />
              ) : (
                <Link key={e.id} href={`/calendrier/rdv/${e.id}`} className={styles.bubbleLink}>
                  Voir la proposition de RDV ›
                </Link>
              ),
            )}
            {entry.drafts?.map((d, i) => (
              <TaskDraftCard key={`${d.title}:${d.due}:${i}`} draft={d} assignable={taskLists.data?.lists.assignable ?? []} />
            ))}
          </div>
        ))}
        {pending && (
          <div className={`${styles.bubble} ${styles.bubbleAgent}`} role="status">
            {slow ? "Toujours en cours…" : "L'assistant prépare votre rendez-vous…"}
          </div>
        )}
        <div ref={bottom} />
      </div>

      {error && !unavailable && (
        <RetryNotice
          message={error.kind === "server" ? "L'assistant n'a pas pu traiter votre demande. Elle n'a pas été perdue : vous pouvez la renvoyer." : error.message}
          onRetry={() => failed && void send(failed.failedRequest!, failed.text, failed.source ?? "typed")}
        />
      )}
      {unavailable && <Notice tone="info">{error?.message}</Notice>}

      {speech.listening && (
        <p className={styles.dictation} role="status">
          Je vous écoute… {clock(speech.elapsed)} / {clock(MAX_DICTATION_SECONDS)}
        </p>
      )}
      {speech.problem === "denied" && <Notice tone="error">Le navigateur n&apos;a pas accès au micro. Autorisez-le dans les réglages du site, ou écrivez votre demande.</Notice>}
      {speech.problem === "failed" && <Notice tone="warning">La dictée n&apos;a pas fonctionné. Vous pouvez écrire votre demande.</Notice>}

      <div className={styles.composer}>
        <textarea
          aria-label="Votre demande"
          placeholder={speech.listening ? "Parlez, le texte s'écrit ici…" : "Écrivez votre demande…"}
          value={text}
          maxLength={MAX_LENGTH}
          rows={2}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value.trim()) setDictated(false);
          }}
          disabled={Boolean(pending) || unavailable || speech.listening}
        />
        {speech.supported && (
          <button
            type="button"
            className={`${styles.micButton} ${speech.listening ? styles.micListening : ""}`}
            aria-label={speech.listening ? "Arrêter la dictée" : "Dicter ma demande"}
            aria-pressed={speech.listening}
            onClick={speech.listening ? speech.stop : speech.start}
            disabled={Boolean(pending) || unavailable}
          >
            {speech.listening ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            )}
          </button>
        )}
        <Button onClick={submit} loading={Boolean(pending)} disabled={!text.trim() || unavailable}>
          Envoyer
        </Button>
      </div>
      {text.length > MAX_LENGTH - 500 && (
        <span className={styles.counter}>
          {text.length}/{MAX_LENGTH}
        </span>
      )}
    </AppShell>
  );
}
