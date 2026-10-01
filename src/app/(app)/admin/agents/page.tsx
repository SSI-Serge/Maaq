"use client";

import { useState } from "react";
import { useApiMutation, useApiQuery, useDebounced } from "@/client/hooks";
import { AdminDialog, PageHead, adminStyles as s, formatDate } from "@/components/admin/AdminShell";
import { PublishAgentForm } from "@/components/admin/PublishAgentForm";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice } from "@/components/ui";

interface Agent {
  id: string;
  name: string;
  categoryLabel: string;
  shortDescription: string;
  status: "available" | "blocked";
  maintenanceMessage: string | null;
  blockedAt: string | null;
  blockedBy: string | null;
}

/** Administration des agents : publication, blocage, réactivation (US-45, US-46, US-47). */
export default function AdminAgentsPage() {
  const [search, setSearch] = useState("");
  const query = useDebounced(search);
  const agents = useApiQuery<{ agents: Agent[] }>(`/api/admin/agents?q=${encodeURIComponent(query)}`);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<Agent | null>(null);
  const [reactivating, setReactivating] = useState<Agent | null>(null);

  return (
    <>
      <PageHead
        title="Agents IA"
        lead="Mettez un agent à disposition dans le catalogue (rubrique Pro, Perso ou Agents des Contrats), ou bloquez-en l'accès le temps d'une maintenance."
        action={
          !publishing && (
            <Button
              onClick={() => {
                setPublished(null);
                setPublishing(true);
              }}
            >
              + Mettre à disposition un agent
            </Button>
          )
        }
      />

      {published && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="success">
            ✓ Agent ajouté au catalogue, rubrique {published} — utilisateurs et invités peuvent l&apos;ajouter à leur dashboard
          </Notice>
        </div>
      )}

      {publishing && (
        <PublishAgentForm
          onCancel={() => setPublishing(false)}
          onPublished={(categoryLabel) => {
            setPublishing(false);
            setPublished(categoryLabel);
            agents.reload();
          }}
        />
      )}

      <input
        className={s.search}
        type="search"
        placeholder="Rechercher un agent (nom, description, rubrique)…"
        aria-label="Rechercher un agent"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {agents.loading && !agents.data && <Loading slow={agents.slow} />}
      <ErrorLine error={agents.error} onRetry={agents.reload} />

      {agents.data && (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Rubrique</th>
              <th>Statut</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {agents.data.agents.map((agent) => (
              <tr key={agent.id}>
                <td>
                  <div style={{ fontWeight: 700 }}>{agent.name}</div>
                  <div className={`${s.muted} ${s.small}`}>{agent.shortDescription}</div>
                  {agent.status === "blocked" && (
                    <div className={s.small} style={{ marginTop: 6, color: "var(--error)" }}>
                      « {agent.maintenanceMessage} » — bloqué par {agent.blockedBy}, le {formatDate(agent.blockedAt!)}
                    </div>
                  )}
                </td>
                <td>{agent.categoryLabel}</td>
                <td>
                  <span className={`${s.badge} ${agent.status === "available" ? s.badgeOk : s.badgeError}`}>
                    {agent.status === "available" ? "Disponible" : "Bloqué"}
                  </span>
                </td>
                <td className={s.cellRight}>
                  {agent.status === "available" ? (
                    <Button variant="secondary" onClick={() => setBlocking(agent)}>
                      Bloquer
                    </Button>
                  ) : (
                    <Button onClick={() => setReactivating(agent)}>Réactiver</Button>
                  )}
                </td>
              </tr>
            ))}
            {agents.data.agents.length === 0 && (
              <tr>
                <td colSpan={4} className={s.empty}>
                  {query ? "Aucun agent ne correspond à cette recherche." : "Aucun agent publié pour l'instant."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {blocking && (
        <BlockDialog
          agent={blocking}
          onClose={() => setBlocking(null)}
          onDone={() => {
            setBlocking(null);
            agents.reload();
          }}
        />
      )}
      {reactivating && (
        <ReactivateDialog
          agent={reactivating}
          onClose={() => setReactivating(null)}
          onDone={() => {
            setReactivating(null);
            agents.reload();
          }}
        />
      )}
    </>
  );
}

/** Message de maintenance obligatoire, 200 caractères au maximum (US-46 RF2). */
function BlockDialog({ agent, onClose, onDone }: { agent: Agent; onClose: () => void; onDone: () => void }) {
  const [message, setMessage] = useState("");
  const mutation = useApiMutation();

  async function confirm() {
    const ok = await mutation.run<null>(`/api/admin/agents/${agent.id}/block`, { method: "POST", body: { message: message.trim() } });
    if (ok !== undefined) onDone();
  }

  return (
    <AdminDialog title={`Bloquer ${agent.name} pour maintenance`} onClose={() => !mutation.pending && onClose()}>
      <label className={s.label} htmlFor="maintenance">
        Message affiché aux utilisateurs et invités pendant le blocage
      </label>
      <textarea
        id="maintenance"
        className={s.textarea}
        maxLength={200}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Ex. Maintenance en cours, retour prévu demain matin."
      />
      <div className={`${s.small} ${s.muted}`} style={{ textAlign: "right" }}>
        {message.length} / 200
      </div>
      <ErrorLine error={mutation.error} onRetry={confirm} />
      <div className={s.actions}>
        <Button variant="secondary" disabled={mutation.pending} onClick={onClose}>
          Annuler
        </Button>
        <Button variant="danger" loading={mutation.pending} disabled={!message.trim()} onClick={confirm}>
          Bloquer
        </Button>
      </div>
    </AdminDialog>
  );
}

/** Confirmation « Réactiver [agent] pour tous les utilisateurs ? » (US-47 RF2). */
function ReactivateDialog({ agent, onClose, onDone }: { agent: Agent; onClose: () => void; onDone: () => void }) {
  const mutation = useApiMutation();
  async function confirm() {
    const ok = await mutation.run<null>(`/api/admin/agents/${agent.id}/reactivate`, { method: "POST" });
    if (ok !== undefined) onDone();
  }
  return (
    <AdminDialog title={`Réactiver ${agent.name} pour tous les utilisateurs ?`} onClose={() => !mutation.pending && onClose()}>
      <p className={s.pageLead}>Le message de maintenance sera effacé et l&apos;agent de nouveau utilisable, sans action des utilisateurs.</p>
      <ErrorLine error={mutation.error} onRetry={confirm} />
      <div className={s.actions}>
        <Button variant="secondary" disabled={mutation.pending} onClick={onClose}>
          Annuler
        </Button>
        <Button loading={mutation.pending} onClick={confirm}>
          Réactiver
        </Button>
      </div>
    </AdminDialog>
  );
}
