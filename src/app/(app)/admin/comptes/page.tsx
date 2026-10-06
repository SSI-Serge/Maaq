"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useApiQuery, useDebounced } from "@/client/hooks";
import { PageHead, adminStyles as s } from "@/components/admin/AdminShell";
import { ACCOUNT_STATUS, type AccountStatus } from "@/components/admin/labels";
import { ErrorLine } from "@/components/auth/parts";
import { ButtonLink, Loading, Notice } from "@/components/ui";

interface Account {
  id: string;
  name: string;
  email: string;
  status: AccountStatus;
  guests: number;
}

/** Comptes des utilisateurs principaux (US-64 RF1). */
export default function AdminAccountsPage() {
  return (
    <Suspense>
      <AccountsList />
    </Suspense>
  );
}

function AccountsList() {
  const created = useSearchParams().get("cree");
  const [search, setSearch] = useState("");
  const query = useDebounced(search);
  const accounts = useApiQuery<{ accounts: Account[] }>(`/api/admin/accounts?q=${encodeURIComponent(query)}`);

  return (
    <>
      <PageHead
        title="Comptes"
        lead="Utilisateurs principaux de MAAQ. Chaque compte peut inviter des invités selon son plan."
        action={<ButtonLink href="/admin/comptes/nouveau">+ Créer un compte</ButtonLink>}
      />
      {created && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="success">✓ Compte créé, email d&apos;activation envoyé à {created}</Notice>
        </div>
      )}
      <input
        className={s.search}
        type="search"
        placeholder="Rechercher un compte (nom, email)…"
        aria-label="Rechercher un compte"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {accounts.loading && !accounts.data && <Loading slow={accounts.slow} />}
      <ErrorLine error={accounts.error} onRetry={accounts.reload} />
      {accounts.data && (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Nom</th>
              <th>Email</th>
              <th>Statut</th>
              <th>Invités</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {accounts.data.accounts.map((a) => (
              <tr key={a.id}>
                <td style={{ fontWeight: 700 }}>{a.name}</td>
                <td>{a.email}</td>
                <td>
                  <span className={`${s.badge} ${ACCOUNT_STATUS[a.status].tone}`}>{ACCOUNT_STATUS[a.status].label}</span>
                </td>
                <td>{a.guests}</td>
                <td className={s.cellRight}>
                  <Link href={`/admin/comptes/${a.id}`} className={s.linkButton}>
                    Voir la fiche ›
                  </Link>
                </td>
              </tr>
            ))}
            {accounts.data.accounts.length === 0 && (
              <tr>
                <td colSpan={5} className={s.empty}>
                  {query ? "Aucun compte ne correspond à cette recherche." : "Aucun compte pour l'instant."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </>
  );
}
