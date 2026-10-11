"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { appStyles as s } from "./AppShell";

export type AgentStatus = "ready" | "to_configure" | "blocked";

export interface DashboardAgent {
  id: string;
  name: string;
  shortDescription: string;
  status: AgentStatus;
  maintenanceMessage: string | null;
}

const STATUS: Record<AgentStatus, { label: string; tone: string }> = {
  ready: { label: "Prêt", tone: s.ok },
  to_configure: { label: "À configurer", tone: s.warn },
  blocked: { label: "Bloqué", tone: s.error },
};

/**
 * Carte d'un agent du dashboard ou de l'onglet « Agents des Contrats » (US-22, US-31 RF2). `origin` est
 * l'écran auquel le bouton retour du tchat doit ramener (US-37 RF4).
 */
export function AgentCard({ agent, origin, onRemoved }: { agent: DashboardAgent; origin: string; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const mutation = useApiMutation();
  const status = STATUS[agent.status];

  async function remove() {
    const result = await mutation.run<null>(`/api/dashboard/agents/${agent.id}`, { method: "DELETE" });
    if (result !== undefined) {
      setConfirming(false);
      onRemoved();
    }
  }

  return (
    <article className={s.agentCard}>
      <div className={s.cardActions}>
        <div className={s.agentName}>{agent.name}</div>
        <span className={`${s.badge} ${status.tone}`}>
          <span className={s.dot} aria-hidden />
          {status.label}
        </span>
      </div>
      <p className={s.muted}>{agent.shortDescription}</p>
      {agent.status === "blocked" && <p className={s.muted} style={{ color: "var(--error)" }}>Bloqué par l&apos;administrateur — {(agent.maintenanceMessage ?? "maintenance en cours").replace(/[.\s]+$/, "")}.</p>}
      {agent.status === "to_configure" && <p className={s.muted}>Cet agent n&apos;est pas encore configuré : il manque des éléments pour l&apos;utiliser.</p>}
      <div className={s.cardActions}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link href={`/tchat/${agent.id}?retour=${encodeURIComponent(origin)}`} className={s.smallButton} style={{ background: "var(--primary)", color: "var(--primary-ink)", padding: "7px 12px", borderRadius: 8 }}>
            Ouvrir le tchat
          </Link>
          <Link href={`/catalogue/${agent.id}`} className={s.smallButton}>
            Voir la fiche
          </Link>
          {agent.status === "to_configure" && (
            <Link href={`/connecteurs?agent=${agent.id}`} className={s.smallButton}>
              Configurer
            </Link>
          )}
        </div>
        <button className={`${s.smallButton} ${s.danger}`} onClick={() => setConfirming(true)}>
          Retirer
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={`Retirer ${agent.name} ?`}
          text="Sa configuration et son carnet de bord sont conservés."
          confirmLabel="Retirer"
          confirming={mutation.pending}
          onConfirm={remove}
          onCancel={() => {
            mutation.reset();
            setConfirming(false);
          }}
        >
          <ErrorLine error={mutation.error} onRetry={remove} />
        </ConfirmDialog>
      )}
    </article>
  );
}

