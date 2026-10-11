"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { ErrorLine } from "@/components/auth/parts";
import type { ChatItem } from "@/server/chat/service";
import styles from "./chat.module.css";

type ActionItem = Extract<ChatItem, { kind: "action" }>;

/** Au-delà, on prévient que l'exécution prend plus de temps que prévu (US-39 RF9). */
const SLOW_EXECUTION_MS = 60_000;

const DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

/**
 * Carte d'une action proposée par l'agent (US-39) : « Valider » / « Refuser », puis le résultat.
 * Les boutons sont inactifs tant que l'agent est bloqué (US-42 RF3).
 */
export function ActionCard({
  agentId,
  item,
  blocked,
  serverNow,
  onChanged,
}: {
  agentId: string;
  item: ActionItem;
  blocked: boolean;
  serverNow: number;
  onChanged: () => void;
}) {
  const { proposal } = item;
  const decide = useApiMutation();
  const [local, setLocal] = useState<ActionItem["proposal"]["status"] | null>(null);
  const status = proposal.status !== "pending" ? proposal.status : (local ?? "pending");
  const isEmail = proposal.kind === "email";
  const slow = status === "executing" && item.decidedAt !== null && serverNow - Date.parse(item.decidedAt) > SLOW_EXECUTION_MS;

  async function send(decision: "validate" | "refuse") {
    const result = await decide.run<{ proposal: ActionItem["proposal"] }>(`/api/chat/${agentId}/actions`, {
      method: "POST",
      body: { proposalId: proposal.proposalId, decision },
    });
    if (!result) return;
    setLocal(result.proposal.status);
    onChanged();
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>{status === "pending" ? "Action proposée — validation requise" : "Action proposée"}</div>
      {isEmail ? (
        <>
          {proposal.subject && (
            <>
              <div className={styles.cardKey}>Objet</div>
              <div className={styles.cardText}>{proposal.subject}</div>
            </>
          )}
          <div className={styles.cardKey}>Destinataire</div>
          <div className={styles.cardText}>{proposal.recipient}</div>
          {proposal.draftPreview && (
            <>
              <div className={styles.cardKey}>Aperçu du brouillon</div>
              <div className={styles.draft}>« {proposal.draftPreview} »</div>
            </>
          )}
          <p className={styles.cardNote}>Ce brouillon a aussi été envoyé dans votre boîte de validation. L&apos;envoi réel n&apos;a lieu qu&apos;après votre accord.</p>
        </>
      ) : (
        <>
          <div className={styles.cardText}>{proposal.summary}</div>
          {proposal.when && (
            <div className={styles.cardText}>
              <b>Quand :</b> {DATE_FORMAT.format(new Date(proposal.when))}
            </div>
          )}
          {proposal.place && (
            <div className={styles.cardText}>
              <b>Lieu :</b> {proposal.place}
            </div>
          )}
          {proposal.participants.length > 0 && (
            <div className={styles.cardText}>
              <b>Participants :</b> {proposal.participants.join(", ")}
            </div>
          )}
        </>
      )}

      {status === "pending" && (
        <>
          {blocked && <p className={styles.cardNote}>Cet agent est en maintenance : vous pourrez décider dès sa remise en service.</p>}
          <ErrorLine error={decide.error} />
          <div className={styles.buttons}>
            <button type="button" className={styles.primary} disabled={blocked || decide.pending} onClick={() => send("validate")}>
              {isEmail ? "Valider l'envoi" : "Valider"}
            </button>
            <button type="button" className={styles.secondary} disabled={blocked || decide.pending} onClick={() => send("refuse")}>
              Refuser
            </button>
          </div>
        </>
      )}
      {status === "executing" && (
        <div className={`${styles.notice} ${slow ? styles.noticeWarning : styles.noticeNeutral}`} role="status">
          {slow ? "L'exécution prend plus de temps que prévu. Le résultat apparaîtra ici." : "Exécution en cours…"}
        </div>
      )}
      {status === "succeeded" && (
        <div className={`${styles.notice} ${styles.noticeSuccess}`} role="status">
          {isEmail ? "✓ Email envoyé" : "✓ Rendez-vous créé"}
        </div>
      )}
      {status === "failed" && (
        <div className={`${styles.notice} ${styles.noticeError}`} role="alert">
          L&apos;action n&apos;a pas pu être exécutée.
        </div>
      )}
      {status === "refused" && (
        <div className={`${styles.notice} ${styles.noticeWarning}`} role="status">
          Action refusée — rien n&apos;a été fait.
        </div>
      )}
      {status === "abandoned" && (
        <div className={`${styles.notice} ${styles.noticeNeutral}`} role="status">
          Action abandonnée.
        </div>
      )}
    </div>
  );
}
