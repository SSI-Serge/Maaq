"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { Button, Notice } from "@/components/ui";
import type { ContractView, ContractsView } from "@/server/contracts/service";
import { frDate } from "./ContractParts";
import styles from "./contracts.module.css";

const frDateTime = (value: string) => `${new Date(value).toLocaleDateString("fr-FR")} à ${new Date(value).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * Transmission des documents (US-129, US-130, US-134, US-135) : ce qui va partir, le bouton « Transmettre », la proposition d'activer l'autre canal avec son consentement,
 * l'état de chaque canal après l'envoi, « Relancer l'analyse » et « Renvoyer ». L'écran ne décide rien : il suit le plan du serveur (`contract.transmit`).
 */
export function TransmitArea({ contract, view, archived, onChanged }: { contract: ContractView; view: ContractsView; archived: boolean; onChanged: (c: ContractView) => void }) {
  const plan = contract.transmit;
  const t = contract.transmission;
  const [step, setStep] = useState<"ask" | "consent" | null>(null);
  const send = useApiMutation();
  const relaunch = useApiMutation();
  const documentsLeft = contract.slots.some((s) => s.document);
  const locked = contract.slots.some((s) => s.document?.locked);

  async function transmit(extra?: "analysis" | "challenge") {
    if (extra) {
      // « Oui, aussi … » : le consentement du canal est donné (et reste, durablement), puis la transmission part pour les deux (US-130 RF2).
      const consent = await send.run<ContractView>(`/api/contracts/${contract.id}/consent`, { method: "POST", body: { channel: extra, enabled: true, accepted: true } });
      if (!consent) return;
      onChanged(consent);
    }
    const result = await send.run<ContractView>(`/api/contracts/${contract.id}/transmit`, { method: "POST" });
    if (result) {
      setStep(null);
      onChanged(result);
    }
  }

  async function again(channel: "analysis" | "challenge") {
    const result = await relaunch.run<ContractView>(`/api/contracts/${contract.id}/relaunch`, { method: "POST", body: { channel } });
    if (result) onChanged(result);
  }

  if (contract.slots.length === 0 || archived) return null;
  const other = plan.offer;
  const consentText = other === "analysis" ? view.analysis.text.replace("Les documents de ce contrat", `Les documents de ${contract.name}`) : view.challenge.text.replace("[nom du contrat]", contract.name);
  const failedDeleted = t && !documentsLeft && (t.analysisStatus === "failed" || t.analysisStatus === "cancelled" || t.challengeStatus === "failed");

  return (
    <div className={styles.transmit}>
      {!plan.alreadyTransmitted && (
        <>
          <div className={styles.docMeta}>{contract.missingRequired > 0 ? plural(contract.missingRequired, "document obligatoire manquant", "documents obligatoires manquants") : plan.line}</div>
          {plan.analysisBlockers.map((reason) => (
            <div key={reason} className={styles.hint}>
              {reason}
            </div>
          ))}
          {plan.skipped.length > 0 && <div className={styles.hint}>{plan.skipped.map((name) => `Le document ${name} était illisible : il ne sera pas analysé.`).join(" ")}</div>}
          {plan.needsAdmin && <div className={styles.hint}>La lecture d&apos;un document est incertaine : l&apos;analyse attendra la vérification de MAAQ.</div>}
          <Button loading={send.pending && step === null} disabled={!plan.ready || send.pending} onClick={() => (other ? setStep("ask") : void transmit())}>
            Transmettre
          </Button>
          {step === null && <ErrorLine error={send.error} onRetry={() => transmit()} />}
        </>
      )}

      {t && locked && (
        <Notice tone="success">
          Documents transmis. Ils seront supprimés le {frDateTime(t.documentsDeletedAt)}.
        </Notice>
      )}
      {t?.challengeStatus === "sending" && <div className={styles.docMeta}>Envoi au challenge en cours…</div>}
      {t?.challengeStatus === "sent" && <div className={styles.docMeta}>Envoyé au challenge le {frDate(t.at)}</div>}
      {t?.forChallenge && view.challenge.simulated && <div className={styles.hint}>Essai : vos documents n&apos;ont été envoyés à aucun courtier. Dans la version finale, ils partiront chez notre partenaire.</div>}
      {t?.challengeStatus === "failed" && documentsLeft && (
        <div className={styles.channel}>
          <div className={styles.error}>L&apos;envoi au challenge a échoué.</div>
          <Button variant="secondary" loading={relaunch.pending} onClick={() => again("challenge")}>
            Renvoyer
          </Button>
        </div>
      )}
      {t?.analysisStatus === "running" && <div className={styles.docMeta}>Analyse en cours…</div>}
      {t?.analysisStatus === "awaiting_admin" && <div className={styles.docMeta}>En cours de vérification par MAAQ.</div>}
      {t?.analysisStatus === "cancelled" && documentsLeft && <div className={styles.hint}>La lecture de vos documents n&apos;était pas assez fiable pour les analyser. Déposez une photo plus nette pour relancer.</div>}
      {t?.analysisStatus === "failed" && documentsLeft && (
        <div className={styles.channel}>
          <div className={styles.error}>L&apos;analyse a échoué.</div>
          <Button variant="secondary" loading={relaunch.pending} onClick={() => again("analysis")}>
            Relancer l&apos;analyse
          </Button>
        </div>
      )}
      {failedDeleted && <div className={styles.hint}>Documents supprimés : déposez-les à nouveau pour relancer.</div>}
      <ErrorLine error={relaunch.error} />

      {step === "ask" && other && (
        <ConfirmDialog
          title={other === "challenge" ? "Faire aussi challenger ce contrat ?" : "Faire aussi analyser ce contrat ?"}
          text={`Voulez-vous aussi ${other === "challenge" ? "faire challenger" : "faire analyser"} ${contract.name} avec ces documents ?`}
          confirmLabel={`Oui, aussi ${other === "challenge" ? "le challenge" : "l'analyse"}`}
          cancelLabel={`Non, seulement ${other === "challenge" ? "l'analyse" : "le challenge"}`}
          confirming={send.pending}
          onConfirm={() => setStep("consent")}
          // « Non » : la transmission part avec le seul canal actif, la proposition reviendra à la prochaine transmission (US-130 RF3). Fermer la fenêtre n'envoie rien.
          onDecline={() => void transmit()}
          onCancel={() => setStep(null)}
        />
      )}
      {step === "consent" && other && (
        <ConfirmDialog
          title={other === "analysis" ? "Analyse IA du contrat" : "Challenge du contrat"}
          text={consentText}
          confirmLabel="J'accepte"
          confirming={send.pending}
          onConfirm={() => transmit(other)}
          // Refuser le consentement ramène à la question : « Non, seulement … » reste un choix explicite (US-130 RF4), rien ne part par accident.
          onCancel={() => {
            send.reset();
            setStep("ask");
          }}
        >
          <ErrorLine error={send.error} onRetry={() => transmit(other)} />
        </ConfirmDialog>
      )}
    </div>
  );
}
