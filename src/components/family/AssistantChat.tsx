"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { useApiQuery } from "@/client/hooks";
import { AppShell, appStyles } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { AssistantMessageView } from "@/server/assistant/service";
import styles from "./family.module.css";

const MAX_LENGTH = 4000;
const REPLY_TIMEOUT_MS = 70_000; // un tour de l'assistant peut enchaîner plusieurs appels du modèle

const EXAMPLES = ["Réunion parents-profs jeudi à 18h à l'école", "Contrôle technique de la voiture samedi à 9h, une heure", "Coller ici le texte d'un mail ou d'un SMS reçu"];

interface Entry {
  key: string;
  role: "user" | "assistant";
  text: string;
  events: AssistantMessageView["events"];
  /** Demande envoyée sans réponse : on peut la renvoyer avec le même identifiant, sans doublon. */
  failedRequest?: string;
}

interface Reply {
  reply: string;
  failed: boolean;
  events: { id: string; title: string; start: string; status: string }[];
}

/**
 * Saisie d'une demande à l'Assistant Famille : le tchat de MAAQ (D29). Le texte est envoyé tel quel ; l'assistant crée un rendez-vous
 * provisoire que le parent confirme depuis l'écran de confirmation (lien « Voir la proposition de RDV »). L'identifiant de la demande,
 * choisi ici, rend « Réessayer » sans danger : aucun rendez-vous n'est créé deux fois.
 */
export function AssistantChat() {
  const history = useApiQuery<{ messages: AssistantMessageView[] }>("/api/assistant/messages");
  const [added, setAdded] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<ApiError>();
  const bottom = useRef<HTMLDivElement>(null);

  const past: Entry[] = (history.data?.messages ?? []).map((m) => ({ key: m.id, role: m.role, text: m.text, events: m.events }));
  // Les messages envoyés pendant cette visite ne sont repris de l'historique qu'au prochain chargement.
  const knownRequests = new Set((history.data?.messages ?? []).map((m) => m.requestId));
  const thread = [...past, ...added.filter((e) => !knownRequests.has(e.key.split(":")[0]))];

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [thread.length, pending]);

  async function send(requestId: string, message: string) {
    setPending(requestId);
    setError(undefined);
    setSlow(false);
    try {
      const reply = await apiRequest<Reply>("/api/assistant/messages", {
        method: "POST",
        body: { requestId, text: message },
        timeoutMs: REPLY_TIMEOUT_MS,
        onSlow: () => setSlow(true),
      });
      setAdded((current) => [...current.filter((e) => e.failedRequest !== requestId), { key: `${requestId}:reply`, role: "assistant", text: reply.reply, events: reply.events }]);
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
    setAdded((current) => [...current, { key: `${requestId}:user`, role: "user", text: message, events: [] }]);
    setText("");
    void send(requestId, message);
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
            {entry.events.map((e) => (
              <Link key={e.id} href={`/calendrier/rdv/${e.id}`} className={styles.bubbleLink}>
                Voir la proposition de RDV ›
              </Link>
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
          onRetry={() => failed && void send(failed.failedRequest!, failed.text)}
        />
      )}
      {unavailable && <Notice tone="info">{error?.message}</Notice>}

      <div className={styles.composer}>
        <textarea
          aria-label="Votre demande"
          placeholder="Écrivez votre demande…"
          value={text}
          maxLength={MAX_LENGTH}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          disabled={Boolean(pending) || unavailable}
        />
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
