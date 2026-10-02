"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { useDraft } from "@/client/hooks";
import { useSessionUser } from "@/components/auth/AuthGate";
import { Loading } from "@/components/ui";
import { LOW_CAP_THRESHOLD, MAX_REQUEST_LENGTH } from "@/server/chat/rules";
import type { ChatItem, ChatView } from "@/server/chat/service";
import { ActionCard } from "./ActionCard";
import styles from "./chat.module.css";
import { ReportForm } from "./ReportForm";

/** Un message en attente de connexion est envoyé tant que moins de 10 minutes se sont écoulées (US-38 RF14). */
const WAIT_FOR_CONNECTION_MS = 10 * 60_000;
/** Délais d'attente de la réponse de l'agent (US-38 RF9, RF10). */
const SLOW_REPLY_MS = 30_000;
const FAILED_REPLY_MS = 120_000;
/** Relecture du tchat : rapide quand on attend quelque chose, sinon assez fréquente pour voir un blocage en moins de 30 s (US-42 RF5). */
const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 15_000;

type OutgoingState = "sending" | "accepted" | "waiting" | "failed";

interface Outgoing {
  requestId: string;
  text: string;
  state: OutgoingState;
  queuedAt: number;
}

interface ChatState {
  data?: ChatView;
  error?: ApiError;
  /** Écart entre l'horloge du serveur et celle de l'appareil, pour mesurer les délais sans dépendre de l'heure du téléphone. */
  offset: number;
}

