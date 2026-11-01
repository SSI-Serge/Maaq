"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import type { ContractView, ContractsView } from "@/server/contracts/service";
import styles from "./contracts.module.css";

export const frDate = (value: string) => new Date(value).toLocaleDateString("fr-FR");
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Ce que dit la pastille d'état d'un contrat (US-126 RF5, US-129 RF4, US-132 RF5, US-135) : la plus parlante d'abord. */
export function contractState(contract: ContractView, archived: boolean): { label: string; tone: "ok" | "info" | "warn" | "muted" } {
  const t = contract.transmission;
  if (t?.analysisStatus === "running") return { label: "Analyse en cours", tone: "info" };
  if (t?.analysisStatus === "awaiting_admin") return { label: "En cours de vérification par MAAQ", tone: "info" };
  if (t?.analysisStatus === "failed") return { label: "L'analyse a échoué", tone: "warn" };
  if (t?.challengeStatus === "failed") return { label: "L'envoi au challenge a échoué", tone: "warn" };
  if (t?.challengeStatus === "sending") return { label: "Envoi au challenge en cours", tone: "info" };
  if (contract.reportAt) return { label: `Rapport du ${frDate(contract.reportAt)}`, tone: "ok" };
  if (t && t.challengeStatus === "sent") return { label: `Envoyé au challenge le ${frDate(t.at)}`, tone: "ok" };
  if (archived) return { label: contract.filled ? "Renseigné" : "Non renseigné", tone: "muted" };
  if (contract.slots.length === 0) return { label: contract.filled ? "Renseigné" : "Non renseigné", tone: "muted" };
  if (contract.missingRequired > 0) return { label: `${plural(contract.missingRequired, "document obligatoire manquant", "documents obligatoires manquants")}`, tone: "muted" };
  return { label: "Prêt à transmettre", tone: "ok" };
}

export const TONE_CLASS = { ok: styles.pillOk, info: styles.pillPending, warn: styles.pillFailed, muted: styles.pillMuted } as const;

/**
 * Interrupteur « Analyse IA » ou « Challenge » d'un contrat (US-127, US-128) : désactivé par défaut, durable, partagé par le noyau. L'activation passe par le texte de
 * consentement (preuve journalisée avec sa version) ; la désactivation est immédiate. L'analyse reste inactive tant que le mode d'analyse est « off » ; le challenge, tant que
 * le courtier n'est pas désigné.
 */
export function ChannelSwitch({
  contract,
  channel,
  view,
  archived,
  onChanged,
}: {
  contract: ContractView;
  channel: "analysis" | "challenge";
  view: ContractsView;
  archived: boolean;
  onChanged: (contract: ContractView) => void;
}) {
  const info = channel === "analysis" ? contract.analysis : contract.challenge;
  const label = channel === "analysis" ? "Analyse IA" : "Challenge";
  const closed = channel === "analysis" ? view.analysis.mode === "off" : !view.challenge.available;
  const note =
    channel === "analysis"
      ? view.analysis.mode === "off"
        ? "L'analyse IA n'est pas encore ouverte."
        : view.analysis.mode === "preview"
          ? "Mode d'essai : le masquage et l'aperçu fonctionnent, aucun document n'est envoyé au service d'IA."
          : null
      : view.challenge.available
        ? null
        : "Le challenge sera disponible quand notre partenaire courtier sera désigné.";
  const [asking, setAsking] = useState(false);
  const mutation = useApiMutation();
  const text = channel === "analysis" ? view.analysis.text.replace("Les documents de ce contrat", `Les documents de ${contract.name}`) : view.challenge.text.replace("[nom du contrat]", contract.name);

  async function change(enabled: boolean, accepted?: boolean) {
    const result = await mutation.run<ContractView>(`/api/contracts/${contract.id}/consent`, { method: "POST", body: { channel, enabled, accepted } });
    if (result) {
      setAsking(false);
      onChanged(result);
    }
  }

  return (
    <div className={styles.channel}>
      <div className={styles.channelHead}>
        <span className={styles.channelName}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={info.enabled}
          aria-label={`${label} du contrat ${contract.name}`}
          className={styles.switch}
          disabled={mutation.pending || (closed && !info.enabled) || (archived && !info.enabled)}
          onClick={() => (info.enabled ? change(false) : setAsking(true))}
        >
          <span className={styles.knob} />
        </button>
      </div>
      {info.at && (
        <div className={styles.audit}>
          {info.enabled ? "Activé" : "Désactivé"} par {info.byFirstName ?? "un profil supprimé"} le {frDate(info.at)}
        </div>
      )}
      {note && !info.enabled && <div className={styles.hint}>{note}</div>}
      {!asking && <ErrorLine error={mutation.error} onRetry={() => change(false)} />}
      {asking && (
        <ConfirmDialog
          title={channel === "analysis" ? "Analyse IA du contrat" : "Challenge du contrat"}
          text={text}
          confirmLabel="J'accepte"
          confirming={mutation.pending}
          onConfirm={() => change(true, true)}
          onCancel={() => {
            mutation.reset();
            setAsking(false);
          }}
        >
          <ErrorLine error={mutation.error} onRetry={() => change(true, true)} />
        </ConfirmDialog>
      )}
    </div>
  );
}
