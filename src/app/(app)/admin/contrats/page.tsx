"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { PageHead, adminStyles as s } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice } from "@/components/ui";

interface Category {
  id: string;
  name: string;
  accounts: number;
  contracts: number;
  documentFields: number;
  archivedAt: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const day = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Ce que la ligne d'une catégorie dit d'elle (maquette Admin-Contrats). */
function meta(c: Category): string {
  if (c.archivedAt) return `Archivée le ${day(c.archivedAt)} · ${plural(c.contracts, "contrat", "contrats")} en lecture seule chez ${plural(c.accounts, "famille", "familles")}`;
  const docs = c.documentFields ? `${plural(c.documentFields, "document attendu", "documents attendus")}` : "Aucun document attendu : à configurer";
  return `${docs} · ${plural(c.contracts, "contrat", "contrats")}`;
}

/**
 * Catégories de contrats, communes à toutes les familles (US-48, US-122, US-139). Une catégorie qui contient des contrats s'archive ; une catégorie sans contrat se supprime.
 * Les catégories archivées apparaissent grisées, en lecture seule.
 */
export default function AdminContractsPage() {
  const list = useApiQuery<{ contracts: Category[] }>("/api/admin/contracts");
  const [categories, setCategories] = useState<Category[] | null>(null);
  const shown = categories ?? list.data?.contracts ?? null;
  const mutation = useApiMutation();
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function change(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown, done?: string) {
    setMessage(null);
    const result = await mutation.run<{ contracts: Category[] }>(path, { method, body });
    if (result) {
      setCategories(result.contracts);
      setMessage(done ?? "✓ Liste mise à jour pour toutes les familles");
    }
    return Boolean(result);
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    if (await change("/api/admin/contracts", "POST", { name: draft }, "✓ Catégorie ajoutée")) setDraft("");
  }

  const active = (shown ?? []).filter((c) => !c.archivedAt);

  return (
    <>
      <PageHead
        title="Catégories de contrats"
        lead="Ces catégories s'affichent dans « Mes contrats » pour tous les utilisateurs et invités. Ouvrez une catégorie pour régler les documents attendus. Les familles ne peuvent pas les modifier."
      />

      {list.loading && !shown && <Loading slow={list.slow} />}
      <ErrorLine error={list.error} onRetry={list.reload} />

      {shown && (
        <ul className={s.list} style={{ maxWidth: 820, marginBottom: 18 }}>
          {shown.map((category) => {
            const archived = category.archivedAt !== null;
            const used = category.contracts > 0;
            const index = active.findIndex((c) => c.id === category.id);
            return (
              <li key={category.id} className={s.listItem} style={archived ? { opacity: 0.6 } : undefined}>
                <div className={s.row} style={{ justifyContent: "space-between" }}>
                  {renaming?.id === category.id ? (
                    <form
                      className={s.row}
                      style={{ flex: 1 }}
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (await change(`/api/admin/contracts/${category.id}`, "PATCH", { name: renaming.name }, "✓ Catégorie renommée")) setRenaming(null);
                      }}
                    >
                      <input className={s.input} style={{ maxWidth: 360 }} aria-label="Nouveau nom de la catégorie" maxLength={120} autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
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
                        <span style={{ fontWeight: 700 }}>{category.name}</span>
                        {archived && <span className={`${s.badge} ${s.badgeError}`} style={{ marginLeft: 8 }}>Archivée</span>}
                        <div className={`${s.muted} ${s.small}`}>{meta(category)}</div>
                      </div>
                      <div className={s.row}>
                        {!archived && (
                          <>
                            <button className={s.linkButton} aria-label={`Déplacer ${category.name} vers le haut`} disabled={index <= 0 || mutation.pending} onClick={() => change(`/api/admin/contracts/${category.id}`, "PATCH", { move: "up" })}>
                              ↑
                            </button>
                            <button className={s.linkButton} aria-label={`Déplacer ${category.name} vers le bas`} disabled={index < 0 || index === active.length - 1 || mutation.pending} onClick={() => change(`/api/admin/contracts/${category.id}`, "PATCH", { move: "down" })}>
                              ↓
                            </button>
                          </>
                        )}
                        <Link href={`/admin/contrats/${category.id}`} className={s.linkButton}>
                          {archived ? "Consulter" : "Ouvrir"}
                        </Link>
                        {!archived && (
                          <button className={s.linkButton} onClick={() => setRenaming({ id: category.id, name: category.name })}>
                            Renommer
                          </button>
                        )}
                        {!archived && (
                          <button className={`${s.linkButton} ${s.dangerLink}`} onClick={() => setAsking(category.id)}>
                            {used ? "Archiver" : "Supprimer"}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {asking === category.id && (
                  <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                    <Notice tone="warning">
                      {used
                        ? `Archiver « ${category.name} » ? ${plural(category.accounts, "famille a", "familles ont")} des contrats dans cette catégorie. Ils resteront consultables, sans transmission possible.`
                        : `Supprimer « ${category.name} » ? Aucun contrat n'utilise cette catégorie.`}
                    </Notice>
                    <div className={s.row}>
                      <Button variant="secondary" onClick={() => setAsking(null)}>
                        Annuler
                      </Button>
                      <Button
                        variant="danger"
                        loading={mutation.pending}
                        onClick={async () => {
                          const ok = used
                            ? await change(`/api/admin/contracts/${category.id}/archive`, "POST", undefined, "✓ Catégorie archivée. Elle n'est plus proposée aux familles.")
                            : await change(`/api/admin/contracts/${category.id}`, "DELETE", undefined, "✓ Catégorie supprimée.");
                          if (ok) setAsking(null);
                        }}
                      >
                        {used ? "Archiver" : "Supprimer"}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
          {shown.length === 0 && <li className={s.empty}>Aucune catégorie.</li>}
        </ul>
      )}

      <form className={s.panel} style={{ maxWidth: 820 }} onSubmit={add}>
        <label className={s.label} htmlFor="new-category">
          Nom de la catégorie à ajouter
        </label>
        <div className={s.row}>
          <input id="new-category" className={s.input} style={{ maxWidth: 420 }} maxLength={120} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Nom de la catégorie (ex. Assurance Voyage)" />
          <Button type="submit" loading={mutation.pending} disabled={!draft.trim()}>
            Ajouter la catégorie
          </Button>
        </div>
      </form>

      <div style={{ maxWidth: 820 }}>
        <ErrorLine error={mutation.error} />
        {message && !mutation.error && <Notice tone="success">{message}</Notice>}
        <p className={`${s.muted} ${s.small}`}>
          Une catégorie qui contient des contrats est archivée, pas supprimée : elle n&apos;est plus proposée et ne reçoit plus de contrats. Les familles gardent leurs contrats, détails et rapports en lecture seule. Une
          catégorie sans contrat peut être supprimée.
        </p>
      </div>
    </>
  );
}
