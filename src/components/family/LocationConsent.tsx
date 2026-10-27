"use client";

import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { Section } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { LocationConsentView } from "@/server/assistant/location-consent";
import styles from "./family.module.css";

interface ExplainerProps {
  consent: LocationConsentView;
  onGranted: (consent: LocationConsentView) => void;
  onCancel: () => void;
}

/**
 * Écran d'explication de l'usage de la position (US-107 RF11, CA 11.1) : il s'affiche AVANT la demande d'autorisation du téléphone, qui n'est faite qu'à la première lecture de la position
 * (écran « Suivi du trajet »). « Autoriser » inscrit l'accord de cet appareil, pour la version du texte montrée ici ; « Pas maintenant » ne change rien.
 */
export function LocationConsentExplainer({ consent, onGranted, onCancel }: ExplainerProps) {
  const mutation = useApiMutation();

  async function allow() {
    const result = await mutation.run<{ consent: LocationConsentView }>("/api/family/location-consent", { method: "PUT", body: { noticeVersion: consent.notice.version } });
    if (result) onGranted(result.consent);
  }

  const error = mutation.error;
  return (
    <div className={styles.proposalCard}>
      <div className={styles.proposalTitle}>Utiliser votre position</div>
      <p style={{ margin: 0 }}>{consent.notice.text}</p>
      <div className={styles.hint}>{consent.notice.withdraw}</div>
      <div className={styles.actions}>
        <Button onClick={() => void allow()} loading={mutation.pending}>
          Autoriser
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={mutation.pending}>
          Pas maintenant
        </Button>
      </div>
      {error &&
        (error.body?.code === "notice_changed" ? (
          <Notice tone="info">Le texte d&apos;information a changé : rechargez cet écran pour le relire.</Notice>
        ) : (
          <RetryNotice message={error.kind === "server" ? "L'autorisation n'a pas pu être enregistrée." : error.message} onRetry={() => void allow()} />
        ))}
      {mutation.slow && <Notice tone="info">Toujours en cours…</Notice>}
    </div>
  );
}

/**
 * Carte « Position » des réglages (US-107 RF11, RT5) : l'autorisation est propre à cet appareil et se retire à tout moment ; le retrait efface la dernière position aussitôt.
 */
export function MyPosition() {
  const query = useApiQuery<{ consent: LocationConsentView }>("/api/family/location-consent");
  const [changed, setChanged] = useState<LocationConsentView | null>(null);
  const [asking, setAsking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const withdraw = useApiMutation();
  const consent = changed ?? query.data?.consent ?? null;
  const active = consent?.status === "active";

  async function doWithdraw() {
    const result = await withdraw.run<{ consent: LocationConsentView }>("/api/family/location-consent", { method: "DELETE" });
    if (result) {
      setChanged(result.consent);
      setConfirming(false);
    }
  }

  return (
    <Section title="Position">
      {query.loading && consent === null && <Loading slow={query.slow} />}
      {query.error && consent === null && <RetryNotice message={query.error.kind === "server" ? "L'autorisation de la position n'a pas pu être chargée." : query.error.message} onRetry={query.reload} />}
      {consent && !asking && (
        <>
          <div className={styles.settingRow}>
            <div className={styles.settingType}>Position sur cet appareil</div>
            <span aria-live="polite">{active ? "Autorisée" : "Non autorisée"}</span>
            <span className={styles.hint}>
              {active
                ? "MAAQ ne la lit que lorsque l'application est ouverte, pour estimer votre trajet avant un RDV que vous suivez. Votre dernière position est gardée au plus 3 heures."
                : consent.status === "outdated"
                  ? "Le texte d'information a changé : autorisez à nouveau pour continuer à suivre vos trajets."
                  : "Sans autorisation, le suivi de trajet n'estime pas votre départ depuis votre position. Le téléphone vous demandera aussi son accord à la première utilisation."}
            </span>
          </div>
          {active && !confirming && (
            <Button variant="secondary" onClick={() => setConfirming(true)}>
              Retirer l&apos;autorisation
            </Button>
          )}
          {active && confirming && (
            <Notice tone="info">
              Retirer l&apos;autorisation efface votre dernière position.
              <div className={styles.actions}>
                <Button onClick={() => void doWithdraw()} loading={withdraw.pending}>
                  Retirer
                </Button>
                <Button variant="ghost" onClick={() => setConfirming(false)} disabled={withdraw.pending}>
                  Garder
                </Button>
              </div>
            </Notice>
          )}
          {!active && (
            <Button variant="secondary" onClick={() => setAsking(true)}>
              Autoriser la position…
            </Button>
          )}
          {withdraw.error && <RetryNotice message={withdraw.error.kind === "server" ? "Le retrait n'a pas pu être enregistré." : withdraw.error.message} onRetry={() => void doWithdraw()} />}
        </>
      )}
      {consent && asking && (
        <LocationConsentExplainer
          consent={consent}
          onGranted={(next) => {
            setChanged(next);
            setAsking(false);
          }}
          onCancel={() => setAsking(false)}
        />
      )}
    </Section>
  );
}
