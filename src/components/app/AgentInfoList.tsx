"use client";

import Link from "next/link";
import { useApiQuery } from "@/client/hooks";
import { Loading, RetryNotice } from "@/components/ui";
import { appStyles as s } from "./AppShell";

interface AgentInfoStatus {
  agentId: string;
  agentName: string;
  fields: number;
  status: "complete" | "missing" | "none";
}

const STATUS = {
  complete: { label: "Complet", tone: s.ok },
  missing: { label: "Informations manquantes", tone: s.warn },
  none: { label: "Aucune information demandée", tone: s.neutral },
};

/** Informations d'un profil, agent par agent, avec les manques signalés (US-10 RF12-RF13, US-12 RF1). */
export function AgentInfoList({ profileId, emptyText }: { profileId?: string; emptyText: string }) {
  const query = useApiQuery<{ agents: AgentInfoStatus[] }>(`/api/profile/agents${profileId ? `?profil=${profileId}` : ""}`);
  if (query.loading && !query.data) return <Loading slow={query.slow} />;
  if (query.error && !query.data) return <RetryNotice message={query.error.message} onRetry={query.reload} />;
  const agents = query.data?.agents ?? [];
  if (agents.length === 0) return <p className={s.muted}>{emptyText}</p>;
  return (
    <div>
      {agents.map((agent) => (
        <div key={agent.agentId} className={s.agentRow}>
          <div>
            <div className={s.text} style={{ fontWeight: 600 }}>
              {agent.agentName}
            </div>
            <span className={`${s.badge} ${STATUS[agent.status].tone}`}>{STATUS[agent.status].label}</span>
          </div>
          {agent.fields > 0 && (
            <Link href={`/informations/${agent.agentId}${profileId ? `?profil=${profileId}` : ""}`} className={s.smallButton}>
              Modifier
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}
