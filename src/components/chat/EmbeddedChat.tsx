"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { Loading } from "@/components/ui";
import styles from "./chat.module.css";

interface Launch {
  url: string;
  origin: string;
  expiresAt: string;
  context: { page: { title: string; url: string }; data: Record<string, unknown> };
}

/**
 * Tchat de Digitorn, embarqué dans le cadre de l'écran (US-37). Le lien de lancement ne sert qu'une fois et expire très
 * vite : un lien neuf est demandé à chaque affichage, jamais conservé. Le contexte de la page est envoyé quand le tchat
 * annonce qu'il écoute (`digitorn:ready`) puis au chargement du cadre ; Digitorn le traite comme non vérifié.
 */
export function EmbeddedChat({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [launch, setLaunch] = useState<Launch>();
  const [error, setError] = useState<ApiError>();
  const [attempt, setAttempt] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Différé d'un cycle : l'état est mis à jour une fois la réponse reçue.
    const start = setTimeout(() => {
      setLaunch(undefined);
      setError(undefined);
      apiRequest<Launch>(`/api/chat/${agentId}/embed`, { method: "POST" })
        .then((data) => {
          if (!cancelled) setLaunch(data);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof ApiError ? err : new ApiError("server", String(err)));
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(start);
    };
  }, [agentId, attempt]);

  const sendContext = useCallback(() => {
    if (launch) frame.current?.contentWindow?.postMessage({ type: "digitorn:context", ...launch.context }, launch.origin);
  }, [launch]);

  useEffect(() => {
    if (!launch) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== launch.origin || event.source !== frame.current?.contentWindow) return;
      if ((event.data as { type?: unknown } | null)?.type === "digitorn:ready") sendContext();
    };
    // Le toucher dans le cadre ne remonte pas jusqu'ici : quand le cadre prend le focus, on le signale au verrouillage (US-52).
    const onBlur = () => {
      if (document.activeElement === frame.current) window.dispatchEvent(new Event("maaq:activity"));
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("blur", onBlur);
    };
  }, [launch, sendContext]);

  if (error) {
    return (
      <div className={styles.welcome}>
        <p className={styles.welcomeText}>
          {error.kind === "rejected" ? error.message : `Le tchat de ${agentName} n'a pas pu s'ouvrir. Vérifiez votre connexion et réessayez.`}
        </p>
        <button type="button" className={styles.smallButton} onClick={() => setAttempt((n) => n + 1)}>
          Réessayer
        </button>
      </div>
    );
  }
  if (!launch) return <Loading />;

  return (
    <div className={styles.embedBox}>
      <iframe
        ref={frame}
        className={styles.embed}
        src={launch.url}
        title={`Tchat avec ${agentName}`}
        allow="clipboard-write; microphone"
        onLoad={sendContext}
      />
    </div>
  );
}
