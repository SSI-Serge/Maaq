"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { PageHead, adminStyles as s } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice } from "@/components/ui";

interface Contract {
  id: string;
  name: string;
  accounts: number;
}

const accountsLabel = (n: number) => (n === 0 ? "aucun compte" : n === 1 ? "1 compte" : `${n} comptes`);

/** Liste des contrats obligatoires, commune à tous les clients (US-48 RF1 à RF9). */
export default function AdminContractsPage() {
  const list = useApiQuery<{ contracts: Contract[] }>("/api/admin/contracts");
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const shown = contracts ?? list.data?.contracts ?? null;
  const mutation = useApiMutation();
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function change(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) {
    setSaved(false);
    const result = await mutation.run<{ contracts: Contract[] }>(path, { method, body });
    if (result) {
      setContracts(result.contracts);
      setSaved(true);
    }
    return Boolean(result);
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    if (await change("/api/admin/contracts", "POST", { name: draft })) setDraft("");
  }

  return (
    <>
      <PageHead
        title="Contrats obligatoires"
        lead="Cette liste s'affiche dans « Mes contrats » pour tous les utilisateurs et invités. Elle est commune à tous les clients et ne peut pas être modifiée par eux."
      />

      {list.loading && !shown && <Loading slow={list.slow} />}
      <ErrorLine error={list.error} onRetry={list.reload} />

      {shown && (
        <ul className={s.list} style={{ maxWidth: 820, marginBottom: 18 }}>
          {shown.map((contract, index) => (
            <li key={contract.id} className={s.listItem}>
              <div className={s.row} style={{ justifyContent: "space-between" }}>
                {renaming?.id === contract.id ? (
                  <form
                    className={s.row}
                    style={{ flex: 1 }}
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await change(`/api/admin/contracts/${contract.id}`, "PATCH", { name: renaming.name })) setRenaming(null);
                    }}
                  >
                    <input
                      className={s.input}
                      style={{ maxWidth: 360 }}
                      aria-label="Nouveau nom du contrat"
                      maxLength={120}
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                    />
                    <Button type="submit" loading={mutation.pending}>
                      Enregistrer
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => setRenaming(null)}>
                      Annuler
                    </Button>
                  </form>
                ) : (
                  <>
                    <div>
                      <span style={{ fontWeight: 700 }}>{contract.name}</span>{" "}
                      <span className={`${s.muted} ${s.small}`}>· renseigné par {accountsLabel(contract.accounts)}</span>
                    </div>
                    <div className={s.row}>
                      <button
                        className={s.linkButton}
                        aria-label={`Déplacer ${contract.name} vers le haut`}
                        disabled={index === 0 || mutation.pending}
                        onClick={() => change(`/api/admin/contracts/${contract.id}`, "PATCH", { move: "up" })}
                      >
                        ↑
                      </button>
                      <button
                        className={s.linkButton}
                        aria-label={`Déplacer ${contract.name} vers le bas`}
                        disabled={index === shown.length - 1 || mutation.pending}
                        onClick={() => change(`/api/admin/contracts/${contract.id}`, "PATCH", { move: "down" })}
                      >
                        ↓
                      </button>
                      <Link href={`/admin/contrats/${contract.id}`} className={s.linkButton}>
                        Champs
                      </Link>
                      <button className={s.linkButton} onClick={() => setRenaming({ id: contract.id, name: contract.name })}>
                        Renommer
                      </button>
                      <button className={`${s.linkButton} ${s.dangerLink}`} onClick={() => setRemoving(contract.id)}>
                        Retirer
                      </button>
                    </div>
                  </>
                )}
              </div>
              {removing === contract.id && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                  <Notice tone="warning">
                    Ce contrat concerne {accountsLabel(contract.accounts)}. Le retirer le masque immédiatement pour tous les utilisateurs et
                    invités ; les informations et documents déjà renseignés restent dans le Google Drive de chaque compte.
                  </Notice>
                  <div className={s.row}>
                    <Button variant="secondary" onClick={() => setRemoving(null)}>
                      Annuler
                    </Button>
                    <Button
                      variant="danger"
                      loading={mutation.pending}
                      onClick={async () => {
                        if (await change(`/api/admin/contracts/${contract.id}`, "DELETE")) setRemoving(null);
                      }}
                    >
                      Confirmer le retrait
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
          {shown.length === 0 && <li className={s.empty}>Aucun contrat dans la liste.</li>}
        </ul>
      )}

      <form className={s.panel} style={{ maxWidth: 820 }} onSubmit={add}>
        <label className={s.label} htmlFor="new-contract">
          Nom du contrat à ajouter
        </label>
        <div className={s.row}>
          <input
            id="new-contract"
            className={s.input}
            style={{ maxWidth: 420 }}
            maxLength={120}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Nom du contrat (ex. Assurance Voyage)"
          />
          <Button type="submit" loading={mutation.pending} disabled={!draft.trim()}>
            Ajouter à la liste
          </Button>
        </div>
      </form>

      <div style={{ maxWidth: 820 }}>
        <ErrorLine error={mutation.error} />
        {saved && !mutation.error && <Notice tone="success">✓ Liste mise à jour pour tous les clients</Notice>}
      </div>
    </>
  );
}
