"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { onUploadDone, useUploads } from "@/client/uploads";
import { AgentCard, type DashboardAgent } from "@/components/app/AgentCard";
import { AppShell, appStyles as s } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { ContractCard } from "@/components/contracts/ContractCard";
import styles from "@/components/contracts/contracts.module.css";
import { ButtonLink, Loading, RetryNotice } from "@/components/ui";
import type { ContractView, ContractsView } from "@/server/contracts/service";

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
      {tab === "agents" ? <ContractAgents /> : <MyContracts />}
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

const POLL_MS = 3_000;

function MyContracts() {
  const user = useSessionUser();
  // Relecture passive (?auto=1) : elle ne prolonge pas le déverrouillage de l'application (US-52).
  const query = useApiQuery<ContractsView>("/api/contracts?auto=1");
  const uploads = useUploads();
  const { reload } = query;
  // Contrats renvoyés par une action, valables jusqu'à la prochaine lecture du serveur.
  const [overrides, setOverrides] = useState<{ base: ContractsView | undefined; byId: Record<string, ContractView> }>({ base: undefined, byId: {} });
  const view = query.data;

  const pendingDocuments = view?.contracts.some((c) => c.documents.some((d) => d.status === "pending")) ?? false;
  const uploading = uploads.some((u) => u.state === "uploading");

  // Les pastilles « Classement en cours » évoluent seules ; un envoi terminé met la liste à jour (US-34 RF10, RF13).
  useEffect(() => {
    if (!pendingDocuments && !uploading) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [pendingDocuments, uploading, reload]);
  useEffect(() => onUploadDone(() => reload()), [reload]);

  if (query.loading && !view) {
    return (
      <>
        <div className={s.skeleton} aria-hidden />
        <div className={s.skeleton} aria-hidden />
        <div className={s.skeleton} aria-hidden />
        {query.slow && <Loading slow />}
      </>
    );
  }
  if (query.error && !view) return <RetryNotice message={query.error.message} onRetry={query.reload} />;
  if (!view) return null;

  const byId = overrides.base === view ? overrides.byId : {};
  const contracts = view.contracts.map((c) => byId[c.id] ?? c);

  return (
    <>
      <p className={styles.hint}>
        Liste fixe définie par MAAQ. Ces contrats sont partagés avec {user.role === "primary_user" ? "votre invité 1" : "l'utilisateur principal"}. Chacun peut renseigner et modifier les détails.
      </p>

      {!view.drive.connected && (
        <div className={styles.banner}>
          <div className={styles.bannerTitle}>Google Drive non connecté</div>
          {view.drive.canConnect ? (
            <>
              <span>Connectez le Google Drive du compte pour que les agents puissent y classer les documents de vos contrats.</span>
              <ButtonLink href={view.drive.connectAgentId ? `/connecteurs?agent=${view.drive.connectAgentId}` : "/connecteurs"}>Connecter mon Google Drive</ButtonLink>
            </>
          ) : (
            <span>{view.drive.primaryFirstName} doit connecter son Google Drive pour classer les documents.</span>
          )}
        </div>
      )}

      {contracts.length === 0 && <p className={s.muted}>Aucun contrat n&apos;est suivi pour le moment</p>}
      {contracts.map((contract) => (
        <ContractCard
          key={contract.id}
          contract={contract}
          consentText={view.consentText}
          primaryFirstName={view.drive.primaryFirstName}
          limits={view.limits}
          uploads={uploads}
          onChanged={(updated) => setOverrides({ base: view, byId: { ...byId, [updated.id]: updated } })}
        />
      ))}

      <p className={styles.hint}>Le consentement est désactivé par défaut. Il ne concerne que le challenge par MAAQ : aucune restitution n&apos;est prévue dans cette version.</p>
    </>
  );
}