/** Lecture du tchat. Les relectures automatiques ne prolongent pas le déverrouillage (US-52). */
function useChatView(agentId: string) {
  const [state, setState] = useState<ChatState>({ offset: 0 });
  const sequence = useRef(0);

  const load = useCallback(
    async (automatic: boolean) => {
      const mine = ++sequence.current;
      try {
        const data = await apiRequest<ChatView>(`/api/chat/${agentId}${automatic ? "?auto=1" : ""}`);
        if (mine !== sequence.current) return undefined; // une lecture plus récente est partie entre-temps
        setState({ data, offset: Date.parse(data.now) - Date.now() });
        return data;
      } catch (err) {
        if (mine !== sequence.current) return undefined;
        const error = err instanceof ApiError ? err : new ApiError("server", String(err));
        setState((previous) => ({ ...previous, error }));
        return undefined;
      }
    },
    [agentId],
  );

  // Premier chargement, différé d'un cycle : la lecture met l'état à jour une fois la réponse reçue.
  useEffect(() => {
    const start = setTimeout(() => void load(false), 0);
    return () => clearTimeout(start);
  }, [load]);

  return { ...state, load };
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Tchat avec un agent (US-37, US-38, US-39, US-41, US-42, US-60, US-61, US-70), maquette Tchat. */
export function ChatScreen({ agentId }: { agentId: string }) {
  const user = useSessionUser();
  const { data, error, offset, load } = useChatView(agentId);
  const [draft, setDraft, clearDraft] = useDraft(`chat:${agentId}`);
  const draftRef = useRef(draft);
  const [outbox, setOutbox] = useState<Outgoing[]>([]);
  const outboxRef = useRef<Outgoing[]>([]);
  const [retriedAt, setRetriedAt] = useState<Record<string, number>>({});
  const [rejection, setRejection] = useState<{ code: string; message: string } | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [thanked, setThanked] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const items = data?.items ?? [];
  const inView = new Set(items.filter((i) => i.kind === "user").map((i) => i.requestId));
  const waitingOutbox = outbox.filter((o) => !inView.has(o.requestId));

  // Réponse de l'agent attendue : dernière demande sans réponse (US-38 RF9).
  const answered = new Set(items.filter((i) => i.kind !== "user").map((i) => i.requestId));
  const lastUser = [...items].reverse().find((i) => i.kind === "user");
  const pendingFromView = lastUser && !answered.has(lastUser.requestId) ? { requestId: lastUser.requestId, text: lastUser.text, since: Date.parse(lastUser.at) } : null;
  const pendingFromOutbox = waitingOutbox.filter((o) => o.state === "accepted").map((o) => ({ requestId: o.requestId, text: o.text, since: o.queuedAt + offset }));
  const pending = [...(pendingFromView ? [pendingFromView] : []), ...pendingFromOutbox].sort((a, b) => b.since - a.since)[0] ?? null;

  const executing = items.some((i) => i.kind === "action" && i.proposal.status === "executing");
  const active = pending !== null || executing || waitingOutbox.some((o) => o.state !== "failed");
  const now = useNow(active);
  const serverNow = now + offset;

  // Relecture régulière : réponses, exécutions, blocage et remise en service de l'agent (US-42 RF5).
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [load, active]);

  // Les demandes déjà visibles dans l'historique n'ont plus besoin de leur copie locale.
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.items.filter((i) => i.kind === "user").map((i) => i.requestId));
    updateOutbox((list) => list.filter((o) => !ids.has(o.requestId)));
  }, [data]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, waitingOutbox.length, pending?.requestId, reporting, data?.gate]);

  function updateOutbox(change: (list: Outgoing[]) => Outgoing[]) {
    outboxRef.current = change(outboxRef.current);
    setOutbox(outboxRef.current);
  }

  function patch(requestId: string, changes: Partial<Outgoing>) {
    updateOutbox((list) => list.map((o) => (o.requestId === requestId ? { ...o, ...changes } : o)));
  }

  /** Envoie une demande ; coupure de connexion : elle attend jusqu'à 10 minutes (US-38 RF14). */
  const dispatch = useCallback(
    async (entry: Outgoing) => {
      if (navigator.onLine === false) return patch(entry.requestId, { state: "waiting" });
      patch(entry.requestId, { state: "sending" });
      try {
        await apiRequest(`/api/chat/${agentId}/messages`, {
          method: "POST",
          body: { requestId: entry.requestId, text: entry.text },
          idempotencyKey: entry.requestId, // la demande est rejouable : le serveur ne la compte ni ne l'exécute deux fois
        });
        patch(entry.requestId, { state: "accepted" });
        void load(false);
      } catch (err) {
        const apiError = err instanceof ApiError ? err : new ApiError("server", String(err));
        if (apiError.kind === "rejected") {
          // Refus (plafond, agent bloqué…) : la demande n'est pas partie, le texte revient dans la zone de saisie (US-70 RF4).
          updateOutbox((list) => list.filter((o) => o.requestId !== entry.requestId));
          setDraft(draftRef.current ? `${entry.text}\n${draftRef.current}` : entry.text);
          setRejection({ code: apiError.body?.code ?? "rejected", message: apiError.message });
          void load(false);
        } else if (apiError.kind === "offline") {
          patch(entry.requestId, { state: "waiting" });
        } else {
          patch(entry.requestId, { state: "failed" });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- patch et updateOutbox ne dépendent que de refs et de setters stables
    [agentId, load, setDraft],
  );

  useEffect(() => {
    const flush = () => {
      for (const entry of outboxRef.current) {
        if (entry.state === "waiting" && Date.now() - entry.queuedAt <= WAIT_FOR_CONNECTION_MS) void dispatch(entry);
      }
      void load(false);
    };
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [dispatch, load]);

  function submit() {
    const text = draft.trim();
    if (!text || !data || data.blocked || data.gate) return;
    clearDraft();
    setRejection(null);
    const entry: Outgoing = { requestId: crypto.randomUUID(), text, state: "sending", queuedAt: Date.now() };
    updateOutbox((list) => [...list, entry]);
    void dispatch(entry);
  }

  function retry(entry: Outgoing) {
    const fresh = { ...entry, queuedAt: Date.now() };
    patch(entry.requestId, { queuedAt: fresh.queuedAt });
    void dispatch(fresh);
  }

  /** Aucune réponse de l'agent après 2 minutes : on renvoie la même demande, sans la recompter (US-38 RF10, US-70 RF6). */
  async function resend(request: { requestId: string; text: string }) {
    setRetriedAt((previous) => ({ ...previous, [request.requestId]: serverNow }));
    try {
      await apiRequest(`/api/chat/${agentId}/messages`, {
        method: "POST",
        body: { requestId: request.requestId, text: request.text },
        idempotencyKey: request.requestId,
      });
      void load(false);
    } catch (err) {
      if (err instanceof ApiError && err.kind === "rejected") setRejection({ code: err.body?.code ?? "rejected", message: err.message });
    }
  }

  function pick(suggestion: string) {
    setDraft(suggestion);
    inputRef.current?.focus();
  }

  const blocked = data?.blocked ?? null;
  const remaining = data?.cap.remaining ?? Infinity;
  const showLowCap = data !== undefined && remaining > 0 && remaining <= LOW_CAP_THRESHOLD;
  const agentName = data?.agent.name ?? "L'agent";

  function renderReport(item: Extract<ChatItem, { kind: "agent" | "action" }>) {
    const justThanked = thanked.includes(item.id);
    return (
      <>
        <div className={styles.under}>
          {item.reported ? (
            <span className={styles.reportedLabel}>Signalée</span>
          ) : (
            reporting !== item.id && (
              <button type="button" className={styles.linkButton} onClick={() => setReporting(item.id)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
                </svg>
                Signaler une erreur
              </button>
            )
          )}
        </div>
        {reporting === item.id && (
          <ReportForm
            agentId={agentId}
            messageRef={item.id}
            onCancel={() => setReporting(null)}
            onDone={() => {
              setReporting(null);
              setThanked((list) => [...list, item.id]);
              void load(false);
            }}
          />
        )}
        {justThanked && (
          <div className={`${styles.notice} ${styles.noticeSuccess}`} role="status">
            Merci, votre signalement a été transmis
          </div>
        )}
      </>
    );
  }

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <Link href="/accueil" className={styles.iconLink} aria-label="Retour au dashboard">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
        <div className={styles.headerText}>
          <div className={styles.agentName}>{data?.agent.name ?? "Tchat"}</div>
          {data && <div className={styles.agentSub}>{data.agent.shortDescription}</div>}
        </div>
        <Link href={`/connecteurs?agent=${agentId}`} className={styles.iconLink} aria-label="Configurer les connecteurs">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
          </svg>
        </Link>
      </header>

      {/* Bannière permanente, sans croix ni masquage (US-60). */}
      <div className={styles.aiBanner} role="note">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v.1M12 11v5" />
        </svg>
        <span>Vous échangez avec une IA. Ses réponses peuvent contenir des erreurs.</span>
      </div>

      <div className={styles.thread} aria-live="polite">
        {!data && !error && <Loading />}
        {!data && error && (
          <div className={styles.welcome}>
            <p className={styles.welcomeText}>{error.kind === "rejected" ? error.message : "Les suggestions n'ont pas pu être chargées."}</p>
            {error.kind !== "rejected" && (
              <button type="button" className={styles.smallButton} onClick={() => void load(false)}>
                Recharger les suggestions
              </button>
            )}
            {error.kind === "rejected" && (
              <Link href="/accueil" className={styles.smallButton}>
                Retour au dashboard
              </Link>
            )}
          </div>
        )}

        {data?.blocked && (
          <div className={styles.blocked} role="alert">
            Accès bloqué — maintenance en cours sur {data.agent.name}. {data.blocked.message}
          </div>
        )}

        {data?.gate && (
          <div className={styles.gate}>
            <h2>{data.agent.name} n&apos;est pas encore prêt</h2>
            <p className={styles.welcomeText} style={{ maxWidth: "none" }}>
              Il manque quelques éléments avant de pouvoir lui écrire :
            </p>
            <ul className={styles.gateList}>
              {data.gate.items.map((item) => (
                <li key={`${item.kind}:${item.label}`}>
                  {item.label}
                  {item.reconnect && <b> — À reconnecter</b>}
                  <span className={styles.gateWho}>{item.responsible === "primary_user" && user.role !== "primary_user" ? `À configurer par ${data.gate!.primaryFirstName ?? "l'utilisateur principal"}` : "À faire de votre côté"}</span>
                </li>
              ))}
            </ul>
            {data.gate.items.some((i) => i.responsible === "primary_user") && user.role !== "primary_user" && (
              <p className={styles.welcomeText} style={{ maxWidth: "none" }}>
                Cet agent doit d&apos;abord être configuré par {data.gate.primaryFirstName ?? "l'utilisateur principal"}.
              </p>
            )}
            {data.gate.canFix && data.gate.items.some((i) => i.kind === "connector" && (i.responsible === "profile" || user.role === "primary_user")) && (
              <Link href={`/connecteurs?agent=${agentId}`} className={styles.linkAction}>
                Configurer mes connecteurs
              </Link>
            )}
            {data.gate.items.some((i) => i.kind === "info") && (
              <Link href={`/informations/${agentId}?retour=${encodeURIComponent(`/tchat/${agentId}`)}`} className={styles.linkAction}>
                Renseigner mes informations
              </Link>
            )}
          </div>
        )}

        {data && !data.gate && items.length === 0 && waitingOutbox.length === 0 && (
          <div className={styles.welcome}>
            <div className={styles.avatar} aria-hidden>
              {data.agent.name.charAt(0).toUpperCase()}
            </div>
            <h2>Bienvenue dans {data.agent.name}</h2>
            <p className={styles.welcomeText}>{data.agent.shortDescription.replace(/[.\s]+$/, "")}. Écrivez-moi ce dont vous avez besoin{data.suggestions.length > 0 ? ", par exemple :" : "."}</p>
            {data.suggestions.length > 0 && (
              <div className={styles.suggestions}>
                {data.suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" className={styles.suggestion} disabled={blocked !== null} onClick={() => pick(suggestion)}>
                    « {suggestion} »
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {items.map((item) => {
          if (item.kind === "user") {
            return (
              <div key={item.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div className={styles.rowEnd}>
                  <div className={styles.bubbleUser}>{item.text}</div>
                </div>
                <div className={styles.rowEnd}>
                  <span className={styles.status}>Envoyé</span>
                </div>
              </div>
            );
          }
          if (item.kind === "agent") {
            return (
              <div key={item.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className={styles.rowStart}>
                  <div className={styles.bubbleAgent}>{item.text}</div>
                </div>
                {renderReport(item)}
              </div>
            );
          }
          return (
            <div key={item.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <ActionCard agentId={agentId} item={item} blocked={blocked !== null} serverNow={serverNow} onChanged={() => void load(false)} />
              {renderReport(item)}
            </div>
          );
        })}

        {waitingOutbox.map((entry) => {
          const state: OutgoingState = entry.state === "waiting" && now - entry.queuedAt > WAIT_FOR_CONNECTION_MS ? "failed" : entry.state;
          return (
            <div key={entry.requestId} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div className={styles.rowEnd}>
                <div className={styles.bubbleUser}>{entry.text}</div>
              </div>
              <div className={styles.rowEnd}>
                <span className={`${styles.status} ${state === "failed" ? styles.statusError : ""}`}>
                  {state === "sending" && "Envoi…"}
                  {state === "accepted" && "Envoyé"}
                  {state === "waiting" && "En attente de connexion"}
                  {state === "failed" && (
                    <>
                      Non envoyé
                      <button type="button" className={styles.linkButton} onClick={() => retry(entry)}>
                        Réessayer
                      </button>
                    </>
                  )}
                </span>
              </div>
            </div>
          );
        })}

        {pending && !blocked && <PendingReply name={agentName} elapsed={serverNow - Math.max(pending.since, retriedAt[pending.requestId] ?? 0)} onRetry={() => void resend(pending)} />}
        <div ref={endRef} />
      </div>

      {data && !data.gate && (
        <div className={styles.composer}>
          {rejection && (
            <div className={rejection.code === "daily_cap_reached" ? styles.capReached : styles.statusError} role="alert" style={{ fontSize: 12, lineHeight: 1.4 }}>
              {rejection.message}
            </div>
          )}
          {showLowCap && !rejection && (
            <div className={styles.capWarning} role="status">
              Il vous reste {remaining} {remaining > 1 ? "demandes" : "demande"} aujourd&apos;hui
            </div>
          )}
          <div className={styles.inputRow}>
            <textarea
              ref={inputRef}
              className={styles.input}
              rows={1}
              aria-label="Votre demande"
              placeholder={blocked ? "Cet agent est en maintenance" : "Écrivez votre demande…"}
              maxLength={MAX_REQUEST_LENGTH}
              disabled={blocked !== null}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (rejection) setRejection(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <button type="button" className={styles.send} aria-label="Envoyer" disabled={blocked !== null || draft.trim().length === 0} onClick={submit}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M4 12l16-8-6 16-2-6-8-2z" />
              </svg>
            </button>
          </div>
          {draft.length > 0 && <div className={styles.inputCount}>{draft.length} caractères</div>}
        </div>
      )}
    </div>
  );
}

/** « [Agent] réfléchit… », puis « met plus de temps » à 30 s et l'échec à 2 minutes (US-38 RF9, RF10). */
function PendingReply({ name, elapsed, onRetry }: { name: string; elapsed: number; onRetry: () => void }) {
  if (elapsed >= FAILED_REPLY_MS) {
    return (
      <div className={`${styles.notice} ${styles.noticeError}`} role="alert" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {name} n&apos;a pas pu répondre.
        <button type="button" className={styles.secondary} onClick={onRetry}>
          Réessayer
        </button>
      </div>
    );
  }
  return (
    <div className={styles.thinking} role="status">
      {elapsed >= SLOW_REPLY_MS ? `${name} met plus de temps que prévu…` : `${name} réfléchit…`}
    </div>
  );
}
