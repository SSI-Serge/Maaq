"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { appStyles as s } from "@/components/app/AppShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, ButtonLink, Loading, Notice, Screen } from "@/components/ui";

interface Result {
  outcome: "authorized" | "partial" | "denied" | "pending";
  agentId: string;
  agentName: string;
  connector: "google_drive" | "google_calendar";
  email: string;
  emailReplaced: boolean;
  missing: string[];
}

const CANNOT = { google_drive: "accéder à vos documents", google_calendar: "gérer votre agenda" };

/**
 * Retour de la page de consentement Google (US-14 RF3 à RF11) : « Finalisation de la connexion… »,
 * puis le résultat. Sur iPhone, ce retour doit rouvrir l'application installée (à tester sur appareil).
 */
export default function ConnectorReturnPage() {
  return (
    <Suspense>
      <Return />
    </Suspense>
  );
}

function Return() {
  const state = useSearchParams().get("etat") ?? "";
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<ApiError>();
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const finalize = useCallback(
    () =>
      apiRequest<Result>("/api/connectors/finalize", { method: "POST", body: { state }, onSlow: () => setSlow(true) }).then(setResult, (err: unknown) =>
        setError(err as ApiError),
      ),
    [state],
  );

  // Un seul appel par tentative : le résultat d'une autorisation ne se lit qu'une fois en détail
  // (un second appel répondrait « déjà traité » et effacerait, par exemple, l'information de compte remplacé).
  const lastRun = useRef<string | null>(null);
  useEffect(() => {
    const key = `${state}:${attempt}`;
    if (lastRun.current === key) return;
    lastRun.current = key;
    void finalize();
  }, [finalize, state, attempt]);

  /** Relance la lecture du résultat (CC-2, CC-3, ou consentement terminé entre-temps). */
  function retry() {
    setError(undefined);
    setResult(undefined);
    setSlow(false);
    setAttempt((n) => n + 1);
  }

  const back = result ? `/connecteurs?agent=${result.agentId}` : "/connecteurs";

  return (
    <Screen>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>Connexion Google</h1>
      <div className={s.form}>
        {!result && !error && <Loading slow={slow} label="Finalisation de la connexion…" />}
        {error && error.kind !== "rejected" && <ErrorLine error={error} onRetry={retry} />}
        {error?.kind === "rejected" && (
          <>
            <Notice tone="error">{error.message}</Notice>
            <ButtonLink href="/connecteurs" block>
              Retour aux connecteurs
            </ButtonLink>
          </>
        )}

        {result?.outcome === "authorized" && (
          <>
            <Notice tone="success">
              ✓ Connecteur actif — {result.agentName} peut maintenant utiliser {result.connector === "google_calendar" ? "votre Google Agenda" : "votre Google Drive"}.
            </Notice>
            {result.emailReplaced && (
              <Notice tone="info">
                Le compte autorisé sur la page Google (<b>{result.email}</b>) est différent de l&apos;adresse saisie : nous avons enregistré le compte réellement autorisé.
              </Notice>
            )}
          </>
        )}
        {result?.outcome === "denied" && <Notice tone="error">Sans cette autorisation, {result.agentName} ne pourra pas {CANNOT[result.connector]}.</Notice>}
        {result?.outcome === "partial" && (
          <>
            <Notice tone="error">Certaines permissions nécessaires n&apos;ont pas été accordées.</Notice>
            {result.missing.length > 0 && (
              <div className={s.section}>
                <div className={s.sectionTitle}>Permissions manquantes</div>
                {result.missing.map((permission) => (
                  <div key={permission} className={s.listLine}>
                    <span aria-hidden>●</span>
                    <span>{permission}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {result?.outcome === "pending" && (
          <>
            <Notice tone="warning">Autorisation en attente : le consentement n&apos;est pas terminé sur la page Google.</Notice>
            <Button variant="secondary" onClick={retry}>
              Vérifier de nouveau
            </Button>
          </>
        )}
        {result && (
          <ButtonLink href={back} block>
            {result.outcome === "authorized" ? "Continuer" : result.outcome === "pending" ? "Reprendre la connexion" : "Réessayer depuis les connecteurs"}
          </ButtonLink>
        )}
      </div>
    </Screen>
  );
}
