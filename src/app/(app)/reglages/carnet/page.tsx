"use client";

import { useId, useMemo, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { useApiQuery } from "@/client/hooks";
import { AppShell, appStyles as s } from "@/components/app/AppShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, RetryNotice } from "@/components/ui";
import type { EntryType, LogbookAgent, LogbookEntryView, LogbookPage } from "@/server/logbook/service";
import styles from "@/components/settings/settings.module.css";

const TYPE_LABEL: Record<EntryType, string> = {
  request: "Demande",
  action_done: "Action réalisée",
  action_validated: "Action validée",
  action_refused: "Action refusée",
};

const PALETTE = ["#7A2E32", "#5E7048", "#B4913A", "#46618C", "#8A5A83", "#A8502E"];

/** Pastille de couleur propre à chaque personne (maquette Carnet). */
function colorOf(name: string | null): string {
  if (!name) return "#9a8f88";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return PALETTE[hash % PALETTE.length];
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const day = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
  const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(date);
  return `${day} · ${time}`;
}

const normalize = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Carnet de bord d'un agent, en lecture seule (US-40, US-50), maquette Carnet. */
export default function LogbookPage() {
  const agents = useApiQuery<{ agents: LogbookAgent[] }>("/api/logbook");
  const [chosen, setChosen] = useState<string | null>(null);
  const list = agents.data?.agents ?? [];
  // Par défaut, le premier agent par ordre alphabétique (US-50 RF2).
  const selected = list.find((a) => a.id === chosen) ?? list[0];

  return (
    <AppShell title="Carnet de bord" back={{ href: "/reglages", label: "Réglages" }}>
      <p className={s.muted}>Demandes et actions partagées entre vous et votre invité, pour un agent donné. Historique conservé 14 mois, même si l&apos;agent est retiré d&apos;un dashboard.</p>
      {agents.loading && !agents.data && <Loading slow={agents.slow} />}
      {agents.error && !agents.data && <RetryNotice message={agents.error.message} onRetry={agents.reload} />}
      {agents.data && list.length === 0 && <p className={s.text}>Aucun carnet disponible pour le moment</p>}
      {selected && (
        <>
          <AgentPicker agents={list} selected={selected} onPick={setChosen} />
          <Entries key={selected.id} agent={selected} />
        </>
      )}
    </AppShell>
  );
}

/** Liste déroulante dans laquelle on peut aussi saisir le nom de l'agent pour le trouver plus vite (US-40, maquette). */
function AgentPicker({ agents, selected, onPick }: { agents: LogbookAgent[]; selected: LogbookAgent; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const listId = useId();
  const typed = query ?? selected.name;
  const options = useMemo(() => (query ? agents.filter((a) => normalize(a.name).includes(normalize(query))) : agents), [agents, query]);

  return (
    <div className={styles.picker}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Agent"
        className={styles.pickerInput}
        value={typed}
        placeholder="Choisir un agent…"
        onFocus={(event) => {
          setOpen(true);
          event.target.select();
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onBlur={() => {
          // Laisse le temps au clic sur une option avant de refermer.
          setTimeout(() => {
            setOpen(false);
            setQuery(null);
          }, 150);
        }}
      />
      {open && (
        <div id={listId} role="listbox" className={styles.pickerList}>
          {options.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="option"
              aria-selected={agent.id === selected.id}
              className={styles.pickerOption}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onPick(agent.id);
                setQuery(null);
                setOpen(false);
              }}
            >
              {agent.name}
            </button>
          ))}
          {options.length === 0 && <div className={styles.pickerEmpty}>Aucun agent ne correspond.</div>}
        </div>
      )}
    </div>
  );
}

function Entries({ agent }: { agent: LogbookAgent }) {
  const first = useApiQuery<LogbookPage>(`/api/logbook/entries?agent=${agent.id}`);
  // Pages supplémentaires, valables tant que la première page n'a pas été relue.
  const [loaded, setMore] = useState<{ base: LogbookPage; entries: LogbookEntryView[]; hasMore: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<ApiError>();

  const base = first.data;
  const more = loaded && loaded.base === base ? loaded : null;

  const entries = [...(base?.entries ?? []), ...(more?.entries ?? [])];
  const hasMore = more ? more.hasMore : (base?.hasMore ?? false);

  async function loadMore() {
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await apiRequest<LogbookPage>(`/api/logbook/entries?agent=${agent.id}&offset=${entries.length}`);
      setMore({ base: base!, entries: [...(more?.entries ?? []), ...page.entries], hasMore: page.hasMore });
    } catch (error) {
      setMoreError(error instanceof ApiError ? error : new ApiError("server", String(error)));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      {base && (
        <div className={s.muted}>
          {base.lastSyncAt
            ? `Dernière mise à jour : ${new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }).format(new Date(base.lastSyncAt))} à ${new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(base.lastSyncAt))}. Les demandes récentes peuvent ne pas encore apparaître.`
            : "Pas encore de mise à jour. Les demandes récentes peuvent ne pas encore apparaître."}
        </div>
      )}
      {first.loading && !base && <Loading slow={first.slow} />}
      {first.error && !base && <RetryNotice message={first.error.message} onRetry={first.reload} />}
      {base && entries.length === 0 && (
        <div className={styles.empty}>
          <p className={s.muted}>Aucune entrée pour cet agent pour le moment. Les demandes apparaissent ici après la prochaine mise à jour.</p>
          <Button variant="secondary" onClick={first.reload}>
            Réessayer
          </Button>
        </div>
      )}
      {entries.map((entry) => (
        <article key={entry.id} className={styles.entry} style={{ borderLeftColor: colorOf(entry.authorFirstName) }}>
          <div className={styles.entryHead}>
            <span className={styles.entryWho}>
              {entry.authorFirstName ?? "Invité supprimé"} <span className={s.muted}>— {TYPE_LABEL[entry.type]}</span>
            </span>
            <time className={styles.entryTime} dateTime={entry.occurredAt}>
              {formatStamp(entry.occurredAt)}
            </time>
          </div>
          <div className={s.text}>{entry.summary}</div>
          {entry.result && <div className={s.muted}>{entry.result}</div>}
        </article>
      ))}
      <ErrorLine error={moreError} onRetry={loadMore} />
      {hasMore && (
        <Button variant="secondary" loading={loadingMore} onClick={loadMore}>
          Voir plus
        </Button>
      )}
    </>
  );
}
