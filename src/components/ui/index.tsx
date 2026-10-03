import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import styles from "./ui.module.css";

function cx(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export function Screen({ children, centered = false }: { children: ReactNode; centered?: boolean }) {
  return <main className={cx(styles.screen, centered && styles.centered)}>{children}</main>;
}

export function Logo({ size = "normal", pulse = false }: { size?: "normal" | "large"; pulse?: boolean }) {
  if (size === "large") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
        <div className={cx(styles.logoMark, styles.logoMarkLarge, pulse && styles.logoMarkPulse)} aria-hidden>
          M
        </div>
        <div className={styles.logoName} style={{ fontSize: 26 }}>
          MAAQ
        </div>
      </div>
    );
  }
  return (
    <div className={styles.logo}>
      <div className={styles.logoMark} aria-hidden>
        M
      </div>
      <div className={styles.logoName}>MAAQ</div>
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  /** Affiche un indicateur et désactive le bouton pour éviter un double envoi (CC-1). */
  loading?: boolean;
}

export function Button({ variant = "primary", block = false, loading = false, disabled, children, className, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(styles.button, styles[variant], block && styles.block, className)}
    >
      {loading && <span className={styles.spinner} aria-hidden />}
      {children}
    </button>
  );
}

/** Lien présenté comme un bouton (navigation vers un autre écran). */
export function ButtonLink({
  href,
  variant = "primary",
  block = false,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  block?: boolean;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={cx(styles.button, styles[variant], block && styles.block)}>
      {children}
    </Link>
  );
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export function Field({ label, error, hint, id, className, ...rest }: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  return (
    <div className={styles.field}>
      <label htmlFor={inputId} className={styles.label}>
        {label}
      </label>
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        className={cx(styles.input, error && styles.inputError, className)}
      />
      {error ? (
        <span id={messageId} className={styles.fieldError}>
          {error}
        </span>
      ) : hint ? (
        <span id={messageId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "error" | "warning" | "success" | "info"; children: ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx(styles.notice, styles[`notice_${tone}`])}>
      {children}
    </div>
  );
}

/** Message d'erreur réseau ou serveur avec « Réessayer » (CC-2, CC-3). */
export function RetryNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.retry}>
      <Notice tone="error">{message}</Notice>
      <Button variant="secondary" onClick={onRetry}>
        Réessayer
      </Button>
    </div>
  );
}

/** Indicateur de chargement, complété par « Toujours en cours… » après 5 s (CC-6). */
export function Loading({ slow = false, label = "Chargement…" }: { slow?: boolean; label?: string }) {
  return (
    <div className={styles.loading} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden />
      <span>{slow ? "Toujours en cours…" : label}</span>
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className={styles.card}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className={styles.eyebrow}>{children}</div>;
}

export { styles as uiStyles };
