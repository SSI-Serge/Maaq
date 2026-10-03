"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useApiQuery } from "@/client/hooks";
import { Loading, Logo, Notice, RetryNotice, Screen, uiStyles } from "@/components/ui";
import type { ExportState } from "@/server/compliance/exports";

/**
 * Page ouverte depuis l'email de l'export (US-55 RF3). Le téléchargement exige d'être connecté (RF6) : l'écran de
 * connexion s'affiche d'abord, et on revient ici ensuite.
 */
export default function ExportDownloadPage() {
  return (
    <Suspense>
      <Download />
    </Suspense>
  );
}

const longDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });

function Download() {
  const id = useSearchParams().get("id");
  const state = useApiQuery<ExportState>("/api/exports");
  const valid = state.data?.status === "ready" && state.data.id === id;

  return (
    <Screen>
      <Logo />
      <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 14 }}>
        <h1 style={{ fontSize: 24 }}>Export de vos données</h1>
        {state.loading && !state.data && <Loading slow={state.slow} />}
        {state.error && !state.data && <RetryNotice message={state.error.message} onRetry={state.reload} />}
        {state.data && valid && (
          <>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
              Votre export est prêt. Il contient un document lisible et vos données dans un format réutilisable.
              {state.data.downloadExpiresAt && <> Le lien est valable jusqu&apos;au {longDate.format(new Date(state.data.downloadExpiresAt))}.</>}
            </p>
            {/* Un lien ordinaire : c'est un fichier à télécharger, pas un écran de l'application. */}
            <a href={`/api/exports/${id}/download`} download="mes-donnees-maaq.zip" className={`${uiStyles.button} ${uiStyles.primary} ${uiStyles.block}`}>
              Télécharger mon export
            </a>
          </>
        )}
        {state.data && !valid && <Notice tone="error">Ce lien de téléchargement n&apos;est plus valable. Demandez un nouvel export depuis les Réglages.</Notice>}
        <Link href="/reglages" style={{ fontSize: 13, fontWeight: 600, color: "var(--secondary-strong)" }}>
          ‹ Retour aux Réglages
        </Link>
      </div>
    </Screen>
  );
}
