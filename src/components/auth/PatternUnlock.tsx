"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { Button, ButtonLink, Notice } from "@/components/ui";
import styles from "./auth.module.css";
import { ErrorLine, LockIcon } from "./parts";
import { PatternGrid } from "./PatternGrid";

export interface PatternUnlockProps {
  firstName: string;
  maskedEmail: string;
  /** Appelé après un schéma correct, avec l'écran d'arrivée proposé par le serveur. */
  onUnlocked: (next: string) => void;
  /** Appelé quand le 3e échec verrouille l'appareil (US-7). */
  onLocked: () => void;
  onUsePassword: () => void;
}

/**
 * Déverrouillage par schéma (US-6 RF5 à RF15) : prénom et email masqué, grille, compteur de
 * tentatives restantes. Une erreur réseau n'est pas comptée comme un échec (RF14, RF15).
 */
export function PatternUnlock({ firstName, maskedEmail, onUnlocked, onLocked, onUsePassword }: PatternUnlockProps) {
  const [points, setPoints] = useState<number[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function submit() {
    if (points.length === 0 || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await apiRequest<{ next: string }>("/api/auth/unlock/pattern", { method: "POST", body: { points } });
      onUnlocked(result.next);
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.body?.code === "pattern_locked") return onLocked();
      setError(apiError);
    } finally {
      setPending(false);
    }
  }

  const wrong = error?.body?.code === "pattern_incorrect";

  return (
    <div className={styles.center}>
      <div className={styles.who}>
        <div className={styles.whoName}>{firstName}</div>
        <div className={styles.whoEmail}>{maskedEmail}</div>
      </div>
      <p className={styles.note} style={{ maxWidth: "26ch", margin: 0 }}>
        Reproduisez votre schéma pour déverrouiller MAAQ rapidement
      </p>
      <PatternGrid
        value={points}
        onChange={(next) => {
          setPoints(next);
          if (wrong) setError(undefined);
        }}
        disabled={pending}
        error={wrong}
      />
      {wrong ? <Notice tone="error">{error.message}</Notice> : <ErrorLine error={error} onRetry={submit} />}
      <Button block loading={pending} disabled={points.length === 0} onClick={submit}>
        Déverrouiller
      </Button>
      <div className={styles.links}>
        <Link href="/schema-oublie" className={styles.link}>
          Schéma oublié ?
        </Link>
        <button type="button" className={styles.link} onClick={onUsePassword}>
          Utiliser mon mot de passe
        </button>
      </div>
    </div>
  );
}

/** Écran « Schéma tactile verrouillé » après 3 échecs (US-7, maquette Schéma verrouillé). */
export function PatternLockedNotice({ onUsePassword }: { onUsePassword: () => void }) {
  return (
    <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 14 }}>
      <LockIcon broken />
      <h1 className={styles.title}>Schéma tactile verrouillé</h1>
      <p className={styles.lead} style={{ margin: 0 }}>
        3 tentatives incorrectes ont été détectées. Le déverrouillage par schéma est bloqué sur cet appareil.
      </p>
      <div className={styles.strikes}>✕ ✕ ✕ — 3 échecs consécutifs</div>
      <ButtonLink href="/schema-oublie" block>
        Récupérer mon accès
      </ButtonLink>
      <Button block variant="secondary" onClick={onUsePassword}>
        Se connecter avec mon mot de passe
      </Button>
      <p className={styles.note}>
        Ce n&apos;est pas définitif : vous pouvez récupérer l&apos;accès à tout moment à partir de votre email de connexion.
      </p>
    </div>
  );
}
