"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { Section, appStyles as s } from "@/components/app/AppShell";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { Button, Notice } from "@/components/ui";
import type { ExportState } from "@/server/compliance/exports";

const longDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const POLL_MS = 4_000;

/**
 * « Exporter mes données » (US-55) : confirmation décrivant le contenu, une seule demande à la fois, état
 * « Export en cours de préparation », puis lien de téléchargement (aussi envoyé par email).
 */
export function ExportSection() {
  // Relecture passive (?auto non nécessaire : la route GET ne prolonge pas le verrouillage).
  const state = useApiQuery<ExportState>("/api/exports");
  const request = useApiMutation();
  const [asking, setAsking] = useState(false);
  const inProgress = state.data?.inProgress ?? false;
  const { reload } = state;

  // Tant que l'export se prépare, on relit son état : le bouton redevient actif en cas d'échec (RF10).
  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [inProgress, reload]);

  async function confirm() {
    const result = await request.run("/api/exports", { method: "POST" });
    if (result) {
      setAsking(false);
      reload();
    }
  }

  return (
    <Section title="Exporter mes données">
      <p className={s.muted}>Recevez une copie de vos données, sans passer par le support.</p>
      {state.data?.status === "ready" && state.data.id && (
        <Notice tone="success">
          Votre export est prêt{state.data.downloadExpiresAt ? ` (téléchargeable jusqu'au ${longDate.format(new Date(state.data.downloadExpiresAt))})` : ""}.{" "}
          <Link href={`/export?id=${state.data.id}`} style={{ textDecoration: "underline" }}>
            Télécharger ›
          </Link>
        </Notice>
      )}
      {state.data?.status === "failed" && <Notice tone="error">La préparation de votre dernier export a échoué. Vous pouvez renouveler votre demande.</Notice>}
      <ErrorLine error={state.error && !state.data ? state.error : undefined} onRetry={state.reload} />
      {inProgress && (
        <Notice tone="info">Export en cours de préparation. Vous recevrez un email avec le lien de téléchargement — vous pouvez quitter cet écran.</Notice>
      )}
      <Button variant="secondary" block disabled={inProgress || (state.loading && !state.data)} onClick={() => setAsking(true)}>
        {inProgress ? "Export en cours de préparation" : "Exporter mes données"}
      </Button>
      {asking && (
        <ConfirmDialog
          title="Exporter mes données ?"
          text="L'export contiendra vos informations, vos adresses de connecteurs, vos contrats et documents que vous avez renseignés, vos consentements, votre carnet de bord et la liste de vos appareils, au format ZIP (un document lisible et un fichier de données). Il est préparé en quelques minutes ; vous recevrez un email avec un lien de téléchargement valable 7 jours."
          confirmLabel="Demander l'export"
          confirming={request.pending}
          onConfirm={confirm}
          onCancel={() => {
            request.reset();
            setAsking(false);
          }}
        >
          <ErrorLine error={request.error} onRetry={confirm} />
        </ConfirmDialog>
      )}
    </Section>
  );
}
