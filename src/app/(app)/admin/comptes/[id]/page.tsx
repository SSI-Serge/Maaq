"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { BackLink, PageHead, adminStyles as s, formatDate } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice } from "@/components/ui";
import { ACCOUNT_STATUS } from "@/components/admin/labels";

interface AccountDetail {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: "activation_pending" | "active" | "grace_period";
  guests: number;
  guestQuota: number;
  dailyRequestLimit: number;
  activationLink: { sentAt: string | null; expiresAt: string; expired: boolean } | null;
  limitHistory: { before: number; after: number; admin: string; at: string }[];
}

/** Fiche d'un compte : plafond quotidien modifiable, invités autorisés en lecture seule, renvoi du lien (US-64, US-69). */
export default function AccountPage() {
  const { id } = useParams<{ id: string }>();
  const account = useApiQuery<AccountDetail>(`/api/admin/accounts/${id}`);

  return (
    <>
      <BackLink href="/admin/comptes">Comptes</BackLink>
      {account.loading && !account.data && <Loading slow={account.slow} />}
      <ErrorLine error={account.error} onRetry={account.reload} />
      {account.data && <AccountCard key={account.data.dailyRequestLimit} account={account.data} onChanged={account.reload} />}
    </>
  );
}

function AccountCard({ account, onChanged }: { account: AccountDetail; onChanged: () => void }) {
  const status = ACCOUNT_STATUS[account.status];
  const [limit, setLimit] = useState(String(account.dailyRequestLimit));
  const [limitError, setLimitError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [resent, setResent] = useState(false);
  const save = useApiMutation();
  const resend = useApiMutation();

  async function saveLimit() {
    setSaved(false);
    if (!/^\d+$/.test(limit.trim()) || Number(limit) < 1) return setLimitError("Indiquez un nombre entier supérieur ou égal à 1.");
    setLimitError(undefined);
    const result = await save.run<AccountDetail>(`/api/admin/accounts/${account.id}`, { method: "PATCH", body: { dailyRequestLimit: Number(limit) } });
    if (result) {
      setSaved(true);
      onChanged();
    }
  }

  async function resendLink() {
    setResent(false);
    const result = await resend.run<null>(`/api/admin/accounts/${account.id}/activation`, { method: "POST" });
    if (result !== undefined) {
      setResent(true);
      onChanged();
    }
  }

  return (
    <>
      <PageHead title={account.name} action={<span className={`${s.badge} ${status.tone}`}>{status.label}</span>} />

      <section className={s.panel} style={{ maxWidth: 720 }}>
        <dl className={s.dl}>
          <dt>Email</dt>
          <dd>{account.email}</dd>
          <dt>Téléphone</dt>
          <dd>{account.phone ?? "—"}</dd>
          <dt>Invités autorisés (lecture seule)</dt>
          <dd>
            {account.guestQuota} <span className={s.muted}>— {account.guests} utilisé{account.guests > 1 ? "s" : ""}</span>
          </dd>
          <dt>Statut</dt>
          <dd>{status.label}</dd>
        </dl>
      </section>

      {account.status === "activation_pending" && (
        <section className={s.panel} style={{ maxWidth: 720 }}>
          <div className={s.panelTitle}>Lien d&apos;activation</div>
          <p className={s.pageLead} style={{ marginBottom: 12 }}>
            Le lien d&apos;activation envoyé est valable 30 minutes et à usage unique. Le renvoyer invalide le lien précédent.
            {account.activationLink?.sentAt && <> Dernier envoi : {formatDate(account.activationLink.sentAt)}.</>}
            {account.activationLink?.expired && <> Ce lien a expiré.</>}
          </p>
          <ErrorLine error={resend.error} onRetry={resendLink} />
          {resent && <Notice tone="success">✓ Nouveau lien d&apos;activation envoyé à {account.email}</Notice>}
          <div style={{ marginTop: 10 }}>
            <Button variant="secondary" loading={resend.pending} onClick={resendLink}>
              Renvoyer le lien d&apos;activation
            </Button>
          </div>
        </section>
      )}

      <section className={s.panel} style={{ maxWidth: 720 }}>
        <div className={s.panelTitle}>Plafond quotidien de demandes par profil</div>
        <div className={s.row}>
          <input
            className={`${s.input} ${limitError ? s.inputError : ""}`}
            style={{ width: 140 }}
            type="number"
            min={1}
            aria-label="Plafond quotidien de demandes par profil"
            value={limit}
            onChange={(e) => {
              setLimit(e.target.value);
              setSaved(false);
            }}
          />
          <Button loading={save.pending} onClick={saveLimit} disabled={limit === String(account.dailyRequestLimit)}>
            Enregistrer
          </Button>
        </div>
        {limitError && <div className={s.fieldError}>{limitError}</div>}
        <div style={{ marginTop: 10 }}>
          <ErrorLine error={save.error} onRetry={saveLimit} />
          {saved && (
            <Notice tone="success">
              ✓ Plafond mis à jour — s&apos;applique aux demandes suivantes, sans remettre à zéro celles déjà envoyées aujourd&apos;hui.
            </Notice>
          )}
        </div>
        {account.limitHistory.length > 0 && (
          <>
            <div className={s.panelTitle} style={{ marginTop: 18 }}>
              Journal des modifications
            </div>
            <ul className={s.list}>
              {account.limitHistory.map((h) => (
                <li key={h.at} className={`${s.small}`}>
                  {h.before} → {h.after} · {h.admin} · {formatDate(h.at)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
