"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, apiRequest, newIdempotencyKey } from "@/client/api";
import { useApiMutation, useDraft } from "@/client/hooks";
import { pushNotice } from "@/client/notices";
import { ErrorLine } from "@/components/auth/parts";
import { Button } from "@/components/ui";
import { Dictation } from "./Dictation";
import styles from "./settings.module.css";

const MIN = 10;
const MAX = 2000;

type Tab = "written" | "dictated";

/**
 * Contact du support (US-62 écrit, US-63 dicté), commun aux utilisateurs, invités et administrateurs.
 * Un message non envoyé est conservé sur l'appareil (CC-8) ; un message dicté part en arrière-plan (CC-10).
 */
export function SupportForm() {
  const [tab, setTab] = useState<Tab>("written");
  const [written, setWritten, clearWritten] = useDraft("support");
  const [dictated, setDictated, clearDictated] = useDraft("support-dictated");
  const [sent, setSent] = useState(false);
  const send = useApiMutation();

  const [dictating, setDictating] = useState(false);
  const [dictationError, setDictationError] = useState<ApiError>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function sendWritten() {
    const result = await send.run<{ sent: boolean }>("/api/support", { method: "POST", body: { text: written.trim(), channel: "written" } });
    if (result) {
      clearWritten();
      setSent(true);
    }
  }

  /** Le message dicté part en arrière-plan : quitter l'écran n'interrompt pas l'envoi (US-63 RF11). */
  function sendDictated() {
    const text = dictated.trim();
    const key = newIdempotencyKey();
    setDictating(true);
    setDictationError(undefined);
    apiRequest("/api/support", { method: "POST", body: { text, channel: "dictated" }, idempotencyKey: key })
      .then(() => {
        clearDictated();
        if (mounted.current) setSent(true);
        else pushNotice("success", "Votre message dicté a été transmis au support");
      })
      .catch((error: unknown) => {
        const apiError = error instanceof ApiError ? error : new ApiError("server", String(error));
        // L'enregistrement transcrit reste dans la zone de texte pour un nouvel essai (RF9, RF10).
        if (mounted.current) setDictationError(apiError);
        else pushNotice("error", `Votre message dicté n'a pas pu être envoyé : ${apiError.message}`);
      })
      .finally(() => {
        if (mounted.current) setDictating(false);
      });
  }

  if (sent) {
    return (
      <div className={styles.sent} role="status">
        <div className={styles.sentIcon} aria-hidden>
          ✓
        </div>
        <h2 style={{ fontSize: 20 }}>Message transmis</h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>Votre message a été transmis au support. L&apos;équipe MAAQ reviendra vers vous rapidement. Une copie vous a été envoyée par email.</p>
        <Button
          variant="secondary"
          onClick={() => {
            setSent(false);
            send.reset();
          }}
        >
          Écrire un autre message
        </Button>
      </div>
    );
  }

  const remaining = MAX - written.length;
  const dictatedReady = dictated.trim().length >= MIN;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, opacity: 0.8 }}>Décrivez le dysfonctionnement rencontré : votre message sera transmis directement à la boîte mail du support MAAQ.</p>
      <div className={styles.tabs} role="tablist">
        {(
          [
            ["written", "Écrit"],
            ["dictated", "Dicté"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} role="tab" type="button" aria-selected={tab === value} className={`${styles.tab} ${tab === value ? styles.tabOn : ""}`} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "written" ? (
        <>
          <textarea
            className={styles.textarea}
            aria-label="Votre message"
            placeholder="Ex : l'agent Admin_lib n'ouvre plus son tchat depuis ce matin…"
            maxLength={MAX}
            value={written}
            onChange={(event) => setWritten(event.target.value)}
          />
          <div className={styles.counter} aria-live="polite">
            {remaining} caractères restants
          </div>
          <ErrorLine error={send.error} onRetry={sendWritten} />
          <Button loading={send.pending} disabled={written.trim().length < MIN} onClick={sendWritten}>
            Envoyer
          </Button>
        </>
      ) : (
        <Dictation text={dictated} onText={setDictated} onSwitchToWritten={() => setTab("written")}>
          {dictating && (
            <div className={styles.progress} role="progressbar" aria-label="Envoi en cours">
              <div className={styles.progressBar} />
            </div>
          )}
          <ErrorLine error={dictationError} onRetry={sendDictated} />
          <Button loading={dictating} disabled={!dictatedReady} onClick={sendDictated}>
            Envoyer
          </Button>
        </Dictation>
      )}
    </div>
  );
}
