"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { AuthScreen, ErrorLine } from "@/components/auth/parts";
import { PatternGrid } from "@/components/auth/PatternGrid";
import { Button, Loading, Notice } from "@/components/ui";
import styles from "@/components/auth/auth.module.css";

const MIN_POINTS = 4;

type Mode = "first" | "recovery" | "after_reset";

/** Création du schéma tactile en deux tracés identiques (US-6 RF1 à RF4, US-8 RF5, US-66 RF7). */
export default function CreatePatternPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [first, setFirst] = useState<number[]>([]);
  const [points, setPoints] = useState<number[]>([]);
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [done, setDone] = useState(false);

  useEffect(() => {
    apiRequest<{ allowed: boolean; mode: Mode | null }>("/api/auth/pattern")
      .then((result) => (result.allowed ? setMode(result.mode) : router.replace("/connexion")))
      .catch((err: ApiError) => setError(err));
  }, [router]);

  async function validate() {
    setMessage(undefined);
    if (points.length < MIN_POINTS) {
      setMessage("Reliez au moins 4 points");
      setPoints([]);
      return;
    }
    if (step === 1) {
      setFirst(points);
      setPoints([]);
      setStep(2);
      return;
    }
    if (points.join("-") !== first.join("-")) {
      setMessage("Les deux schémas ne correspondent pas. Recommencez.");
      setFirst([]);
      setPoints([]);
      setStep(1);
      return;
    }
    await save();
  }

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const result = await apiRequest<{ next: string }>("/api/auth/pattern", {
        method: "POST",
        body: { points: first, confirmation: points },
      });
      setDone(true);
      setTimeout(() => router.replace(result.next), 900);
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.status === 401) return router.replace("/connexion");
      setError(apiError);
    } finally {
      setSaving(false);
    }
  }

  if (!mode) {
    return <AuthScreen>{error ? <ErrorLine error={error} onRetry={() => window.location.reload()} /> : <Loading />}</AuthScreen>;
  }

  return (
    <AuthScreen>
      <div className={styles.eyebrow}>Étape {step} sur 2</div>
      <h1 className={styles.title}>{step === 1 ? "Dessinez votre schéma" : "Confirmez votre schéma"}</h1>
      <p className={styles.lead}>
        {step === 1
          ? "Reliez au moins 4 points, dans l'ordre de votre choix."
          : "Tracez de nouveau le même schéma."}
      </p>

      <div className={styles.center}>
        <PatternGrid
          value={points}
          onChange={(next) => {
            setPoints(next);
            setMessage(undefined);
          }}
          disabled={saving || done}
        />
        {message && <Notice tone="error">{message}</Notice>}
        <ErrorLine error={error} onRetry={save} />
        {done && <div className={styles.success}>✓ Schéma enregistré</div>}
        <Button block loading={saving} disabled={points.length === 0 || done} onClick={validate}>
          {step === 1 ? "Continuer" : "Confirmer"}
        </Button>
        <Button block variant="secondary" disabled={points.length === 0 || saving || done} onClick={() => setPoints([])}>
          Effacer le tracé
        </Button>
        {mode === "after_reset" && !done && (
          <Link href="/connexion" className={styles.link}>
            Non merci, me connecter par mot de passe
          </Link>
        )}
      </div>
    </AuthScreen>
  );
}
