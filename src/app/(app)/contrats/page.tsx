"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AgentCard, type DashboardAgent } from "@/components/app/AgentCard";
import { AppShell, appStyles as s } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { ContractsList } from "@/components/contracts/ContractsList";
import { ButtonLink, RetryNotice } from "@/components/ui";

type Tab = "agents" | "contracts";

interface Dashboard {
  max: number;
  tabs: { contracts: DashboardAgent[] };
}

/** Page Contrats : « Agents des Contrats » et « Mes contrats » (US-30), maquettes U-Contrats et I-Contrats. */
export default function ContractsPage() {
  return (
    <Suspense>
      <Contracts />
    </Suspense>
  );
}

function Contracts() {
  const user = useSessionUser();
  const router = useRouter();
  const requested = useSearchParams().get("onglet");
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab: Tab = chosen ?? (requested === "agents" ? "agents" : "contracts");
  const allowed = user.role === "primary_user" || user.guestRank === "core";

  // La page est entièrement masquée aux invités secondaires et à l'administrateur (US-30 RF3).
  useEffect(() => {
    if (!allowed) router.replace("/accueil");
  }, [allowed, router]);
  if (!allowed) return null;

  return (
    <AppShell title="Contrats" subtitle="Vos agents et vos contrats, au même endroit.">
      <div className={s.segments} role="tablist">
        {(
          [
            ["agents", "Agents des Contrats"],
            ["contracts", "Mes contrats"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} role="tab" aria-selected={tab === value} className={`${s.segment} ${tab === value ? s.segmentOn : ""}`} onClick={() => setChosen(value)}>
            {label}
          </button>
        ))}
      </div>
      {/* Chaque onglet ne charge ses données que lorsqu'il est affiché (US-30 RT1). */}
      {tab === "agents" ? <ContractAgents /> : <ContractsList />}
    </AppShell>
  );
}

function ContractAgents() {
  const dashboard = useApiQuery<Dashboard>("/api/dashboard");
  const agents = dashboard.data?.tabs.contracts ?? [];

  return (
    <>
      {dashboard.data && (
        <div className={s.counter}>
          {agents.length}/{dashboard.data.max} agents
        </div>
      )}
      {dashboard.loading && !dashboard.data && (
        <>
          <div className={s.skeleton} aria-hidden />
          <div className={s.skeleton} aria-hidden />
        </>
      )}
      {dashboard.error && !dashboard.data && <RetryNotice message={dashboard.error.message} onRetry={dashboard.reload} />}
      {dashboard.data && agents.length === 0 && (
        <div className={s.empty}>
          <p className={s.text}>Vous n&apos;avez pas encore d&apos;agent des Contrats</p>
          <ButtonLink href="/catalogue?categorie=contracts">Parcourir le catalogue</ButtonLink>
        </div>
      )}
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} origin="/contrats?onglet=agents" onRemoved={dashboard.reload} />
      ))}
      {dashboard.data && agents.length > 0 && (
        <Link href="/catalogue?categorie=contracts" className={s.smallButton}>
          + Ajouter un agent depuis le catalogue
        </Link>
      )}
    </>
  );
}
