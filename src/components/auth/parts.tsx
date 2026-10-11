"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button, Field, Logo, Notice, RetryNotice, Screen } from "@/components/ui";
import type { ApiError } from "@/client/api";
import styles from "./auth.module.css";

/** Écran d'accès : logo en tête, puis le contenu (maquettes Connexion, Vérification, Récupération). */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <Screen>
      <div className={styles.header}>
        <Logo />
      </div>
      {children}
    </Screen>
  );
}

export function Heading({ eyebrow, title, lead }: { eyebrow?: string; title: string; lead?: ReactNode }) {
  return (
    <>
      {eyebrow && <div className={styles.eyebrow}>{eyebrow}</div>}
      <h1 className={styles.title}>{title}</h1>
      {lead && <p className={styles.lead}>{lead}</p>}
    </>
  );
}

/** Secondes restantes avant une échéance, mises à jour chaque seconde. */
export function useCountdown(until: Date | null, max = 60): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  // Plafonné : un léger décalage d'horloge avec le serveur n'affiche pas « 61 s ».
  return until ? Math.min(max, Math.max(0, Math.ceil((until.getTime() - now) / 1000))) : 0;
}

/** Erreur d'un appel : refus métier en message simple, problème réseau avec « Réessayer » (CC-2, CC-3). */
export function ErrorLine({ error, onRetry }: { error: ApiError | undefined; onRetry?: () => void }) {
  if (!error) return null;
  if (error.retryable && onRetry) return <RetryNotice message={error.message} onRetry={onRetry} />;
  return <Notice tone="error">{error.message}</Notice>;
}

export interface CodeEntryProps {
  code: string;
  onCode: (code: string) => void;
  onConfirm: () => void;
  confirming: boolean;
  onResend: () => void;
  resending: boolean;
  resendAvailableAt: Date | null;
  error?: ApiError;
  resent?: boolean;
}

/**
 * Saisie d'un code à 6 chiffres (US-8, US-51, US-66) : « Confirmer », renvoi possible après 60 s,
 * « Recevoir un nouveau code » quand le code a expiré ou n'est plus valable.
 */
export function CodeEntry(props: CodeEntryProps) {
  const wait = useCountdown(props.resendAvailableAt);
  const needsNewCode = ["code_expired", "code_invalidated", "code_missing"].includes(props.error?.body?.code ?? "");
  const resendLabel = wait > 0 ? `Renvoyer dans ${wait} s` : needsNewCode ? "Recevoir un nouveau code" : "Renvoyer le code";

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (props.code.length === 6) props.onConfirm();
      }}
    >
      <Field
        label="Code à 6 chiffres"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        placeholder="000000"
        className={styles.codeInput}
        value={props.code}
        onChange={(event) => props.onCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
      />
      <ErrorLine error={props.error} onRetry={props.onConfirm} />
      {props.resent && !props.error && <div className={styles.success}>✓ Un nouveau code vient d&apos;être envoyé.</div>}
      <Button type="submit" block loading={props.confirming} disabled={props.code.length !== 6}>
        Confirmer
      </Button>
      <Button type="button" variant="secondary" block loading={props.resending} disabled={wait > 0} onClick={props.onResend}>
        {resendLabel}
      </Button>
    </form>
  );
}

export interface ConfirmDialogProps {
  title: string;
  text?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
  /** Contenu complémentaire, par exemple un message d'erreur, affiché dans la fenêtre. */
  children?: ReactNode;
}

/** Fenêtre de confirmation (US-9 RF2, RF3). */
export function ConfirmDialog({ title, text, confirmLabel, onConfirm, onCancel, confirming, children }: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !confirming && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, confirming]);

  return (
    <div className={styles.backdrop} onClick={() => !confirming && onCancel()}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title" className={styles.dialogTitle}>
          {title}
        </h2>
        {text && <p className={styles.dialogText}>{text}</p>}
        {children}
        <div className={styles.dialogActions}>
          <Button block loading={confirming} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button block variant="secondary" disabled={confirming} onClick={onCancel}>
            Annuler
          </Button>
        </div>
      </div>
    </div>
  );
}

export function LockIcon({ broken = false }: { broken?: boolean }) {
  return (
    <div className={`${styles.lockIcon} ${broken ? styles.lockIconError : ""}`} aria-hidden>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        {broken && <path d="M12 14v3" />}
      </svg>
    </div>
  );
}
