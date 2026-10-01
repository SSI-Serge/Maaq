"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, Section, appStyles as s } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { ButtonLink, RetryNotice } from "@/components/ui";

type Tab = "pro" | "perso";
type Status = "ready" | "to_configure" | "blocked";

interface Agent {
  id: string;
  name: string;
  shortDescription: string;
  status: Status;
  maintenanceMessage: string | null;
}

interface Dashboard {
  max: number;
  tabs: Record<Tab, Agent[]>;
}

const TAB_LABEL: Record<Tab, string> = { pro: "Pro", perso: "Perso" };
const STATUS: Record<Status, { label: string; tone: string }> = {
  ready: { label: "Prêt", tone: s.ok },
  to_configure: { label: "À configurer", tone: s.warn },
  blocked: { label: "Bloqué", tone: s.error },
};
const LAST_TAB_KEY = "maaq:dashboard-tab";

const noSubscription = () => () => {};

function readLastTab(): Tab {
  try {
    return localStorage.getItem(LAST_TAB_KEY) === "perso" ? "perso" : "pro";
  } catch {
    return "pro";
  }
}

/**
 * Dashboard du profil (US-22) : deux onglets Pro et Perso, les agents que le profil a ajoutés dans
 * l'ordre d'ajout, avec leur statut. Après la configuration initiale, on propose d'inviter un proche
 * si personne ne l'est encore (US-11 RF8).
 */
export default function DashboardPage() {
  const user = useSessionUser();
  const dashboard = useApiQuery<Dashboard>("/api/dashboard");
  // Dernier onglet consulté, ou « Pro » à la première ouverture (RF2) ; lu après le rendu serveur.
  const [chosen, setChosen] = useState<Tab | null>(null);
  const remembered = useSyncExternalStore(noSubscription, readLastTab, () => "pro" as Tab);
  const tab = chosen ?? remembered;

  function pick(next: Tab) {
    setChosen(next);
    try {
      localStorage.setItem(LAST_TAB_KEY, next);
    } catch {
      // stockage indisponible : l'onglet reste choisi pour cette session
    }
  }

  const agents = dashboard.data?.tabs[tab] ?? [];
  const max = dashboard.data?.max ?? 10;

  return (
    <AppShell
      title={`Bonjour ${user.firstName}`}
      subtitle={user.role === "guest" ? "Invité" : "Utilisateur principal"}
      action={
        <Link href="/catalogue" className={s.smallButton} style={{ marginTop: 6 }}>
          Catalogue
        </Link>
      }
    >
      {user.role === "primary_user" && <InviteSuggestion />}

      <div className={s.segments} role="tablist">
        {(["pro", "perso"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`${s.segment} ${tab === t ? s.segmentOn : ""}`} onClick={() => pick(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {dashboard.data && (
        <div className={s.counter}>
          {agents.length}/{max} agents
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
          <p className={s.text}>Vous n&apos;avez pas encore d&apos;agent dans cette rubrique</p>
          <ButtonLink href={`/catalogue?categorie=${tab}`}>Parcourir le catalogue</ButtonLink>
        </div>
      )}

      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} onRemoved={dashboard.reload} />
      ))}
    </AppShell>
  );
}

function AgentCard({ agent, onRemoved }: { agent: Agent; onRemoved: () => void }) {
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
        <Link href={`/catalogue/${agent.id}`} className={s.smallButton}>
          Voir la fiche
        </Link>
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

function InviteSuggestion() {
  const guests = useApiQuery<{ guests: unknown[]; quota: number }>("/api/guests");
  if (!guests.data || guests.data.guests.length > 0 || guests.data.quota === 0) return null;
  return (
    <Section title="Invitez un proche">
      <p className={s.text}>
        Votre plan vous permet d&apos;inviter {guests.data.quota} personne{guests.data.quota > 1 ? "s" : ""} à utiliser vos agents avec vous.
      </p>
      <ButtonLink href="/invites" block>
        Ajouter un invité
      </ButtonLink>
    </Section>
  );
}
