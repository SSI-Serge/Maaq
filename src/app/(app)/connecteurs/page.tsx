"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell, appStyles as s } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { CcSection } from "@/components/connectors/CcSection";
import { GoogleCard } from "@/components/connectors/GoogleCard";
import { MailboxCard } from "@/components/connectors/MailboxCard";
import type { Overview } from "@/components/connectors/types";
import { Loading, RetryNotice } from "@/components/ui";

/** Connecteurs des agents du profil, un onglet par agent (US-13 à US-17, US-67), maquettes Connecteurs. */
export default function ConnectorsPage() {
  return (
    <Suspense>
      <Connectors />
    </Suspense>
  );
}

function Connectors() {
  const user = useSessionUser();
  const requested = useSearchParams().get("agent");
  const overview = useApiQuery<Overview>("/api/connectors");
  const [chosen, setChosen] = useState<string | null>(null);

  const agents = overview.data?.agents ?? [];
  const selected = agents.find((a) => a.agentId === (chosen ?? requested)) ?? agents[0];

  return (
    <AppShell
      title="Connecteurs des agents"
      back={{ href: "/reglages", label: "Réglages" }}
      subtitle="Propres à chaque agent, en complément de vos informations générales. Vous connectez vos propres comptes Google : les autres profils connectent les leurs séparément."
    >
      {overview.loading && !overview.data && <Loading slow={overview.slow} />}
      {overview.error && !overview.data && <RetryNotice message={overview.error.message} onRetry={overview.reload} />}

      {overview.data && agents.length === 0 && (
        <p className={s.muted}>
          Aucun de vos agents n&apos;a besoin d&apos;un connecteur pour l&apos;instant. Quand vous en ajouterez un qui en demande, il apparaîtra ici.
        </p>
      )}

      {agents.length > 0 && (
        <div className={s.segments} role="tablist" style={{ overflowX: "auto" }}>
          {agents.map((agent) => (
            <button
              key={agent.agentId}
              role="tab"
              aria-selected={selected?.agentId === agent.agentId}
              className={`${s.segment} ${selected?.agentId === agent.agentId ? s.segmentOn : ""}`}
              style={{ whiteSpace: "nowrap", padding: "9px 12px" }}
              onClick={() => setChosen(agent.agentId)}
            >
              {agent.name}
            </button>
          ))}
        </div>
      )}

      {selected && overview.data && (
        <div key={selected.agentId} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {selected.connectors.map((connector) =>
            connector.kind === "mailbox" ? (
              <MailboxCard key={connector.code} agent={{ id: selected.agentId, name: selected.name }} connector={connector} onChanged={overview.reload} />
            ) : (
              <GoogleCard
                key={connector.code}
                agent={{ id: selected.agentId, name: selected.name }}
                connector={connector}
                suggestedEmail={overview.data!.suggestedEmail}
                onChanged={overview.reload}
              />
            ),
          )}
          {selected.cc && <CcSection agentId={selected.agentId} cc={selected.cc} isPrimary={user.role === "primary_user"} onChanged={overview.reload} />}
        </div>
      )}
    </AppShell>
  );
}
